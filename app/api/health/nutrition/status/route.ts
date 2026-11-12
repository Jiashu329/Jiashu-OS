import { readNutritionDayStatus, writeNutritionDayStatus } from '../../../../../db/nutrition-store';
import { parseNutritionQuery, parseNutritionStatus } from '../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard } from '../_shared';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const selection = parseNutritionQuery(new URL(request.url).searchParams);
    return json({ dayStatus: await readNutritionDayStatus(nutritionDatabase(), user.userId, selection.date) });
  } catch (error) { return nutritionError(error); }
}
export async function PATCH(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  try {
    const input = parseNutritionStatus(await nutritionBody(request));
    return json({ dayStatus: await writeNutritionDayStatus(nutritionDatabase(), user.userId, input) });
  } catch (error) { return nutritionError(error); }
}
