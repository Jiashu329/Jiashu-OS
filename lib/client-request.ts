/** Literal browser source stays self-contained after production minification. */
export const CLIENT_REQUEST_SCRIPT = String.raw`
async function requestJSON(url,options={}){
  const {timeoutMs,...init}=options;
  const duration=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:(!init.method||init.method==='GET'?20000:30000);
  const controller=new AbortController();const external=init.signal;let timer;let response;let timedOut=false;let cancel;
  const cancelled=new Promise((_,reject)=>{cancel=()=>{const error=new Error('本次读取已取消。');error.name='AbortError';controller.abort();reject(error);};});
  if(external?.aborted){cancel();}else external?.addEventListener('abort',cancel,{once:true});
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();try{response?.body?.cancel()?.catch(()=>{});}catch{}const error=new Error('等待响应超时，请检查网络后重试。');error.name='TimeoutError';error.code='REQUEST_TIMEOUT';reject(error);},duration);});
  const operation=(async()=>{
    try{
      response=await fetch(url,{credentials:'same-origin',cache:'no-store',...init,signal:controller.signal,headers:{Accept:'application/json',...init.headers}});
      const text=await response.text();let data;
      try{data=JSON.parse(text);}catch{const error=new Error(response.status===401||response.status===403?'请刷新页面并重新登录。':'服务返回内容暂时无法读取，请稍后重试。');error.status=response.status;error.code='INVALID_RESPONSE';throw error;}
      if(!response.ok){const message=typeof data?.error==='string'?data.error:typeof data?.message==='string'?data.message:data?.error?.message;const extra=Array.isArray(data?.issues)?data.issues.slice(0,2).map((item)=>item.message).filter(Boolean).join('；'):'';const diagnosticId=/^[a-f0-9]{32}$/.test(data?.diagnosticId)?data.diagnosticId:null;const error=new Error((message||'操作未完成，请检查数据后重试。')+(extra?' '+extra:'')+(diagnosticId?' 诊断编号：'+diagnosticId:''));error.status=response.status;error.code=data?.code;error.diagnosticId=diagnosticId;const retryAfter=response.status===429?response.headers?.get?.('Retry-After'):null;if(typeof retryAfter==='string'&&/^\d{1,5}$/.test(retryAfter)&&Number(retryAfter)>=1&&Number(retryAfter)<=86400)error.retryAfter=Number(retryAfter);throw error;}
      return data;
    }catch(error){if(timedOut){const timeout=new Error('等待响应超时，请检查网络后重试。');timeout.name='TimeoutError';timeout.code='REQUEST_TIMEOUT';throw timeout;}if(error?.status||error?.name==='AbortError')throw error;const failure=new Error('网络请求未完成，请检查连接后重试。');failure.code='NETWORK_ERROR';throw failure;}
  })();
  try{return await Promise.race([operation,deadline,cancelled]);}finally{clearTimeout(timer);external?.removeEventListener('abort',cancel);}
}
`;
