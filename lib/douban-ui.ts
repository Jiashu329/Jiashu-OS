import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';

export const DOUBAN_IMPORT_CONTENT = '<details class="db-connection db-import-panel" id="douban-import-panel"><summary>导入私密记录或已有导出资料</summary><p class="db-note">导入你在本人豆瓣账号登录后保存的收藏页面，或已导出的 JSON、CSV、Obsidian Markdown。原文件只在当前浏览器解析；点击预览会将规范化条目发送本站核对，确认导入后才保存，不修改豆瓣。</p><details class="db-import-guide"><summary>如何准备导入文件</summary><ol class="db-note"><li>已有 Obsidian 豆瓣插件生成的 Markdown 笔记，可直接多选这些 .md 文件。</li><li>也可在自己的浏览器登录豆瓣，打开“看过”“读过”或“听过”的收藏列表，通过浏览器菜单逐页另存为 HTML，再选择对应类型导入。多页列表需逐页保存，单页文件不代表历史全量。</li><li>CSV／JSON 请保存为 UTF-8 文本，至少提供 title、url、state；state 使用“看过”“读过”或“听过”。个人字段 myRating（1–5）、myComment、collectionDate 可以缺省。电影／电视剧可用 type=movie／series 明确区分；无法确认的影视保留待分类，不按片名猜测。</li></ol><p class="db-note">myRating 是个人评分，不是豆瓣站点评分。无需向本站提供豆瓣密码或 Cookie。</p></details><form id="douban-import-form" novalidate><div class="db-import-fields"><label class="db-field"><span>这份资料所属的豆瓣主页或 ID</span><input class="db-control" id="douban-import-profile" type="text" maxlength="300" autocomplete="off" placeholder="填写资料所属的豆瓣主页"></label><label class="db-field"><span>文件（可多选）</span><input class="db-control" id="douban-import-files" type="file" multiple accept=".json,.csv,.md,.markdown,.html,.htm"></label><label class="db-field"><span>HTML 收藏页类型</span><select class="db-control" id="douban-import-domain"><option value="">自动识别</option><option value="screen">影视</option><option value="book">书籍</option><option value="music">音乐</option></select></label></div><label class="db-import-check"><input id="douban-import-completed" type="checkbox"><span>这些资料属于上方主页，导入的是已看过、已读过或已听过的记录。没有状态的条目按此确认处理；明确的想看、在看等记录仍会跳过。</span></label><p class="db-note">最多 100 个文件、合计 8 MiB；每个 HTML 文件最多 2 MiB；单次最多 500 条。文件需为 UTF-8 文本。文件只保留在本页内存，离开或刷新后需重新选择。导入不改变当前豆瓣连接。</p><div class="db-import-actions"><button class="db-btn" id="douban-import-preview" type="submit">解析并预览</button><button class="db-btn" id="douban-import-clear" type="button">清空本次资料</button></div></form><section id="douban-import-result" class="db-import-result" hidden aria-labelledby="douban-import-result-title"><h3 id="douban-import-result-title">导入预览</h3><p id="douban-import-counts" class="db-note"></p><ul id="douban-import-sample" class="db-import-sample"></ul><p id="douban-import-warnings" class="db-note"></p><p class="db-note">预览不会保存。确认导入后，已有记录中经你导入的个人评分、短评和标记日期会优先保留，后续公开同步不会用缺失值抹去。</p><button class="db-btn primary" id="douban-import-confirm" type="button" disabled>确认导入</button></section><button class="db-btn" id="douban-import-retry" type="button" hidden>重试原导入</button><p class="db-form-status" id="douban-import-status" role="status" aria-live="polite"></p></details>';

