import { readNutritionHistory } from '../../../../../../db/nutrition-store';
import { validNutritionId } from '../../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { nutritionDatabase, nutritionError, nutritionNotFound } from '../../_shared';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const { id } = await context.params; if (!validNutritionId(id)) return nutritionNotFound();
  try {
    const history = await readNutritionHistory(nutritionDatabase(),user.userId,id);
    return history ? json({entryId:id.toLowerCase(),history}) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
