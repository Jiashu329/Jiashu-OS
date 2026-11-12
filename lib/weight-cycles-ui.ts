import type { WeightCycleArchive, WeightCycleCommand } from './weight-cycles.ts';
import type { WeightPlanReview } from './weight-plan.ts';

export interface WeightCyclePageData extends WeightPlanReview {cycle?:{id:string;archivedAt:string|null}|null;cycles?:WeightCycleArchive[];cycleCount?:number}
interface DraftManager {
  ready():Promise<unknown>;get(id:string):{data:unknown}|null;
  save(id:string,label:string,data:unknown,options:{url:string;kind:'pending'}):boolean;clearConfirmed(id:string):boolean;problem?:string;
}
interface WeightCycleHooks {
  data():WeightCyclePageData|null;busy(value:boolean):void;apply(data:WeightCyclePageData):void;formControls():void;prepare():void;
  request(url:string,options?:RequestInit):Promise<unknown>;
  hasDraft?():boolean;
}

/** Self-contained typed controller, embedded after transpilation by the page renderer. */
export function installWeightCycles(hooks:WeightCycleHooks){
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('weight-plan-'+id) as T;
  const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}),format=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?number.format(value):'—';
  const manager=(window as Window&{JiashuDrafts?:DraftManager}).JiashuDrafts;
  const draftId='weight-cycle-operation';
  let preparing=false,busy=false,pending:{key:string;body:WeightCycleCommand}|null=null,loadedArchives:WeightCycleArchive[]=[],lastData:WeightCyclePageData|null=null;
  const feedback=(message:string)=>{el('cycle-status').textContent=message;};
  const clearOperation=()=>{if(!manager)return true;try{return manager.clearConfirmed(draftId);}catch{return false;}};
  const rate=(value:WeightPlanReview['observations']['rate7']|undefined)=>!value||value.kgPerWeek===null?'至少需要两个不同日期的真实记录。':format(value.changeKg)+' kg，折合 '+format(value.kgPerWeek)+' kg／周；'+value.from+' — '+value.to+'（跨度'+value.daysBetween+'天，'+value.recordedDays+'个记录日）';
  function render(){
    const data=hooks.data();if(!data)return;const archived=Boolean(data.cycle?.archivedAt);
    el('rate-7').textContent=rate(data.observations.rate7);el('rate-30').textContent=rate(data.observations.rate30);
    const sustained=data.progress?.sustained;el('sustained').textContent=!sustained?'未启用计划，暂不判断持续达成。':data.progress?.direction==='maintain'?'维持计划展示偏差，不自动判定持续达成。':sustained.achieved?'最近连续7个上海日期均有记录并达到自定目标。':'持续达成需连续7个上海日期均有记录且达到目标；当前覆盖 '+sustained.recordedDays+'／7 天，其中 '+sustained.qualifyingDays+' 天达标。';
    el<HTMLButtonElement>('cycle-archive-open').hidden=!data.settings||archived;el<HTMLButtonElement>('cycle-archive-open').disabled=busy||Boolean(pending);
    el<HTMLButtonElement>('cycle-start-prepare').hidden=Boolean(data.settings)&&!archived;el<HTMLButtonElement>('cycle-start-prepare').disabled=busy||Boolean(pending);
    el<HTMLFormElement>('form').hidden=archived&&!preparing;
    el<HTMLButtonElement>('cycle-confirm').disabled=busy||Boolean(pending);el<HTMLButtonElement>('cycle-cancel').disabled=busy;
    el<HTMLButtonElement>('cycle-retry').hidden=!pending;el<HTMLButtonElement>('cycle-retry').disabled=busy;
    if(data!==lastData){loadedArchives=data.cycles??[];lastData=data;}
    el('cycle-list').innerHTML=loadedArchives.length?loadedArchives.map((cycle)=>'<details class="wp-details"><summary>'+esc(cycle.settings.startDate)+' — '+esc(cycle.settings.deadline)+' · '+format(cycle.settings.baselineWeight)+' → '+format(cycle.settings.targetWeight)+' kg</summary><p class="wp-note">归档于 '+esc(cycle.archivedAt)+'。此总结保留归档时的数据，不随之后的更正重算。</p><dl class="wp-facts"><div><dt>归档时近7天日均</dt><dd>'+format(cycle.summary.average7)+' kg</dd></div><div><dt>有记录日期</dt><dd>'+cycle.summary.recordedDays7+'／7 天</dd></div></dl><p class="wp-note">近7天变化：'+esc(rate(cycle.summary.rate7))+'</p><p class="wp-note">近30天变化：'+esc(rate(cycle.summary.rate30))+'</p></details>').join(''):'<p class="wp-note">暂无归档周期。当前计划会作为第一个周期保留，不补造更早历史。</p>';
    el<HTMLButtonElement>('cycle-more').hidden=loadedArchives.length>=(data.cycleCount??0);el<HTMLButtonElement>('cycle-more').disabled=busy;
    if(archived&&!preparing&&!pending&&!el('cycle-status').textContent)feedback('当前周期已归档。点击“开始新周期”后填写新目标；旧周期总结保持不变。');
    hooks.formControls();
    if(archived||preparing)el<HTMLButtonElement>('save').textContent=busy?'正在保存…':'开始新周期';
  }
  async function send(operation:{key:string;body:WeightCycleCommand}){
    if(busy)return;busy=true;pending=operation;feedback('正在保存周期操作…');hooks.busy(true);render();
    let persisted=true,requestStarted=false;
    try{
      if(manager){
        persisted=false;
        persisted=manager.save(draftId,operation.body.action==='archive'?'体重周期归档待确认':'新体重周期待确认',operation,{url:'/health/weight-plan',kind:'pending'});
        if(!persisted)throw new Error('无法在本机保留提交标识，本次操作未发送到服务器。');
      }
      requestStarted=true;
      const data=await hooks.request('/api/health/weight-plan/cycles',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Idempotency-Key':operation.key},body:JSON.stringify(operation.body)}) as WeightCyclePageData;
      if(!data.observations||!Array.isArray(data.observations.points)||!Object.hasOwn(data,'settings'))throw new Error('暂时无法确认周期操作结果，请保留原操作并重试。');
      const cleared=clearOperation();if(cleared)pending=null;
      preparing=false;el('cycle-confirmation').hidden=true;hooks.apply(data);
      feedback(cleared?(operation.body.action==='archive'?'周期已归档，归档总结已冻结。':'新周期已开始，旧周期保持归档。'):'服务器已确认，但本机待确认标识未能清理；请保留原操作继续核对。');
    }catch(error){
      const status=(error as {status?:number})?.status;
      if(requestStarted&&status&&status>=400&&status<500&&status!==429){if(clearOperation())pending=null;}
      feedback((error instanceof Error?error.message:'网络请求未完成。')+(!persisted?' 原操作仍保留在当前页面，请恢复本机存储后点击“继续核对原操作”；关闭页面可能丢失它。':pending?' 原操作已保留，点击“继续核对原操作”。':' 请刷新核对最新版本后操作。'));
    }
    finally{busy=false;hooks.busy(false);render();}
  }
  el('cycle-archive-open').addEventListener('click',()=>{if(busy||pending)return;if(hooks.hasDraft?.()){feedback('有尚未保存的计划填写。请先保存或清除这份草稿，再归档已保存的周期。');return;}el('cycle-confirmation').hidden=false;feedback('归档会冻结当前计划与今日总结，并停用此周期；实测记录会保留。');});
  el('cycle-cancel').addEventListener('click',()=>{if(!busy)el('cycle-confirmation').hidden=true;});
  el('cycle-confirm').addEventListener('click',()=>{const data=hooks.data();if(busy||pending||!data?.settings)return;if(hooks.hasDraft?.()){el('cycle-confirmation').hidden=true;feedback('归档前检测到新的未保存填写，请先保存或清除草稿。');return;}void send({key:crypto.randomUUID(),body:{action:'archive',expectedRevision:data.settings.revision??0}});});
  el('cycle-start-prepare').addEventListener('click',()=>{if(busy||pending)return;preparing=true;if(!hooks.hasDraft?.())hooks.prepare();render();feedback('请填写本次周期的起点、目标与期限，再点击“开始新周期”。');el<HTMLInputElement>('baseline').focus();});
  el('cycle-retry').addEventListener('click',()=>{if(pending&&!busy)void send(pending);});
  el('cycle-more').addEventListener('click',async()=>{if(busy)return;try{const body=await hooks.request('/api/health/weight-plan/cycles?offset='+loadedArchives.length,{redirect:'error'}) as {cycles?:WeightCycleArchive[];error?:string};if(!Array.isArray(body.cycles))throw new Error(body.error||'无法读取更多周期。');loadedArchives=[...loadedArchives,...body.cycles];render();}catch(error){feedback(error instanceof Error?error.message:'无法读取更多周期。');}});
  if(manager)void manager.ready().then(()=>{const saved=manager.get(draftId)?.data as {key?:unknown;body?:WeightCycleCommand}|undefined;if(saved&&typeof saved.key==='string'&&/^[0-9a-f-]{36}$/i.test(saved.key)&&saved.body&&['archive','start'].includes(saved.body.action)&&Number.isSafeInteger(saved.body.expectedRevision)){pending={key:saved.key,body:saved.body};feedback('上次周期操作结果待确认，请使用原操作继续核对；不会自动提交。');render();}}).catch(()=>{feedback('本机待确认操作暂时无法读取，请保留当前浏览器后重试。');});
  return{render,isStarting:()=>preparing||Boolean(hooks.data()?.cycle?.archivedAt),isPending:()=>Boolean(pending),start:async(body:Record<string,unknown>)=>{const {expectedRevision,...plan}=body;await send({key:crypto.randomUUID(),body:{action:'start',expectedRevision:Number(expectedRevision),plan:plan as unknown as Extract<WeightCycleCommand,{action:'start'}>['plan']}});}};
}

