import { createRecipe, listRecipes, readRecipeBySource } from '../../../../../db/nutrition-recipes-store';
import { MAX_RECIPE_REQUEST_BYTES, parseRecipeCreation, parseRecipeLink, parseRecipeList } from '../../../../../lib/nutrition-recipes';
import { nutritionBody, nutritionDatabase } from '../_shared';
import { recipeRead, recipeWrite } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return recipeRead(async (userId) => {
    const query = new URL(request.url).searchParams;
    const sourceUrl = query.get('sourceUrl');
    if (sourceUrl === null) return listRecipes(nutritionDatabase(), userId, parseRecipeList(query));
    const recipe = await readRecipeBySource(nutritionDatabase(), userId, parseRecipeLink(sourceUrl).key);
    return recipe ? { recipe } : null;
  });
}

export async function POST(request: Request) {
  return recipeWrite(request, async (userId, operationId) => {
    const input = parseRecipeCreation(await nutritionBody(request, MAX_RECIPE_REQUEST_BYTES));
    return createRecipe(nutritionDatabase(), userId, input, operationId);
  });
}
