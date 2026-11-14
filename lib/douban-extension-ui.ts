export const DOUBAN_EXTENSION_CONTENT = '<section class="db-connection" aria-labelledby="douban-browser-title"><div class="db-section-heading"><div><h2 id="douban-browser-title">通过本人浏览器同步</h2><p id="douban-browser-profile">使用电脑 Chrome 或 Edge，保留浏览器中正常的豆瓣登录状态。</p></div><div class="db-sync-actions"><button class="db-btn primary" id="douban-browser-sync" type="button" disabled>通过浏览器同步</button><button class="db-btn" id="douban-browser-stop" type="button" hidden>暂停</button></div></div><form id="douban-browser-form"><p class="db-note">点击同步后，扩展会读取并保存已绑定主页的看过、读过和听过记录，每次最多处理 20 步。登录状态保留在你的浏览器中，密码、Cookie 和原始页面不会上传本站。</p><p id="douban-browser-status" class="db-form-status" role="status" aria-live="polite"></p><div id="douban-browser-progress" class="db-sources" hidden></div><div class="db-import-actions"><button class="db-btn" id="douban-browser-connect" type="button">检测浏览器连接</button><button class="db-btn" id="douban-browser-login" type="button">登录豆瓣</button><button class="db-btn" id="douban-browser-reset" type="button" hidden>结束本次同步</button></div></form><details id="douban-browser-install"><summary>首次安装浏览器扩展</summary><ol class="db-note"><li><a href="/downloads/jiashu-douban-extension.zip" download>下载豆瓣同步扩展 ZIP</a>，解压后保留整个文件夹。</li><li>在 Chrome 或 Edge 的“管理扩展程序”页面打开“开发者模式”，选择“加载已解压的扩展程序”，选中解压后的文件夹。安装一次即可。</li><li>必须在安装扩展的同一个 Chrome 或 Edge 中打开本站，内置浏览器无法使用此扩展。安装后刷新本站，点击“登录豆瓣”打开普通登录标签页，再回本站同步。扩展可连接不代表已登录豆瓣，实际读取时会核对。</li></ol><p class="db-note">Safari 和手机浏览器暂不支持此扩展，仍可使用公开同步、HTML／JSON 文件导入，或书籍导出书签。无需把豆瓣密码或 Cookie 填到本站。</p></details></section>';

export function renderDoubanExtensionScript(): string {
  return '<script>' + DOUBAN_EXTENSION_SCRIPT + '</script>';
}

