import { changeRecipeCooking } from '../../../../../../../../db/nutrition-recipes-store';
import { MAX_RECIPE_REQUEST_BYTES, parseRecipeArchive, parseRecipeCookingEdit } from '../../../../../../../../lib/nutrition-recipes';
import { nutritionBody, nutritionDatabase } from '../../../../_shared';
import { recipeId, recipeWrite } from '../../../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; cookingId: string }> };

export async function PATCH(request: Request, context: Context) {
  return recipeWrite(request, async (userId, operationId) => {
    const params = await context.params;
    const id = recipeId(params.id), cookingId = recipeId(params.cookingId);
    if (!id || !cookingId) return null;
    const { expectedRevision, ...input } = parseRecipeCookingEdit(await nutritionBody(request, MAX_RECIPE_REQUEST_BYTES));
    return changeRecipeCooking(nutritionDatabase(), userId, id, cookingId, operationId, expectedRevision, input);
  });
}

export async function DELETE(request: Request, context: Context) {
  return recipeWrite(request, async (userId, operationId) => {
    const params = await context.params;
    const id = recipeId(params.id), cookingId = recipeId(params.cookingId);
    if (!id || !cookingId) return null;
    const expectedRevision = parseRecipeArchive(await nutritionBody(request));
    return changeRecipeCooking(nutritionDatabase(), userId, id, cookingId, operationId, expectedRevision, null);
  });
}
