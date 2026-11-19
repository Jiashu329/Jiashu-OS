import { addRecipeCooking } from '../../../../../../../db/nutrition-recipes-store';
import { MAX_RECIPE_REQUEST_BYTES, parseRecipeCooking } from '../../../../../../../lib/nutrition-recipes';
import { nutritionBody, nutritionDatabase } from '../../../_shared';
import { recipeId, recipeWrite } from '../../_shared';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return recipeWrite(request, async (userId, operationId) => {
    const id = recipeId((await context.params).id);
    if (!id) return null;
    const input = parseRecipeCooking(await nutritionBody(request, MAX_RECIPE_REQUEST_BYTES));
    return addRecipeCooking(nutritionDatabase(), userId, id, operationId, input);
  });
}
