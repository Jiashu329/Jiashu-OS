import { normalizeTimestamp, shanghaiDay } from './health.ts';
import { calculateFoodSelection, type FoodSnapshot } from './food-catalog.ts';
import { NUTRIENT_KEYS, summarizeNutrients, type NutrientKey, type NutritionNutrients } from './nutrition-nutrients.ts';

export const NUTRITION_MEALS = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
} as const;
export type NutritionMeal = keyof typeof NUTRITION_MEALS;
export type NutritionMealStatus = 'unrecorded' | 'recorded' | 'skipped';
export interface NutritionDayStatus { date: string; complete: boolean; meals: Record<NutritionMeal, NutritionMealStatus>; revision: number }
export interface NutritionDayStatusInput extends Omit<NutritionDayStatus, 'revision'> { expectedRevision: number }
export type NutritionSource = 'manual' | 'label' | 'catalog' | 'ai' | 'unknown';
export interface NutritionValueProvenance { source: NutritionSource; basis?: string; portion?: string; originalValue?: string | null }
export type NutritionProvenance = Partial<Record<NutrientKey, NutritionValueProvenance>>;
export interface NutritionInput {
  date: string;
  meal: NutritionMeal;
  name: string;
  portion: string;
  note: string;
  caloriesTenth: number | null;
  carbsTenth?: number | null;
  proteinTenth?: number | null;
  fatTenth?: number | null;
  food?: FoodSnapshot;
  provenance?: NutritionProvenance;
}
export interface NutritionEntry extends NutritionInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface NutritionEntryView extends NutritionEntry { calories: string | null; carbs: string | null; protein: string | null; fat: string | null; deleted: boolean }
export interface NutritionMealSummary {
  meal: NutritionMeal;
  label: string;
  entryCount: number;
  knownCount: number;
  unknownCount: number;
  knownCalories: string | null;
  nutrients: NutritionNutrients;
}
export interface NutritionSummary {
  entryCount: number;
  knownCount: number;
  unknownCount: number;
  knownCalories: string | null;
  nutrients: NutritionNutrients;
  meals: NutritionMealSummary[];
}
export interface NutritionQuery {
  date: string;
  today: string;
  includeDeleted: boolean;
  recentFrom: string;
  recentTo: string;
}
export interface NutritionReview extends NutritionQuery {
  entries: NutritionEntryView[];
  summary: NutritionSummary;
  recent7days: Array<{ date: string; summary: NutritionSummary }>;
}
export type NutritionPatch = { kind: 'edit'; input: NutritionInput; expectedRevision: number }
  | { kind: 'deleted'; deleted: boolean; expectedRevision: number };

