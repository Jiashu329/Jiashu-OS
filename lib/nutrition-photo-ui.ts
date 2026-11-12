import type { NutritionDraft } from './nutrition-parser.ts';

export const NUTRITION_PHOTO_CSS=String.raw`.nt-photo-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.nt-photo-actions .nt-btn{min-height:44px}.nt-photo-preview{margin:14px 0;display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}.nt-photo-preview img{display:block;max-width:100%;width:min(100%,420px);max-height:300px;object-fit:contain;border-radius:9px;border:1px solid var(--line);background:var(--subtle)}.nt-photo-fields{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:12px;margin:14px 0}.nt-photo-fields label{display:block;color:var(--muted);font-size:12px;margin:0 0 6px}.nt-photo-fields textarea{min-height:78px}.nt-photo-meta{font-size:11px;color:var(--muted);margin:8px 0}.nt-photo-status{font-size:12px;line-height:1.8;color:var(--primary-hover);margin:12px 0}.nt-photo-status.error{color:var(--red)}.nt-photo-blocked{font-size:12px;line-height:1.8;color:var(--muted);margin:10px 0}.nt-photo-file{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:700px){.nt-photo-fields{grid-template-columns:1fr}.nt-photo-actions .nt-btn{flex:1}.nt-entry-methods button{padding-left:10px;padding-right:10px;min-height:44px}.nt-photo-preview img{max-height:260px}}`;

export function renderNutritionPhotoPanel():string{return String.raw`<div id="nutrition-entry-photo" role="tabpanel" aria-labelledby="nutrition-method-photo" hidden><form id="nutrition-photo-form" novalidate><div class="nt-photo-actions"><button type="button" class="nt-btn" id="nutrition-photo-choose">选择餐食图片</button><button type="button" class="nt-btn" id="nutrition-photo-take">拍一张</button><input class="nt-photo-file" id="nutrition-photo-file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif" aria-label="从相册选择一张餐食图片"><input class="nt-photo-file" id="nutrition-photo-camera" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" aria-label="拍摄一张餐食图片"></div><p class="nt-photo-meta" id="nutrition-photo-date"></p><div class="nt-photo-preview" id="nutrition-photo-preview" hidden><img id="nutrition-photo-image" alt="待识别的餐食图片，仅在当前页面预览"><button type="button" class="nt-btn" id="nutrition-photo-remove">移除图片</button></div><div class="nt-photo-fields"><div><label for="nutrition-photo-text">补充说明（可选）</label><textarea class="nt-control" id="nutrition-photo-text" maxlength="2000" rows="2" placeholder="如：这是我吃的午餐，米饭只吃了一半；鸡肉约150克"></textarea></div><div><label for="nutrition-photo-meal">记在哪一餐</label><select class="nt-control" id="nutrition-photo-meal"><option value="">核对时再选择</option><option value="breakfast">早餐</option><option value="lunch">午餐</option><option value="dinner">晚餐</option><option value="snack">加餐</option></select></div></div><button type="submit" class="nt-btn primary" id="nutrition-photo-recognize" disabled>识别图片，核对食物</button><p class="nt-ai-note">点击识别会将压缩图片和补充说明发送至本人配置的 MiniMax；图片不写入本站记录。食物、实际吃下的份量和营养值都需核对，未知不会按0计算。<a href="/settings/ai">AI 设置</a></p><p class="nt-photo-meta">支持一张 JPG、PNG、WebP 或可解码的手机照片，原图不超过20 MiB；会移除图片元数据并压缩后发送。刷新或离开页面会清除图片。</p><p class="nt-photo-blocked" id="nutrition-photo-blocked" hidden></p><p class="nt-photo-status" id="nutrition-photo-status" role="status" aria-live="polite">选图只在本页预览，不会自动识别或保存。</p></form></div>`;}

export interface PreparedNutritionPhoto { dataUrl:string;blob:Blob;width:number;height:number }
interface PhotoRequest { image:{dataUrl:string};text?:string;date:string;meal:'breakfast'|'lunch'|'dinner'|'snack'|null }
export interface NutritionPhotoHooks {
  selection():{date:string}; blocked():string|null; busy():boolean; setBusy(value:boolean):void;
  request(input:PhotoRequest,signal:AbortSignal):Promise<unknown>;
  accept(rows:NutritionDraft[],warnings:string[]):boolean;
}
interface EphemeralPhotoGuard {saved():void;failed():void}

