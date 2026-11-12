import { archiveNutritionTemplate, readNutritionTemplate, replaceNutritionTemplate } from '../../../../../../db/nutrition-templates-store';
import { parseNutritionTemplateEdit, parseNutritionTemplateRevision } from '../../../../../../lib/nutrition-templates';
import { validNutritionId } from '../../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound, nutritionRequestId } from '../../_shared';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const { id } = await context.params; if (!validNutritionId(id)) return nutritionNotFound();
  try { const template = await readNutritionTemplate(nutritionDatabase(), user.userId, id); return template ? json({ template }) : nutritionNotFound(); }
  catch (error) { return nutritionError(error); }
}
export async function PUT(request: Request, context: Context) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  const { id } = await context.params; if (!validNutritionId(id)) return nutritionNotFound();
  const operationId = nutritionRequestId(request); if (!operationId) return invalidNutritionRequestId();
  try {
    const { definition, expectedRevision } = parseNutritionTemplateEdit(await nutritionBody(request, 64 * 1024));
    const result = await replaceNutritionTemplate(nutritionDatabase(), user.userId, id, definition, expectedRevision, operationId);
    return result ? json(result) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
export async function DELETE(request: Request, context: Context) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = nutritionGuard(request); if (guard) return guard;
  const { id } = await context.params; if (!validNutritionId(id)) return nutritionNotFound();
  const operationId = nutritionRequestId(request); if (!operationId) return invalidNutritionRequestId();
  try {
    const expectedRevision = parseNutritionTemplateRevision(await nutritionBody(request));
    const result = await archiveNutritionTemplate(nutritionDatabase(), user.userId, id, expectedRevision, operationId);
    return result ? json(result) : nutritionNotFound();
  } catch (error) { return nutritionError(error); }
}
