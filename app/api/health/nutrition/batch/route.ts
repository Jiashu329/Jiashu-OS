import { createNutritionMeal } from '../../../../../db/nutrition-store';
import { parseNutritionMealCreate, presentNutritionEntry } from '../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionRequestId } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  const id = nutritionRequestId(request);
  if (!id) return invalidNutritionRequestId();
  try {
    const input = parseNutritionMealCreate(await nutritionBody(request));
    const result = await createNutritionMeal(nutritionDatabase(), user.userId, input.entries, id);
    return json({ date: input.date, meal: input.meal, entries: result.entries.map(presentNutritionEntry), replayed: result.replayed }, 201);
  } catch (error) { return nutritionError(error); }
}
