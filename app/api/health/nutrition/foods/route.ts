import { FOOD_CATALOG_RELEASES, FOOD_CATALOG_SOURCE, searchFoods } from '../../../../../lib/food-catalog';
import { apiUser, json, unauthenticated } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'q') || params.getAll('q').length > 1) {
    return json({ error: '请提交一个食物关键词。', code: 'INVALID_FOOD_SEARCH' }, 400);
  }
  const query = params.get('q') ?? '';
  if (query.length > 100) return json({ error: '食物关键词最多100个字符。', code: 'INVALID_FOOD_SEARCH' }, 400);
  return json({ foods: searchFoods(query), source: FOOD_CATALOG_SOURCE, releases: FOOD_CATALOG_RELEASES });
}
