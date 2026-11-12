import { env } from 'cloudflare:workers';
import { readHealth } from '../../../../../db/health-repository';
import { readWeightCycleState, readWeightCycles, writeWeightCycle } from '../../../../../db/weight-cycles-store';
import { WeightPlanConflictError, readWeightPlanSettings } from '../../../../../db/weight-plan-store';
import { buildWeightPlanReview, WeightPlanValidationError } from '../../../../../lib/weight-plan';
import { parseWeightCycleCommand } from '../../../../../lib/weight-cycles';
import { apiUser, invalidOrigin, isSameOrigin, json, unauthenticated, unavailable } from '../../../_shared';

export const dynamic='force-dynamic';
function database(){if(!env.DB)throw new Error('Health database unavailable');return env.DB;}
function failed(error:unknown){
  if(error instanceof WeightPlanConflictError)return json({error:error.message,code:error.code},409);
  if(error instanceof WeightPlanValidationError)return json({error:error.message,code:error.code,issues:error.issues},400);
  if(error instanceof SyntaxError)return json({error:'周期操作格式无效。',code:'INVALID_WEIGHT_PLAN'},400);
  if(error instanceof RangeError)return json({error:'周期操作不能超过2 KB。',code:'WEIGHT_PLAN_TOO_LARGE'},413);
  return unavailable();
}
export async function GET(request:Request){
  const user=await apiUser();if(!user)return unauthenticated();
  try{const raw=new URL(request.url).searchParams.get('offset')??'0';if(!/^\d{1,6}$/.test(raw))return json({error:'周期分页位置无效。',code:'INVALID_WEIGHT_PLAN'},400);return json({cycles:await readWeightCycles(database(),user.userId,Number(raw))});}catch(error){return failed(error);}
}
export async function POST(request:Request){
  const user=await apiUser();if(!user)return unauthenticated();if(!isSameOrigin(request))return invalidOrigin();
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'请提交JSON周期操作。'},415);
  const id=request.headers.get('Idempotency-Key')??'';if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return json({error:'请保留原操作标识并重新提交。',code:'INVALID_WEIGHT_PLAN_OPERATION'},400);
  try{
    if(Number(request.headers.get('content-length'))>2048)throw new RangeError();
    const reader=request.body?.getReader();if(!reader)throw new SyntaxError();let bytes=0,text='';const decoder=new TextDecoder();
    try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>2048){await reader.cancel();throw new RangeError();}text+=decoder.decode(next.value,{stream:true});}}finally{reader.releaseLock();}
    const now=new Date().toISOString(),command=parseWeightCycleCommand(JSON.parse(text+decoder.decode()),Date.parse(now));
    const health=await readHealth(user.userId,360),operation=await writeWeightCycle(database(),user.userId,command,id,health.measurements,now);
    const settings=await readWeightPlanSettings(database(),user.userId);
    return json({...buildWeightPlanReview(settings,health.measurements,Date.parse(now)),...await readWeightCycleState(database(),user.userId),operation});
  }catch(error){return failed(error);}
}
