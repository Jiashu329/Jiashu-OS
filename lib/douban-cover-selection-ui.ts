/** All dependencies stay inside this function so it can be embedded in the page. */
export function normalizePreviewCoverUrl(value: unknown): string {
  const invalid = () => { throw new Error('请填写公开的 HTTPS 图片链接，不含账户密码、本机地址或非标准端口。'); };
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !host.includes('.')
    || host.startsWith('[') || /^[0-9.]+$/.test(host) || !/^[a-z0-9.-]+$/.test(host)
    || host.endsWith('.') || host.split('.').some(part => !part || part.startsWith('-') || part.endsWith('-'))
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return invalid();
  url.hash = '';
  if (url.href.length > 2000) return invalid();
  return url.href;
}

export const DOUBAN_COVER_SELECTION_CSS = String.raw`
.db-cover-editor{margin-top:18px;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--paper)}.db-cover-editor>summary{cursor:pointer;min-height:28px;line-height:1.8;font-size:13px;color:var(--primary-hover)}.db-cover-form{display:grid;gap:13px;padding-top:12px}.db-cover-form .db-note,.db-cover-form .db-form-status{margin:0}.db-cover-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.db-cover-preview{display:flex;align-items:flex-start;gap:14px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--subtle)}.db-cover-preview img{display:block;max-width:110px;max-height:160px;object-fit:contain;flex:none;border-radius:4px}.db-cover-preview p{min-width:0;line-height:1.8;font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin:0}.db-cover-form select:focus-visible,.db-cover-form input:focus-visible{outline:2px solid var(--primary);outline-offset:2px}@media(max-width:700px){.db-cover-editor{padding:11px 12px}.db-cover-form .db-control{font-size:16px}.db-cover-actions .db-btn{min-height:44px;flex:1 1 120px}.db-cover-preview{gap:12px}.db-cover-preview img{max-width:92px;max-height:140px}}
`;

export function renderDoubanCoverSelectionScript(): string {
  return '<script>' + DOUBAN_COVER_SELECTION_SCRIPT + '</script>';
}

