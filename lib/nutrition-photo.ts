import { validAssistantText } from './health-assistant-chat.ts';
import { parseNutritionParserRequest } from './nutrition-parser.ts';
import type { NutritionDraft, NutritionDraftMeal } from './nutrition-parser.ts';
import { searchFoods } from './food-catalog.ts';
import type { NutritionProvenance } from './nutrition.ts';
import { MAX_NUTRITION_PHOTO_BYTES, validateNutritionPhotoDataUrl } from './nutrition-photo-image.ts';

export const MAX_NUTRITION_PHOTO_REQUEST_BYTES = Math.ceil(MAX_NUTRITION_PHOTO_BYTES / 3) * 4 + 16 * 1024;
const BODY_TIMEOUT_MS = 20000;
export interface NutritionPhotoRequest {
  image: { dataUrl: string };
  text: string;
  date: string;
  today: string;
  meal: NutritionDraftMeal | null;
}
export class NutritionPhotoError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message = '图片识别结果暂时无法核对，请更换清晰图片或补充文字后重试。', status = 502) {
    super(message); this.name = 'NutritionPhotoError';this.status=status;
    this.code = status === 413 ? 'NUTRITION_PHOTO_TOO_LARGE' : status === 408 ? 'NUTRITION_PHOTO_UPLOAD_TIMEOUT'
      : status === 400 ? 'INVALID_NUTRITION_PHOTO' : 'NUTRITION_PHOTO_RESPONSE_INVALID';
  }
}
function object(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new NutritionPhotoError('请提交图片、记录日期和可选的餐次及说明。', 400);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new NutritionPhotoError('图片识别请求含缺失或不支持的字段。', 400);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new NutritionPhotoError('图片识别请求格式无效。', 400);
    result[key] = descriptor.value as unknown;
  }
  return result;
}
export function parseNutritionPhotoRequest(input: unknown, now: Date | number = Date.now()): NutritionPhotoRequest {
  const raw = object(input, ['image', 'text', 'date', 'meal'], ['image', 'date']);
  const image = object(raw.image, ['dataUrl']);
  if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > 4000 || [...raw.text].length > 2000
    || (raw.text.trim() && !validAssistantText(raw.text, 2000)) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(raw.text))) throw new NutritionPhotoError('补充说明最多 2000 字，请检查内容后重试。', 400);
  let selection;
  try { selection = parseNutritionParserRequest({ text: '图片中的食物', date: raw.date, meal: raw.meal }, now); }
  catch { throw new NutritionPhotoError('请选择有效且不晚于今天的记录日期，以及早餐、午餐、晚餐或加餐。', 400); }
  const validated = validateNutritionPhotoDataUrl(image.dataUrl);
  return { image: { dataUrl: validated.dataUrl }, text: typeof raw.text === 'string' ? raw.text.trim() : '', date: selection.date, today: selection.today, meal: selection.meal };
}

/** Bound actual bytes before parsing, even if content-length is missing or forged. */
export async function readNutritionPhotoBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_NUTRITION_PHOTO_REQUEST_BYTES) throw new NutritionPhotoError('图片请求过大，请选择较小的照片后重试。', 413);
  if (!request.body) throw new NutritionPhotoError('请先选择一张食物图片。', 400);
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '', timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new NutritionPhotoError('图片上传等候超时，请检查网络后重试。', 408)); void reader.cancel().catch(() => {}); }, BODY_TIMEOUT_MS);
  });
  const read = async () => {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_NUTRITION_PHOTO_REQUEST_BYTES) { void reader.cancel().catch(() => {}); throw new NutritionPhotoError('图片请求过大，请选择较小的照片后重试。', 413); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  };
  try { return await Promise.race([read(), deadline]); }
  catch (error) { if (error instanceof NutritionPhotoError) throw error; throw new NutritionPhotoError('图片请求格式无效，请重新选择照片后重试。', 400); }
  finally { if (timer !== undefined) clearTimeout(timer); try { reader.releaseLock(); } catch { /* A cancelled pending read must not replace the safe timeout response. */ } }
}
const keys = ['calories', 'carbs', 'protein', 'fat'] as const;
const labels = { calories: '热量', carbs: '碳水化合物', protein: '蛋白质', fat: '脂肪' } as const;
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && Boolean(value.trim()) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function safeSlice(value: string, maximum: number) { return value.slice(0, maximum).replace(/[\ud800-\udbff]$/, ''); }
function resultObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try { return object(value, fields); } catch { throw new NutritionPhotoError(); }
}

