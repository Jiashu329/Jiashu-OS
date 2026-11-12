import { readNutritionRangeSnapshot } from '../../../../../db/nutrition-store';
import { buildNutritionInsight, parseNutritionInsightQuery } from '../../../../../lib/nutrition-review';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionDatabase, nutritionError } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const range = parseNutritionInsightQuery(new URL(request.url).searchParams);
    const db = nutritionDatabase();
    const { entries, statuses } = await readNutritionRangeSnapshot(db, user.userId, range);
    return json(buildNutritionInsight(entries, statuses, range));
  } catch (error) { return nutritionError(error); }
}
