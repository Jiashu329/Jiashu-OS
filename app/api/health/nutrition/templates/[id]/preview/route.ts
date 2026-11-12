import { previewStoredNutritionTemplate } from '../../../../../../../db/nutrition-templates-store';
import { parseNutritionTemplatePreview } from '../../../../../../../lib/nutrition-templates';
import { validNutritionId } from '../../../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound } from '../../../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  const { id } = await context.params; if (!validNutritionId(id)) return nutritionNotFound();
  try {
    const input = parseNutritionTemplatePreview(await nutritionBody(request));
    const preview = await previewStoredNutritionTemplate(nutritionDatabase(), user.userId, id, input);
    return preview ? json({ preview }) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
