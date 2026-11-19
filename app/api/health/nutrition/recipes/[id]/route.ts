import { changeRecipe, readRecipe } from '../../../../../../db/nutrition-recipes-store';
import { parseRecipeArchive, parseRecipeEdit } from '../../../../../../lib/nutrition-recipes';
import { nutritionBody, nutritionDatabase } from '../../_shared';
import { recipeId, recipeRead, recipeWrite } from '../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  return recipeRead(async (userId) => {
    const id = recipeId((await context.params).id);
    const recipe = id ? await readRecipe(nutritionDatabase(), userId, id) : null;
    return recipe ? { recipe } : null;
  });
}

export async function PATCH(request: Request, context: Context) {
  return recipeWrite(request, async (userId, operationId) => {
    const id = recipeId((await context.params).id);
    if (!id) return null;
    const { expectedRevision, ...definition } = parseRecipeEdit(await nutritionBody(request, 64 * 1024));
    return changeRecipe(nutritionDatabase(), userId, id, operationId, expectedRevision, definition);
  });
}

export async function DELETE(request: Request, context: Context) {
  return recipeWrite(request, async (userId, operationId) => {
    const id = recipeId((await context.params).id);
    if (!id) return null;
    const expectedRevision = parseRecipeArchive(await nutritionBody(request));
    return changeRecipe(nutritionDatabase(), userId, id, operationId, expectedRevision, null);
  });
}
