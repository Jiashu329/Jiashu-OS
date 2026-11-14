import { FOOD_CATALOG_SOURCES } from '../../../../lib/food-catalog';
import { foodCatalogImages } from '../../../../lib/food-catalog-images';
import { browseUnifiedFoodLibrary, readFoodLibrarySnapshot, unifiedLibraryFood, FoodLibraryValidationError } from '../../../../lib/food-library-service';
import { apiUser, json, unauthenticated, unavailable } from '../../_shared';
import { nutritionDatabase } from '../nutrition/_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const params = new URL(request.url).searchParams;
  const invalid = (error = '请提交有效的食物关键词、品牌、分类或分页参数。') => json({ error, code: 'INVALID_FOOD_SEARCH' }, 400);
  const fields = ['q', 'category', 'brand', 'scope', 'offset', 'limit', 'id'];
  if ([...params.keys()].some((key) => !fields.includes(key) || params.getAll(key).length !== 1)) return invalid();
  if (params.has('id')) {
    const id = params.get('id')!;
    if (params.size !== 1 || !id.trim() || id.length > 120) return invalid();
    try {
      const snapshot = await readFoodLibrarySnapshot(nutritionDatabase(), user.userId, user.isOwner === true, id.startsWith('template:'));
      const food = unifiedLibraryFood(snapshot, id);
      if (!food) return json({ error: '当前食物库中没有这项食品，可能已更新或下架。', code: 'FOOD_NOT_FOUND' }, 404);
      const metadata = browseUnifiedFoodLibrary(snapshot, { limit: 1 });
      const images = foodCatalogImages([food]);
      if (food.basis === 'managed' && food.image) images[food.id] = food.image;
      return json({ food, sources: FOOD_CATALOG_SOURCES, brands: metadata.brands, categories: metadata.categories, canManage: snapshot.canManage, images });
    } catch { return unavailable(); }
  }
  const rawOffset = params.get('offset'), rawLimit = params.get('limit');
  if (rawOffset !== null && !/^(?:0|[1-9]\d*)$/.test(rawOffset) || rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) return invalid();
  try {
    const scope = params.get('scope') ?? 'all';
    if (!['all','public','mine'].includes(scope) || (params.get('q')?.length ?? 0) > 100) return invalid();
    const snapshot = await readFoodLibrarySnapshot(nutritionDatabase(), user.userId, user.isOwner === true, scope !== 'public');
    const result = browseUnifiedFoodLibrary(snapshot, { query: params.get('q') ?? '', category: params.get('category') ?? '', brand: params.get('brand') ?? '', scope,
      offset: rawOffset === null ? 0 : Number(rawOffset), limit: rawLimit === null ? 24 : Number(rawLimit) });
    return json(result);
  } catch (error) { return error instanceof FoodLibraryValidationError ? invalid(error.message) : unavailable(); }
}
