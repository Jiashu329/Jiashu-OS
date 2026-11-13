import { FOOD_CATALOG_CATEGORIES, FOOD_CATALOG_RELEASES, FOOD_CATALOG_SOURCE, FOOD_CATALOG_SOURCES, browseFoods, getFood } from '../../../../../lib/food-catalog';
import { foodCatalogImages } from '../../../../../lib/food-catalog-images';
import { apiUser, json, unauthenticated } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const params = new URL(request.url).searchParams;
  const invalid = (error = '请提交有效的食物关键词、分类或分页参数。') => json({ error, code: 'INVALID_FOOD_SEARCH' }, 400);
  const fields = ['q', 'category', 'offset', 'limit', 'id'];
  if ([...params.keys()].some((key) => !fields.includes(key) || params.getAll(key).length !== 1)) return invalid();
  // Discovery responses advertise current sources only. Historical releases are
  // deliberately not a public browse switch, but still validate saved records.
  const metadata = { source: FOOD_CATALOG_SOURCE, sources: FOOD_CATALOG_SOURCES,
    releases: FOOD_CATALOG_RELEASES.filter((release) => release.active), categories: FOOD_CATALOG_CATEGORIES };
  if (params.has('id')) {
    const id = params.get('id')!;
    if (params.size !== 1 || !id.trim() || id.length > 120) return invalid();
    const food = getFood(id);
    return food ? json({ food, ...metadata, images: foodCatalogImages([food]) })
      : json({ error: '当前食物库中没有这项食品。', code: 'FOOD_NOT_FOUND' }, 404);
  }
  const query = params.get('q') ?? '';
  if (query.length > 100) return invalid('食物关键词最多100个字符。');
  const rawOffset = params.get('offset'), rawLimit = params.get('limit');
  if ((rawOffset !== null && !/^(?:0|[1-9]\d*)$/.test(rawOffset))
    || (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit))) return invalid();
  const offset = rawOffset === null ? 0 : Number(rawOffset), limit = rawLimit === null ? 20 : Number(rawLimit);
  try {
    const result = browseFoods({ query, category: params.get('category') ?? '', offset, limit });
    return json({ ...result, ...metadata, images: foodCatalogImages(result.foods) });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : undefined);
  }
}
