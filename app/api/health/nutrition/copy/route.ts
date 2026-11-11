import { copyNutritionMeal, previewNutritionCopy } from '../../../../../db/nutrition-reuse-store';
import { parseNutritionCopy } from '../../../../../lib/nutrition-reuse';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionRequestId } from '../_shared';

export const dynamic='force-dynamic';
export async function POST(request:Request) {
  const user=await apiUser();if(!user)return unauthenticated();const guard=nutritionGuard(request);if(guard)return guard;
  try {
    const command=parseNutritionCopy(await nutritionBody(request));
    if(command.action==='preview')return json({preview:await previewNutritionCopy(nutritionDatabase(),user.userId,command.selection)});
    const id=nutritionRequestId(request);if(!id)return invalidNutritionRequestId();
    return json({operationId:id,...await copyNutritionMeal(nutritionDatabase(),user.userId,command.selection,command.previewToken,id)},201);
  }catch(error){return nutritionError(error);}
}