export const DOUBAN_CSS = String.raw`
:root{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit;color:inherit}a{color:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.48}[hidden]{display:none!important}.db-main{width:100%;max-width:1440px;min-width:0;padding:32px;margin:0 auto}.db-heading,.db-section-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}.db-heading{margin-bottom:24px}.db-heading h1{font-size:28px;font-weight:650;margin:0}.db-heading>a{text-decoration:none}.db-btn{display:inline-flex;justify-content:center;align-items:center;min-height:42px;padding:9px 13px;border:1px solid var(--line);border-radius:9px;background:var(--paper);color:var(--primary-hover);font:inherit;font-size:13px;text-decoration:none;white-space:nowrap}.db-btn:hover:not(:disabled){background:var(--hover)}.db-btn.primary{background:var(--primary);border-color:var(--primary);color:var(--paper)}.db-connection{padding:22px;border:1px solid var(--line);border-radius:13px;background:var(--paper);margin-bottom:28px}.db-section-heading h2{font-size:17px;font-weight:600;margin:0}.db-section-heading p{font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.8;overflow-wrap:anywhere}.db-sync-actions{display:flex;gap:8px;flex-wrap:wrap}.db-connection details{margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}.db-connection summary{cursor:pointer;font-size:13px;color:var(--primary-hover);min-height:24px}.db-profile-fields{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}.db-profile-fields input{min-width:180px;flex:1}.db-connection form{margin-top:13px}.db-connection form>label{font-size:12px;color:var(--muted)}.db-control{min-height:42px;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--paper);padding:9px 11px;width:100%;font-size:13px}.db-note{font-size:12px!important;color:var(--muted);line-height:1.85;overflow-wrap:anywhere;margin:10px 0 0}.db-form-status,.db-sync-status,.db-status{font-size:13px;color:var(--muted);line-height:1.8;overflow-wrap:anywhere;margin:12px 0 0;white-space:pre-line}.db-form-status.error,.db-status.error{color:var(--red)}.db-sync-status{color:var(--primary-hover)}.db-sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:13px}.db-source{border:1px solid var(--line);border-radius:9px;padding:11px 12px;background:var(--subtle)}.db-source strong{font-size:12px;font-weight:600}.db-source p{font-size:11px;line-height:1.8;color:var(--muted);margin:5px 0 0;overflow-wrap:anywhere}.db-import-panel>summary{font-size:15px;font-weight:600;color:var(--ink);cursor:pointer}.db-import-fields{display:grid;grid-template-columns:1fr 1fr 170px;gap:12px;margin:16px 0}.db-import-check{display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.9;color:var(--muted);margin-top:14px}.db-import-check input{flex:none;width:17px;height:17px;accent-color:var(--primary);margin-top:4px}.db-import-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.db-import-result{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}.db-import-result h3{font-size:15px;font-weight:600;margin:0}.db-import-sample{padding-left:20px;font-size:12px;line-height:2;color:var(--muted)}.db-import-sample li{overflow-wrap:anywhere}.db-import-panel #douban-import-confirm,.db-import-panel #douban-import-retry{margin-top:12px}.db-run-counts{font-size:12px;line-height:1.8;color:var(--muted);margin:11px 0 0}.db-toolbar{display:grid;grid-template-columns:minmax(160px,1fr) 170px 185px auto;gap:10px;align-items:end;margin:18px 0}.db-field{display:grid;min-width:0;gap:6px}.db-field>span{font-size:12px;color:var(--muted)}.db-status:empty{display:none}.db-grid{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.db-card{min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--paper);overflow:hidden}.db-card-open{width:100%;height:100%;display:grid;grid-template-columns:68px minmax(0,1fr);gap:14px;text-align:left;border:0;background:transparent;padding:16px;color:var(--ink);font:inherit}.db-card-open:hover{background:var(--hover)}.db-cover{position:relative;width:68px;height:94px;display:flex;align-items:center;justify-content:center;border-radius:6px;overflow:hidden;background:var(--subtle);color:var(--muted);border:1px solid var(--line);font-size:12px}.db-cover img{width:100%;height:100%;object-fit:cover}.db-cover-placeholder{padding:8px;text-align:center;line-height:1.6}.db-card-copy{min-width:0}.db-card h3{font-size:14px;font-weight:600;line-height:1.65;margin:0 0 6px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.db-meta{font-size:11px;color:var(--muted);line-height:1.8;margin:3px 0;overflow-wrap:anywhere}.db-rating{color:var(--primary-hover)}.db-comment{font-size:12px;color:var(--muted);line-height:1.75;margin:8px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.db-empty{padding:34px 22px;border:1px dashed var(--line);border-radius:12px;background:var(--paper);text-align:center;margin-top:16px}.db-empty h3{font-size:16px;font-weight:500;margin:0 0 8px}.db-empty p{font-size:13px;color:var(--muted);line-height:1.8;margin:0}.db-pagination{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:20px}.db-pagination span{font-size:12px;color:var(--muted)}.db-dialog{width:min(620px,calc(100vw - 28px));max-height:85dvh;overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper);color:var(--ink);padding:22px}.db-dialog::backdrop{background:rgb(21 33 52 / .32)}.db-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.db-dialog-head h2{font-size:20px;line-height:1.6;margin:0;overflow-wrap:anywhere}.db-detail-values{margin:18px 0 0;display:grid;gap:12px}.db-detail-values div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;line-height:1.8}.db-detail-values dt{font-size:12px;color:var(--muted)}.db-detail-values dd{font-size:13px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.db-detail-link{display:inline-flex;margin-top:20px;color:var(--primary-hover);font-size:13px}.db-btn:focus-visible,.db-card-open:focus-visible,.db-control:focus-visible,summary:focus-visible{outline:2px solid var(--primary);outline-offset:3px}@media(max-width:1180px){.db-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:980px){.db-main{padding:24px}}@media(max-width:700px){.db-main{padding:20px 16px}.db-import-fields{grid-template-columns:1fr}.db-heading h1{font-size:24px}.db-connection{padding:17px}.db-toolbar{grid-template-columns:1fr 1fr}.db-toolbar .db-field:first-child{grid-column:1/-1}.db-toolbar .db-btn{grid-column:1/-1}.db-control{font-size:16px}.db-sources{grid-template-columns:1fr}.db-grid{grid-template-columns:1fr}.db-sync-actions{width:100%}.db-card-open{grid-template-columns:62px minmax(0,1fr);padding:14px;gap:12px}.db-cover{width:62px;height:86px}.db-dialog{padding:18px}.db-profile-fields input{flex-basis:100%}.db-pagination{gap:8px}}
`;

