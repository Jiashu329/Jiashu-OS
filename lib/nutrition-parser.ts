import { searchFoods, calculateFoodSelection } from './food-catalog.ts';
import type { FoodItem, FoodSelection } from './food-catalog.ts';
import { validAssistantText } from './health-assistant-chat.ts';
import { shanghaiDay } from './health.ts';
import type { NutritionProvenance } from './nutrition.ts';

export type NutritionDraftMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type NutritionDraftMacro = 'carbs' | 'protein' | 'fat';
export type NutritionDraftSource = 'catalog' | 'ai' | null;
export interface NutritionParserRequest {
  text: string;
  date: string;
  today: string;
  meal: NutritionDraftMeal | null;
}
export interface NutritionDraft {
  date: string;
  meal: NutritionDraftMeal | null;
  name: string;
  amount: number | null;
  unit: string | null;
  portion: string;
  calories: string | null;
  calorieSource: 'catalog' | 'ai' | null;
  carbs: string | null;
  protein: string | null;
  fat: string | null;
  macroSources: Record<NutritionDraftMacro, NutritionDraftSource>;
  provenance: NutritionProvenance;
  note: string;
  food: FoodSelection | null;
  candidates: FoodItem[];
  warnings: string[];
}
export class NutritionParserError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message = '饮食识别结果暂时无法核对，请换一种描述后重试。', status = 502) {
    super(message);
    this.name = 'NutritionParserError';
    this.status = status;
    this.code = status === 400 ? 'INVALID_NUTRITION_PARSE_REQUEST' : 'NUTRITION_PARSE_RESPONSE_INVALID';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validMeal(value: unknown): value is NutritionDraftMeal {
  return typeof value === 'string' && ['breakfast', 'lunch', 'dinner', 'snack'].includes(value);
}
export function parseNutritionParserRequest(raw: unknown, now: number | Date = Date.now()): NutritionParserRequest {
  if (!object(raw) || Object.keys(raw).some((key) => !['text', 'date', 'meal'].includes(key))) {
    throw new NutritionParserError('请提交饮食描述、记录日期和可选餐次。', 400);
  }
  if (!validAssistantText(raw.text, 2000)) throw new NutritionParserError('请用 1–2000 个字符描述吃了什么。', 400);
  const today = shanghaiDay(new Date(now).toISOString());
  if (!validDay(raw.date) || raw.date > today) throw new NutritionParserError('请选择有效且不晚于今天的记录日期。', 400);
  if (raw.meal !== undefined && raw.meal !== null && !validMeal(raw.meal)) {
    throw new NutritionParserError('请选择早餐、午餐、晚餐或加餐。', 400);
  }
  return { text: raw.text.trim(), date: raw.date, today, meal: validMeal(raw.meal) ? raw.meal : null };
}

function dateFromText(raw: unknown, request: NutritionParserRequest): string {
  if (raw === null) return request.date;
  if (typeof raw !== 'string' || raw.length > 40 || !raw.trim() || !request.text.includes(raw)) throw new NutritionParserError();
  // Keep the original-text evidence, then remove only a bounded time-of-day
  // suffix. Matching a day anywhere in a phrase could hide ambiguous dates.
  const dayText = raw.normalize('NFKC').trim().replace(/(?:的)?(?:凌晨|清晨|早晨|早上|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|半夜|早餐|早饭|午餐|午饭|晚餐|晚饭|夜宵|宵夜|加餐)$/, '');
  if (!dayText) return request.date; // A time of day alone keeps the selected date.
  const shifts: Record<string, number> = { 今天: 0, 今日: 0, 今儿: 0, 今儿个: 0, 今早: 0, 今晨: 0, 今晚: 0, 今夜: 0,
    昨天: -1, 昨日: -1, 昨晚: -1, 昨夜: -1, 昨早: -1, 昨晨: -1, 前天: -2, 大前天: -3,
    明天: 1, 明日: 1, 后天: 2, 後天: 2, 大后天: 3 };
  let date = dayText;
  if (Object.hasOwn(shifts, dayText)) date = new Date(Date.parse(request.today + 'T12:00:00Z') + shifts[dayText] * 86400000).toISOString().slice(0, 10);
  else {
    const full = /^(\d{4})年(\d{1,2})月(\d{1,2})(?:日|号)$/.exec(dayText)
      ?? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dayText) ?? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(dayText);
    const partial = /^(\d{1,2})月(\d{1,2})(?:日|号)$/.exec(dayText) ?? /^(\d{1,2})-(\d{1,2})$/.exec(dayText);
    if (full) date = full[1] + '-' + full[2].padStart(2, '0') + '-' + full[3].padStart(2, '0');
    else if (partial) date = request.today.slice(0, 4) + '-' + partial[1].padStart(2, '0') + '-' + partial[2].padStart(2, '0');
  }
  if (!validDay(date)) throw new NutritionParserError('识别出的日期无效，请在描述中使用明确的年月日。');
  if (date > request.today) throw new NutritionParserError('饮食记录日期不能晚于今天，请检查描述中的日期。', 400);
  return date;
}

