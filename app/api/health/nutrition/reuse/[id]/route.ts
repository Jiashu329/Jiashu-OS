import { removeNutritionFavorite } from '../../../../../../db/nutrition-reuse-store';
import { parseNutritionFavoriteRemove } from '../../../../../../lib/nutrition-reuse';
import { validNutritionId } from '../../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound } from '../../_shared';

export const dynamic='force-dynamic';
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}) {
  const user=await apiUser();if(!user)return unauthenticated();const guard=nutritionGuard(request);if(guard)return guard;
  const {id}=await context.params;if(!validNutritionId(id))return nutritionNotFound();
  try{const revision=parseNutritionFavoriteRemove(await nutritionBody(request));return json({favorite:await removeNutritionFavorite(nutritionDatabase(),user.userId,id.toLowerCase(),revision)});}catch(error){return nutritionError(error);}
}
