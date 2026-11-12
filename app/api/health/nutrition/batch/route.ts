import { createNutritionBatch } from '../../../../../db/nutrition-store';
import { parseNutritionBatch, presentNutritionEntry } from '../../../../../lib/nutrition';
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
    const inputs = parseNutritionBatch(await nutritionBody(request, 64 * 1024));
    const result = await createNutritionBatch(nutritionDatabase(), user.userId, inputs, id);
    return json({ entries: result.entries.map(presentNutritionEntry), replayed: result.replayed }, 201);
  } catch (error) { return nutritionError(error); }
}