/** Only registers the bridge; connecting or reading always starts with a user action. */
export const DOUBAN_EXTENSION_SCRIPT = String.raw`
(()=>{
 const extensionId='gbcgjkicjfbaakippafhhpadfkfifaeb';
 window.JiashuDoubanExtensionUI={create(options){
  const el=options.el,integer=value=>Number.isSafeInteger(value)&&value>=0,profileOK=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  const state={ownerKey:crypto.randomUUID(),busy:false,stop:false,frozen:false,connected:false,pin:null,run:null,pendingStep:null,page:null,saved:0,added:0,updated:0,unchanged:0,pages:0};
  const sourceLabels={screen:'看过的影视',book:'读过的书',music:'听过的音乐'},statuses={pending:'待读取',complete:'已读取',blocked:'读取受限',failed:'未能读取',limited:'本次读取受限'};
  const reasons={DOUBAN_BROWSER_LOGIN_REQUIRED:'需要在浏览器登录豆瓣后重试。',DOUBAN_BROWSER_CHALLENGE:'豆瓣要求安全验证，请在浏览器完成后重试。',DOUBAN_BROWSER_BLOCKED:'豆瓣暂时限制读取，已保存记录仍保留。',DOUBAN_BROWSER_RATE_LIMITED:'豆瓣暂时限制读取频率，请稍后手动继续。',DOUBAN_BROWSER_PROFILE_MISMATCH:'当前豆瓣账号与绑定主页不符，请先在浏览器切换到对应账号。',DOUBAN_BROWSER_INVALID:'未能确认收藏页面，请在浏览器核对对应列表。',DOUBAN_BROWSER_TOO_LARGE:'页面超过本次读取上限，已保存记录仍保留。',DOUBAN_BROWSER_TIMEOUT:'读取页面超时，可稍后手动继续。',DOUBAN_BROWSER_NETWORK:'浏览器暂时无法读取页面，可稍后重试。',DOUBAN_BROWSER_LIMIT:'已达到本次来源读取上限，部分记录可能尚未读取。'};
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const transport=()=>window.chrome?.runtime,accountChanged=()=>state.frozen||options.isAccountChanged(),pending=()=>Boolean(state.pendingStep||state.page),locked=()=>state.busy||pending();
  const mobile=()=>Boolean(window.navigator?.userAgentData?.mobile||/Android|Mobile|iPhone|iPad|iPod/i.test(window.navigator?.userAgent||''));
  const compatible=()=>!mobile()&&(!window.navigator?.userAgent||/(?:Chrome|Chromium|Edg|HeadlessChrome)\//.test(window.navigator.userAgent));
  const supported=()=>compatible()&&typeof transport()?.sendMessage==='function';
  const outsideLocked=()=>accountChanged()||options.isLocked();
  function message(text,error=false){el('status').textContent=text||'';el('status').classList.toggle('error',error);}
  function notify(){update();options.onChange();}
  function update(){
   const connection=options.getConnection(),bound=profileOK(connection?.profileId)&&integer(connection?.revision),blocked=outsideLocked(),canUse=supported();
   el('sync').disabled=blocked||state.busy||!bound||!canUse;el('sync').textContent=state.busy?'正在通过浏览器同步…':pending()?'重试并继续浏览器同步':state.run&&!state.run.done?'继续浏览器同步':'通过浏览器同步';
   el('connect').disabled=blocked||state.busy||!bound||!compatible();el('login').disabled=blocked||state.busy||pending()||!bound||!canUse;el('stop').hidden=!state.busy;el('stop').disabled=state.stop;el('stop').textContent=state.stop?'暂停中…':'暂停';
   el('reset').hidden=!state.run&&!pending();el('reset').disabled=blocked||state.busy||Boolean(state.page?.commit);
   el('profile').textContent=bound?'将读取并保存绑定主页 '+connection.profileId+' 的已完成记录。':'先在上方保存自己的豆瓣主页，再通过本人浏览器同步。';
  }
  function envelope(action,extra={}){return{type:'JIASHU_DOUBAN',version:1,action,ownerKey:state.ownerKey,profileId:state.pin?.profileId||options.getConnection()?.profileId,...extra};}
  function send(body){return new Promise((resolve,reject)=>{
   const runtime=transport();if(!supported()){const error=new Error(mobile()?'请在电脑 Chrome 或 Edge 中安装扩展后使用。':'未检测到同步扩展，请按安装指引加载扩展后再试。');error.code='EXTENSION_UNAVAILABLE';reject(error);return;}
   let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
   const timer=setTimeout(()=>{const error=new Error('扩展响应尚未确认，请保留本页并手动重试。');error.code='EXTENSION_RESPONSE_UNKNOWN';finish(error);},65000);
   try{runtime.sendMessage(extensionId,body,response=>{const lastError=runtime.lastError;if(lastError){const error=new Error('未收到扩展结果，请检查扩展连接后重试。');error.code='EXTENSION_RESPONSE_UNKNOWN';finish(error);return;}if(!response||response.ok!==true){const code=response?.error?.code,error=new Error(code==='RUN_NOT_FOUND'?'扩展进度已失效，请重新开始同步。':code==='PACING'?'读取间隔较短，请稍后手动继续。':code==='RUN_BUSY'?'浏览器仍在读取当前页，请稍后手动重试。':code==='STEP_CONFLICT'?'扩展读取进度未能核对，请结束本次同步后重新开始。':response?.error?.message||'扩展暂时无法完成操作。');error.code=typeof code==='string'?code:'EXTENSION_INVALID_RESPONSE';error.retryAfter=response?.error?.retryAfter;finish(error);return;}finish(null,response.data);});}catch{const error=new Error('无法连接同步扩展，请按安装指引检查后重试。');error.code='EXTENSION_RESPONSE_UNKNOWN';finish(error);}
  });}
  function samePin(){const connection=options.getConnection();return state.pin&&connection?.profileId===state.pin.profileId&&connection?.revision===state.pin.revision&&!accountChanged();}
  function verifyPin(){if(!samePin())throw new Error('登录账号或豆瓣连接已变化，本次返回未保存。请刷新后核对绑定主页。');}
  function progress(data){
   const value=data?.progress;if(!value||!['running','completed','partial','failed','cancelled'].includes(value.status))throw new Error('扩展进度格式未能核对，请保留本页重试。');
   if(value.accountProfileId!==null&&value.accountProfileId!==undefined&&value.accountProfileId!==state.pin.profileId)throw new Error('当前豆瓣账号与绑定主页不符，本次记录未保存。');
   el('progress').hidden=false;el('progress').innerHTML=['screen','book','music'].map(domain=>{const source=value.sources?.[domain]||{},reason=reasons[source.errorCode];return '<article class="db-source" data-douban-browser-source="'+domain+'"><strong>'+sourceLabels[domain]+' · '+escape(statuses[source.status]||'待核对')+'</strong><p>已读 '+(integer(source.pages)?source.pages:0)+' 页 · 获取 '+(integer(source.received)?source.received:0)+' 条</p>'+(reason?'<p>'+escape(reason)+'</p>':'')+'</article>';}).join('');return value;
  }
  function normalizeItems(items){
   if(!Array.isArray(items)||items.length>30)throw new Error('扩展返回记录数量不符合要求，当前页未保存。');
   const keys=['domain','subjectId','title','url','kind','coverUrl','rating','markedDate','comment','publishedAt','source'];
   return items.map(item=>{if(!item||item.source!=='import'||!options.validItem(item))throw new Error('扩展返回记录格式未能核对，当前页未保存。');return Object.fromEntries(keys.map(key=>[key,item[key]??null]));});
  }
  function checkPreview(preview,items){return preview&&preview.profileId===state.pin.profileId&&preview.total===items.length&&['added','updated','unchanged'].every(key=>integer(preview[key]))&&typeof preview.snapshotHash==='string'&&/^[a-f0-9]{64}$/i.test(preview.snapshotHash);}
  function checkReceipt(receipt,commit){return receipt&&receipt.profileId===commit.profile&&receipt.requestId===commit.requestId&&receipt.total===commit.items.length&&['added','updated','unchanged'].every(key=>integer(receipt[key]));}
  async function savePage(){
   const page=state.page;if(!page)return;verifyPin();if(!page.items.length){state.pages++;state.page=null;return;}
   if(!page.commit){message('已读取当前页，正在核对并保存到本站…');const result=await options.requestJSON('/api/life/douban/import',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'preview',profile:state.pin.profileId,items:page.items})});verifyPin();if(!checkPreview(result.preview,page.items))throw new Error('当前页保存预览未能核对，资料已保留，请重试。');page.commit={action:'commit',profile:state.pin.profileId,items:page.items,expectedSnapshotHash:result.preview.snapshotHash,requestId:crypto.randomUUID(),confirmed:true};}
   message('正在保存当前页；暂停会在本页保存后生效…');let result;try{result=await options.requestJSON('/api/life/douban/import',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify(page.commit)});}catch(error){if([400,409,413,415,422].includes(error?.status)){page.commit=null;error.message=(error.message||'本页未保存。')+' 当前页已保留，请点击继续重新核对。';}throw error;}verifyPin();
   const receipt=result.receipt;if(!checkReceipt(receipt,page.commit))throw new Error('当前页保存回执尚未确认，请保留本页并重试原提交。');
   state.saved+=receipt.total;state.added+=receipt.added;state.updated+=receipt.updated;state.unchanged+=receipt.unchanged;state.pages++;state.page=null;
  }
  function summary(){return '已处理 '+state.pages+' 步，已保存 '+state.saved+' 条（新增 '+state.added+'、更新 '+state.updated+'、未变化 '+state.unchanged+'）。';}
  function completionNote(){return state.run?.done&&state.pages>0&&state.run.progress?.accountProfileId==null?' 本次仅完成当前可访问记录；未能确认豆瓣登录账户，私密记录可能未包含，请点击“登录豆瓣”后重新同步。':'';}
  async function connect(){if(outsideLocked()||state.busy||!profileOK(options.getConnection()?.profileId))return;state.busy=true;notify();message('正在检测浏览器扩展连接…');try{const data=await send(envelope('CONNECT'));if(accountChanged())return;if(data?.protocolVersion!==1||typeof data.extensionVersion!=='string')throw new Error('扩展版本不兼容，请重新下载并加载最新版。');state.connected=true;message('浏览器扩展可连接。实际同步时会核对豆瓣账号和读取权限。');}catch(error){if(!accountChanged())message(error.message,true);}finally{state.busy=false;notify();}}
  async function login(){if(outsideLocked()||state.busy||pending()||!supported()||!profileOK(options.getConnection()?.profileId))return;state.busy=true;notify();message('正在打开普通豆瓣登录页…');try{const result=await send(envelope('LOGIN',{profileId:options.getConnection().profileId}));if(result?.opened!==true)throw new Error('登录页打开结果未能确认，请手动打开豆瓣登录。');if(!accountChanged())message('已打开豆瓣登录页。请在该标签页完成登录，再回本站点击“通过浏览器同步”。');}catch(error){if(!accountChanged())message(error.message||'未能打开登录页，请在普通浏览器标签页手动登录豆瓣。',true);}finally{state.busy=false;notify();}}
  async function reconcileOriginal(){
   const page=state.page,commit=page?.commit;if(!commit||accountChanged()||state.busy)return;state.busy=true;notify();message('绑定主页已变化，正在核对原保存提交；不会读取另一主页…');
   try{const result=await options.requestJSON('/api/life/douban/import',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify(commit)});if(accountChanged())return;if(!checkReceipt(result.receipt,commit))throw new Error('原保存回执尚未确认，请保留本页并重试原提交。');cancel();resetData();await options.onSaved();if(!accountChanged())message('原提交已核对，已保存记录仍保留。绑定主页已变化，请核对后重新开始浏览器同步。');}
   catch(error){if(!accountChanged()){if([400,409,413,415,422].includes(error?.status)){page.commit=null;message('原提交未保存，绑定主页已变化。请结束本次同步，再核对绑定主页重新开始。',true);}else message((error.message||'原保存结果尚未确认。')+' 原提交已保留，请手动重试核对。',true);}}
   finally{state.busy=false;notify();}
  }
  async function sync(){
   if(outsideLocked()||state.busy||!supported())return;if(state.run?.done&&!pending())resetData();const connection=options.getConnection();if(!profileOK(connection?.profileId)||!integer(connection?.revision))return;
   if(state.pin&&!samePin()){if(state.page?.commit){await reconcileOriginal();return;}message('豆瓣连接已变化，请先结束本次同步，再核对新的绑定主页。',true);return;}
   state.pin=state.pin||{profileId:connection.profileId,revision:connection.revision};state.busy=true;state.stop=false;notify();let errorText=null;
   try{
    if(!state.connected){const data=await send(envelope('CONNECT'));verifyPin();if(data?.protocolVersion!==1||typeof data.extensionVersion!=='string')throw new Error('扩展版本不兼容，请重新下载并加载最新版。');state.connected=true;}
    if(!state.run){const result=await send(envelope('START'));verifyPin();if(typeof result?.runId!=='string'||!result.runId||result.runId.length>100||result.step!==0||result.done!==false)throw new Error('扩展同步进度未能核对，请重新连接。');progress(result);state.run={runId:result.runId,step:0,done:false};}
    if(state.page)await savePage();
    for(let step=0;step<20&&!state.run.done&&!state.stop;step++){
     verifyPin();if(!state.pendingStep)state.pendingStep=envelope('STEP',{runId:state.run.runId,step:state.run.step,requestId:crypto.randomUUID()});message('正在通过浏览器读取并保存… '+summary());
     const command=state.pendingStep,result=await send(command);verifyPin();if(result?.runId!==state.run.runId||result.step!==command.step+1||typeof result.done!=='boolean')throw new Error('扩展当前页进度尚未确认，请保留本页重试。');progress(result);const items=normalizeItems(result.items);state.run.step=result.step;state.run.done=result.done;state.run.progress=result.progress;state.page={items,commit:null};state.pendingStep=null;await savePage();
     if(state.stop||state.run.done)break;if(step<19)await new Promise(resolve=>setTimeout(resolve,1500));
    }
   }catch(error){if(!state.run&&!pending())state.pin=null;if(error?.code==='RUN_NOT_FOUND'&&!state.page){state.run=null;state.pendingStep=null;state.pin=null;}errorText=error.message||'本次同步结果尚未确认，请保留本页重试。';}
   finally{state.busy=false;const paused=state.stop;state.stop=false;if(!accountChanged()){if(state.pages>0)await options.onSaved();message(errorText?errorText+(state.page?.commit?' 请点击“重试并继续浏览器同步”核对原保存提交。':''):state.run?.done?(state.run.progress?.status==='completed'?'浏览器同步完成。':'浏览器同步部分完成，请查看各来源的读取结果。')+' '+summary()+completionNote():paused?'已暂停浏览器同步，当前页已保存。'+summary():'本批同步已完成，仍有后续页面。点击“继续浏览器同步”继续。'+summary(),Boolean(errorText));}notify();}
  }
  function cancel(){if(!state.run)return;const body=envelope('CANCEL',{runId:state.run.runId});send(body).catch(()=>{});}
  function resetData(){state.run=null;state.pin=null;state.pendingStep=null;state.page=null;state.saved=0;state.added=0;state.updated=0;state.unchanged=0;state.pages=0;el('progress').hidden=true;}
  function discard(){if(state.busy)return;cancel();resetData();message('本次浏览器同步已结束，已保存的记录仍保留。');notify();}
  function freeze(){state.frozen=true;state.stop=true;cancel();state.page=null;state.pendingStep=null;message('登录账号已变化，浏览器同步已停止，后续返回不会保存。请刷新后继续。',true);notify();}
  el('sync').addEventListener('click',sync);el('connect').addEventListener('click',connect);el('login').addEventListener('click',login);el('stop').addEventListener('click',()=>{if(state.busy){state.stop=true;message('正在完成并保存当前页，随后暂停。');notify();}});el('reset').addEventListener('click',()=>{if(!outsideLocked()&&!state.busy&&!state.page?.commit)discard();});el('form').addEventListener('submit',event=>event.preventDefault());
  message(!compatible()?'手机或当前浏览器暂不支持扩展同步，请使用电脑 Chrome／Edge，或下方文件导入。':supported()?'点击检测连接，或直接通过浏览器同步。打开本页不会自动读取豆瓣。':'首次使用请按下方指引安装扩展，再检测连接。');update();
  return{update,isBusy:()=>state.busy,hasPending:pending,isLocked:locked,accountChanged:freeze,discard};
 }};
})();
`;
