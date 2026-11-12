import { calculateFoodSelection, foodSelectionFromSnapshot, getFood, type FoodItem, type FoodSelection } from './food-catalog.ts';
import { NutritionValidationError, parseNutritionCreate, type NutritionMeal, type NutritionProvenance } from './nutrition.ts';
import { NUTRIENT_KEYS, NUTRIENT_LABELS, nutrientDecimal, type NutritionNutrients } from './nutrition-nutrients.ts';

export type NutritionTemplateKind = 'food' | 'recipe' | 'meal';
export interface NutritionTemplateComponent {
  name: string; portion: string; grams: string | null;
  calories: string | null; carbs: string | null; protein: string | null; fat: string | null;
  provenance: NutritionProvenance; food?: FoodSelection;
}
export interface NutritionTemplateDefinition {
  kind: NutritionTemplateKind; name: string; note: string; baseServings: string; totalWeight: string | null;
  components: NutritionTemplateComponent[];
}
export interface NutritionTemplate extends NutritionTemplateDefinition {
  id: string; revision: number; createdAt: string; updatedAt: string; archivedAt: string | null;
}
export interface NutritionTemplateRow {
  date: string; meal: NutritionMeal; name: string; portion: string; note: string;
  calories: string | null; carbs: string | null; protein: string | null; fat: string | null;
  provenance: NutritionProvenance; food?: FoodSelection;
}
export interface NutritionTemplatePreviewInput {
  mode: 'servings' | 'weight'; amount: string; date: string; meal: NutritionMeal; expectedRevision: number;
}
export interface NutritionTemplatePreview {
  templateId: string; revision: number; rows: NutritionTemplateRow[]; nutrients: NutritionNutrients; foods: FoodItem[];
  scale: { mode: 'servings' | 'weight'; amount: string; baseAmount: string; ratio: string };
}
function fail(path: string, message: string): never { throw new NutritionValidationError([{ path, message }]); }
function object(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('$', '请提交完整的食物模板。');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return fail('$', '食物模板含不支持的字段。');
  return raw;
}
function text(value: unknown, key: string, max: number, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (key === 'note' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value) || value.trim().length > max || (!optional && !value.trim())) return fail(key, `请填写${optional ? '不超过' : '1–'}${max}字的${key === 'name' ? '名称' : key === 'note' ? '说明' : '份量'}。`);
  return value.trim();
}
function milli(value: unknown, path: string, nullable = false): bigint | null {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || value.length > 30 || !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return fail(path, '份数或重量需为大于0的普通数字，最多保留3位小数。');
  const [whole, fraction = ''] = value.trim().split('.');
  const result = BigInt(whole + fraction.padEnd(3, '0'));
  if (result <= BigInt(0) || result > BigInt(1000000000)) return fail(path, '份数或重量需大于0，且不超过1000000。');
  return result;
}
function decimalMilli(value: bigint): string {
  const digits = value.toString().padStart(4, '0');
  return (digits.slice(0, -3) + '.' + digits.slice(-3)).replace(/\.?0+$/, '');
}
function tenth(value: string) { return BigInt(value.replace('.', '')); }
function rounded(value: bigint, numerator: bigint, denominator: bigint) { return (value * numerator * BigInt(2) + denominator) / (denominator * BigInt(2)); }
function nutrientProvenance(component: NutritionTemplateComponent, numerator: bigint, denominator: bigint, portion: string): NutritionProvenance {
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const origin = component.provenance[key] ?? { source: 'unknown' as const };
    return [key, { ...origin, portion, ...(origin.originalValue === undefined ? {} : { originalValue: origin.originalValue === null ? null : nutrientDecimal(rounded(tenth(origin.originalValue), numerator, denominator)) }) }];
  }));
}
export function parseNutritionTemplate(input: unknown): NutritionTemplateDefinition {
  const raw = object(input, ['kind', 'name', 'note', 'baseServings', 'totalWeight', 'components']);
  if (!['food', 'recipe', 'meal'].includes(String(raw.kind))) return fail('kind', '请选择自建食物、食谱或整餐模板。');
  if (!Array.isArray(raw.components) || raw.components.length < 1 || raw.components.length > 30 || (raw.kind === 'food' && raw.components.length !== 1)) return fail('components', '自建食物需1项成分，食谱或整餐需1–30项成分。');
  const components = raw.components.map((value, index): NutritionTemplateComponent => {
    const item = object(value, ['name', 'portion', 'grams', 'calories', 'carbs', 'protein', 'fat', 'provenance', 'food']);
    const parsed = parseNutritionCreate({ date: '1970-01-01', meal: 'snack', name: item.name, portion: item.portion ?? '', note: '',
      ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, item[key] ?? null])), ...(item.food ? { food: item.food } : {}), ...(item.provenance ? { provenance: item.provenance } : {}) });
    const grams = milli(item.grams, `components.${index}.grams`, true);
    const normalized: NutritionTemplateComponent = { name: parsed.name, portion: parsed.portion, grams: grams === null ? null : decimalMilli(grams),
      calories: parsed.caloriesTenth === null ? null : nutrientDecimal(parsed.caloriesTenth),
      carbs: parsed.carbsTenth == null ? null : nutrientDecimal(parsed.carbsTenth), protein: parsed.proteinTenth == null ? null : nutrientDecimal(parsed.proteinTenth), fat: parsed.fatTenth == null ? null : nutrientDecimal(parsed.fatTenth),
      provenance: {}, ...(parsed.food ? { food: foodSelectionFromSnapshot(parsed.food) } : {}) };
    for (const key of NUTRIENT_KEYS) normalized.provenance[key] = parsed.provenance?.[key] ?? { source: 'unknown' };
    return normalized;
  });
  const servings = milli(raw.baseServings, 'baseServings')!;
  const weight = milli(raw.totalWeight, 'totalWeight', true);
  return { kind: raw.kind as NutritionTemplateKind, name: text(raw.name, 'name', 100), note: text(raw.note, 'note', 500, true), baseServings: decimalMilli(servings), totalWeight: weight === null ? null : decimalMilli(weight), components };
}
export function parseNutritionTemplateEdit(input: unknown) {
  const raw = object(input, ['kind', 'name', 'note', 'baseServings', 'totalWeight', 'components', 'expectedRevision']);
  const expectedRevision = parseNutritionTemplateRevision({ expectedRevision: raw.expectedRevision });
  const { expectedRevision: _, ...definition } = raw;
  return { definition: parseNutritionTemplate(definition), expectedRevision };
}
export function parseNutritionTemplateRevision(input: unknown): number {
  const raw = object(input, ['expectedRevision']);
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1) return fail('expectedRevision', '请先读取模板的最新版本。');
  return Number(raw.expectedRevision);
}
export function parseNutritionTemplatePreview(input: unknown): NutritionTemplatePreviewInput {
  const raw = object(input, ['mode', 'amount', 'date', 'meal', 'expectedRevision']);
  if (raw.mode !== 'servings' && raw.mode !== 'weight') return fail('mode', '请选择按份数或重量换算。');
  const base = parseNutritionCreate({ date: raw.date, meal: raw.meal, name: '模板预览', portion: '', calories: null, note: '' });
  return { mode: raw.mode, amount: decimalMilli(milli(raw.amount, 'amount')!), date: base.date, meal: base.meal, expectedRevision: parseNutritionTemplateRevision({ expectedRevision: raw.expectedRevision }) };
}
/** Preview is pure: it neither records meals nor updates the reusable definition. */
export function previewNutritionTemplate(template: NutritionTemplate, input: NutritionTemplatePreviewInput): NutritionTemplatePreview {
  if (template.archivedAt) return fail('template', '此模板已归档，请选择其他模板。');
  const numerator = milli(input.amount, 'amount')!;
  const baseAmount = input.mode === 'servings' ? template.baseServings : template.totalWeight;
  if (!baseAmount) return fail('totalWeight', '此模板尚未填写成品总重量，请按份数换算或先补充重量。');
  const denominator = milli(baseAmount, 'baseAmount')!;
  const foods = new Map<string, FoodItem>();
  const scaled: NutritionTemplateRow[] = template.components.map((component) => {
    const grams = component.grams === null ? null : rounded(milli(component.grams, 'grams')!, numerator, denominator);
    const portion = grams !== null ? decimalMilli(grams) + 'g' : `${component.portion || '基础份量'} × ${decimalMilli(numerator)} / ${baseAmount}`;
    const values = Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, component[key] === null ? null : nutrientDecimal(rounded(tenth(component[key]!), numerator, denominator))]));
    let food: FoodSelection | undefined;
    const provenance = nutrientProvenance(component, numerator, denominator, portion);
    if (component.food) {
      const amount = rounded(milli(String(component.food.amount), 'food.amount')!, numerator, denominator);
      if (amount === BigInt(0)) return fail('amount', '换算后的食物库份量小于0.001，请增加份数。');
      const selection = { ...component.food, amount: Number(decimalMilli(amount)) };
      let calculated;
      try { calculated = calculateFoodSelection(selection); }
      catch (error) { return fail('amount', error instanceof Error ? error.message : '食物库份量换算失败，请调整份量。'); }
      food = foodSelectionFromSnapshot(calculated);
      const item = getFood(food.id, food.catalogRelease);
      if (item) foods.set(food.catalogRelease + ':' + food.id, item);
      // Catalog values follow the captured release and rounded three-decimal selection.
      for (const key of NUTRIENT_KEYS) if (key === 'calories' || provenance[key]?.source === 'catalog') values[key] = calculated[`${key}Tenth`] == null ? null : nutrientDecimal(calculated[`${key}Tenth`]!);
    }
    const row = { date: input.date, meal: input.meal, name: component.name, portion, note: template.note, ...values, provenance, ...(food ? { food } : {}) } as NutritionTemplateRow;
    parseNutritionCreate(row); // enforce the same bounds and source rules as actual batch confirmation
    return row;
  });
  const nutrients = Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const known = scaled.filter((row) => row[key] !== null);
    return [key, { total: known.length ? nutrientDecimal(known.reduce((sum, row) => sum + tenth(row[key]!), BigInt(0))) : null, knownCount: known.length, unknownCount: scaled.length - known.length }];
  })) as NutritionNutrients;
  let rows = scaled;
  if (template.kind === 'recipe') {
    const portion = input.amount + (input.mode === 'servings' ? '份' : 'g');
    const values = Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, nutrients[key].unknownCount ? null : nutrients[key].total]));
    const provenance: NutritionProvenance = {};
    for (const key of NUTRIENT_KEYS) provenance[key] = { source: 'unknown', portion, basis: ('食谱「' + template.name + '」版本' + template.revision + '；' +
      (nutrients[key].unknownCount ? `${nutrients[key].unknownCount}项未知，合计留空；` : '') + '各成分' + NUTRIENT_LABELS[key] + '相加；' +
      scaled.map((row) => { const origin = row.provenance[key]; return row.name + ':' + (origin?.source ?? 'unknown') + (origin?.basis ? '（' + origin.basis + '）' : ''); }).join('、')).slice(0, 300) };
    const row = { date: input.date, meal: input.meal, name: template.name, portion, note: template.note, ...values, provenance } as NutritionTemplateRow;
    parseNutritionCreate(row);
    rows = [row];
  } else if (template.kind === 'food' && !rows[0].food) rows[0].name = template.name;
  return { templateId: template.id, revision: template.revision, rows, nutrients, foods: [...foods.values()],
    scale: { mode: input.mode, amount: input.amount, baseAmount, ratio: `${input.amount}/${baseAmount}` } };
}
