import { readRecipePhoto } from '../../../../../../../../../db/nutrition-recipes-store';
import { nutritionDatabase } from '../../../../../_shared';
import { recipeId, recipeRead } from '../../../../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; cookingId: string }> };

export async function GET(_request: Request, context: Context) {
  return recipeRead(async (userId) => {
    const params = await context.params;
    const id = recipeId(params.id), cookingId = recipeId(params.cookingId);
    const photoDataUrl = id && cookingId ? await readRecipePhoto(nutritionDatabase(), userId, id, cookingId) : null;
    return photoDataUrl ? { photoDataUrl } : null;
  });
}
