import catalogData from '../data/food-catalog.json' with { type: 'json' };
import sourceData from '../data/food-catalog-source.json' with { type: 'json' };

export interface FoodSource { name: string; url: string; recordId: string; version: string }
export interface FoodItem {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  state: string;
  description?: string;
  kcalPer100g: number;
  proteinPer100g?: number;
  fatPer100g?: number;
  carbsPer100g?: number;
  source: FoodSource;
  portions: Array<{ unit: string; grams: number; label?: string; estimated: boolean }>;
}
export interface FoodSnapshot {
  foodId: string;
  foodName: string;
  amount: number;
  unit: string;
  grams: number;
  kcalPer100g: number;
  caloriesTenth: number;
  source: FoodSource;
  estimated: boolean;
}

export const FOOD_CATALOG_SOURCE = Object.freeze(sourceData);
const catalog = catalogData as FoodItem[];
const byId = new Map(catalog.map((food) => [food.id.toLowerCase(), food]));
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, '');
const searchable = catalog.map((food) => ({ food, name: normalize(food.name),
  aliases: food.aliases.map(normalize), category: normalize(food.category), description: normalize(food.description ?? '') }));
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

export function getFood(id: string): FoodItem | null {
  return typeof id === 'string' ? byId.get(id.trim().toLowerCase()) ?? null : null;
}

function fraction(value: number): { numerator: bigint; denominator: bigint } {
  const text = value.toString();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('数量或单位重量格式不正确。');
  const [whole, decimal = ''] = text.split('.');
  return { numerator: BigInt(whole + decimal), denominator: BigInt(10) ** BigInt(decimal.length) };
}

/** Calculate from the selected record, never from a model-supplied calorie. */
export function calculateFoodSelection(input: { id: string; amount: number; unit: string }): FoodSnapshot {
  const food = getFood(input?.id);
  if (!food) throw new Error('找不到这项食物，请重新从食物库选择。');
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0
    || !/^\d+(?:\.\d{1,3})?$/.test(input.amount.toString())) throw new Error('数量需大于0，最多保留3位小数。');
  if (typeof input.unit !== 'string' || input.unit.length > 30) throw new Error('请选择有效单位。');
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
  return { foodId: food.id, foodName: food.name, amount: input.amount, unit: portion?.unit ?? unit,
    grams, kcalPer100g: food.kcalPer100g, caloriesTenth, source: { ...food.source }, estimated: portion?.estimated ?? false };
}
