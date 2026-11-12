import { normalizeTimestamp, shanghaiDay } from './health.ts';

export const NUTRITION_MEALS = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
} as const;
export type NutritionMeal = keyof typeof NUTRITION_MEALS;
export interface NutritionInput {
  date: string;
  meal: NutritionMeal;
  name: string;
  portion: string;
  note: string;
  caloriesTenth: number | null;
}
export interface NutritionEntry extends NutritionInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface NutritionEntryView extends NutritionEntry { calories: string | null; deleted: boolean }
export interface NutritionMealSummary {
  meal: NutritionMeal;
  label: string;
  entryCount: number;
  knownCount: number;
  unknownCount: number;
  knownCalories: string | null;
}
export interface NutritionSummary {
  entryCount: number;
  knownCount: number;
  unknownCount: number;
  knownCalories: string | null;
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
  quickEntry: NutritionQuickEntry;
}
export interface NutritionSuggestion extends NutritionEntryView { uses: number }
export interface NutritionQuickEntry {
  from: string;
  previousDate: string | null;
  previousMeals: Array<{ meal: NutritionMeal; label: string; entries: NutritionEntryView[] }>;
  recent: NutritionSuggestion[];
  frequent: NutritionSuggestion[];
}
export interface NutritionMealInput { date: string; meal: NutritionMeal; entries: NutritionInput[] }
export const MAX_NUTRITION_MEAL_ENTRIES = 40;
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
  const raw = fields(input, ['date', 'meal', 'name', 'portion', 'calories', 'note']);
  if (typeof raw.meal !== 'string' || !Object.hasOwn(NUTRITION_MEALS, raw.meal)) return fail('meal', '请选择早餐、午餐、晚餐或加餐。');
  return {
    date: date(raw.date, shanghaiDay(new Date(now).toISOString())), meal: raw.meal as NutritionMeal,
    name: text(raw.name, 'name', 100), portion: text(raw.portion, 'portion', 100, true),
    note: text(raw.note, 'note', 500, true), caloriesTenth: calories(raw.calories),
  };
}
/** An explicit, editable snapshot of a whole meal; all rows share the selected date and meal. */
export function parseNutritionMealCreate(input: unknown, now: Date | number = Date.now()): NutritionMealInput {
  const raw = fields(input, ['date', 'meal', 'entries']);
  const selectedDate = date(raw.date, shanghaiDay(new Date(now).toISOString()));
  if (typeof raw.meal !== 'string' || !Object.hasOwn(NUTRITION_MEALS, raw.meal)) return fail('meal', '请选择早餐、午餐、晚餐或加餐。');
  if (!Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > MAX_NUTRITION_MEAL_ENTRIES) return fail('entries', '每次整餐保存需包含 1–40 项食物；记录较多时请分次添加。');
  const meal = raw.meal as NutritionMeal;
  const entries = raw.entries.map((item, index) => {
    const row = fields(item, ['name', 'portion', 'calories', 'note']);
    try { return parseNutritionCreate({ ...row, date: selectedDate, meal }, now); }
    catch (error) {
      if (error instanceof NutritionValidationError) throw new NutritionValidationError(error.issues.map((issue) => ({ ...issue, path: `entries[${index}].${issue.path}` })));
      throw error;
    }
  });
  return { date: selectedDate, meal, entries };
}
export function parseNutritionPatch(input: unknown, now: Date | number = Date.now()): NutritionPatch {
  const raw = fields(input, ['date', 'meal', 'name', 'portion', 'calories', 'note', 'deleted', 'expectedRevision']);
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
export function parseNutritionQuery(params: URLSearchParams, now: Date | number = Date.now()): NutritionQuery {
  const today = shanghaiDay(new Date(now).toISOString());
  const selected = date(params.get('date') ?? today, today);
  const first = shiftDate(selected, -6);
  return { date: selected, today, includeDeleted: params.get('includeDeleted') === '1', recentFrom: first < '1970-01-01' ? '1970-01-01' : first, recentTo: selected };
}
export function presentNutritionEntry(entry: NutritionEntry): NutritionEntryView {
  return { ...entry, calories: entry.caloriesTenth === null ? null : decimal(BigInt(entry.caloriesTenth)), deleted: entry.deletedAt !== null };
}
export function nutritionQuickFrom(selectedDate: string): string {
  const from = shiftDate(selectedDate, -29);
  return from < '1970-01-01' ? '1970-01-01' : from;
}
/** Reuse only active, observed portions. A different calorie value stays a different suggestion. */
export function buildNutritionQuickEntry(entries: readonly NutritionEntry[], selectedDate: string): NutritionQuickEntry {
  const from = nutritionQuickFrom(selectedDate);
  const active = entries.filter((row) => row.deletedAt === null && row.date >= from && row.date <= selectedDate)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const groups = new Map<string, NutritionSuggestion>();
  for (const row of active) {
    const key = JSON.stringify([row.name, row.portion, row.caloriesTenth]);
    const existing = groups.get(key);
    if (existing) existing.uses++;
    else groups.set(key, { ...presentNutritionEntry(row), uses: 1 });
  }
  const recent = [...groups.values()];
  const previousDate = selectedDate > '1970-01-01' ? shiftDate(selectedDate, -1) : null;
  return {
    from, previousDate,
    previousMeals: (Object.keys(NUTRITION_MEALS) as NutritionMeal[]).map((meal) => ({ meal, label: NUTRITION_MEALS[meal],
      entries: active.filter((row) => row.date === previousDate && row.meal === meal)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(presentNutritionEntry),
    })),
    recent: recent.slice(0, 6),
    frequent: [...recent].filter((row) => row.uses >= 2).sort((a, b) => b.uses - a.uses || b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 6),
  };
}
export function summarizeNutrition(entries: readonly NutritionEntry[]): NutritionSummary {
  const active = entries.filter((entry) => entry.deletedAt === null);
  const sum = (rows: readonly NutritionEntry[]) => {
    const known = rows.filter((entry) => entry.caloriesTenth !== null);
    const total = known.reduce((value, entry) => value + BigInt(entry.caloriesTenth!), BigInt(0));
    return { entryCount: rows.length, knownCount: known.length, unknownCount: rows.length - known.length,
      knownCalories: known.length ? decimal(total) : null };
  };
  return { ...sum(active), meals: (Object.keys(NUTRITION_MEALS) as NutritionMeal[]).map((meal) => ({
    meal, label: NUTRITION_MEALS[meal], ...sum(active.filter((entry) => entry.meal === meal)),
  })) };
}
export function buildNutritionReview(entries: readonly NutritionEntry[], selection: NutritionQuery): NutritionReview {
  const selected = entries.filter((entry) => entry.date === selection.date);
  const order = Object.keys(NUTRITION_MEALS);
  const visible = selected.filter((entry) => selection.includeDeleted || entry.deletedAt === null)
    .sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const recentDays = Math.round((Date.parse(selection.recentTo + 'T12:00:00Z') - Date.parse(selection.recentFrom + 'T12:00:00Z')) / 86400000) + 1;
  return { ...selection, entries: visible.map(presentNutritionEntry), summary: summarizeNutrition(selected), quickEntry: buildNutritionQuickEntry(entries, selection.date),
    recent7days: Array.from({ length: recentDays }, (_, index) => {
      const date = shiftDate(selection.recentFrom, index);
      return { date, summary: summarizeNutrition(entries.filter((entry) => entry.date === date)) };
    }),
  };
}
