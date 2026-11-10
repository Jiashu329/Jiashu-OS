import { readNutritionEntry, replaceNutritionEntry, setNutritionEntryDeleted } from '../../../../../db/nutrition-store';
import { parseNutritionPatch, presentNutritionEntry, validNutritionId } from '../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  if (!validNutritionId(id)) return nutritionNotFound();
  try {
    const entry = await readNutritionEntry(nutritionDatabase(), user.userId, id.toLowerCase());
    return entry ? json({ entry: presentNutritionEntry(entry) }) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  const { id } = await context.params;
  if (!validNutritionId(id)) return nutritionNotFound();
  try {
    const patch = parseNutritionPatch(await nutritionBody(request));
    const entry = patch.kind === 'edit'
      ? await replaceNutritionEntry(nutritionDatabase(), user.userId, id.toLowerCase(), patch.input, patch.expectedRevision)
      : await setNutritionEntryDeleted(nutritionDatabase(), user.userId, id.toLowerCase(), patch.deleted, patch.expectedRevision);
    return entry ? json({ entry: presentNutritionEntry(entry) }) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
