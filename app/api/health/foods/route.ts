import { FOOD_LIBRARY_BRANDS, FOOD_LIBRARY_CATEGORIES, browseFoodLibrary, foodLibraryCategories, getLibraryFood } from '../../../../lib/food-library-catalog';
import { FOOD_CATALOG_SOURCES } from '../../../../lib/food-catalog';
import { foodCatalogImages } from '../../../../lib/food-catalog-images';
import { apiUser, json, unauthenticated } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!await apiUser()) return unauthenticated();
  const params = new URL(request.url).searchParams;
  const invalid = (error = '请提交有效的食物关键词、品牌、分类或分页参数。') => json({ error, code: 'INVALID_FOOD_SEARCH' }, 400);
  const fields = ['q', 'category', 'brand', 'offset', 'limit', 'id'];
  if ([...params.keys()].some((key) => !fields.includes(key) || params.getAll(key).length !== 1)) return invalid();
  const metadata = { sources: FOOD_CATALOG_SOURCES, brands: FOOD_LIBRARY_BRANDS, categories: FOOD_LIBRARY_CATEGORIES };
  if (params.has('id')) {
    const id = params.get('id')!;
    if (params.size !== 1 || !id.trim() || id.length > 120) return invalid();
    const food = getLibraryFood(id);
    return food ? json({ food, ...metadata, images: foodCatalogImages([food]) })
      : json({ error: '当前食物库中没有这项食品。', code: 'FOOD_NOT_FOUND' }, 404);
  }
  const rawOffset = params.get('offset'), rawLimit = params.get('limit');
  if (rawOffset !== null && !/^(?:0|[1-9]\d*)$/.test(rawOffset) || rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) return invalid();
  try {
    const brand = params.get('brand') ?? '';
    const result = browseFoodLibrary({ query: params.get('q') ?? '', category: params.get('category') ?? '', brand,
      offset: rawOffset === null ? 0 : Number(rawOffset), limit: rawLimit === null ? 24 : Number(rawLimit) });
    return json({ ...result, ...metadata, categories: foodLibraryCategories(brand), images: foodCatalogImages(result.foods) });
  } catch (error) { return invalid(error instanceof Error ? error.message : undefined); }
}