/** Visual evidence is deliberately separate from the literal sourceText contract of text parsing. */
export function buildNutritionPhotoDrafts(answer: string, request: NutritionPhotoRequest): { drafts: NutritionDraft[]; warnings: string[] } {
  if (typeof answer !== 'string' || answer.length > 10000) throw new NutritionPhotoError();
  let parsed: unknown; try { parsed = JSON.parse(answer); } catch { throw new NutritionPhotoError(); }
  const raw = resultObject(parsed, ['items']);
  if (!Array.isArray(raw.items) || raw.items.length > 20) throw new NutritionPhotoError();
  let skipped = 0;
  const drafts: NutritionDraft[] = [];
  for (const value of raw.items) {
    const item = resultObject(value, ['name', 'evidence', 'confidence', 'estimate']);
    if (!boundedText(item.name, 100) || !boundedText(item.evidence, 200) || !['high', 'medium', 'low'].includes(String(item.confidence))) throw new NutritionPhotoError();
    let estimate: Record<string, unknown> | null = null;
    const values: Record<typeof keys[number], string | null> = { calories: null, carbs: null, protein: null, fat: null };
    if (item.estimate !== null) {
      estimate = resultObject(item.estimate, [...keys, 'portion', 'basis']);
      if (!boundedText(estimate.portion, 100) || !boundedText(estimate.basis, 200)) throw new NutritionPhotoError();
      for (const key of keys) {
        const value = estimate[key];
        if (value === null) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20000) throw new NutritionPhotoError();
        values[key] = value.toFixed(1);
      }
    }
    if (item.confidence === 'low') { skipped++; continue; }
    const evidence = item.evidence.trim(), name = item.name.trim();
    const portion = estimate ? safeSlice('图片估计：' + String(estimate.portion).trim(), 100) : '图片份量待核对';
    const basis = safeSlice('图片可见：' + evidence + (estimate ? '；估算依据：' + String(estimate.basis).trim() : '；缺少可合理估算的份量依据'), 300);
    const provenance: NutritionProvenance = {};
    for (const key of keys) provenance[key] = values[key] === null ? { source: 'unknown', basis, portion }
      : { source: 'ai', basis, portion, originalValue: values[key] };
    const warnings = ['食物和份量来自图片识别，不能确认实际吃下的数量；请核对名称、实际份量及用油。'];
    if (item.confidence === 'medium') warnings.push('此项辨认把握一般，请特别核对食物种类与烹饪方式。');
    if (request.meal === null) warnings.push('请选择这项食物的餐次。');
    const missing = keys.filter((key) => values[key] === null).map((key) => labels[key]);
    if (missing.length) warnings.push(missing.join('、') + '暂时未知，请按实际份量补充；未知不会按0计算。');
    const candidates = searchFoods(name, 6);
    if (candidates.some((food) => food.id.startsWith('luckin-cn:'))) warnings.push('瑞幸官网热量仅适用于列明的杯型、冰热和糖度，图片不能确认这些配置，请核对候选规格后主动选择。');
    drafts.push({ date: request.date, meal: request.meal, name, amount: null, unit: null, portion,
      calories: values.calories, calorieSource: values.calories === null ? null : 'ai', carbs: values.carbs, protein: values.protein, fat: values.fat,
      macroSources: { carbs: values.carbs === null ? null : 'ai', protein: values.protein === null ? null : 'ai', fat: values.fat === null ? null : 'ai' },
      provenance, note: safeSlice('AI 图片估算；' + basis + '；' + portion + '。需核对实际食用量。', 500), food: null, candidates, warnings });
  }
  return { drafts, warnings: drafts.length ? ['以下是图片识别草稿。热量和三大营养素是图片份量的参考估算，请核对后保存。', ...(skipped ? ['部分项目辨认不清，未自动生成记录；可补充清晰图片或手动填写。'] : [])]
    : ['这张图片中没有可可靠辨认的食物。请换一张食物更清晰的照片，或使用文字、手动录入。'] };
}
