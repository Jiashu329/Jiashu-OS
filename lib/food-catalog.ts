import catalogData from '../data/food-catalog.json' with { type: 'json' };
import sourceData from '../data/food-catalog-source.json' with { type: 'json' };
import releaseManifest from '../data/food-catalog-releases.json' with { type: 'json' };
import chineseRelease from '../data/food-catalog-releases/tfda-2024-03-29-cn2.json' with { type: 'json' };
import mcdRelease from '../data/food-catalog-releases/mcd-cn-2025-04-v1.json' with { type: 'json' };
import mcdSource from '../data/food-catalog-sources/mcd-cn-2025-04.json' with { type: 'json' };

export interface FoodSource { name: string; url: string; recordId: string; version: string }
interface FoodItemBase {
  /** Immutable application catalog release, distinct from the upstream source version. */
  catalogRelease?: string;
  id: string;
  name: string;
  aliases: string[];
  /** Broader discovery terms never used for automatic AI identity matching. */
  searchAliases?: string[];
  category: string;
  state: string;
  description?: string;
  proteinPer100g?: number;
  fatPer100g?: number;
  carbsPer100g?: number;
  source: FoodSource;
  portions: Array<{ unit: string; grams: number; label?: string; estimated: boolean }>;
}
export interface ServingNutrition {
  /** One portion is exactly this published product specification, never an assumed gram weight. */
  unit: '份';
  label: string;
  originalLabel: string | null;
  kcal: number;
  energyKj: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  sodiumMg?: number;
  calciumMg?: number;
}
export interface WeightFoodItem extends FoodItemBase {
  /** Existing released records intentionally retain their original field shape. */
  basis?: never;
  kcalPer100g: number;
  grams?: number;
}
export interface ServingFoodItem extends FoodItemBase {
  basis: 'perServing';
  kcalPer100g: null;
  grams: null;
  serving: ServingNutrition;
}
export type FoodItem = WeightFoodItem | ServingFoodItem;
interface FoodSnapshotBase {
  /** Missing on pre-versioning snapshots, which always belong to LEGACY_FOOD_CATALOG_RELEASE. */
  catalogRelease?: string;
  foodId: string;
  foodName: string;
  amount: number;
  unit: string;
  caloriesTenth: number;
  carbsPer100g?: number;
  proteinPer100g?: number;
  fatPer100g?: number;
  /** Grams for this serving, rounded to tenths; missing means the source has no value. */
  carbsTenth?: number;
  proteinTenth?: number;
  fatTenth?: number;
  source: FoodSource;
  estimated: boolean;
}
export interface WeightFoodSnapshot extends FoodSnapshotBase {
  basis?: never;
  grams: number;
  kcalPer100g: number;
}
export interface ServingFoodSnapshot extends FoodSnapshotBase {
  basis: 'perServing';
  grams: null;
  kcalPer100g: null;
  serving: ServingNutrition;
}
export type FoodSnapshot = WeightFoodSnapshot | ServingFoodSnapshot;

export function isServingFood(value: unknown): value is ServingFoodItem | ServingFoodSnapshot {
  return value !== null && typeof value === 'object' && (value as { basis?: unknown }).basis === 'perServing';
}

/** Presentation follows the published basis; a missing gram weight stays unknown. */
export function foodEnergyLabel(food: FoodItem | FoodSnapshot): string {
  return isServingFood(food) ? `每份 ${food.serving.kcal} kcal（${food.serving.label}）` : `每100g ${food.kcalPer100g} kcal`;
}

export interface FoodSelection { id: string; amount: number; unit: string; catalogRelease?: string }
export const LEGACY_FOOD_CATALOG_RELEASE = releaseManifest.legacy;
export const ACTIVE_FOOD_CATALOG_RELEASE = releaseManifest.active;
export const CHINESE_FOOD_CATALOG_RELEASE = chineseRelease.id;
export const MCD_FOOD_CATALOG_RELEASE = mcdRelease.id;
export const FOOD_CATALOG_RELEASES = Object.freeze(releaseManifest.releases.map((release) => Object.freeze({ ...release,
  sourceVersion: release.id === MCD_FOOD_CATALOG_RELEASE ? `${sourceData.version}；${mcdSource.version}` : sourceData.version,
  sourceSnapshotDate: release.id === MCD_FOOD_CATALOG_RELEASE ? mcdSource.snapshotDate : sourceData.snapshotDate,
  active: release.id === ACTIVE_FOOD_CATALOG_RELEASE })));
export const FOOD_CATALOG_SOURCE = Object.freeze({ ...sourceData, catalogRelease: ACTIVE_FOOD_CATALOG_RELEASE,
  catalogVersion: chineseRelease.label, catalogUpdatedAt: chineseRelease.publishedAt,
  description: sourceData.description + chineseRelease.description });