export function renderWeightCyclesPanel(){return String.raw`<section class="wp-panel" aria-labelledby="weight-plan-cycle-title"><div class="wp-panel-heading"><h2 id="weight-plan-cycle-title">管理周期</h2><div class="wp-heading-actions"><button class="wp-btn" type="button" id="weight-plan-cycle-archive-open" hidden>归档当前周期</button><button class="wp-btn" type="button" id="weight-plan-cycle-start-prepare" hidden>开始新周期</button></div></div><dl class="wp-facts"><div><dt>近7天变化速度</dt><dd id="weight-plan-rate-7" style="font-size:13px">—</dd></div><div><dt>近30天变化速度</dt><dd id="weight-plan-rate-30" style="font-size:13px">—</dd></div></dl><p class="wp-note">速度由窗口内最早和最新两个真实日末体重计算，不补齐缺失日期，也不代表未来预测。</p><p class="wp-note" id="weight-plan-sustained"></p><div id="weight-plan-cycle-confirmation" class="wp-details" hidden><p class="wp-note">归档会保留当前计划与今日总结，并停用此周期。实测记录不会删除；之后可开始新周期。</p><button class="wp-btn primary" id="weight-plan-cycle-confirm" type="button">确认归档此周期</button> <button class="wp-btn" id="weight-plan-cycle-cancel" type="button">取消</button></div><p id="weight-plan-cycle-status" class="wp-form-status" role="status" aria-live="polite"></p><button id="weight-plan-cycle-retry" type="button" class="wp-btn" hidden>继续核对原操作</button><details class="wp-details"><summary>查看归档周期</summary><div id="weight-plan-cycle-list"></div><button class="wp-btn" type="button" id="weight-plan-cycle-more" hidden>查看更多周期</button></details></section>`;}
