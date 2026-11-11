import { AI_DIAGNOSTICS_HELPERS } from './ai-diagnostics-ui.ts';

/** Kept separately so the conversation budget can be exercised without a browser. */
export const HEALTH_CHAT_HISTORY_HELPERS = String.raw`
function boundedHistory(messages){let result=messages.slice(-8).map((message)=>({role:message.role,content:message.content}));if(result.length%2)result.shift();while(result.length&&new TextEncoder().encode(JSON.stringify(result)).byteLength>32000)result=result.slice(2);return result;}
`;

export function renderHealthAssistantWidgetScript(): string {
  return String.raw`<script type="module">(()=>{
function initHealthChat(){
const root=document.getElementById('health-chat');
if(!root||root.dataset.initialized==='true')return;
root.dataset.initialized='true';
${AI_DIAGNOSTICS_HELPERS}
${HEALTH_CHAT_HISTORY_HELPERS}
const el=(id)=>root.querySelector('#health-chat-'+id);
const state={open:false,days:7,data:null,loading:false,sending:false,history:[],sequence:0,session:0,loadController:null,sendController:null,opener:null};
const sourcePaths=new Set(['/health','/health/records','/health/review','/health/nutrition','/health/weight-plan']);
const dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const time=Date.parse(value+'T12:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function safeSourceHref(value){if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return null;try{const url=new URL(value,location.origin);return url.origin===location.origin&&sourcePaths.has(url.pathname)?url.pathname+url.search+url.hash:null;}catch{return null;}}
function add(parent,tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;parent.append(node);return node;}
function scrollBottom(){el('scroll').scrollTop=el('scroll').scrollHeight;}
function clearContext(){state.data=null;el('context').hidden=true;el('config').hidden=true;el('coverage').replaceChildren();el('sources').replaceChildren();el('limitations').textContent='';el('context-range').textContent='';el('provider').textContent='结合你的真实记录，聊聊健康';}
function formError(message){el('form-error').hidden=!message;el('form-error').textContent=message;}
function status(message,error=false,login=false){el('status').hidden=!message;el('status').classList.toggle('is-error',error);el('status-text').textContent=message;el('retry').hidden=!error||login;el('login').hidden=!login;el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(location.pathname+location.search);}
function controls(){
  const busy=state.loading||state.sending,question=el('question').value.trim(),length=[...question].length;
  el('send').disabled=busy||!state.data?.configuration?.ready||!state.data?.hasData||!el('consent').checked||!question||length>1000;
  el('send').setAttribute('aria-label',state.sending?'正在等待回复':'发送消息');
  el('question').disabled=state.sending;el('consent').disabled=busy||!state.data?.configuration?.ready||!state.data?.hasData;
  el('new').disabled=busy;el('retry').disabled=busy;
  root.querySelectorAll('[data-health-chat-days]').forEach((button)=>{button.disabled=busy;button.setAttribute('aria-pressed',String(Number(button.dataset.healthChatDays)===state.days));});
  root.querySelectorAll('[data-health-chat-question]').forEach((button)=>button.disabled=state.sending);
  el('count').textContent=[...el('question').value].length+' / 1000';
  el('launcher-label').textContent=state.sending?'健康助手 · 正在回复':'健康助手';
  el('input-hint').textContent=state.loading?'正在读取所选健康摘要…':state.sending?'MiniMax 正在回复…':!state.data?'打开后读取健康摘要':!state.data.configuration.ready?'先在 AI 设置保存配置':!state.data.hasData?'所选范围暂无健康或饮食记录':!el('consent').checked?'勾选同意后可发送':'Enter 发送 · Shift+Enter 换行';
}
function resizeInput(){el('question').style.height='auto';el('question').style.height=Math.min(el('question').scrollHeight,126)+'px';}
function sourceList(target,sources){
  target.replaceChildren();
  for(const source of Array.isArray(sources)?sources:[]){
    if(!source||typeof source.label!=='string')continue;
    const li=document.createElement('li'),href=safeSourceHref(source.url);
    const text=(typeof source.id==='string'&&/^(?:H[1-5]|N1)$/.test(source.id)?'['+source.id+'] ':'')+source.label;
    const label=add(li,href?'a':'span',text);if(href){label.href=href;label.target='_blank';label.rel='noopener noreferrer';label.setAttribute('aria-label',text+'（在新标签页查看，保留当前对话）');}
    const bits=[];if(validDay(source.from)&&validDay(source.to))bits.push(source.from+' — '+source.to);
    if(Number.isInteger(source.recordedDays)&&source.recordedDays>=0)bits.push('有记录 '+source.recordedDays+' 天');
    if(bits.length)add(li,'small',bits.join(' · '));target.append(li);
  }
}
function checkContext(data,days){const context=data?.context,range=context?.range;return typeof data?.configuration?.ready==='boolean'&&data.configuration.provider==='MiniMax'&&typeof data.configuration.model==='string'&&context?.version===1&&context.timezone==='Asia/Shanghai'&&range?.days===days&&validDay(range.from)&&validDay(range.to)&&validDay(range.today)&&range.from<=range.to&&Array.isArray(context.health)&&context.health.every((metric)=>metric&&typeof metric.label==='string'&&Number.isInteger(metric.recordedDays)&&metric.recordedDays>=0&&metric.recordedDays<=days)&&context.nutrition&&Number.isInteger(context.nutrition.recordedDays)&&context.nutrition.recordedDays>=0&&context.nutrition.recordedDays<=days&&Array.isArray(context.limitations)&&Array.isArray(data.sources)&&typeof data.hasData==='boolean';}
function renderContext(data){
  const range=data.context.range;
  el('provider').textContent='MiniMax · '+data.configuration.model;
  el('scope-label').textContent='参考近 '+state.days+' 天的健康摘要';
  el('context').hidden=false;el('context-summary').textContent='查看本次健康摘要与来源';
  el('context-range').textContent=range.from+' — '+range.to+'（北京时间，包含今天）';
  el('coverage').replaceChildren();
  for(const metric of data.context.health){const item=document.createElement('div');add(item,'dt',metric.label);add(item,'dd',metric.recordedDays+' / '+range.days+' 天');el('coverage').append(item);}
  const nutrition=document.createElement('div');add(nutrition,'dt','饮食热量');add(nutrition,'dd',data.context.nutrition.recordedDays+' / '+range.days+' 天');el('coverage').append(nutrition);
  sourceList(el('sources'),data.sources);
  el('limitations').textContent=data.context.limitations.filter((note)=>typeof note==='string').join(' ');
  el('config').hidden=data.configuration.ready===true;
  el('config-message').textContent=typeof data.configuration.message==='string'?data.configuration.message:'请先在 AI 设置保存自己的 MiniMax 配置。';
  if(!data.hasData)status('所选范围暂无健康或饮食记录。同步或补录后，可重新读取。',true);
}
async function readResponse(response){
  let data;try{data=await response.json();}catch{const error=new Error(response.status===401?'请先登录网站。':'暂时无法读取服务响应，请稍后重试。');error.status=response.status;throw error;}
  if(!response.ok){const error=new Error(typeof data?.error==='string'&&data.error.length<=500?data.error:'本次对话没有完成，请稍后重试。');error.status=response.status;error.code=data?.code;const detail=diagnosticText(data?.diagnostics);if(detail)error.message+=' '+detail;const retry=Number(response.headers.get('Retry-After'));if(Number.isFinite(retry)&&retry>0)error.message+=' 建议 '+Math.ceil(retry)+' 秒后再试。';throw error;}
  return data;
}
async function load(){
  if(state.sending)return;
  const sequence=++state.sequence;state.loadController?.abort();const controller=new AbortController();state.loadController=controller;
  state.loading=true;clearContext();el('consent').checked=false;formError('');status('正在读取近 '+state.days+' 天的健康摘要…');controls();
  const days=state.days;
  try{const response=await fetch('/api/health/assistant?'+new URLSearchParams({days:String(days)}),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});const data=await readResponse(response);if(sequence!==state.sequence)return;if(!checkContext(data,days))throw new Error('健康摘要暂时无法核对，请重新读取。');state.data=data;status('');renderContext(data);}
  catch(error){if(sequence!==state.sequence||error?.name==='AbortError')return;state.data=null;const auth=error?.status===401||error?.code==='SIGN_IN_REQUIRED';if(auth)clearConversation();status(error?.message||'健康摘要暂时无法读取，请重试。',true,auth);}
  finally{if(sequence===state.sequence){state.loading=false;state.loadController=null;controls();}}
}
function open(opener){state.opener=opener||el('launcher');state.open=true;el('panel').hidden=false;el('launcher').hidden=true;el('launcher').setAttribute('aria-expanded','true');if(!state.data&&!state.loading)load();controls();if(state.sending)el('panel').focus();else el('question').focus();scrollBottom();}
function close(){state.open=false;el('panel').hidden=true;el('launcher').hidden=false;el('launcher').setAttribute('aria-expanded','false');const target=state.opener?.isConnected?state.opener:el('launcher');if(typeof target?.focus==='function')target.focus();}
function clearConversation(){state.history=[];el('messages').replaceChildren();el('welcome').hidden=false;el('question').value='';el('consent').checked=false;formError('');resizeInput();controls();}
function appendUser(question){const article=add(el('messages'),'article',undefined,'hc-message is-user');add(article,'span','你','hc-message-label');add(article,'div',question,'hc-bubble');return article;}
function pending(){const article=add(el('messages'),'article',undefined,'hc-message');add(article,'span','健康助手','hc-message-label');const bubble=add(article,'div',undefined,'hc-bubble hc-pending');const dots=add(bubble,'span',undefined,'hc-pending-dots');dots.setAttribute('aria-hidden','true');for(let index=0;index<3;index++)add(dots,'i');add(bubble,'span','正在查看记录…');return article;}
function appendAnswer(data){
  const article=add(el('messages'),'article',undefined,'hc-message');add(article,'span','健康助手','hc-message-label');
  const bubble=add(article,'div',undefined,'hc-bubble hc-markdown');
  // Only this same-origin API's server-rendered Markdown is HTML. User input
  // and all metadata always use textContent; there is no client HTML parser.
  if(typeof data.answerHtml==='string'&&data.answerHtml.length>0&&data.answerHtml.length<=160000)bubble.innerHTML=data.answerHtml;else bubble.textContent=data.answer;
  const tools=add(article,'div',undefined,'hc-message-tools');const time=new Date(data.generatedAt);
  add(tools,'span',data.range.from+' — '+data.range.to+(Number.isFinite(time.getTime())?' · '+dateTime.format(time):''));
  const copy=add(tools,'button','复制','hc-copy');copy.type='button';copy.setAttribute('aria-label','复制这条助手回答');copy.addEventListener('click',async()=>{try{if(!navigator.clipboard?.writeText)throw new Error('CLIPBOARD_UNAVAILABLE');await navigator.clipboard.writeText(data.answer);copy.textContent='已复制';}catch{copy.textContent='请选中文字复制';}setTimeout(()=>{copy.textContent='复制';},2500);});
  if(data.sources.length){const details=add(article,'details',undefined,'hc-message-sources');add(details,'summary','本次数据来源');sourceList(add(details,'ul',undefined,'hc-source-list'),data.sources);}
}
function checkAnswer(data){const range=data?.range;return typeof data?.answer==='string'&&data.answer.trim()&&data.answer.length<=10000&&data.provider==='MiniMax'&&typeof data.model==='string'&&range?.days===state.days&&validDay(range.from)&&validDay(range.to)&&Array.isArray(data.sources);}
async function submit(event){
  event?.preventDefault();if(state.loading||state.sending)return;formError('');const question=el('question').value.trim();
  if(!question||[...question].length>1000){formError('请填写 1–1000 个字符的问题。');el('question').focus();return;}
  if(!state.data?.configuration?.ready){formError('请先在 AI 设置保存可用的 MiniMax 配置。');return;}
  if(!state.data.hasData){formError('所选范围暂无健康或饮食记录，请同步或补录后再提问。');return;}
  if(!el('consent').checked){formError('请先同意将本次问题、对话历史和所选健康摘要发送至 MiniMax。');el('consent').focus();return;}
  const session=state.session,history=boundedHistory(state.history),questionBubble=appendUser(question),waiting=pending();
  el('welcome').hidden=true;state.sending=true;status('');controls();scrollBottom();
  const controller=new AbortController();state.sendController=controller;let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},65000);
  try{
    const response=await fetch('/api/health/assistant',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({question,days:state.days,shareHealthData:true,history})});
    const data=await readResponse(response);if(session!==state.session)return;if(!checkAnswer(data))throw new Error('助手返回的回答不完整，请稍后重试。');
    waiting.remove();appendAnswer(data);state.history=boundedHistory([...history,{role:'user',content:question},{role:'assistant',content:data.answer}]);el('question').value='';resizeInput();
  }catch(error){
    if(session!==state.session)return;waiting.remove();questionBubble.remove();el('welcome').hidden=el('messages').children.length>0;
    const auth=error?.status===401||error?.code==='SIGN_IN_REQUIRED';if(auth){clearConversation();clearContext();status('登录状态已失效，请重新登录。',true,true);}else formError(timedOut?'已等待超过 65 秒。请求可能仍在处理中，再次发送可能产生 API 费用，请稍后再试。':error?.message||'本次对话没有完成，问题已保留，请稍后重试。');
    if(error?.code==='AI_NOT_CONFIGURED'&&state.data){state.data.configuration.ready=false;el('config').hidden=false;el('config-message').textContent=error.message;}
  }finally{clearTimeout(timer);if(session===state.session){state.sending=false;state.sendController=null;controls();scrollBottom();if(state.open)el('question').focus();}}
}
el('launcher').addEventListener('click',()=>open(el('launcher')));
el('close').addEventListener('click',close);el('minimize').addEventListener('click',close);
el('new').addEventListener('click',()=>{if(state.loading||state.sending)return;clearConversation();load();el('question').focus();});
el('form').addEventListener('submit',submit);
el('question').addEventListener('input',()=>{formError('');resizeInput();controls();});
el('question').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!el('send').disabled)submit();}});
el('consent').addEventListener('change',()=>{formError('');controls();});
el('retry').addEventListener('click',()=>{if(!state.loading&&!state.sending)load();});
root.querySelectorAll('[data-health-chat-question]').forEach((button)=>button.addEventListener('click',()=>{if(state.sending)return;el('question').value=button.dataset.healthChatQuestion;formError('');resizeInput();controls();el('question').focus();}));
root.querySelectorAll('[data-health-chat-days]').forEach((button)=>button.addEventListener('click',()=>{if(state.loading||state.sending)return;const days=Number(button.dataset.healthChatDays);if(![7,30].includes(days)||days===state.days)return;state.days=days;clearConversation();load();}));
document.addEventListener('click',(event)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor||anchor.hasAttribute('download')||anchor.target==='_blank')return;let url;try{url=new URL(anchor.href,location.origin);}catch{return;}if(url.origin===location.origin&&url.pathname==='/health/assistant'){event.preventDefault();open(anchor);}});
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&state.open&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){event.preventDefault();close();}});
window.addEventListener('pagehide',()=>{state.session++;state.sequence++;state.loadController?.abort();state.sendController?.abort();state.loadController=null;state.sendController=null;state.sending=false;state.loading=false;clearContext();clearConversation();status('');});
window.addEventListener('pageshow',(event)=>{if(event.persisted){clearConversation();if(state.open)load();}});
controls();if(location.pathname==='/health/assistant')open(el('launcher'));
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initHealthChat,{once:true});else initHealthChat();
})();</script>`;
}