/** Separate attributions prevent the TFDA open-data license being applied to brand material. */
export const FOOD_CATALOG_SOURCES = Object.freeze([FOOD_CATALOG_SOURCE,
  Object.freeze({ ...mcdSource, catalogRelease: MCD_FOOD_CATALOG_RELEASE })]);
function freezeFood(food: FoodItem): FoodItem {
  return Object.freeze({ ...food, source: Object.freeze({ ...food.source }),
    ...(isServingFood(food) ? { serving: Object.freeze({ ...food.serving }) } : {}),
    aliases: Object.freeze([...food.aliases]) as unknown as string[],
    ...(food.searchAliases ? { searchAliases: Object.freeze([...food.searchAliases]) as unknown as string[] } : {}),
    portions: Object.freeze(food.portions.map((portion) => Object.freeze({ ...portion }))) as unknown as FoodItem['portions'] });
}
const baseline = (catalogData as FoodItem[]).map((food) => freezeFood({ ...food, catalogRelease: LEGACY_FOOD_CATALOG_RELEASE }));
const additions = chineseRelease.aliases as Record<string, string[]>;
const referenceFoods = new Set(chineseRelease.referencePortionFoodIds);
const chineseCatalog: FoodItem[] = baseline.map((food) => freezeFood({ ...food, catalogRelease: CHINESE_FOOD_CATALOG_RELEASE,
  searchAliases: additions[food.id] ?? [],
  portions: [...food.portions, ...(referenceFoods.has(food.id) ? chineseRelease.referencePortions : [])] }));
const catalog: FoodItem[] = [
  ...chineseCatalog.map((food) => freezeFood({ ...food, catalogRelease: MCD_FOOD_CATALOG_RELEASE })),
  ...(mcdRelease.foods as ServingFoodItem[]).map((food) => freezeFood({ ...food, catalogRelease: MCD_FOOD_CATALOG_RELEASE })),
];
const releases = new Map<string, Map<string, FoodItem>>([
  [LEGACY_FOOD_CATALOG_RELEASE, new Map(baseline.map((food) => [food.id.toLowerCase(), food]))],
  [CHINESE_FOOD_CATALOG_RELEASE, new Map(chineseCatalog.map((food) => [food.id.toLowerCase(), food]))],
  [MCD_FOOD_CATALOG_RELEASE, new Map(catalog.map((food) => [food.id.toLowerCase(), food]))],
]);
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, '');
const searchable = catalog.map((food) => ({ food, name: normalize(food.name),
  aliases: [...food.aliases, ...(food.searchAliases ?? [])].map(normalize), category: normalize(food.category), description: normalize(food.description ?? '') }));
const commonFoods = ['白饭', '鸡蛋(白壳)', '全脂鲜乳平均值', '香蕉', '富士苹果', '传统豆腐', '青花菜', '鸡胸肉', '燕麦片'];

/** Bounded, offline lookup; food states remain separate records. */
export function searchFoods(query: string, limit = 20): FoodItem[] {
  if (typeof query !== 'string' || query.length > 100) throw new Error('食物关键词最多100个字符。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('每次可返回1至50项食物。');
  const needle = normalize(query);
  if (!needle) {
    return [...catalog].sort((a, b) => {
      const ai = commonFoods.indexOf(a.name), bi = commonFoods.indexOf(b.name);
      return (ai < 0 ? commonFoods.length : ai) - (bi < 0 ? commonFoods.length : bi);
    }).slice(0, limit);
  }
  return searchable.map((item, order) => {
    const { name, aliases, category, description } = item;
    const rank = name === needle ? 0 : aliases.includes(needle) ? 1 : name.startsWith(needle) ? 2
      : aliases.some((value) => value.startsWith(needle)) ? 3 : name.includes(needle) ? 4
        : aliases.some((value) => value.includes(needle)) ? 5 : category.includes(needle) ? 6 : description.includes(needle) ? 7 : 100;
    return { food: item.food, rank, order };
  }).filter((item) => item.rank < 100).sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit).map((item) => item.food);
}

export function getFood(id: string, catalogRelease = ACTIVE_FOOD_CATALOG_RELEASE): FoodItem | null {
  return typeof id === 'string' ? releases.get(catalogRelease)?.get(id.trim().toLowerCase()) ?? null : null;
}

function fraction(value: number): { numerator: bigint; denominator: bigint } {
  const text = value.toString();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('数量或单位重量格式不正确。');
  const [whole, decimal = ''] = text.split('.');
  return { numerator: BigInt(whole + decimal), denominator: BigInt(10) ** BigInt(decimal.length) };
}