export class NutritionValidationError extends Error {
  readonly code = 'INVALID_NUTRITION_ENTRY';
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super(issues.map((issue) => issue.message).join('；'));
    this.name = 'NutritionValidationError';
    this.issues = issues;
  }
}
function fail(path: string, message: string): never { throw new NutritionValidationError([{ path, message }]); }
function fields(input: unknown, allowed: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return fail('$', '请提交完整的饮食记录。');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new NutritionValidationError(unknown.map((path) => ({ path, message: '此饮食记录字段不受支持。' })));
  return raw;
}
function text(input: unknown, path: string, maximum: number, optional = false) {
  if (input === undefined && optional) return '';
  if (typeof input !== 'string') return fail(path, '请使用文字填写' + (path === 'name' ? '食物名称。' : path === 'portion' ? '份量。' : '备注。'));
  for (const character of input) {
    const code = character.charCodeAt(0);
    const allowedWhitespace = path === 'note' && (code === 9 || code === 10 || code === 13);
    if ((code < 32 && !allowedWhitespace) || code === 127) return fail(path, '文字中包含不支持的控制字符。');
  }
  const result = input.trim();
  if ((!optional && !result) || result.length > maximum) return fail(path, path === 'name' ? '食物名称需为 1–100 个字符。' : (path === 'portion' ? '份量最多 100 个字符。' : '备注最多 500 个字符。'));
  return result;
}
function date(input: unknown, today: string) {
  if (typeof input !== 'string' || input.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(input)
    || !normalizeTimestamp(input + 'T12:00:00+08:00')) return fail('date', '请选择 1970–2100 年之间的有效日期。');
  if (input > today) return fail('date', '饮食记录日期不能晚于今天。');
  return input;
}
function calories(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string' || input.length > 128) return fail('calories', '热量请填写普通数字，未知时留空。');
  for (const character of input) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return fail('calories', '热量格式不正确。');
  const value = input.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d)?$/.test(value)) return fail('calories', '热量需为非负数字，最多保留 1 位小数，不附带单位。');
  const [whole, fraction = '0'] = value.split('.');
  const tenth = BigInt(whole + fraction);
  if (tenth > BigInt(200000)) return fail('calories', '单份食物热量不能超过 20000 kcal。');
  return Number(tenth);
}
const macroKeys = ['carbs', 'protein', 'fat'] as const;
const macroLabels = { carbs: '碳水化合物', protein: '蛋白质', fat: '脂肪' } as const;
function macroGrams(input: unknown, key: (typeof macroKeys)[number]): number | null {
  if (input === undefined || input === null) return null;
  const label = macroLabels[key];
  if (typeof input !== 'string' || input.length > 128 || /[\u0000-\u001f\u007f]/.test(input)) return fail(key, label + '请填写普通数字，未知时留空。');
  const value = input.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d)?$/.test(value)) return fail(key, label + '需为非负数字，最多保留 1 位小数，不附带单位。');
  const [whole, fraction = '0'] = value.split('.');
  const tenth = BigInt(whole + fraction);
  if (tenth > BigInt(200000)) return fail(key, '单份食物的' + label + '不能超过 20000g。');
  return Number(tenth);
}
function decimal(tenth: bigint) {
  const digits = tenth.toString().padStart(2, '0');
  return digits.slice(0, -1) + '.' + digits.slice(-1);
}
function shiftDate(day: string, offset: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

export function validNutritionId(input: unknown): input is string {
  return typeof input === 'string' && input.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}
export function parseNutritionCreate(input: unknown, now: Date | number = Date.now()): NutritionInput {
  const raw = fields(input, ['date', 'meal', 'name', 'portion', 'calories', 'carbs', 'protein', 'fat', 'note', 'food', 'provenance']);
  if (typeof raw.meal !== 'string' || !Object.hasOwn(NUTRITION_MEALS, raw.meal)) return fail('meal', '请选择早餐、午餐、晚餐或加餐。');
  let food: FoodSnapshot | undefined;
  if (raw.food !== undefined && raw.food !== null) {
    const selection = fields(raw.food, ['id', 'amount', 'unit', 'catalogRelease']);
    if (typeof selection.id !== 'string' || typeof selection.amount !== 'number' || typeof selection.unit !== 'string') return fail('food', '请选择食物库中的食物并填写有效份量。');
    if (Object.hasOwn(selection, 'catalogRelease') && (typeof selection.catalogRelease !== 'string' || !selection.catalogRelease || selection.catalogRelease.length > 100)) return fail('food', '请选择有效的食物库版本。');
    try {
      food = calculateFoodSelection({ id: selection.id, amount: selection.amount, unit: selection.unit,
        ...(Object.hasOwn(selection, 'catalogRelease') ? { catalogRelease: selection.catalogRelease as string } : {}) });
      // Preserve pre-versioning request fingerprints and uncertain queued writes.
      if (!Object.hasOwn(selection, 'catalogRelease')) delete food.catalogRelease;
    }
    catch (error) { return fail('food', error instanceof Error ? error.message : '食物库记录已变化，请重新选择食物。'); }
    if (!Number.isSafeInteger(food.caloriesTenth) || food.caloriesTenth < 0 || food.caloriesTenth > 200000) return fail('food', '这份食物热量超出支持范围，请调整份量。');
  }
  const macros: Pick<NutritionInput, 'carbsTenth' | 'proteinTenth' | 'fatTenth'> = {};
  for (const key of macroKeys) {
    // Omitted fields preserve old request fingerprints across a deployment.
    if (!Object.hasOwn(raw, key)) continue;
    const field = `${key}Tenth` as 'carbsTenth' | 'proteinTenth' | 'fatTenth';
    macros[field] = macroGrams(raw[key], key) ?? food?.[field] ?? null;
  }
  const result: NutritionInput = {
    date: date(raw.date, shanghaiDay(new Date(now).toISOString())), meal: raw.meal as NutritionMeal,
    name: food ? text(food.foodName, 'name', 100) : text(raw.name, 'name', 100),
    portion: food ? text(String(food.amount) + food.unit, 'portion', 100) : text(raw.portion, 'portion', 100, true),
    note: text(raw.note, 'note', 500, true), caloriesTenth: food ? food.caloriesTenth : calories(raw.calories),
    ...macros,
    ...(food ? { food } : {}),
  };
  if (Object.hasOwn(raw, 'provenance')) result.provenance = parseNutritionProvenance(raw.provenance, result);
  return result;
}
export function parseNutritionPatch(input: unknown, now: Date | number = Date.now()): NutritionPatch {
  const raw = fields(input, ['date', 'meal', 'name', 'portion', 'calories', 'carbs', 'protein', 'fat', 'note', 'food', 'provenance', 'deleted', 'expectedRevision']);
  if (typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1) return fail('expectedRevision', '请先读取最新版本的饮食记录。');
  if (Object.hasOwn(raw, 'deleted')) {
    if (typeof raw.deleted !== 'boolean' || Object.keys(raw).some((key) => !['deleted', 'expectedRevision'].includes(key))) return fail('deleted', '删除或恢复操作仅提交状态和当前版本，不同时编辑食物。');
    return { kind: 'deleted', deleted: raw.deleted, expectedRevision: raw.expectedRevision };
  }
  const required = ['date', 'meal', 'name', 'portion', 'calories', 'note'];
  for (const key of required) if (!Object.hasOwn(raw, key)) return fail(key, '编辑时请提交完整食物记录；未知热量使用 null。');
  const { expectedRevision, ...edit } = raw;
  return { kind: 'edit', input: parseNutritionCreate(edit, now), expectedRevision };
}

/** New writes store explicit field origins; old omitted metadata stays hash-compatible. */
export function parseNutritionProvenance(value: unknown, input: NutritionInput): NutritionProvenance {
  const raw = fields(value, NUTRIENT_KEYS);
  const result: NutritionProvenance = {};
  for (const key of NUTRIENT_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const item = fields(raw[key], ['source', 'basis', 'portion', 'originalValue']);
    if (!['manual', 'label', 'catalog', 'ai', 'unknown'].includes(String(item.source))) return fail('provenance.' + key, '请选择有效的营养数据来源。');
    const source = item.source as NutritionSource;
    const parsed: NutritionValueProvenance = { source };
    for (const field of ['basis', 'portion'] as const) if (Object.hasOwn(item, field)) {
      if (typeof item[field] !== 'string' || item[field].length > (field === 'basis' ? 300 : 100) || /[\u0000-\u001f\u007f]/.test(item[field])) return fail('provenance.' + key + '.' + field, '来源依据或份量说明格式不正确。');
      if (item[field].trim()) parsed[field] = item[field].trim();
    }
    if (Object.hasOwn(item, 'originalValue')) {
      const original = key === 'calories' ? calories(item.originalValue) : macroGrams(item.originalValue, key);
      parsed.originalValue = original === null ? null : decimal(BigInt(original));
    }
    if (source === 'ai' && !parsed.basis) return fail('provenance.' + key + '.basis', 'AI 估算需保留估算依据。');
    const field = `${key}Tenth` as 'caloriesTenth' | 'carbsTenth' | 'proteinTenth' | 'fatTenth';
    if (source === 'catalog' && (!input.food || input.food[field] === undefined || input[field] !== input.food[field])) return fail('provenance.' + key, '食物库来源需与当前选中食物和份量的计算值一致。');
    if (input[field] === undefined || input[field] === null) parsed.source = 'unknown';
    result[key] = parsed;
  }
  return result;
}

export function nutritionProvenance(input: NutritionInput): NutritionProvenance {
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const field = `${key}Tenth` as 'caloriesTenth' | 'carbsTenth' | 'proteinTenth' | 'fatTenth';
    const value = input[field];
    const supplied = input.provenance?.[key];
    const catalog = value !== null && value !== undefined && input.food?.[field] !== undefined && input.food[field] === value;
    const source = value === null || value === undefined ? 'unknown' : key === 'calories' && catalog ? 'catalog' : supplied?.source ?? (catalog ? 'catalog' : 'unknown');
    return [key, { ...supplied, source }];
  }));
}
export function parseNutritionQuery(params: URLSearchParams, now: Date | number = Date.now()): NutritionQuery {
  const today = shanghaiDay(new Date(now).toISOString());
  const selected = date(params.get('date') ?? today, today);
  const first = shiftDate(selected, -6);
  return { date: selected, today, includeDeleted: params.get('includeDeleted') === '1', recentFrom: first < '1970-01-01' ? '1970-01-01' : first, recentTo: selected };
}
export function presentNutritionEntry(entry: NutritionEntry): NutritionEntryView {
  const display = (value: number | null | undefined) => value === undefined || value === null ? null : decimal(BigInt(value));
  return { ...entry, calories: display(entry.caloriesTenth), carbs: display(entry.carbsTenth), protein: display(entry.proteinTenth), fat: display(entry.fatTenth), deleted: entry.deletedAt !== null };
}
export function summarizeNutrition(entries: readonly NutritionEntry[]): NutritionSummary {
  const active = entries.filter((entry) => entry.deletedAt === null);
  const sum = (rows: readonly NutritionEntry[]) => {
    const known = rows.filter((entry) => entry.caloriesTenth !== null);
    const total = known.reduce((value, entry) => value + BigInt(entry.caloriesTenth!), BigInt(0));
    return { entryCount: rows.length, knownCount: known.length, unknownCount: rows.length - known.length,
      knownCalories: known.length ? decimal(total) : null };
  };
  return { ...sum(active), nutrients: summarizeNutrients(active), meals: (Object.keys(NUTRITION_MEALS) as NutritionMeal[]).map((meal) => ({
    meal, label: NUTRITION_MEALS[meal], ...sum(active.filter((entry) => entry.meal === meal)), nutrients: summarizeNutrients(active.filter((entry) => entry.meal === meal)),
  })) };
}
export function buildNutritionReview(entries: readonly NutritionEntry[], selection: NutritionQuery): NutritionReview {
  const selected = entries.filter((entry) => entry.date === selection.date);
  const order = Object.keys(NUTRITION_MEALS);
  const visible = selected.filter((entry) => selection.includeDeleted || entry.deletedAt === null)
    .sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const recentDays = Math.round((Date.parse(selection.recentTo + 'T12:00:00Z') - Date.parse(selection.recentFrom + 'T12:00:00Z')) / 86400000) + 1;
  return { ...selection, entries: visible.map(presentNutritionEntry), summary: summarizeNutrition(selected),
    recent7days: Array.from({ length: recentDays }, (_, index) => {
      const date = shiftDate(selection.recentFrom, index);
      return { date, summary: summarizeNutrition(entries.filter((entry) => entry.date === date)) };
    }),
  };
}

