import { RecipeConflictError } from '../../../../../db/nutrition-recipes-store';
import { validNutritionId } from '../../../../../lib/nutrition';
import { NutritionPhotoImageError } from '../../../../../lib/nutrition-photo-image';
import { RecipeValidationError } from '../../../../../lib/nutrition-recipes';
import { apiUser, json, unauthenticated, unavailable } from '../../../_shared';
import { invalidNutritionRequestId, nutritionGuard, nutritionRequestId } from '../_shared';

export function recipeId(value: string) {
  return validNutritionId(value) ? value.toLowerCase() : null;
}

function notFound() {
  return json({ error: '找不到这份菜谱或制作记录。', code: 'RECIPE_NOT_FOUND' }, 404);
}

function recipeError(error: unknown) {
  if (error instanceof RecipeValidationError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof RecipeConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof NutritionPhotoImageError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof SyntaxError) return json({ error: '菜谱填写格式不正确。', code: 'INVALID_RECIPE' }, 400);
  if (error instanceof RangeError) return json({ error: '菜谱或照片过大，请缩小后重试。', code: 'RECIPE_REQUEST_TOO_LARGE' }, 413);
  return unavailable();
}

function recipeGuard(request: Request, userId: string) {
  const guard = nutritionGuard(request, false);
  if (guard) return guard;
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请通过网站或 App 提交 JSON 格式的菜谱。' }, 415);
  }
  const pageOwner = request.headers.get('x-page-owner');
  if (pageOwner && pageOwner !== userId) {
    return json({ error: '登录账号已变化，请重新打开菜谱后重试。', code: 'RECIPE_OWNER_CHANGED' }, 409);
  }
  return null;
}

export async function recipeRead(run: (userId: string) => Promise<object | null>, request?: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = request && recipeGuard(request, user.userId);
  if (guard) return guard;
  try {
    const result = await run(user.userId);
    return result ? json(result) : notFound();
  } catch (error) { return recipeError(error); }
}

export async function recipeWrite(request: Request, run: (userId: string, operationId: string) => Promise<object | null>) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = recipeGuard(request, user.userId);
  if (guard) return guard;
  const operationId = nutritionRequestId(request);
  if (!operationId) return invalidNutritionRequestId();
  try {
    const result = await run(user.userId, operationId);
    return result ? json(result) : notFound();
  } catch (error) { return recipeError(error); }
}