function scaledServingTenth(amount: number, value: number): number {
  const quantity = fraction(amount), nutrient = fraction(value);
  const numerator = quantity.numerator * nutrient.numerator * BigInt(10);
  const denominator = quantity.denominator * nutrient.denominator;
  const result = Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
  if (!Number.isSafeInteger(result) || result > 200000) throw new Error('这份食物的热量或营养素超出支持范围，请核对份数。');
  return result;
}

function calculateServingFood(food: ServingFoodItem, amount: number, unit: string, catalogRelease: string): ServingFoodSnapshot {
  if (unit !== food.serving.unit) throw new Error('此食物仅公布官方规格每份营养，请按份数记录；没有克重或毫升换算依据。');
  if (amount > 1000) throw new Error('单项食物最多记录1,000份，请核对份数。');
  const serving = food.serving;
  if (serving.unit !== '份' || !serving.label || !Number.isFinite(serving.energyKj) || serving.energyKj < 0
    || !Number.isInteger(serving.kcal) || serving.kcal < 0 || serving.kcal !== Math.round(serving.energyKj / 4.184)) {
    throw new Error('食物库官方每份营养数据格式不正确，请重新选择食物。');
  }
  const macros: { carbsTenth?: number; proteinTenth?: number; fatTenth?: number } = {};
  for (const key of ['carbs', 'protein', 'fat'] as const) {
    const value = serving[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error('食物库官方每份营养数据格式不正确，请重新选择食物。');
    macros[`${key}Tenth`] = scaledServingTenth(amount, value);
  }
  return { basis: 'perServing', catalogRelease, foodId: food.id, foodName: food.name, amount, unit: serving.unit,
    grams: null, kcalPer100g: null, serving: { ...serving }, caloriesTenth: scaledServingTenth(amount, serving.kcal),
    ...macros, source: { ...food.source }, estimated: false };
}

/** Calculate from the selected record, never from a model-supplied calorie. */
export function calculateFoodSelection(input: FoodSelection): FoodSnapshot {
  // Old queued request bodies must keep the same source forever. New search and
  // parser selections always send their explicit application catalog release.
  const catalogRelease = input?.catalogRelease ?? LEGACY_FOOD_CATALOG_RELEASE;
  if (typeof catalogRelease !== 'string' || !releases.has(catalogRelease)) throw new Error('找不到这版食物库，请保留原始来源或重新选择当前食物。');
  const food = getFood(input?.id, catalogRelease);
  if (!food) throw new Error('找不到这项食物，请重新从食物库选择。');
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0
    || !/^\d+(?:\.\d{1,3})?$/.test(input.amount.toString())) throw new Error('数量需大于0，最多保留3位小数。');
  if (typeof input.unit !== 'string' || input.unit.length > 30) throw new Error('请选择有效单位。');
  if (isServingFood(food)) return calculateServingFood(food, input.amount, input.unit, catalogRelease);
  const requested = normalize(input.unit);
  const unit = ['g', '克', '公克'].includes(requested) ? 'g' : ['kg', '千克', '公斤'].includes(requested) ? 'kg' : requested;
  const portion = food.portions.find((item) => normalize(item.unit) === unit);
  const weight = unit === 'g' ? 1 : unit === 'kg' ? 1000 : portion?.grams;
  if (weight === undefined) throw new Error('这项食物没有该单位的可靠克重，请改填克（g）或选择来源参考单位。');
  const amountFraction = fraction(input.amount), weightFraction = fraction(weight), energyFraction = fraction(food.kcalPer100g);
  const gramsNumerator = amountFraction.numerator * weightFraction.numerator;
  const gramsDenominator = amountFraction.denominator * weightFraction.denominator;
  const grams = Number(gramsNumerator) / Number(gramsDenominator);
  if (!Number.isFinite(grams) || grams <= 0 || grams > 20000) throw new Error('单项食物重量需大于0且不超过20,000g。');
  const numerator = gramsNumerator * energyFraction.numerator * BigInt(10);
  const denominator = gramsDenominator * energyFraction.denominator * BigInt(100);
  // Integer half-up rounding keeps decimal portions stable at 0.1 kcal.
  const caloriesTenth = Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
  if (!Number.isSafeInteger(caloriesTenth) || caloriesTenth > 200000) throw new Error('这份食物总热量不能超过20,000 kcal。');
  const macroTenth = (per100g: number | undefined): number | undefined => {
    if (per100g === undefined) return undefined;
    if (!Number.isFinite(per100g) || per100g < 0) throw new Error('食物库营养数据格式不正确，请重新选择食物。');
    const nutrient = fraction(per100g);
    const numerator = gramsNumerator * nutrient.numerator * BigInt(10);
    const denominator = gramsDenominator * nutrient.denominator * BigInt(100);
    const result = Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
    if (!Number.isSafeInteger(result) || result > 200000) throw new Error('这份食物的营养素不能超过20,000g。');
    return result;
  };
  const carbsTenth = macroTenth(food.carbsPer100g), proteinTenth = macroTenth(food.proteinPer100g), fatTenth = macroTenth(food.fatPer100g);
  return { catalogRelease, foodId: food.id, foodName: food.name, amount: input.amount, unit: portion?.unit ?? unit,
    grams, kcalPer100g: food.kcalPer100g, caloriesTenth,
    ...(carbsTenth !== undefined ? { carbsPer100g: food.carbsPer100g, carbsTenth } : {}),
    ...(proteinTenth !== undefined ? { proteinPer100g: food.proteinPer100g, proteinTenth } : {}),
    ...(fatTenth !== undefined ? { fatPer100g: food.fatPer100g, fatTenth } : {}),
    source: { ...food.source }, estimated: portion?.estimated ?? false };
}