export const DOUBAN_COVER_SELECTION_SCRIPT = String.raw`
(()=>{
 const normalize=${normalizePreviewCoverUrl.toString()};
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const key=item=>JSON.stringify([item?.profileId,item?.domain,item?.subjectId]);
 const cover=item=>item?.cover?.mode==='url'&&typeof item.cover.url==='string'?{mode:'url',url:item.cover.url}:{mode:'original',url:''};
 window.JiashuDoubanCoverSelectionUI={create(options){
  let form=null,editor=null,active=null,baseline='',guard=null,busy=false,conflict=false,sequence=0,previewSequence=0,previewUrl='',previewState='idle';
  const changed=()=>options.isAccountChanged?.()===true||window.JiashuAccountSession?.changed===true;
  const locked=()=>busy||changed()||options.isLocked?.()===true;
  const field=selector=>form?.querySelector(selector);
  const mode=()=>field('[data-douban-cover-mode]')?.value;
  const fingerprint=()=>form?JSON.stringify([mode(),mode()==='url'?field('[data-douban-cover-url]').value:'']):'';
  const dirty=()=>Boolean(form&&fingerprint()!==baseline);
  function status(text,error=false){const node=field('[data-douban-cover-status]');if(node){node.textContent=text;node.classList.toggle('error',error);}}
  function previewMessage(text,error=false){const node=field('[data-douban-cover-preview-status]');if(node){node.textContent=text;node.classList.toggle('error',error);}}
  function update(){
   if(!form)return;const blocked=locked()||conflict,usingUrl=mode()==='url';
   for(const node of form.querySelectorAll('button,input,select'))node.disabled=blocked;
   field('[data-douban-cover-url-field]').hidden=!usingUrl;
   field('[data-douban-cover-preview]').disabled=blocked||(!usingUrl&&!options.originalCoverURL?.(active));
   let verified=false;try{verified=usingUrl&&previewState==='loaded'&&normalize(field('[data-douban-cover-url]').value.trim())===previewUrl;}catch{}
   const save=field('[data-douban-cover-save]');save.disabled=blocked||!dirty()||usingUrl&&!verified||!['url','original'].includes(mode());save.textContent=busy?'保存中…':'保存封面';
   field('[data-douban-cover-original]').disabled=blocked||mode()==='original';
  }
  function notify(){options.onBusyChange?.(busy);options.onDirtyChange?.(dirty());update();}
  function clearPreview(){
   previewSequence++;previewUrl='';previewState='idle';const image=field('[data-douban-cover-preview-image]');if(image){image.onload=null;image.onerror=null;image.removeAttribute('src');image.hidden=true;}
   const panel=field('[data-douban-cover-preview-panel]');if(panel)panel.hidden=true;
  }
  function restore(){
   if(!form||!active)return;clearPreview();const saved=cover(active);field('[data-douban-cover-mode]').value=saved.mode;field('[data-douban-cover-url]').value=saved.url;baseline=fingerprint();status('填写已还原为当前已保存的封面设置。');previewMessage('未预览。点击“预览封面”后才会读取图片链接。');notify();
  }
  function detailHTML(item){const saved=cover(item);return '<details class="db-cover-editor" data-douban-cover-editor><summary>备用封面</summary><form class="db-cover-form" id="douban-cover-form" novalidate><p class="db-note">封面依次尝试豆瓣、TMDB、自定义图片链接。备用链接可选填，仅在豆瓣和 TMDB 封面都不可用时使用。</p><label class="db-field"><span>备用封面设置</span><select class="db-control" data-douban-cover-mode><option value="original"'+(saved.mode==='original'?' selected':'')+'>自动封面（无备用链接）</option><option value="url"'+(saved.mode==='url'?' selected':'')+'>填写备用图片链接</option></select></label><label class="db-field" data-douban-cover-url-field'+(saved.mode==='url'?'':' hidden')+'><span>备用 HTTPS 图片链接</span><input class="db-control" type="url" data-douban-cover-url maxlength="2000" autocomplete="off" spellcheck="false" placeholder="https://example.com/cover.jpg" value="'+esc(saved.url)+'"></label><div class="db-cover-actions"><button class="db-btn" type="button" data-douban-cover-preview>预览封面</button><button class="db-btn primary" type="submit" data-douban-cover-save disabled>保存封面</button><button class="db-btn" type="button" data-douban-cover-original>移除备用链接</button><button class="db-btn" type="button" data-douban-cover-reset>还原填写</button></div><div class="db-cover-preview" data-douban-cover-preview-panel hidden><img data-douban-cover-preview-image referrerpolicy="no-referrer" decoding="async" alt="待保存的封面预览" hidden><p data-douban-cover-preview-status role="status" aria-live="polite">未预览。点击“预览封面”后才会读取图片链接。</p></div><p class="db-note">预览成功后才可保存备用链接。保存链接不会改变封面尝试顺序，也可随时移除备用链接。</p><p class="db-form-status" data-douban-cover-status role="status" aria-live="polite"></p></form></details>';}
  function sameEpoch(epoch){return !changed()&&options.getDataEpoch()===epoch;}
  function preview(){
   if(!form||!active||locked()||conflict)return;let url;const usingUrl=mode()==='url';
   try{url=usingUrl?normalize(field('[data-douban-cover-url]').value.trim()):options.originalCoverURL?.(active);if(!url)throw new Error('自动封面暂时不可预览，仍可移除备用链接并保存。');}catch(error){status(error.message||'请核对图片链接。',true);return;}
   clearPreview();const token=++previewSequence,target=form,epoch=options.getDataEpoch(),original=key(active),image=field('[data-douban-cover-preview-image]');previewUrl=url;previewState='loading';field('[data-douban-cover-preview-panel]').hidden=false;previewMessage('正在预览封面…');status('预览不会保存。');
   const current=()=>token===previewSequence&&form===target&&sameEpoch(epoch)&&key(active)===original&&image.getAttribute('src')===url;
   image.onload=()=>{if(!current())return;previewState='loaded';image.hidden=false;previewMessage(usingUrl?'备用链接预览成功。保存后仅在豆瓣和 TMDB 封面都不可用时显示。':'自动封面预览成功。点击“保存封面”后将移除备用链接。');notify();};
   image.onerror=()=>{if(!current())return;previewState='failed';image.hidden=true;previewMessage(usingUrl?'备用链接无法读取，请更换可访问的图片链接，或移除备用链接。':'自动封面暂时无法读取，仍可保存并移除备用链接。',true);notify();};
   image.hidden=false;image.setAttribute('src',url);notify();
  }
  function validResult(item,original,chosen,url){const revision=item?.local?.revision;return item&&key(item)===key(original)&&Number.isSafeInteger(revision)&&revision>=0&&item.cover?.revision===revision&&item.cover.mode===chosen&&(chosen==='original'||item.cover.url===url);}
  async function save(){
   if(!form||!active||locked()||conflict||!dirty())return;const chosen=mode();if(!['original','url'].includes(chosen))return;
   let url;try{if(chosen==='url'){url=normalize(field('[data-douban-cover-url]').value.trim());if(previewState!=='loaded'||previewUrl!==url)throw new Error('请先成功预览当前备用图片链接，再保存封面。');}}catch(error){status(error.message||'请核对图片链接。',true);return;}
   const epoch=options.getDataEpoch(),original=active,target=form,revision=active.local?.revision??active.cover?.revision,token=++sequence,saveGuard=guard;
   if(!Number.isSafeInteger(epoch)||epoch<0||!Number.isSafeInteger(revision)||revision<0){status('封面资料版本暂无法核对，请重新读取收藏后操作。',true);return;}
   const body={profileId:original.profileId,domain:original.domain,subjectId:original.subjectId,expectedDataEpoch:epoch,expectedLocalRevision:revision,mode:chosen,...(chosen==='url'?{url}:{})};let completed=false;
   busy=true;notify();status('正在保存封面选择…');
   try{const result=await options.requestJSON('/api/life/douban/cover-selection',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(token!==sequence||form!==target||!sameEpoch(epoch))return;if(result.dataEpoch!==epoch||!validResult(result.item,original,chosen,url))throw new Error('封面保存回执暂无法核对，请保留本页并重试。');active=result.item;const saved=cover(active);field('[data-douban-cover-mode]').value=saved.mode;field('[data-douban-cover-url]').value=saved.url;if(chosen==='original')clearPreview();baseline=fingerprint();status(chosen==='url'?'备用封面链接已保存。':'备用链接已移除，将自动尝试豆瓣和 TMDB 封面。');await options.onSaved?.(result);completed=token===sequence&&form===target&&sameEpoch(epoch);}
   catch(error){if(token!==sequence||form!==target||changed())return;saveGuard?.failed();if(error?.status===409){conflict=true;status('封面或个人整理已在其他页面更新，或收藏已重置。填写已保留，请关闭详情并重新打开核对后保存。',true);}else status((error.message||'封面保存结果暂未确认。')+' 当前填写已保留，可重试核对同一选择。',true);}
   finally{if(token===sequence){busy=false;notify();if(completed)saveGuard?.saved();}}
  }
  function bindDetail(container,item){
   sequence++;clearPreview();guard?.dispose?.();guard=null;form=container.querySelector('#douban-cover-form');editor=container.querySelector('[data-douban-cover-editor]');active=item;busy=false;conflict=false;if(!form)return;
   const saved=cover(item);field('[data-douban-cover-mode]').value=saved.mode;field('[data-douban-cover-url]').value=saved.url;baseline=fingerprint();
   form.addEventListener('submit',event=>{event.preventDefault();if(locked()||conflict)return;if(options.beforeSave)options.beforeSave(save);else save();});
   form.addEventListener('input',event=>{if(event.target.matches('[data-douban-cover-url]')){clearPreview();status('备用链接填写尚未保存，请先预览。');notify();}});
   field('[data-douban-cover-mode]').addEventListener('change',()=>{clearPreview();status(mode()==='original'?'保存后将移除备用链接，自动尝试豆瓣和 TMDB 封面。':'请填写并预览备用图片链接。');notify();});
   field('[data-douban-cover-preview]').addEventListener('click',preview);
   field('[data-douban-cover-original]').addEventListener('click',()=>{if(locked()||conflict)return;field('[data-douban-cover-mode]').value='original';clearPreview();status('已选择移除备用链接，点击“保存封面”后生效。');notify();});
   field('[data-douban-cover-reset]').addEventListener('click',()=>{if(locked())return;restore();guard?.reset();});
   guard=window.JiashuDraftGuards?.register({form,trackWhenHidden:true,durable:false,label:'书影音封面选择',isActive:()=>Boolean(form)&&!changed(),isDirty:dirty,isBusy:()=>busy,isBlocked:()=>busy,canSave:()=>!locked()&&!conflict&&(mode()==='original'||previewState==='loaded'),onDiscard:()=>{if(!busy)restore();}})||null;notify();
  }
  function open(){if(!editor||changed())return;editor.open=true;const target=mode()==='url'?field('[data-douban-cover-url]'):field('[data-douban-cover-mode]');target?.focus?.();editor.scrollIntoView?.({block:'nearest'});}
  function updateItem(item){if(active&&key(item)===key(active)){active=item;update();}}
  function reset(){sequence++;clearPreview();guard?.dispose?.();guard=null;form=null;editor=null;active=null;baseline='';busy=false;conflict=false;notify();}
  document.addEventListener('jiashu-account-changed',reset);window.addEventListener('pagehide',reset);
  return {detailHTML,bindDetail,open,update,updateItem,reset,isBusy:()=>busy,isDirty:dirty,confirm(action){if(guard?.confirm)return guard.confirm(action);if(!dirty()&&!busy){action();return true;}return false;}};
 }};
})();
`;
