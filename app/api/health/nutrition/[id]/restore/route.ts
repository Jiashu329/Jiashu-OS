import { restoreNutritionRevision } from '../../../../../../db/nutrition-store';
import { NutritionValidationError, presentNutritionEntry, validNutritionId } from '../../../../../../lib/nutrition';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { invalidNutritionRequestId, nutritionBody, nutritionDatabase, nutritionError, nutritionGuard, nutritionNotFound, nutritionRequestId } from '../../_shared';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard=nutritionGuard(request);if(guard)return guard;
  const {id}=await context.params;if(!validNutritionId(id))return nutritionNotFound();
  const operationId=nutritionRequestId(request);if(!operationId)return invalidNutritionRequestId();
  try {
    const raw=await nutritionBody(request);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some((key)=>!['revision','expectedRevision'].includes(key)))throw new NutritionValidationError([{path:'$',message:'请提交要恢复的版本和当前版本。'}]);
    const value=raw as Record<string,unknown>;
    if(!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<1)throw new NutritionValidationError([{path:'revision',message:'请先读取有效的历史版本和当前记录。'}]);
    const result=await restoreNutritionRevision(nutritionDatabase(),user.userId,id,Number(value.revision),Number(value.expectedRevision),operationId);
    return result?json({entry:presentNutritionEntry(result.entry),replayed:result.replayed}):nutritionNotFound();
  }catch(error){return nutritionError(error);}
}
