import { addNutritionFavorite, listNutritionFavorites, removeNutritionFavorite } from '../../../../../db/nutrition-store';
import { validNutritionId } from '../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound } from '../_shared';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try { return json({ favorites: await listNutritionFavorites(nutritionDatabase(), user.userId) }); }
  catch (error) { return nutritionError(error); }
}
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request);
  if (guard) return guard;
  try {
    const raw = await nutritionBody(request);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'entryId') || !validNutritionId((raw as Record<string, unknown>).entryId)) return json({ error: '请选择一条有效食物记录加入常用。', code: 'INVALID_NUTRITION_FAVORITE' }, 400);
    const favorite = await addNutritionFavorite(nutritionDatabase(), user.userId, (raw as { entryId: string }).entryId);
    return favorite ? json({ favorite }) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
export async function DELETE(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = nutritionGuard(request, false);
  if (guard) return guard;
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!validNutritionId(id)) return nutritionNotFound();
    const deleted = await removeNutritionFavorite(nutritionDatabase(), user.userId, id);
    return deleted ? json({ deleted: true }) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