export function renderDoubanScript(): string {
  return '<script type="module">' + CLIENT_REQUEST_SCRIPT + DOUBAN_SCRIPT + '</script>';
}

/** Raw browser source remains self-contained after minification. */
export const DOUBAN_SCRIPT = String.raw`
(()=>{
const el=id=>document.getElementById('douban-'+id),pageSize=24;
const kinds={movie:'电影',series:'电视剧',book:'书籍',music:'音乐',screen:'待分类影视'},sourceNames={collection:'公开收藏页',rss:'近期 RSS',import:'资料导入'};
const importState={busy:false,sequence:0,items:null,profileId:null,preview:null,fingerprint:null,pending:null,touched:false,baseline:''};
const state={connection:null,profileBaseline:'',profileRevision:0,profileConflict:false,profileBusy:false,items:[],total:0,counts:{},kind:'',query:'',scope:'all',offset:0,hasMore:false,loading:false,loadSequence:0,controller:null,run:null,syncing:false,stop:false,trigger:null};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const changedAccount=()=>Boolean(window.JiashuAccountSession?.changed);
const profileDirty=()=>el('profile').value!==state.profileBaseline;
let guard=null,importGuard=null;
function canonicalProfile(id){return typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)?'https://www.douban.com/people/'+id+'/':null;}
function subjectURL(item){const domain={screen:'movie',book:'book',music:'music'}[item?.domain];return domain&&typeof item.subjectId==='string'&&/^[1-9][0-9]{0,15}$/.test(item.subjectId)?'https://'+domain+'.douban.com/subject/'+item.subjectId+'/':null;}
function coverURL(raw){try{if(typeof raw!=='string'||raw.length>2000)return null;const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&/^img[0-9]*\.doubanio\.com$/.test(url.hostname)?url.href:null;}catch{return null;}}
function dateText(value){if(typeof value!=='string'||!value)return'未提供';const date=new Date(value);return Number.isNaN(date.getTime())?'未提供':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);}
function rating(value){return Number.isInteger(value)&&value>=1&&value<=5?'个人评分 '+value+' / 5':'未评分';}
function status(message,error=false){el('status').textContent=message||'';el('status').classList.toggle('error',error);el('retry').hidden=!error;}
function profileStatus(message,error=false){el('profile-status').textContent=message||'';el('profile-status').classList.toggle('error',error);}
function controls(){
 const locked=changedAccount()||state.profileBusy||state.syncing||importState.busy||Boolean(importState.pending);
 el('profile').disabled=locked||!state.connection&&state.loading;el('save').disabled=locked||!state.connection||state.profileConflict;el('disconnect').disabled=locked||!state.connection?.profileId||state.profileConflict;
 el('sync').disabled=locked||state.loading||!state.connection?.profileId||state.profileConflict||profileDirty();el('stop').hidden=!state.syncing;el('stop').disabled=state.stop;
 el('sync').textContent=state.syncing?'正在同步…':state.run?.status==='running'&&state.run.connectionRevision===state.connection?.revision?'继续同步公开记录':'同步公开记录';
 el('stop').textContent=state.stop?'暂停中…':'暂停';el('reload-profile').disabled=locked;
 el('previous').disabled=state.loading||state.syncing||state.offset===0;el('next').disabled=state.loading||state.syncing||!state.hasMore;for(const id of ['query','kind','scope','search','retry'])el(id).disabled=state.syncing||changedAccount();importControls();
}
function resetProfile(connection){state.profileBaseline=canonicalProfile(connection.profileId)||'';state.profileRevision=connection.revision;state.profileConflict=false;el('profile').value=state.profileBaseline;guard?.reset();el('reload-profile').hidden=true;}
function presentConnection(connection,preserve){
 if(!connection||!integer(connection.revision)||(connection.profileId!==null&&!canonicalProfile(connection.profileId)))throw new Error('豆瓣连接格式暂时无法读取。');
 const dirty=profileDirty(),revisionChanged=state.connection&&connection.revision!==state.profileRevision;
 state.connection=connection;
 if(!preserve||!dirty)resetProfile(connection);else if(revisionChanged){state.profileConflict=true;el('reload-profile').hidden=false;profileStatus('连接已在其他页面更新。填写已保留，请读取最新连接后核对。',true);}
 const url=canonicalProfile(connection.profileId);el('connection-summary').textContent=url?'已关联主页 '+connection.profileId+' · 仅当前网站账户可见':'填写豆瓣主页，手动同步公开的已完成标记。';el('profile-link').hidden=!url;if(url)el('profile-link').href=url;
 if(url&&!importState.touched&&!el('import-profile').value){el('import-profile').value=url;importState.baseline=url;importGuard?.reset();}
 if(!url){el('profile-settings').open=true;el('profile-settings').setAttribute('open','');}
}
function renderRun(run){
 state.run=run||null;el('run-summary').hidden=!run;el('sources').hidden=!run;if(!run){el('sources').innerHTML='';return;}
 const labels={running:'同步尚未完成，可暂停后继续',completed:'公开记录同步完成',partial:'部分同步完成',failed:'本次未能完成同步'};
 const count=value=>integer(value)?value:0;
 el('sync-status').textContent=labels[run.status]||'同步结果待核对';
 const counts='新增 '+count(run.added)+' · 更新 '+count(run.updated)+' · 未变化 '+count(run.unchanged);
 el('run-summary').innerHTML='<p class="db-run-counts">'+esc(counts)+(run.updatedAt?' · '+esc(dateText(run.updatedAt)):'')+'</p>'+(typeof run.message==='string'?'<p class="db-note">'+esc(run.message)+'</p>':'');
 const statuses={pending:'待同步',complete:'已读取',blocked:'访问受限',failed:'读取失败',limited:'本次读取受限'};
 el('sources').innerHTML=['screen','book','music'].map(key=>{const data=run.sources?.[key]||{},title={screen:'影视收藏',book:'读过的书',music:'听过的音乐'}[key];return '<article class="db-source"><strong>'+title+' · '+(statuses[data.status]||'待核对')+'</strong><p>已读 '+count(data.pages)+' 页 · 获取 '+count(data.received)+' 条'+(integer(data.total)?' / 来源公布 '+data.total+' 条':'')+'</p></article>';}).join('');
 if(run.rss?.status==='complete')el('sources').innerHTML+='<article class="db-source"><strong>近期 RSS 补充</strong><p>本次获取 '+count(run.rss.received)+' 条近期完成标记；不代表历史全量。</p></article>';
 if(run.classification&&count(run.classification.unclassified)>0)el('sources').innerHTML+='<article class="db-source"><strong>影视类型待确认</strong><p>'+count(run.classification.unclassified)+' 条暂无法核实电影或电视剧类型，已保留记录。</p></article>';
}
function renderRecords(){
 const count=integer(state.total)?state.total:0;el('total').textContent='共 '+count+' 条'+(state.scope==='current'?' · 当前绑定主页':' · 全部已保存来源');
 for(const option of el('kind').querySelectorAll('option')){const kind=option.getAttribute('value');const label=kind?kinds[kind]:'全部类别',amount=state.counts[kind||'all'];option.textContent=label+(integer(amount)?'（'+amount+'）':'');}
 el('empty').hidden=state.items.length>0;el('empty-text').textContent=state.query||state.kind?'没有符合当前筛选的记录，可试试其他名称或类别。':state.scope==='current'&&!state.connection?.profileId?'尚未绑定豆瓣主页；原来源的资料仍可在“全部已保存来源”查看。':'保存豆瓣主页后，点击“同步公开记录”。受限来源会明确显示，不会当作空收藏。';
 el('list').innerHTML=state.items.map((item,index)=>{const cover=item.source==='import'?null:coverURL(item.coverUrl),kind=kinds[item.kind]||'待分类',profile=canonicalProfile(item.profileId)?item.profileId:'未注明';
 return '<li class="db-card"><button class="db-card-open" type="button" data-douban-open="'+index+'" aria-label="'+esc('查看'+item.title+'的记录详情')+'"><span class="db-cover">'+(cover?'<img src="'+esc(cover)+'" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt=""><span class="db-cover-placeholder" hidden>'+esc(kind)+'</span>':'<span class="db-cover-placeholder">'+esc(kind)+'</span>')+'</span><span class="db-card-copy"><h3>'+esc(item.title)+'</h3><p class="db-meta">'+esc(kind)+' · '+esc(sourceNames[item.source]||'豆瓣资料')+'</p><p class="db-meta db-rating">'+esc(rating(item.rating))+'</p><p class="db-meta">标记日期 '+esc(item.markedDate||'未提供')+'</p><p class="db-meta">来源 '+esc(profile)+'</p>'+(item.comment?'<p class="db-comment">'+esc(item.comment)+'</p>':'')+'</span></button></li>';}).join('');
 for(const image of el('list').querySelectorAll('img'))image.addEventListener('error',()=>{image.hidden=true;image.removeAttribute('src');const fallback=image.parentElement.querySelector('.db-cover-placeholder');if(fallback)fallback.hidden=false;});
 el('pagination').hidden=state.total<=pageSize;el('page-number').textContent='第 '+(Math.floor(state.offset/pageSize)+1)+' / '+Math.max(1,Math.ceil(state.total/pageSize))+' 页';controls();
}
function readLocation(){const params=new URLSearchParams(location.search),offset=params.get('offset'),kind=params.get('kind');state.query=(params.get('q')||'').slice(0,100).trim();state.kind=Object.hasOwn(kinds,kind)?kind:'';state.scope=params.get('profile')==='current'?'current':'all';state.offset=offset&&/^(0|[1-9]\d*)$/.test(offset)&&integer(Number(offset))?Math.floor(Number(offset)/pageSize)*pageSize:0;el('query').value=state.query;el('kind').value=state.kind;el('scope').value=state.scope;}
function syncUrl(push=false){const params=new URLSearchParams();if(state.query)params.set('q',state.query);if(state.kind)params.set('kind',state.kind);if(state.scope!=='all')params.set('profile',state.scope);if(state.offset)params.set('offset',state.offset);const path='/life/douban'+(params.size?'?'+params:'');history[push?'pushState':'replaceState'](null,'',path);}
async function load(preserve=true){
 if(changedAccount())return;const sequence=++state.loadSequence;state.controller?.abort();const controller=new AbortController();state.controller=controller;state.loading=true;el('page').setAttribute('aria-busy','true');status('正在读取已保存的书影音…');controls();
 try{const params=new URLSearchParams({offset:state.offset,limit:pageSize,profile:state.scope});if(state.kind)params.set('kind',state.kind);if(state.query)params.set('q',state.query);const data=await requestJSON('/api/life/douban?'+params,{signal:controller.signal});if(sequence!==state.loadSequence||changedAccount())return;
  if(!Array.isArray(data.items)||!integer(data.total)||data.items.length>60||!data.counts||data.items.some(item=>!item||typeof item.title!=='string'||!subjectURL(item)))throw new Error('书影音记录格式暂时无法读取。');if(data.total>0&&state.offset>=data.total){state.offset=0;syncUrl();return load(preserve);}presentConnection(data.connection,preserve);state.items=data.items;state.total=data.total;state.counts=data.counts;state.hasMore=data.hasMore===true;renderRun(data.lastRun);renderRecords();status('');syncUrl();
 }catch(error){if(sequence===state.loadSequence&&error?.name!=='AbortError')status(error.message||'暂时无法读取书影音，请稍后重试。',true);}
 finally{if(sequence===state.loadSequence){state.loading=false;state.controller=null;el('page').setAttribute('aria-busy','false');controls();}}
}
async function saveProfile(disconnect=false){
 if(state.profileBusy||state.syncing||changedAccount()||!state.connection||state.profileConflict)return;
 if(disconnect&&profileDirty()){profileStatus('有未保存的主页填写，请先保存或读取原连接后再断开。',true);return;}
 const profile=disconnect?null:el('profile').value.trim();if(!disconnect&&!profile){profileStatus('先填写自己的豆瓣主页或 ID。',true);el('profile').focus();return;}
 state.profileBusy=true;controls();profileStatus(disconnect?'正在断开连接…':'正在保存主页关联…');
 try{const data=await requestJSON('/api/life/douban/connection',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile,expectedRevision:state.profileRevision})});if(changedAccount())return;presentConnection(data.connection,false);guard?.saved();renderRun(null);state.offset=0;profileStatus(disconnect?'连接已断开，已保存资料仍保留。':'连接已保存。点击“同步公开记录”才会开始读取豆瓣。');await load(true);}
 catch(error){guard?.failed();if(error?.status===409){state.profileConflict=true;el('reload-profile').hidden=false;}profileStatus(error.message||'连接保存未确认，填写已保留，请读取最新连接。',true);}
 finally{state.profileBusy=false;controls();}
}
function validRun(run,connection){return run&&typeof run.id==='string'&&/^[0-9a-f-]{36}$/i.test(run.id)&&integer(run.revision)&&run.profileId===connection.profileId&&run.connectionRevision===connection.revision&&['running','completed','partial','failed'].includes(run.status);}
async function beginSync(){
 if(el('sync').disabled||state.syncing||changedAccount())return;const connection=state.connection;state.syncing=true;state.stop=false;controls();el('sync-status').textContent='正在开始或继续同步公开记录…';
 let errorMessage=null,finished=false;
 try{for(let step=0;step<20;step++){
  if(state.stop||changedAccount()||state.connection.revision!==connection.revision)break;
  const active=state.run?.status==='running'&&state.run.connectionRevision===connection.revision?state.run:null;
  const body={expectedConnectionRevision:connection.revision,...(active?{runId:active.id,expectedRunRevision:active.revision}:{})};
  const result=await requestJSON('/api/life/douban/sync',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(changedAccount()||state.connection.revision!==connection.revision)return;if(!result.connection||result.connection.revision!==connection.revision||!validRun(result.run,connection))throw new Error('同步结果未能核对，请重新读取已保存的结果后继续。');
  renderRun(result.run);controls();if(result.more!==true||result.run.status!=='running'){finished=true;break;}if(state.stop)break;
  if(step<19)await new Promise(resolve=>setTimeout(resolve,1500));
 }}catch(error){errorMessage=error?.status===429?(error.message||'本次同步请求较快。')+(error.retryAfter?' 请至少 '+error.retryAfter+' 秒后手动继续。':' 请稍后手动继续。'):error.message||'同步结果暂未确认，请读取最新结果后继续。';}
 finally{state.syncing=false;controls();if(!changedAccount()){await load(true);if(errorMessage)el('sync-status').textContent=errorMessage;else if(!finished)el('sync-status').textContent=state.stop?'已暂停，已获取的记录和进度已保存。可点击继续同步。':'本批已完成，仍有待处理记录。点击“继续同步公开记录”继续。';state.stop=false;controls();}}
}
function showDetail(index,trigger){const item=state.items[index];if(!item)return;state.trigger=trigger;el('detail-title').textContent=item.title;const rows=[['类别',kinds[item.kind]||'待分类'],['个人评分',rating(item.rating)],['豆瓣标记日期',item.markedDate||'未提供'],['豆瓣动态时间',item.publishedAt?dateText(item.publishedAt):'未提供'],['个人短评',item.comment||'未填写'],['来源主页',item.profileId||'未注明'],['采集来源',sourceNames[item.source]||'豆瓣资料'],['最后同步',dateText(item.observedAt||item.updatedAt)]];
 el('detail-body').innerHTML='<dl class="db-detail-values">'+rows.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl>'+(subjectURL(item)?'<a class="db-detail-link" href="'+esc(subjectURL(item))+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">在豆瓣查看条目 ↗</a>':'')+(item.kind==='screen'?'<p class="db-note">详情暂未确认电影或电视剧类型，因此保留为待分类影视。</p>':'');el('detail-dialog').showModal();el('detail-close').focus();
}
function importFiles(){return Array.from(el('import-files').files||[]);}
function importDirty(){return Boolean(importFiles().length||importState.items||importState.preview||importState.pending||el('import-profile').value!==importState.baseline||el('import-completed').checked||el('import-domain').value);}
function importFingerprint(){return JSON.stringify([el('import-profile').value,el('import-domain').value,el('import-completed').checked,importFiles().map(file=>[file.name,file.size,file.lastModified])]);}
function importStatus(message,error=false){el('import-status').textContent=message||'';el('import-status').classList.toggle('error',error);}
function importControls(){
 const pending=Boolean(importState.pending),locked=importState.busy||pending||state.syncing||state.profileBusy||changedAccount();
 for(const id of ['import-profile','import-files','import-domain','import-completed'])el(id).disabled=locked;
 el('import-preview').disabled=locked;el('import-clear').disabled=locked;el('import-retry').hidden=!pending;el('import-retry').disabled=importState.busy||state.syncing||changedAccount();
 el('import-confirm').disabled=locked||!importState.preview||importState.fingerprint!==importFingerprint()||!el('import-completed').checked;
}
function invalidateImport(){if(importState.pending)return;importState.sequence++;importState.items=null;importState.profileId=null;importState.preview=null;importState.fingerprint=null;el('import-result').hidden=true;for(const id of ['import-counts','import-sample','import-warnings'])el(id).textContent='';importControls();}
function clearImport(force=false){
 if(importState.busy||importState.pending&&!force)return;
 importState.sequence++;importState.items=null;importState.profileId=null;importState.preview=null;importState.fingerprint=null;importState.pending=null;importState.touched=false;el('import-files').value='';el('import-domain').value='';el('import-completed').checked=false;el('import-result').hidden=true;for(const id of ['import-counts','import-sample','import-warnings'])el(id).textContent='';importState.baseline=el('import-profile').value;importGuard?.reset();controls();
}
function readImportProfile(){
 const raw=el('import-profile').value.trim();if(canonicalProfile(raw))return raw;
 let url;try{url=new URL(raw);}catch{throw new Error('请填写导出资料所属的豆瓣主页或 ID。');}
 const match=/^\/people\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/.exec(url.pathname);
 if(url.protocol!=='https:'||!['douban.com','www.douban.com'].includes(url.hostname)||url.username||url.password||url.port||url.search||url.hash||!match||/[%\\?#]/.test(raw)||/^https:\/\/[^/?#]*:/i.test(raw))throw new Error('请填写不含额外参数的豆瓣个人主页链接或 ID。');
 return match[1];
}
function importBodyFits(body){if(new TextEncoder().encode(JSON.stringify(body)).byteLength>4*1024*1024)throw new Error('规范化后的导入记录超过 4 MiB，请减少本次文件后重试。');}
async function previewImport(){
 if(importState.busy||importState.pending||state.syncing||state.profileBusy||changedAccount())return;
 let profileId,files;try{profileId=readImportProfile();files=importFiles();if(!files.length)throw new Error('先选择本人导出的文件。');if(!el('import-completed').checked)throw new Error('请先确认资料所属主页和已完成标记。');if(files.length>100||files.reduce((sum,file)=>sum+file.size,0)>8*1024*1024)throw new Error('每次最多 100 个文件、合计 8 MiB。');}catch(error){importStatus(error.message,true);return;}
 invalidateImport();importState.busy=true;importState.touched=true;const sequence=++importState.sequence,stamp=importFingerprint(),domain=el('import-domain').value;controls();importStatus('正在本地解析文件，再核对本站已有记录…');
 try{
  if(!window.JiashuDoubanImport?.parse)throw new Error('本地导入解析器暂不可用，请刷新后重试。');
  const localFiles=await Promise.all(files.map(async file=>{let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('文件无法按 UTF-8 读取，请将文件另存为 UTF-8 后重试。');}return{name:file.name,text,...(domain&&/\.html?$/i.test(file.name)?{domain}:{})};}));
  if(sequence!==importState.sequence||changedAccount()||stamp!==importFingerprint())return;
  const parsed=await window.JiashuDoubanImport.parse(localFiles,{profileId,confirmCompleted:true});
  if(sequence!==importState.sequence||changedAccount()||stamp!==importFingerprint())return;
  if(!Array.isArray(parsed?.items)||!parsed.items.length)throw new Error('没有可导入的已完成记录。请核对导出文件、状态和所属类型。');
  if(parsed.items.length>500||parsed.items.some(item=>item?.source!=='import'||!subjectURL(item)))throw new Error('导入记录格式或数量不符合要求，请核对文件。');
  const body={action:'preview',profile:profileId,items:parsed.items};importBodyFits(body);
  const result=await requestJSON('/api/life/douban/import',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(sequence!==importState.sequence||changedAccount()||stamp!==importFingerprint())return;const preview=result.preview;
  if(!preview||preview.profileId!==profileId||preview.total!==parsed.items.length||!['added','updated','unchanged'].every(key=>integer(preview[key]))||typeof preview.snapshotHash!=='string'||!/^[a-f0-9]{64}$/i.test(preview.snapshotHash))throw new Error('导入预览未能核对，请重新预览。');
  importState.items=parsed.items;importState.profileId=profileId;importState.preview=preview;importState.fingerprint=stamp;
  el('import-counts').textContent='主页 '+profileId+' · '+preview.total+' 条记录：新增 '+preview.added+'、更新 '+preview.updated+'、未变化 '+preview.unchanged+'。';
  el('import-sample').innerHTML=parsed.items.slice(0,8).map(item=>'<li>'+esc(item.title)+' · '+esc(kinds[item.kind]||'待分类影视')+' · '+esc(rating(item.rating))+(item.markedDate?' · 标记 '+esc(item.markedDate):'')+'</li>').join('');
  const warnings=Array.isArray(parsed.warnings)?parsed.warnings.filter(value=>typeof value==='string').slice(0,8):[];
  el('import-warnings').textContent='本地跳过 '+(integer(parsed.skipped)?parsed.skipped:0)+' 条，去重 '+(integer(parsed.duplicates)?parsed.duplicates:0)+' 条。'+warnings.join(' ');
  el('import-result').hidden=false;importStatus('预览完成，尚未保存。核对所属主页、记录和更新数量后，点击“确认导入”。');
 }catch(error){if(sequence===importState.sequence&&!changedAccount())importStatus(error.message||'本次预览未完成，原文件仍在本页，可调整后重试。',true);}
 finally{importState.busy=false;controls();}
}
async function commitImport(retry=false){
 if(importState.busy||state.syncing||state.profileBusy||changedAccount())return;
 if(!retry){if(!importState.preview||!importState.items||importState.fingerprint!==importFingerprint()||!el('import-completed').checked)return;try{const body={action:'commit',profile:importState.profileId,items:importState.items,expectedSnapshotHash:importState.preview.snapshotHash,requestId:crypto.randomUUID(),confirmed:true};importBodyFits(body);importState.pending=JSON.parse(JSON.stringify(body));}catch(error){importStatus(error.message||'无法创建安全的导入提交，请保留本页重试。',true);return;}}
 const body=importState.pending;if(!body)return;importState.busy=true;controls();importStatus(retry?'正在重试原导入，不会新建重复提交…':'正在保存已确认的导入记录…');
 try{
  const result=await requestJSON('/api/life/douban/import',{method:'POST',timeoutMs:65000,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(changedAccount())return;
  const receipt=result.receipt;if(!receipt||receipt.profileId!==body.profile||receipt.requestId!==body.requestId||receipt.total!==body.items.length||!['added','updated','unchanged'].every(key=>integer(receipt[key])))throw new Error('导入回执未能核对，请保留本页并重试原导入。');
  importState.busy=false;clearImport(true);importGuard?.saved();importStatus('导入已保存：新增 '+receipt.added+'、更新 '+receipt.updated+'、未变化 '+receipt.unchanged+' 条。');state.offset=0;state.scope='all';state.kind='';state.query='';el('scope').value='all';el('kind').value='';el('query').value='';await load(true);
 }catch(error){
  if(!changedAccount()){importGuard?.failed();if([400,409,413,415,422].includes(error?.status)){importState.pending=null;invalidateImport();importStatus((error.message||'本次导入未写入。')+' 请重新预览后确认。',true);}else importStatus((error.message||'导入结果暂未确认。')+' 请保留本页，点击“重试原导入”核对同一提交。',true);}
 }finally{importState.busy=false;controls();}
}
guard=window.JiashuDraftGuards?.register({form:el('profile-form'),label:'豆瓣主页关联',durable:false,isDirty:profileDirty,isBusy:()=>state.profileBusy||state.syncing,isBlocked:()=>state.profileBusy||state.syncing,canSave:()=>!state.profileConflict&&!changedAccount(),onDiscard:()=>{el('profile').value=state.profileBaseline;controls();}})||null;
importGuard=window.JiashuDraftGuards?.register({form:el('import-form'),label:'书影音导入资料与待确认提交',durable:false,isDirty:importDirty,isBusy:()=>importState.busy,isBlocked:()=>importState.busy,canSave:()=>false,onDiscard:()=>clearImport(true)})||null;
el('profile').addEventListener('input',()=>{el('reload-profile').hidden=!profileDirty()&&!state.profileConflict;controls();if(profileDirty())profileStatus('主页填写尚未保存。保存只更新关联，不会开始同步。');});
el('profile-form').addEventListener('submit',event=>{event.preventDefault();saveProfile(false);});el('disconnect').addEventListener('click',()=>saveProfile(true));
el('reload-profile').addEventListener('click',()=>{if(state.profileBusy||state.syncing)return;const reload=()=>{resetProfile(state.connection);load(false);};if(guard?.confirm)guard.confirm(reload);else if(!profileDirty())reload();else profileStatus('填写尚未保存，请先保存，或还原为已保存主页后重读。',true);});
el('sync').addEventListener('click',beginSync);el('stop').addEventListener('click',()=>{if(state.syncing){state.stop=true;el('sync-status').textContent='正在完成当前一步，随后暂停。';controls();}});
el('retry').addEventListener('click',()=>{if(!state.syncing&&!changedAccount())load(true);});
el('import-form').addEventListener('submit',event=>{event.preventDefault();previewImport();});el('import-confirm').addEventListener('click',()=>commitImport(false));el('import-retry').addEventListener('click',()=>commitImport(true));el('import-clear').addEventListener('click',()=>{clearImport();importStatus('本次文件和预览已从本页清空。');});
for(const id of ['import-profile','import-files','import-domain','import-completed'])for(const eventName of ['input','change'])el(id).addEventListener(eventName,()=>{if(importState.pending)return;importState.touched=true;invalidateImport();importStatus('资料或导入选项已修改，请重新预览。');});
el('search-form').addEventListener('submit',event=>{event.preventDefault();state.query=el('query').value.trim().slice(0,100);state.kind=Object.hasOwn(kinds,el('kind').value)?el('kind').value:'';state.scope=el('scope').value==='current'?'current':'all';state.offset=0;syncUrl(true);load(true);});
for(const id of ['kind','scope'])el(id).addEventListener('change',()=>{state.kind=Object.hasOwn(kinds,el('kind').value)?el('kind').value:'';state.scope=el('scope').value==='current'?'current':'all';state.offset=0;syncUrl(true);load(true);});
el('previous').addEventListener('click',()=>{if(state.loading||state.offset===0)return;state.offset=Math.max(0,state.offset-pageSize);syncUrl(true);load(true);});el('next').addEventListener('click',()=>{if(state.loading||!state.hasMore)return;state.offset+=pageSize;syncUrl(true);load(true);});
el('list').addEventListener('click',event=>{const button=event.target.closest('[data-douban-open]');if(button&&el('list').contains(button))showDetail(Number(button.dataset.doubanOpen),button);});
el('detail-close').addEventListener('click',()=>el('detail-dialog').close());el('detail-dialog').addEventListener('close',()=>{if(state.trigger?.isConnected)state.trigger.focus();});
window.addEventListener('popstate',()=>{readLocation();load(true);});document.addEventListener('jiashu-account-changed',()=>{state.stop=true;state.controller?.abort();state.loadSequence++;importState.sequence++;state.loading=false;el('page').setAttribute('aria-busy','false');status('登录账号已变化，请刷新后继续。',true);controls();});
readLocation();load(false);
})();
`;