function mealFromText(...texts: Array<string | null>): NutritionDraftMeal | null {
  const named: Array<[NutritionDraftMeal, RegExp]> = [['breakfast', /早餐|早饭/], ['lunch', /午餐|午饭/],
    ['dinner', /晚餐|晚饭/], ['snack', /加餐|夜宵|宵夜|下午茶|零食/]];
  const periods: Array<[NutritionDraftMeal, RegExp]> = [['breakfast', /早上|早晨|清晨|上午|今早|今晨|昨早|昨晨/],
    ['lunch', /中午/], ['dinner', /傍晚|晚上|今晚|昨晚/]];
  // Prefer evidence beside this item. Fall back to the whole sentence only
  // when it describes one unambiguous meal, never by the server clock.
  for (const text of texts) {
    if (!text) continue;
    const matches = new Set([...named, ...periods].filter(([, pattern]) => pattern.test(text)).map(([meal]) => meal));
    if (matches.size > 1) return null;
    if (matches.size === 1) return [...matches][0];
  }
  return null;
}
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·・，,、()（）]/g, '');
function compatiblePreparation(source: string, food: FoodItem): boolean {
  const description = [food.name, food.state, ...food.aliases].join(' ');
  // A model must not discard an explicitly stated cooking method and silently
  // match the remaining generic ingredient to its raw counterpart.
  const method = /煎|炸|炒|烤|蒸|炖|焖|燉|燜/.exec(source)?.[0];
  if (method && !description.includes(method)) return false;
  if (/(?:生米|生肉|生鸡|生魚|生鱼|生蛋|生鲜)/.test(source) && /熟制|熟食|水煮|清蒸/.test(description)) return false;
  if (/生鲜/.test(food.state) && /肉|蛋|米|面|魚|鱼|虾|蝦/.test(source) && !/生|鲜|新鮮/.test(source)) return false;
  if (/熟|水煮|煮熟/.test(source) && /生鲜/.test(food.state) && !/熟/.test(food.state)) return false;
  return true;
}
function boundedText(raw: unknown, maximum: number): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f]/.test(raw);
}