export function parseNutritionBatch(input: unknown, now: Date | number = Date.now()): NutritionInput[] {
  const raw = fields(input, ['entries']);
  if (!Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > 30) return fail('entries', '一次请保存 1 至 30 条食物记录。');
  return raw.entries.map((item) => parseNutritionCreate(item, now));
}
export function parseNutritionStatus(input: unknown, now: Date | number = Date.now()): NutritionDayStatusInput {
  const raw = fields(input, ['date', 'complete', 'meals', 'expectedRevision']);
  if (typeof raw.complete !== 'boolean') return fail('complete', '请明确选择当天记录是否完整。');
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) return fail('expectedRevision', '请重新读取当天记录状态。');
  const meals = fields(raw.meals, Object.keys(NUTRITION_MEALS));
  for (const meal of Object.keys(NUTRITION_MEALS)) if (!['unrecorded', 'recorded', 'skipped'].includes(meals[meal] as string)) return fail('meals.' + meal, '请选择已记录、未进食或尚未记录。');
  if (raw.complete && ['breakfast', 'lunch', 'dinner'].some((meal) => meals[meal] === 'unrecorded')) return fail('complete', '请先为早餐、午餐和晚餐补充记录或标记未进食。');
  return { date: date(raw.date, shanghaiDay(new Date(now).toISOString())), complete: raw.complete, meals: meals as Record<NutritionMeal, NutritionMealStatus>, expectedRevision: raw.expectedRevision as number };
}
