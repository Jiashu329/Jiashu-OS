import { createNutritionTemplate, listNutritionTemplates } from '../../../../../db/nutrition-templates-store';
import { parseNutritionTemplate } from '../../../../../lib/nutrition-templates';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionRequestId } from '../_shared';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  try { return json({ templates: await listNutritionTemplates(nutritionDatabase(), user.userId, new URL(request.url).searchParams.get('includeArchived') === '1') }); }
  catch (error) { return nutritionError(error); }
}
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  const id = nutritionRequestId(request); if (!id) return invalidNutritionRequestId();
  try {
    const definition = parseNutritionTemplate(await nutritionBody(request, 64 * 1024));
    return json(await createNutritionTemplate(nutritionDatabase(), user.userId, definition, id));
  } catch (error) { return nutritionError(error); }
}
