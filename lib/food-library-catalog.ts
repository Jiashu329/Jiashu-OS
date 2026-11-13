import luckinRelease from '../data/food-catalog-releases/luckin-cn-2026-11-13-v1.json' with { type: 'json' };
import { browseFoods, getFood, type FoodItem, type FoodSource } from './food-catalog.ts';

/** Products without official energy are browsable, but never trusted nutrition selections. */
export interface CatalogOnlyProduct {
  basis: 'catalogOnly';
  id: string;
  name: string;
  aliases: string[];
  searchAliases?: string[];
  category: string;
  state: string;
  description?: string;
  source: FoodSource;
  reference: { label: string | null; protein?: number; fat?: number; carbs?: number; caffeineMg?: number };
  catalogRelease?: string;
}
export type LibraryFood = FoodItem | CatalogOnlyProduct;
export type FoodLibraryBrandId = 'mcd-cn' | 'luckin-cn';
export function foodLibraryBrand(food: { id: string }): FoodLibraryBrandId {
  return food.id.startsWith('luckin-cn:') ? 'luckin-cn' : 'mcd-cn';
}

const foods: LibraryFood[] = [];
for (let offset = 0; ; offset += 50) {
  const page = browseFoods({ offset, limit: 50 });
  foods.push(...page.foods);
  if (offset + 50 >= page.total) break;
}
const catalogOnly = luckinRelease.products as CatalogOnlyProduct[];
foods.push(...catalogOnly.map((food) => Object.freeze({ ...food,
  source: Object.freeze({ ...food.source }), reference: Object.freeze({ ...food.reference }),
  aliases: Object.freeze([...food.aliases]) as unknown as string[],
  searchAliases: Object.freeze([...(food.searchAliases ?? [])]) as unknown as string[] })));
const productsById = new Map(catalogOnly.map((food) => [food.id, foods.find((item) => item.id === food.id)!]));
export const FOOD_LIBRARY_BRANDS = Object.freeze([
  { id: 'mcd-cn', name: '麦当劳', count: foods.filter((food) => foodLibraryBrand(food) === 'mcd-cn').length },
  { id: 'luckin-cn', name: '瑞幸', count: foods.filter((food) => foodLibraryBrand(food) === 'luckin-cn').length },
].map((brand) => Object.freeze(brand)));
export const FOOD_LIBRARY_CATEGORIES = Object.freeze([...new Set(foods.map((food) => food.category))]
  .map((name) => Object.freeze({ name, count: foods.filter((food) => food.category === name).length })));
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, '');
const searchable = foods.map((food, order) => ({ food, order, name: normalize(food.name),
  aliases: [...food.aliases, ...(food.searchAliases ?? [])].map(normalize),
  category: normalize(food.category), description: normalize(food.description ?? '') }));

export function getLibraryFood(id: string): LibraryFood | null {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return getFood(key) ?? productsById.get(key) ?? null;
}
export interface FoodLibraryBrowseOptions { query?: string; category?: string; brand?: string; offset?: number; limit?: number }
export function browseFoodLibrary({ query = '', category = '', brand = '', offset = 0, limit = 24 }: FoodLibraryBrowseOptions = {}) {
  if (typeof query !== 'string' || query.length > 100) throw new Error('食物关键词最多100个字符。');
  if (typeof category !== 'string' || category && !FOOD_LIBRARY_CATEGORIES.some((item) => item.name === category)) throw new Error('请选择有效的食品分类。');
  if (typeof brand !== 'string' || brand && !FOOD_LIBRARY_BRANDS.some((item) => item.id === brand)) throw new Error('请选择有效的品牌。');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('请提交有效的食物分页参数。');
  const needle = normalize(query);
  const matching = searchable.map((item) => ({ ...item, rank: !needle || item.name === needle ? 0
    : item.aliases.includes(needle) ? 1 : item.name.startsWith(needle) ? 2
      : item.aliases.some((alias) => alias.startsWith(needle)) ? 3 : item.name.includes(needle) ? 4
        : item.aliases.some((alias) => alias.includes(needle)) ? 5 : item.category.includes(needle) ? 6
          : item.description.includes(needle) ? 7 : 100 }))
    .filter((item) => item.rank < 100 && (!category || item.food.category === category) && (!brand || foodLibraryBrand(item.food) === brand))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  return { foods: matching.slice(offset, offset + limit).map((item) => item.food), total: matching.length, offset, limit };
}
