import { listManagedFoodLibrary } from '../db/managed-food-store.ts';
import { listNutritionTemplates } from '../db/nutrition-templates-store.ts';
import type { NutritionDatabase } from '../db/nutrition-store.ts';
import { FOOD_CATALOG_SOURCES, browseFoods, type FoodItem } from './food-catalog.ts';
import { browseFoodLibrary, foodLibraryBrand, type LibraryFood } from './food-library-catalog.ts';
import { foodCatalogImages } from './food-catalog-images.ts';
import { personalLibraryFood } from './personal-food-library.ts';

export class FoodLibraryValidationError extends Error {}

export type FoodLibraryScope = 'all' | 'public' | 'mine';
export interface FoodLibrarySnapshot {
  publicFoods: LibraryFood[]; personalFoods: LibraryFood[];
  overrides: string[]; canManage: boolean;
}
const staticLibrary: LibraryFood[] = [];
for (let offset = 0; ; offset += 50) {
  const page = browseFoodLibrary({ offset, limit: 50 });
  staticLibrary.push(...page.foods);
  if (offset + 50 >= page.total) break;
}
export function libraryBrand(food: LibraryFood) {
  return 'brand' in food ? food.brand : { id: foodLibraryBrand(food), name: foodLibraryBrand(food) === 'luckin-cn' ? '瑞幸' : '麦当劳' };
}
export async function readFoodLibrarySnapshot(db: NutritionDatabase, userId: string, canManage = false, includePersonal = true): Promise<FoodLibrarySnapshot> {
  const [managed, templates] = await Promise.all([
    listManagedFoodLibrary(db), includePersonal ? listNutritionTemplates(db, userId) : Promise.resolve([]),
  ]);
  const excluded = new Set(managed.overrides);
  return { publicFoods: [...staticLibrary.filter((food) => !excluded.has(food.id)), ...managed.foods],
    personalFoods: templates.map((template) => personalLibraryFood(template)), overrides: managed.overrides, canManage };
}
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, '');
export function browseUnifiedFoodLibrary(snapshot: FoodLibrarySnapshot, options: { query?: string; brand?: string; category?: string; scope?: string; offset?: number; limit?: number } = {}) {
  const { query = '', brand = '', category = '', scope = 'all', offset = 0, limit = 24 } = options;
  if (!['all', 'public', 'mine'].includes(scope)) throw new FoodLibraryValidationError('请选择全部、公共或我的食物。');
  if (typeof query !== 'string' || query.length > 100) throw new FoodLibraryValidationError('食物关键词最多100个字符。');
  if (typeof brand !== 'string' || typeof category !== 'string' || category.length > 100) throw new FoodLibraryValidationError('请选择有效的品牌与分类。');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new FoodLibraryValidationError('请提交有效的食物分页参数。');
  const all = [...snapshot.publicFoods, ...snapshot.personalFoods];
  const selected = scope === 'public' ? snapshot.publicFoods : scope === 'mine' ? snapshot.personalFoods : all;
  const brandMap = new Map<string, { id: string; name: string; count: number }>();
  for (const food of selected) { const identity = libraryBrand(food); const old = brandMap.get(identity.id); brandMap.set(identity.id, { ...identity, count: (old?.count ?? 0) + 1 }); }
  const knownBrands = new Set(['mcd-cn', 'luckin-cn', 'mine', ...all.map((food) => libraryBrand(food).id)]);
  if (brand && !knownBrands.has(brand)) throw new FoodLibraryValidationError('请选择有效的品牌。');
  const effectiveBrand = !brand || brandMap.has(brand) ? brand : '';
  const brandFoods = selected.filter((food) => !effectiveBrand || libraryBrand(food).id === effectiveBrand);
  const categories = [...new Set(brandFoods.map((food) => food.category))].map((name) => ({ name, count: brandFoods.filter((food) => food.category === name).length }));
  if (category && effectiveBrand === brand && !['自建食物','食谱','整餐'].includes(category) && !all.some((food) => food.category === category)) throw new FoodLibraryValidationError('请选择有效的食品分类。');
  const effectiveCategory = effectiveBrand === brand && categories.some((item) => item.name === category) ? category : '';
  const effectiveOffset = effectiveBrand !== brand || effectiveCategory !== category ? 0 : offset;
  const needle = normalize(query);
  const matching = brandFoods.map((food, order) => {
    const name = normalize(food.name), aliases = [...food.aliases, ...('searchAliases' in food ? food.searchAliases ?? [] : [])].map(normalize);
    const rank = !needle || name === needle ? 0 : aliases.includes(needle) ? 1 : name.startsWith(needle) ? 2
      : aliases.some((alias) => alias.startsWith(needle)) ? 3 : name.includes(needle) ? 4
        : aliases.some((alias) => alias.includes(needle)) ? 5 : normalize(food.category).includes(needle) ? 6
          : normalize(food.description ?? '').includes(needle) ? 7 : 100;
    return { food, rank, order };
  }).filter((item) => item.rank < 100 && (!effectiveCategory || item.food.category === effectiveCategory)).sort((a, b) => a.rank - b.rank || a.order - b.order);
  const foods = matching.slice(effectiveOffset, effectiveOffset + limit).map((item) => item.food);
  const images = foodCatalogImages(foods);
  for (const food of foods) if (food.basis === 'managed' && food.image) images[food.id] = food.image;
  return { foods, total: matching.length, offset: effectiveOffset, limit, category: effectiveCategory, brand: effectiveBrand,
    scope: scope as FoodLibraryScope, brands: [...brandMap.values()], categories, images, sources: FOOD_CATALOG_SOURCES, canManage: snapshot.canManage };
}
export function unifiedLibraryFood(snapshot: FoodLibrarySnapshot, id: string): LibraryFood | null {
  return [...snapshot.publicFoods, ...snapshot.personalFoods].find((food) => food.id === id) ?? null;
}

/** Existing pending selections stay verifiable; fresh suggestions omit withdrawn public entries. */
export function currentNutritionFoods(excluded: readonly string[], query: string, limit = 20): FoodItem[] {
  const blocked = new Set(excluded), result: FoodItem[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = browseFoods({ query, offset, limit: 50 });
    result.push(...page.foods.filter((food) => !blocked.has(food.id)));
    if (result.length >= limit || offset + 50 >= page.total) break;
  }
  return result.slice(0, limit);
}
