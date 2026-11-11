import { NutritionValidationError, parseNutritionCreate, validNutritionId, type NutritionMeal } from './nutrition.ts';

export interface NutritionCopySelection { fromDate: string; fromMeal: NutritionMeal; toDate: string; toMeal: NutritionMeal }
export type NutritionCopyCommand = { action: 'preview'; selection: NutritionCopySelection } | { action: 'copy'; selection: NutritionCopySelection; previewToken: string };
function fail(message: string): never { throw new NutritionValidationError([{ path: '$', message }]); }
function fields(input: unknown, allowed: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('请提交完整的复用内容。');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return fail('复用内容含不支持的字段。');
  return raw;
}
export function parseNutritionFavorite(input: unknown) {
  const raw = fields(input, ['entryId', 'expectedRevision']);
  if (!validNutritionId(raw.entryId) || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1) return fail('请先读取要保存为常用的记录。');
  return { entryId: raw.entryId.toLowerCase(), expectedRevision: Number(raw.expectedRevision) };
}
export function parseNutritionFavoriteRemove(input: unknown) {
  const raw = fields(input, ['expectedRevision']);
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1) return fail('请重新读取常用食物后移除。');
  return Number(raw.expectedRevision);
}
export function parseNutritionCopy(input: unknown, now = Date.now()): NutritionCopyCommand {
  const raw = fields(input, ['action', 'fromDate', 'fromMeal', 'toDate', 'toMeal', 'previewToken']);
  if (raw.action !== 'preview' && raw.action !== 'copy') return fail('请选择预览或复制餐次。');
  const base = { name: '餐次复制', portion: '', note: '', calories: null };
  const from = parseNutritionCreate({ ...base, date: raw.fromDate, meal: raw.fromMeal }, now);
  const to = parseNutritionCreate({ ...base, date: raw.toDate, meal: raw.toMeal }, now);
  if (from.date === to.date && from.meal === to.meal) return fail('来源与目标餐次相同，请选择不同日期或餐次。');
  const selection = { fromDate: from.date, fromMeal: from.meal, toDate: to.date, toMeal: to.meal };
  if (raw.action === 'preview') { if (Object.hasOwn(raw, 'previewToken')) return fail('请重新预览餐次。'); return { action: 'preview', selection }; }
  if (typeof raw.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.previewToken)) return fail('请先预览复制内容。');
  return { action: 'copy', selection, previewToken: raw.previewToken };
}
