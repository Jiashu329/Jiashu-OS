import { parseRecipePreview } from '../../../../../../lib/nutrition-recipes';
import { fetchRecipeLinkPreview } from '../../../../../../lib/recipe-link';
import { nutritionBody } from '../../_shared';
import { recipeRead } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return recipeRead(async () => ({ preview: await fetchRecipeLinkPreview(parseRecipePreview(await nutritionBody(request))) }), request);
}