const macroFields = ['carbs', 'protein', 'fat'] as const;
const macroLabels = { carbs: '碳水化合物', protein: '蛋白质', fat: '脂肪' } as const;
interface NutritionEstimate {
  calories: string;
  carbs: string | null;
  protein: string | null;
  fat: string | null;
  portion: string;
  basis: string;
}
function calorieEstimate(raw: unknown): NutritionEstimate | null {
  // Older model responses remain usable; estimates never supply catalog IDs.
  if (raw === undefined || raw === null) return null;
  if (!object(raw) || !['calories', 'portion', 'basis'].every((key) => Object.hasOwn(raw, key))
    || Object.keys(raw).some((key) => !['calories', 'portion', 'basis', ...macroFields].includes(key))
    || typeof raw.calories !== 'number' || !Number.isFinite(raw.calories)
    || raw.calories < 0 || raw.calories > 20000
    || !boundedText(raw.portion, 100) || !boundedText(raw.basis, 200)) throw new NutritionParserError();
  const macros: Record<NutritionDraftMacro, string | null> = { carbs: null, protein: null, fat: null };
  for (const key of macroFields) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20000) throw new NutritionParserError();
    macros[key] = value.toFixed(1);
  }
  return { calories: raw.calories.toFixed(1), ...macros, portion: raw.portion.trim(), basis: raw.basis.trim() };
}