/** A persisted snapshot can only claim values present in its immutable release.
 * Old snapshots may omit macros added later, but supplied values must match.
 * Return the original shape: adding fields would change historical fingerprints.
 */
export function validateFoodSnapshot(value: unknown): FoodSnapshot {
  const fail = (): never => { throw new Error('食物来源、版本、克重或营养值与可信食物库不一致。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (raw.basis === 'perServing') {
    const required = ['basis', 'catalogRelease', 'foodId', 'foodName', 'amount', 'unit', 'grams', 'kcalPer100g', 'caloriesTenth', 'serving', 'source', 'estimated'];
    const optional = ['carbsTenth', 'proteinTenth', 'fatTenth'];
    if (required.some((key) => !Object.hasOwn(raw, key)) || Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
      || typeof raw.foodId !== 'string' || typeof raw.amount !== 'number' || typeof raw.unit !== 'string'
      || typeof raw.catalogRelease !== 'string' || raw.catalogRelease.length > 100) return fail();
    const trusted = calculateFoodSelection({ id: raw.foodId, amount: raw.amount, unit: raw.unit, catalogRelease: raw.catalogRelease });
    if (!isServingFood(trusted)) return fail();
    for (const key of [...required.filter((key) => key !== 'source' && key !== 'serving'), ...optional.filter((key) => Object.hasOwn(raw, key))]) {
      if (raw[key] !== (trusted as unknown as Record<string, unknown>)[key]) return fail();
    }
    const sameObject = (candidate: unknown, expected: object) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      && Object.keys(candidate).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, expectedValue]) => (candidate as Record<string, unknown>)[key] === expectedValue);
    if (!sameObject(raw.serving, trusted.serving) || !sameObject(raw.source, trusted.source)) return fail();
    // Preserve the original optional macro shape and ordering for restore/replay identities.
    return { ...raw, serving: { ...raw.serving as ServingNutrition }, source: { ...trusted.source } } as unknown as ServingFoodSnapshot;
  }
  const required = ['foodId', 'foodName', 'amount', 'unit', 'grams', 'kcalPer100g', 'caloriesTenth', 'source', 'estimated'];
  const optional = ['catalogRelease', 'carbsPer100g', 'proteinPer100g', 'fatPer100g', 'carbsTenth', 'proteinTenth', 'fatTenth'];
  if (required.some((key) => !Object.hasOwn(raw, key)) || Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))) return fail();
  if (typeof raw.foodId !== 'string' || typeof raw.amount !== 'number' || typeof raw.unit !== 'string'
    || (Object.hasOwn(raw, 'catalogRelease') && (typeof raw.catalogRelease !== 'string' || raw.catalogRelease.length > 100))) return fail();
  const trusted = calculateFoodSelection({ id: raw.foodId, amount: raw.amount, unit: raw.unit,
    ...(Object.hasOwn(raw, 'catalogRelease') ? { catalogRelease: raw.catalogRelease as string } : {}) });
  for (const key of [...required.filter((key) => key !== 'source'), ...optional.filter((key) => Object.hasOwn(raw, key))]) {
    if (raw[key] !== (trusted as unknown as Record<string, unknown>)[key]) return fail();
  }
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) return fail();
  const source = raw.source as Record<string, unknown>;
  const sourceKeys = ['name', 'url', 'recordId', 'version'] as const;
  if (Object.keys(source).length !== sourceKeys.length || sourceKeys.some((key) => source[key] !== trusted.source[key])) return fail();
  return { ...raw, source: { ...trusted.source } } as unknown as FoodSnapshot;
}

/** Rescaling an old entry retains its original source; selecting a search result is an explicit refresh. */
export function foodSelectionFromSnapshot(value: FoodSnapshot): FoodSelection {
  const snapshot = validateFoodSnapshot(value);
  return { id: snapshot.foodId, amount: snapshot.amount, unit: snapshot.unit,
    catalogRelease: snapshot.catalogRelease ?? LEGACY_FOOD_CATALOG_RELEASE };
}
