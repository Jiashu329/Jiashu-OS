import { createNutritionEntry, listNutritionEntries } from '../../../../db/nutrition-store';
import { buildNutritionReview, nutritionQuickFrom, parseNutritionCreate, parseNutritionQuery, presentNutritionEntry } from '../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionRequestId } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const selection = parseNutritionQuery(new URL(request.url).searchParams);
    const entries = await listNutritionEntries(nutritionDatabase(), user.userId, { from: nutritionQuickFrom(selection.date), to: selection.recentTo, includeDeleted: true });
    return json(buildNutritionReview(entries, selection));
  } catch (error) { return nutritionError(error); }
}

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  const id = nutritionRequestId(request);
  if (!id) return invalidNutritionRequestId();
  try {
    const input = parseNutritionCreate(await nutritionBody(request));
    const result = await createNutritionEntry(nutritionDatabase(), user.userId, input, id);
    return json({ entry: presentNutritionEntry(result.entry), replayed: result.replayed }, 201);
  } catch (error) { return nutritionError(error); }
}