/** Prefer catalog calculations; validated model estimates remain labeled, editable drafts. */
export function buildNutritionDrafts(answer: string, request: NutritionParserRequest): { drafts: NutritionDraft[]; warnings: string[] } {
  if (typeof answer !== 'string' || answer.length > 10000) throw new NutritionParserError();
  let raw: unknown;
  try { raw = JSON.parse(answer); } catch { throw new NutritionParserError(); }
  if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.items) || raw.items.length > 20) throw new NutritionParserError();
  if (!Object.hasOwn(raw, 'items')) throw new NutritionParserError();
  const drafts = raw.items.map((value): NutritionDraft => {
    if (!object(value) || ![6, 7].includes(Object.keys(value).length)
      || !['name', 'amount', 'unit', 'meal', 'dateText', 'sourceText'].every((key) => Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !['name', 'amount', 'unit', 'meal', 'dateText', 'sourceText', 'estimate'].includes(key))
      || !boundedText(value.name, 100) || !validAssistantText(value.sourceText, 500)
      || !request.text.includes(value.sourceText)
      || !(value.amount === null || (typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount > 0 && value.amount <= 100000))
      || !(value.unit === null || boundedText(value.unit, 20))
      || !(value.meal === null || validMeal(value.meal))) throw new NutritionParserError();
    const name = value.name.trim(), amount = value.amount as number | null, unit = typeof value.unit === 'string' ? value.unit.trim() : null;
    const date = dateFromText(value.dateText, request), meal = validMeal(value.meal) ? value.meal
      : mealFromText(value.sourceText as string, value.dateText as string | null, request.text) ?? request.meal;
    const candidates = searchFoods(name, 6);
    // The official display name carries its specification; a branded base name
    // may resolve only when exactly one specification matches.
    const exact = candidates.filter((food) => [food.name, ...food.aliases,
      ...(food.basis === 'perServing' ? [food.name.replace(/［[^［］]+］$/, '')] : [])].some((alias) => normalized(alias) === normalized(name))
      && compatiblePreparation(value.sourceText as string, food));
    const warnings: string[] = [];
    const estimate = calorieEstimate(value.estimate);
    let food: NutritionDraft['food'] = null, calories: string | null = null, portion = amount === null ? '份量待补充' : String(amount) + (unit ?? '（单位待补充）');
    let calorieSource: NutritionDraft['calorieSource'] = null, note = '';
    const macros: Record<NutritionDraftMacro, string | null> = { carbs: null, protein: null, fat: null };
    const macroSources: NutritionDraft['macroSources'] = { carbs: null, protein: null, fat: null };
    if (!meal) warnings.push('请选择这项食物的餐次。');
    if (!candidates.length) warnings.push('食物库暂未找到匹配项，可搜索其他名称或核对下方估算。');
    else if (exact.length !== 1) warnings.push('食物或生熟、烹饪方式尚需核对，请从候选中选择。');
    if (amount === null || unit === null) warnings.push('份量或单位不明确，请补充实际重量或数量。');
    else if (exact.length === 1) {
      try {
        const selection = { id: exact[0].id, amount, unit,
          ...(exact[0].catalogRelease ? { catalogRelease: exact[0].catalogRelease } : {}) };
        const calculated = calculateFoodSelection(selection);
        if (!Number.isSafeInteger(calculated.caloriesTenth) || calculated.caloriesTenth < 0 || calculated.caloriesTenth > 200000) throw new Error('Invalid calorie amount');
        food = selection;
        calories = (calculated.caloriesTenth / 10).toFixed(1);
        calorieSource = 'catalog';
        for (const key of macroFields) {
          const tenth = calculated[`${key}Tenth`];
          if (tenth !== undefined && tenth !== null && Number.isSafeInteger(tenth) && tenth >= 0 && tenth <= 200000) {
            macros[key] = (tenth / 10).toFixed(1);
            macroSources[key] = 'catalog';
          }
        }
        const knownGrams = typeof calculated.grams === 'number' && Number.isFinite(calculated.grams);
        portion = String(amount) + unit + (knownGrams && !['g', '克', '公克'].includes(unit) ? '（' + calculated.grams + 'g）' : '');
        if (calculated.estimated) warnings.push('份量换算使用食物库参考重量，请核对实际份量。');
      } catch {
        warnings.push(exact[0].basis === 'perServing'
          ? '这个规格只提供官方每份营养值，尚无可靠克重。请核对规格并选择份数，或核对下方估算。'
          : '这个单位没有食物库重量换算；请改填克重，或核对下方估算。');
      }
    }
    if (calories === null && estimate) {
      calories = estimate.calories;
      calorieSource = 'ai';
      // Keep original quantities as evidence; inferred serving sizes are display-only.
      portion = estimate.portion;
      note = 'AI 估算：' + estimate.portion + '；' + estimate.basis + '。';
      warnings.push('热量为 AI 估算，受份量、配料和用油影响，请核对后保存。');
    } else if (calories === null) warnings.push('暂时无法估算热量，请补充食物、份量或包装信息后重新识别，也可手动填写。');
    for (const key of macroFields) {
      if (macros[key] === null && estimate?.[key] !== undefined && estimate[key] !== null) {
        macros[key] = estimate[key];
        macroSources[key] = 'ai';
      }
    }
    const estimatedMacros = macroFields.filter((key) => macroSources[key] === 'ai').map((key) => macroLabels[key]);
    if (estimatedMacros.length && estimate) {
      const names = estimatedMacros.join('、');
      if (calorieSource === 'ai') note += names + '也为 AI 估算。';
      else note = 'AI 营养估算：' + names + '；' + estimate.portion + '；' + estimate.basis + '。';
      warnings.push(names + '为 AI 估算，单位为当前食用份量的合计克数，请核对后保存。');
    }
    const unknownMacros = macroFields.filter((key) => macros[key] === null).map((key) => macroLabels[key]);
    if (unknownMacros.length) warnings.push(unknownMacros.join('、') + '暂未提供，可手动填写；未知不会按0计算。');
    const provenance: NutritionProvenance = {};
    for (const key of ['calories', ...macroFields] as const) {
      const source = key === 'calories' ? calorieSource : macroSources[key];
      provenance[key] = source === 'ai' && estimate
        ? { source: 'ai', basis: estimate.basis, portion: estimate.portion, originalValue: key === 'calories' ? estimate.calories : estimate[key] }
        : source === 'catalog' ? { source: 'catalog', basis: exact[0].source.name + ' · ' + exact[0].source.version, portion }
          : { source: 'unknown' };
    }
    return { date, meal, name: food ? exact[0].name : name, amount, unit, portion, calories, calorieSource, ...macros, macroSources, provenance, note, food, candidates, warnings };
  });
  return { drafts, warnings: drafts.length ? ['以下是识别草稿，检查食物、生熟状态与份量后可批量保存。'] : ['未识别到明确吃过的食物，请描述实际吃了什么及份量。'] };
}
