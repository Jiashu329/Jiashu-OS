/** Only an SSR owner activates this guard; a document never adopts a queried session as its baseline. */
export const ACCOUNT_SESSION_SCRIPT = String.raw`
if(!window.JiashuAccountSession||window.JiashuAccountSession.document!==document){
 window.JiashuAccountSession=(()=>{
  const transport=fetch;
  let owner='',changed=false,problem='',verification=null,attested=false,epoch=0,verificationController=null;
  const valid=(value)=>typeof value==='string'&&value.length>0&&value.length<=200&&!Array.from(value).some((character)=>character.charCodeAt(0)<32||character.charCodeAt(0)===127);
  const initial=window.__JIASHU_PAGE_SESSION__;
  const bootstrap=initial&&valid(initial.userId)&&initial.userId===window.__JIASHU_PAGE_OWNER__&&typeof initial.email==='string'&&typeof initial.displayName==='string'&&typeof initial.isOwner==='boolean'?initial:null;
  function failure(message,code='ACCOUNT_SESSION_UNAVAILABLE',status=503){const error=new Error(message);error.code=code;error.status=status;return error;}
  function markChanged(){if(!changed){changed=true;invalidate();problem='登录账号已变化。当前内容仍属于原账号，请刷新后继续；原账号的草稿和待确认操作已保留。';document.documentElement?.setAttribute('data-account-changed','');document.dispatchEvent(new Event('jiashu-account-changed'));}return failure(problem,'ACCOUNT_CHANGED',401);}
  function markSignedOut(){if(!changed){changed=true;invalidate();notifySignedOut();problem='登录状态已失效，请重新登录。';document.documentElement?.setAttribute('data-account-verifying','');document.dispatchEvent(new Event('jiashu-account-signed-out'));}return failure(problem,'SIGN_IN_REQUIRED',401);}
  function bind(id){if(!valid(id)||changed)return false;if(owner&&owner!==id){markChanged();return false;}if(!owner&&window.__JIASHU_PAGE_OWNER__!==id)return true;owner=id;return true;}
  function acceptIdentity(id){if(!bind(id))return false;attested=Boolean(owner);return true;}
  function invalidate(){attested=false;epoch++;verificationController?.abort();verification=null;verificationController=null;}
  let channel=null,announcedEnded=false;
  function notice(message){if(!owner||changed||!message||typeof message!=='object')return;if(message.kind==='signed-out'||message.kind==='identity'&&valid(message.owner)&&message.owner!==owner)markChanged();}
  function connect(){if(channel||typeof BroadcastChannel!=='function')return;try{channel=new BroadcastChannel('jiashu-session');channel.onmessage=(event)=>notice(event.data);}catch{}}
  function announce(kind='identity'){const message={kind,owner,nonce:String(Date.now())+':'+Math.random()};try{channel?.postMessage(message);}catch{}try{if(typeof localStorage!=='undefined')localStorage.setItem('jiashu:session-notice',JSON.stringify(message));}catch{}}
  function notifySignedOut(){if(!announcedEnded){announcedEnded=true;announce('signed-out');}}
  async function readIdentity(){
    if(changed)throw markChanged();if(!owner)throw failure('请刷新已登录页面后继续原操作。','ACCOUNT_SESSION_UNBOUND',401);if(verification)return verification;
    const generation=epoch;
    verification=(async()=>{
      const controller=new AbortController();verificationController=controller;let timer;
      const current=()=>{if(generation!==epoch)throw failure('登录核验已更新，请重试。');if(changed)throw markChanged();};
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('暂时无法核对当前登录账号，本次尚未发送。请保留填写后重试。'));},10000);});
      try{
        const result=await Promise.race([(async()=>{
          const response=await transport('/api/session',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});
          current();
          if(response.status===401)throw markSignedOut();
          if(response.status===403)throw markSignedOut();
          if(!response.ok)throw failure('暂时无法核对当前登录账号，本次尚未发送。请保留填写后重试。');
          let data;try{data=await response.json();}catch{throw failure('登录信息暂时无法核对，本次尚未发送。');}
          current();
          if(!valid(data?.userId))throw failure('登录信息暂时无法核对，本次尚未发送。');
          if(!acceptIdentity(data.userId))throw markChanged();announce();return data;
        })(),deadline]);
        return result;
      }catch(error){if(error?.code)throw error;throw failure('暂时无法核对当前登录账号，本次尚未发送。请保留填写后重试。');}
      finally{clearTimeout(timer);if(generation===epoch){verification=null;verificationController=null;}}
    })();return verification;
  }
  async function verify(){await readIdentity();return owner;}
  function localApi(input){try{const value=typeof input==='string'||input instanceof URL?input:input?.url;const url=new URL(value,location.href);return url.origin===location.origin&&url.pathname.startsWith('/api/')&&url.pathname!=='/api/session';}catch{return false;}}
  function rejected(error){return new Response(JSON.stringify({error:error.message,code:error.code||'ACCOUNT_SESSION_UNAVAILABLE'}),{status:error.status||503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
  async function request(input,options={}){
    if(!owner||!localApi(input))return transport(input,options);
    try{
      const checkAbort=()=>{if(options.signal?.aborted){const error=new Error('本次请求已取消。');error.name='AbortError';throw error;}};checkAbort();
      const headers=new Headers(options.headers||((typeof input==='object'&&input?.headers)||{}));
      const explicit=headers.get('X-Page-Owner');const draftOwner=window.JiashuDrafts?.owner;
      if(explicit&&!bind(explicit)||!owner&&valid(draftOwner)&&!bind(draftOwner))throw markChanged();
      const expected=attested?owner:await verify();checkAbort();if(changed)throw markChanged();headers.set('X-Page-Owner',expected);
      const response=await transport(input,{...options,headers});
      if(changed)throw markChanged();
      const responseOwner=response.headers?.get?.('X-Account-Owner');
      if(responseOwner&&responseOwner!==expected)throw markChanged();
      if([401,403,409].includes(response.status)){
        let data;try{data=await response.clone().json();}catch{}
        if(['ACCOUNT_CHANGED','PAGE_OWNER_MISMATCH','ACCOUNT_OWNER_CHANGED'].includes(data?.code))throw markChanged();
        if(response.status===401||data?.code==='SIGN_IN_REQUIRED'||data?.code==='ACCOUNT_NOT_ALLOWED')throw markSignedOut();
      }
      // The identity response and the API response can cross a sign-in change.
      // Confirm before exposing data when the server did not attest its owner.
      if(!responseOwner){await verify();if(owner!==expected||changed)throw markChanged();}
      return response;
    }catch(error){if(error?.code==='ACCOUNT_CHANGED'||error?.code==='SIGN_IN_REQUIRED'||error?.code==='ACCOUNT_SESSION_UNAVAILABLE')return rejected(error);throw error;}
  }
  connect();if(bootstrap){acceptIdentity(bootstrap.userId);announce();}
  if(typeof window.addEventListener==='function'){
    window.addEventListener('storage',(event)=>{if(event.key==='jiashu:session-notice')try{notice(JSON.parse(event.newValue));}catch{}});
    window.addEventListener('pagehide',(event)=>{if(event.persisted&&owner){invalidate();document.documentElement?.setAttribute('data-account-verifying','');}try{channel?.close();}catch{}channel=null;});
    window.addEventListener('pageshow',(event)=>{if(event.persisted)connect();});
  }
  window.fetch=request;
  return {document,bind,acceptIdentity,invalidate,notifySignedOut,readIdentity,verify,request,bootstrap,get attested(){return attested;},get owner(){return owner;},get changed(){return changed;},get problem(){return problem;}};
 })();
}
if(typeof window.__JIASHU_PAGE_OWNER__==='string'){window.JiashuAccountSession.bind(window.__JIASHU_PAGE_OWNER__);if(!window.JiashuAccountSession.bootstrap)document.documentElement?.setAttribute('data-account-verifying','');}
`;

export function renderAccountSessionScript(ownerId = ''): string {
  const owner = JSON.stringify(ownerId).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<script>${ownerId ? `window.__JIASHU_PAGE_OWNER__=${owner};` : ''}${ACCOUNT_SESSION_SCRIPT}</script>`;
}
