import { nutritionReuseOptions, saveNutritionFavorite } from '../../../../../db/nutrition-reuse-store';
import { parseNutritionFavorite } from '../../../../../lib/nutrition-reuse';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionRequestId } from '../_shared';

export const dynamic='force-dynamic';
export async function GET() { const user=await apiUser();if(!user)return unauthenticated();try{return json(await nutritionReuseOptions(nutritionDatabase(),user.userId));}catch(error){return nutritionError(error);} }
export async function POST(request:Request) {
  const user=await apiUser();if(!user)return unauthenticated();const guard=nutritionGuard(request);if(guard)return guard;
  const id=nutritionRequestId(request);if(!id)return invalidNutritionRequestId();
  try {const input=parseNutritionFavorite(await nutritionBody(request));return json(await saveNutritionFavorite(nutritionDatabase(),user.userId,input,id),201);}catch(error){return nutritionError(error);}
}