/** All runtime dependencies are browser APIs or explicit hooks, so embedding survives minification. */
export function installNutritionPhoto(hooks:NutritionPhotoHooks,prepare:(file:File)=>Promise<PreparedNutritionPhoto>){
  const el=<T=HTMLElement>(id:string)=>document.getElementById('nutrition-photo-'+id)! as unknown as T;
  const context=el<HTMLTextAreaElement>('text'),meal=el<HTMLSelectElement>('meal');
  let prepared:PreparedNutritionPhoto|null=null,previewUrl:string|null=null,revision=0,imageRevision=0,acceptedRevision:number|null=null;
  let preparing=false,recognizing=false,departed=false,controller:AbortController|null=null,retryUntil=0,timer:ReturnType<typeof setTimeout>|null=null;
  let observedDate=hooks.selection().date;
  const windowWithGuards=window as unknown as {JiashuDraftGuards?:{register(options:Record<string,unknown>):EphemeralPhotoGuard}};
  function message(text:string,error=false){el('status').textContent=text;el('status').classList.toggle('error',error);}
  function stopTimer(){if(timer!==null){clearTimeout(timer);timer=null;}}
  function remaining(){return Math.max(0,Math.ceil((retryUntil-Date.now())/1000));}
  function render(){
    const externalBusy=hooks.busy()&&!recognizing,blocked=hooks.blocked(),wait=remaining();
    for(const id of ['choose','take','file','camera','remove','text','meal'])el<HTMLInputElement>(id).disabled=externalBusy;
    const button=el<HTMLButtonElement>('recognize');button.disabled=departed||preparing||recognizing||!prepared||Boolean(blocked)||wait>0;
    button.textContent=preparing?'正在准备图片…':recognizing?'正在识别图片…':wait>0?(wait<3600?wait+'秒后可重试':Math.ceil(wait/60)+'分钟后可重试'):'识别图片，核对食物';
    el('preview').hidden=!prepared;el('date').textContent='记入所选日期：'+hooks.selection().date+'（北京时间）';
    el('blocked').hidden=!blocked||recognizing;el('blocked').textContent=blocked||'';
  }
  function countdown(){stopTimer();render();if(remaining()>0&&!departed)timer=setTimeout(countdown,1000);}
  function releasePreview(){if(previewUrl!==null){URL.revokeObjectURL(previewUrl);previewUrl=null;}el<HTMLImageElement>('image').removeAttribute('src');prepared=null;}
  function invalidate(cancelMessage?:string){
    revision++;controller?.abort();
    if(recognizing&&cancelMessage)message(cancelMessage+' 已停止等待，原识别请求可能已计入 API 额度。');
  }
  function clear(clearContext=false){invalidate();imageRevision++;releasePreview();preparing=false;for(const id of ['file','camera'])el<HTMLInputElement>(id).value='';if(clearContext)context.value='';render();}
  const guard=windowWithGuards.JiashuDraftGuards?.register({form:el<HTMLFormElement>('form'),durable:false,label:'未保存的餐食图片',canSave:()=>false,isBusy:()=>recognizing,isBlocked:()=>recognizing,isDirty:()=>Boolean(prepared||context.value.trim()),readValue:()=>revision,onDiscard:()=>clear(true)});
  async function selectFile(input:HTMLInputElement){
    if(hooks.busy()&&!recognizing)return;
    const file=input.files?.[0];input.value='';if(!file)return;
    invalidate('图片已更换，旧结果不会进入草稿。');const current=++imageRevision;releasePreview();preparing=true;message('正在本机处理图片方向、移除元数据并压缩…');render();
    try{
      const next=await prepare(file);if(current!==imageRevision||departed)return;
      if(typeof next.dataUrl!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(next.dataUrl)||next.dataUrl.length>Math.ceil(2*1024*1024/3)*4+100)throw new Error('图片准备失败，请换一张 JPG 或 PNG 后重试。');
      prepared=next;previewUrl=URL.createObjectURL(next.blob);el<HTMLImageElement>('image').src=previewUrl;
      message('图片已在本机准备好。确认日期和餐次，再点击识别；尚未发送图片。');
    }catch(error){if(current===imageRevision&&!departed){releasePreview();message(error instanceof Error?error.message:'图片无法读取，请改用 JPG、PNG 或 WebP。',true);}}
    finally{if(current===imageRevision&&!departed){preparing=false;render();}}
  }
  function snapshot(){return{revision,date:hooks.selection().date,meal:meal.value,text:context.value};}
  function same(snapshotValue:ReturnType<typeof snapshot>){return!departed&&snapshotValue.revision===revision&&snapshotValue.date===hooks.selection().date&&snapshotValue.meal===meal.value&&snapshotValue.text===context.value;}
  async function recognize(){
    if(preparing||recognizing||!prepared||departed||remaining()>0)return;
    const blocked=hooks.blocked();if(blocked){message(blocked,true);render();return;}
    if(context.value.trim().length>2000){message('补充说明最多2000个字符。',true);context.focus();return;}
    const selected=prepared,current=snapshot(),selectedMeal=['breakfast','lunch','dinner','snack'].includes(meal.value)?meal.value as PhotoRequest['meal']:null;
    recognizing=true;controller=new AbortController();hooks.setBusy(true);render();message('正在识别图片中的食物。份量与营养仅作参考，识别后仍需核对。');
    try{
      const result=await hooks.request({image:{dataUrl:selected.dataUrl},...(current.text.trim()?{text:current.text.trim()}:{}),date:current.date,meal:selectedMeal},controller.signal);
      if(!same(current))return;
      if(!result||typeof result!=='object'||!Array.isArray((result as {drafts?:unknown}).drafts))throw new Error('图片识别结果暂时无法核对，请保留图片后重试。');
      const data=result as {drafts:NutritionDraft[];warnings?:unknown};
      if(data.drafts.length>20||data.drafts.some((row)=>!row||typeof row.name!=='string'||!row.name.trim()||row.name.length>100||row.date!==current.date||row.meal!==selectedMeal))throw new Error('图片识别结果的日期、餐次或食物内容不完整，请重试。');
      if(!data.drafts.length){message('没有识别到可确认的食物。请换一张清晰的餐食照片，或补充实际吃了什么、吃了多少。');return;}
      hooks.setBusy(false);
      const conflict=hooks.blocked();if(conflict){message('图片已识别，但'+conflict+' 本次结果未替换原草稿。',true);return;}
      if(!same(current))return;
      const warnings=Array.isArray(data.warnings)?data.warnings.filter((value):value is string=>typeof value==='string'&&value.length<=500).slice(0,8):[];
      if(!hooks.accept(data.drafts,warnings))throw new Error('已有记录需要先核对，本次图片结果没有替换原草稿。');
      acceptedRevision=current.revision;guard?.saved();
      message('已识别 '+data.drafts.length+' 项食物，图片份量和营养值均需核对，确认保存前不会写入记录。');
    }catch(error){
      if(!same(current))return;
      guard?.failed();const failure=error as {name?:string;message?:string;status?:number;retryAfter?:number};
      if(failure.status===429){const seconds=Number.isInteger(failure.retryAfter)&&Number(failure.retryAfter)>=1&&Number(failure.retryAfter)<=86400?Number(failure.retryAfter):60;retryUntil=Date.now()+seconds*1000;countdown();}
      message(failure.name==='AbortError'||failure.name==='TimeoutError'?'已停止等待图片识别。原请求可能已计入 API 额度；图片和说明仍在本页，可稍后主动重试。':failure.message||'这次图片识别未完成。图片和说明仍在本页，请稍后主动重试。',true);
    }finally{controller=null;recognizing=false;hooks.setBusy(false);if(!departed)render();}
  }
  el('choose').addEventListener('click',()=>{if(!hooks.busy()||recognizing)el<HTMLInputElement>('file').click();});
  el('take').addEventListener('click',()=>{if(!hooks.busy()||recognizing)el<HTMLInputElement>('camera').click();});
  for(const id of ['file','camera'])el<HTMLInputElement>(id).addEventListener('change',(event)=>{void selectFile(event.target as HTMLInputElement);});
  el('remove').addEventListener('click',()=>{if(hooks.busy()&&!recognizing)return;const wasRecognizing=recognizing;clear();message(wasRecognizing?'图片已移除，旧识别结果不会进入草稿；原请求可能已计入 API 额度。':'图片已从当前页面移除。');});
  context.addEventListener('input',()=>{invalidate('补充说明已更新，旧结果不会进入草稿。');render();});
  meal.addEventListener('change',()=>{invalidate('餐次已更换，旧结果不会进入草稿。');render();});
  el('form').addEventListener('submit',(event)=>{event.preventDefault();void recognize();});
  window.addEventListener('pagehide',()=>{departed=true;invalidate();imageRevision++;releasePreview();preparing=false;context.value='';stopTimer();});
  window.addEventListener('pageshow',(event)=>{if(event.persisted){departed=false;countdown();}});
  function refresh(){const date=hooks.selection().date;if(date!==observedDate){observedDate=date;invalidate('记录日期已更换，旧结果不会进入草稿。');}render();}
  render();
  return{refresh,isBusy:()=>preparing||recognizing,focus:()=>el<HTMLButtonElement>('choose').focus(),batchSaved(){const consumed=acceptedRevision;acceptedRevision=null;if(consumed!==null&&consumed===revision){clear(true);guard?.saved();message('已保存核对后的食物，图片已从当前页面移除。');}},batchDiscarded(){acceptedRevision=null;render();}};
}
