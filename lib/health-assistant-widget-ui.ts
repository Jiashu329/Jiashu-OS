import { DATE_RANGE_CLIENT_SCRIPT } from './date-range.ts';
import { ASSISTANT_RANGE_UI_SCRIPT } from './assistant-range-ui.ts';
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
${DATE_RANGE_CLIENT_SCRIPT}
const el=(id)=>root.querySelector('#health-chat-'+id);
const metricNames={weight:'体重',lean_body_mass:'去脂体重',steps:'步数',active_energy:'活动能量',sleep:'睡眠'};
const state={scope:{metrics:Object.keys(metricNames),includeNutrition:true,includeGoals:false},remainingToday:null,cooldownUntil:0,waitStarted:0,clockTimer:null,open:false,days:7,customRange:null,data:null,loading:false,sending:false,typing:false,history:[],sequence:0,session:0,loadController:null,sendController:null,opener:null};
${ASSISTANT_RANGE_UI_SCRIPT}
const sourcePaths=new Set(['/health','/health/records','/health/review','/health/nutrition','/health/weight-plan']);
const dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const time=Date.parse(value+'T12:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function safeSourceHref(value){if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return null;try{const url=new URL(value,location.origin);return url.origin===location.origin&&sourcePaths.has(url.pathname)?url.pathname+url.search+url.hash:null;}catch{return null;}}
function add(parent,tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;parent.append(node);return node;}
function scrollBottom(){el('scroll').scrollTop=el('scroll').scrollHeight;}
function nearBottom(){const scroll=el('scroll');return scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<64;}
function scopeKey(){return JSON.stringify([state.days,state.scope.metrics,state.scope.includeNutrition,state.scope.includeGoals,...(state.customRange?[state.customRange.from,state.customRange.to]:[])]);}
function setScope(scope){state.scope=scope;root.querySelectorAll('[data-health-chat-metric]').forEach((field)=>field.checked=scope.metrics.includes(field.dataset.healthChatMetric));el('include-nutrition').checked=scope.includeNutrition;el('include-goals').checked=scope.includeGoals;}
function usage(data){const value=data?.usage;if(Number.isInteger(value?.remainingToday)&&value.remainingToday>=0&&value.remainingToday<=20)state.remainingToday=value.remainingToday;if(Number.isFinite(value?.retryAfter)&&value.retryAfter>0){state.cooldownUntil=Date.now()+Math.min(value.retryAfter,86400)*1000;clockTick();}}
function clockTick(){clearTimeout(state.clockTimer);state.clockTimer=null;const waiting=root.querySelector('.hc-pending-time');if(waiting&&state.waitStarted)waiting.textContent='已等待 '+Math.max(0,Math.floor((Date.now()-state.waitStarted)/1000))+' 秒 · 最小化可继续等候';controls();if(state.waitStarted||state.cooldownUntil>Date.now())state.clockTimer=setTimeout(clockTick,1000);}
function stopWaiting(){state.waitStarted=0;clearTimeout(state.clockTimer);state.clockTimer=null;if(state.cooldownUntil>Date.now())clockTick();}
function clearContext(){state.data=null;el('context').hidden=true;el('config').hidden=true;el('coverage').replaceChildren();el('sources').replaceChildren();el('limitations').textContent='';el('context-range').textContent='';el('provider').textContent='结合你的真实记录，聊聊健康';}
function formError(message){el('form-error').hidden=!message;el('form-error').textContent=message;}
function status(message,error=false,login=false){el('status').hidden=!message;el('status').classList.toggle('is-error',error);el('status-text').textContent=message;el('retry').hidden=!error||login;el('login').hidden=!login;el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(location.pathname+location.search);}
function controls(){
  const busy=state.loading||state.sending,question=el('question').value.trim(),length=[...question].length;
  el('send').disabled=busy||state.cooldownUntil>Date.now()||!state.data?.configuration?.ready||!state.data?.hasData||!question||length>1000;
  el('send').setAttribute('aria-label',state.typing?'正在输出回复':state.sending?'正在等待回复':'发送消息');
  el('question').disabled=state.sending;
  el('new').disabled=busy;el('retry').disabled=busy;
  root.querySelectorAll('[data-health-chat-days]').forEach((button)=>{button.disabled=busy;button.setAttribute('aria-pressed',String(!state.customRange&&Number(button.dataset.healthChatDays)===state.days));});
  root.querySelectorAll('#health-chat-range-from,#health-chat-range-to,#health-chat-range-apply').forEach((field)=>field.disabled=busy);
  root.querySelectorAll('[data-health-chat-question]').forEach((button)=>button.disabled=state.sending);root.querySelectorAll('[data-health-chat-metric],#health-chat-include-nutrition,#health-chat-include-goals').forEach((field)=>field.disabled=busy);
  const remaining=Math.max(0,Math.ceil((state.cooldownUntil-Date.now())/1000));el('usage').textContent=(state.remainingToday===null?'应用今日剩余次数待读取':'应用今日剩余 '+state.remainingToday+' / 20 次')+'（与 Token Plan 余额不同）'+(remaining?' · '+remaining+' 秒后可重试':'');
  el('count').textContent=[...el('question').value].length+' / 1000';
  el('launcher-label').textContent=state.sending?'健康助手 · 正在回复':'健康助手';
  el('input-hint').textContent=state.loading?'正在读取所选健康摘要…':state.typing?'正在逐字显示，可点击“立即显示”查看全文':state.sending?'MiniMax 正在回复…':!state.data?'打开后读取健康摘要':!state.data.configuration.ready?'先在 AI 设置保存配置':!state.data.hasData?'所选范围暂无健康或饮食记录':'Enter 发送 · Shift+Enter 换行';
}
function resizeInput(){el('question').style.height='auto';el('question').style.height=Math.min(el('question').scrollHeight,126)+'px';}
function sourceList(target,sources){
  target.replaceChildren();
  for(const source of Array.isArray(sources)?sources:[]){
    if(!source||typeof source.label!=='string')continue;
    const li=document.createElement('li'),href=safeSourceHref(source.url);
    const text=(typeof source.id==='string'&&/^(?:H[1-5]|N1)(?:-\d{8})?$/.test(source.id)?'['+source.id+'] ':'')+source.label;
    const label=add(li,href?'a':'span',text);if(href){label.href=href;label.target='_blank';label.rel='noopener noreferrer';label.setAttribute('aria-label',text+'（在新标签页查看，保留当前对话）');}
    const bits=[];if(validDay(source.from)&&validDay(source.to))bits.push(source.from+' — '+source.to);
    if(Number.isInteger(source.recordedDays)&&source.recordedDays>=0)bits.push('有记录 '+source.recordedDays+' 天');
    if(bits.length)add(li,'small',bits.join(' · '));if(Array.isArray(source.dates)&&source.dates.length>1&&href?.startsWith('/health/nutrition?')){const dates=add(li,'span');for(const day of source.dates.filter(validDay)){const link=add(dates,'a',day+' ');link.href='/health/nutrition?'+new URLSearchParams({date:day});link.target='_blank';link.rel='noopener noreferrer';}}target.append(li);
  }
}
function checkContext(data,days){const context=data?.context,range=context?.range;return typeof data?.configuration?.ready==='boolean'&&data.configuration.provider==='MiniMax'&&typeof data.configuration.model==='string'&&context?.version===1&&context.timezone==='Asia/Shanghai'&&range?.days===days&&assistantRangeMatches(range)&&validDay(range.from)&&validDay(range.to)&&validDay(range.today)&&range.from<=range.to&&Array.isArray(context.health)&&context.health.every((metric)=>metric&&typeof metric.label==='string'&&Number.isInteger(metric.recordedDays)&&metric.recordedDays>=0&&metric.recordedDays<=days)&&context.nutrition&&Number.isInteger(context.nutrition.recordedDays)&&context.nutrition.recordedDays>=0&&context.nutrition.recordedDays<=days&&Array.isArray(context.limitations)&&Array.isArray(data.sources)&&typeof data.hasData==='boolean';}
function renderContext(data){
  const range=data.context.range;
  el('provider').textContent='MiniMax · '+data.configuration.model;
  el('scope-label').textContent=range.from+' — '+range.to+' · '+state.scope.metrics.map((key)=>metricNames[key]).join('、')+(state.scope.includeNutrition?'、饮食':'')+(state.scope.includeGoals?' · 用户自定目标':'');
  el('context').hidden=false;el('context-summary').textContent='查看本次健康摘要与来源';
  el('context-range').textContent=range.from+' — '+range.to+'（北京时间，包含起止日期）';
  el('coverage').replaceChildren();
  for(const metric of data.context.health){const item=document.createElement('div');add(item,'dt',metric.label);add(item,'dd',metric.recordedDays+' / '+range.days+' 天');el('coverage').append(item);}
  if(state.scope.includeNutrition){const nutrition=document.createElement('div');add(nutrition,'dt','饮食与营养');add(nutrition,'dd',data.context.nutrition.recordedDays+' / '+range.days+' 天'+(Number.isInteger(data.context.nutrition.completeDays)?'；用户标记记完 '+data.context.nutrition.completeDays+' 天，可比较 '+data.context.nutrition.comparableDays+' 天':''));el('coverage').append(nutrition);for(const [key,label]of Object.entries({carbs:'碳水化合物',protein:'蛋白质',fat:'脂肪'})){const fields=(data.context.nutrition.days||[]).map((day)=>day.nutrients?.[key]).filter(Boolean);if(!fields.length)continue;const item=document.createElement('div');add(item,'dt',label+'（g）');add(item,'dd','已填 '+fields.reduce((sum,row)=>sum+row.knownCount,0)+' 项，未填 '+fields.reduce((sum,row)=>sum+row.unknownCount,0)+' 项');el('coverage').append(item);}}if(state.scope.includeGoals){const goals=data.context.goals;const note=document.createElement('div');add(note,'dt','用户自定目标');add(note,'dd',goals?goals.targets.map((t)=>metricNames[t.metric]+' '+t.value).concat((goals.nutritionTargets||[]).map((target)=>({calories:'热量',carbs:'碳水化合物',protein:'蛋白质',fat:'脂肪'}[target.nutrient]||'营养目标')+' '+target.value+' '+target.unit)).join('；')+(goals.weightPlan?'；体重计划 '+goals.weightPlan.targetWeight+' kg（'+goals.weightPlan.deadline+'）':'；无当前启用的体重计划')+(Array.isArray(goals.notes)?' '+goals.notes.join(' '):''):'当前无可参考的目标');el('coverage').append(note);}
  sourceList(el('sources'),data.sources);
  el('limitations').textContent=data.context.limitations.filter((note)=>typeof note==='string').join(' ');
  el('config').hidden=data.configuration.ready===true;
  el('config-message').textContent=typeof data.configuration.message==='string'?data.configuration.message:'请先在 AI 设置保存自己的 MiniMax 配置。';
  if(!data.hasData)status('所选范围暂无健康或饮食记录。同步或补录后，可重新读取。',true);
}
async function readResponse(response,valid=()=>true){
  let data;try{data=await response.json();}catch{const error=new Error(response.status===401?'请先登录网站。':'暂时无法读取服务响应，请稍后重试。');error.status=response.status;throw error;}
  if(valid())usage(data);
  if(!response.ok){const error=new Error(typeof data?.error==='string'&&data.error.length<=500?data.error:'本次对话没有完成，请稍后重试。');error.status=response.status;error.code=data?.code;const detail=diagnosticText(data?.diagnostics);if(detail)error.message+=' '+detail;const retry=Number(response.headers.get('Retry-After'));if(Number.isFinite(retry)&&retry>0&&valid()){state.cooldownUntil=Date.now()+Math.min(retry,86400)*1000;clockTick();error.message+=' '+Math.ceil(retry)+' 秒后可主动重试。';}throw error;}
  return data;
}
async function readPreview(url,controller,valid){let timer;try{return await Promise.race([(async()=>readResponse(await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal}),valid))(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();const error=new Error('健康摘要读取超过20秒，请主动重试。');error.code='CONTEXT_TIMEOUT';reject(error);},20000);})]);}finally{clearTimeout(timer);}}
async function load(){
  if(state.sending)return;
  const sequence=++state.sequence;state.loadController?.abort();const controller=new AbortController();state.loadController=controller;
  state.loading=true;clearContext();formError('');status('正在读取所选 '+state.days+' 天的健康摘要…');syncAssistantDateControls();controls();
  const days=state.days;const scope=state.scope;
  try{const data=await readPreview('/api/health/assistant?'+new URLSearchParams({...Object.fromEntries(Object.entries(assistantRangeSelection()).map(([key,value])=>[key,String(value)])),metrics:scope.metrics.join(','),nutrition:scope.includeNutrition?'1':'0',goals:scope.includeGoals?'1':'0'}),controller,()=>sequence===state.sequence);if(sequence!==state.sequence)return;if(!checkContext(data,days))throw new Error('健康摘要暂时无法核对，请重新读取。');state.data=data;status('');renderContext(data);}
  catch(error){if(sequence!==state.sequence||error?.name==='AbortError')return;state.data=null;const auth=error?.status===401||error?.code==='SIGN_IN_REQUIRED';if(auth)clearConversation();status(error?.message||'健康摘要暂时无法读取，请重试。',true,auth);}
  finally{if(sequence===state.sequence){state.loading=false;state.loadController=null;controls();}}
}
function open(opener){state.opener=opener||el('launcher');state.open=true;el('panel').hidden=false;el('launcher').hidden=true;el('launcher').setAttribute('aria-expanded','true');const prompt=opener?.dataset?.healthChatPrompt;if(!state.sending&&typeof prompt==='string'&&prompt.trim()){el('question').value=[...prompt.trim()].slice(0,1000).join('');formError('');resizeInput();}if(!state.data&&!state.loading)load();controls();if(state.sending)el('panel').focus();else el('question').focus();scrollBottom();}
function close(){state.open=false;el('panel').hidden=true;el('launcher').hidden=false;el('launcher').setAttribute('aria-expanded','false');const target=state.opener?.isConnected?state.opener:el('launcher');if(typeof target?.focus==='function')target.focus();}
function clearConversation(){state.history=[];el('messages').replaceChildren();el('welcome').hidden=false;el('question').value='';formError('');resizeInput();controls();}
function appendUser(question){const article=add(el('messages'),'article',undefined,'hc-message is-user');add(article,'span','你','hc-message-label');add(article,'div',question,'hc-bubble');return article;}
function pending(){const article=add(el('messages'),'article',undefined,'hc-message');add(article,'span','健康助手','hc-message-label');const bubble=add(article,'div',undefined,'hc-bubble hc-pending');const dots=add(bubble,'span',undefined,'hc-pending-dots');dots.setAttribute('aria-hidden','true');for(let index=0;index<3;index++)add(dots,'i');add(bubble,'span','正在查看记录…','hc-pending-time');return article;}
function revealAnswer(bubble,article,skip,copy,signal){
  const motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  // Animate only text in the already-safe Markdown tree. Never parse partial
  // Markdown or slice HTML, which could break markup or its safety guarantees.
  if(motion?.matches||typeof Intl.Segmenter!=='function'||signal.aborted)return Promise.resolve();
  const segmenter=new Intl.Segmenter('zh-CN',{granularity:'grapheme'}),entries=[],elements=[];
  function collect(parent){for(const node of parent.childNodes){if(node.nodeType===3&&node.textContent.trim()){entries.push({node,text:node.textContent,parts:Array.from(segmenter.segment(node.textContent),(part)=>part.segment),offset:0});}else if(node.nodeType===1){elements.push({node,hidden:node.hidden});collect(node);}}}
  collect(bubble);const total=entries.reduce((sum,entry)=>sum+entry.parts.length,0);if(!total)return Promise.resolve();
  for(const entry of entries)entry.node.textContent='';for(const item of elements)item.node.hidden=true;
  const cursor=document.createElement('span');cursor.className='hc-cursor';cursor.setAttribute('aria-hidden','true');
  bubble.classList.add('is-typing');article.setAttribute('aria-busy','true');skip.hidden=false;copy.disabled=true;state.typing=true;controls();
  return new Promise((resolve)=>{
    let timer=null,done=false,index=0,shown=0;const started=Date.now(),interval=Math.min(24,12000/total);
    function finish(){
      if(done)return;done=true;clearTimeout(timer);const follow=state.open&&nearBottom();
      for(const entry of entries)entry.node.textContent=entry.text;for(const item of elements)item.node.hidden=item.hidden;
      cursor.remove();bubble.classList.remove('is-typing');article.setAttribute('aria-busy','false');skip.hidden=true;copy.disabled=false;
      skip.removeEventListener('click',finish);signal.removeEventListener('abort',finish);motion?.removeEventListener?.('change',onMotion);
      if(follow)scrollBottom();resolve();
    }
    function onMotion(event){if(event.matches)finish();}
    function step(){
      if(done)return;if(signal.aborted){finish();return;}const follow=state.open&&nearBottom();
      const target=Math.min(total,Math.max(shown+1,Math.floor((Date.now()-started)/interval)));
      while(shown<target){
        const entry=entries[index],count=Math.min(entry.parts.length-entry.offset,target-shown);
        entry.node.textContent+=entry.parts.slice(entry.offset,entry.offset+count).join('');entry.offset+=count;shown+=count;
        for(let parent=entry.node.parentNode;parent&&parent!==bubble;parent=parent.parentNode)parent.hidden=false;
        entry.node.parentNode.insertBefore(cursor,entry.node.nextSibling);if(entry.offset===entry.parts.length)index++;
      }
      if(follow)scrollBottom();if(shown===total)finish();else timer=setTimeout(step,24);
    }
    skip.addEventListener('click',finish);signal.addEventListener('abort',finish,{once:true});motion?.addEventListener?.('change',onMotion);step();
  });
}
async function appendAnswer(data,signal,follow){
  const article=add(el('messages'),'article',undefined,'hc-message');add(article,'span','健康助手','hc-message-label');
  const bubble=add(article,'div',undefined,'hc-bubble hc-markdown');
  // Only this same-origin API's server-rendered Markdown is HTML. User input
  // and all metadata always use textContent; there is no client HTML parser.
  if(typeof data.answerHtml==='string'&&data.answerHtml.length>0&&data.answerHtml.length<=160000)bubble.innerHTML=data.answerHtml;else bubble.textContent=data.answer;
  const tools=add(article,'div',undefined,'hc-message-tools');const time=new Date(data.generatedAt);
  add(tools,'span',data.range.from+' — '+data.range.to+(Number.isFinite(time.getTime())?' · '+dateTime.format(time):''));
  const copy=add(tools,'button','复制','hc-copy');copy.type='button';copy.setAttribute('aria-label','复制这条助手回答');copy.addEventListener('click',async()=>{try{if(!navigator.clipboard?.writeText)throw new Error('CLIPBOARD_UNAVAILABLE');await navigator.clipboard.writeText(data.answer);copy.textContent='已复制';}catch{copy.textContent='请选中文字复制';}setTimeout(()=>{copy.textContent='复制';},2500);});
  const skip=add(tools,'button','立即显示','hc-reveal');skip.type='button';skip.hidden=true;skip.setAttribute('aria-label','立即显示这条回答的全部内容');
  if(data.sources.length){const details=add(article,'details',undefined,'hc-message-sources');add(details,'summary','本次数据来源');sourceList(add(details,'ul',undefined,'hc-source-list'),data.sources);}
  const revealing=revealAnswer(bubble,article,skip,copy,signal);if(follow&&state.open)scrollBottom();await revealing;
}
function checkAnswer(data){const range=data?.range;return typeof data?.answer==='string'&&data.answer.trim()&&data.answer.length<=10000&&data.provider==='MiniMax'&&typeof data.model==='string'&&assistantRangeMatches(range)&&validDay(range.from)&&validDay(range.to)&&Array.isArray(data.sources);}
async function submit(event){
  event?.preventDefault();if(state.loading||state.sending)return;formError('');const question=el('question').value.trim();
  if(!question||[...question].length>1000){formError('请填写 1–1000 个字符的问题。');el('question').focus();return;}
  if(!state.data?.configuration?.ready){formError('请先在 AI 设置保存可用的 MiniMax 配置。');return;}
  if(!state.data.hasData){formError('所选范围暂无健康或饮食记录，请同步或补录后再提问。');return;}
  if(state.cooldownUntil>Date.now()){formError('请等待限流倒计时结束后主动重试。');return;}
  const session=state.session,history=boundedHistory(state.history),questionBubble=appendUser(question),waiting=pending();
  el('welcome').hidden=true;state.sending=true;state.waitStarted=Date.now();status('');clockTick();controls();scrollBottom();
  const controller=new AbortController();state.sendController=controller;let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},65000);
  try{
    const response=await fetch('/api/health/assistant',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({question,...assistantRangeSelection(),shareHealthData:true,history,scope:state.scope,historyScope:scopeKey()})});
    const data=await readResponse(response,()=>session===state.session);if(session!==state.session)return;if(!checkAnswer(data))throw new Error('助手返回的回答不完整，请稍后重试。');
    clearTimeout(timer);stopWaiting();const follow=nearBottom();waiting.remove();await appendAnswer(data,controller.signal,follow);if(session!==state.session)return;
    state.history=boundedHistory([...history,{role:'user',content:question},{role:'assistant',content:data.answer}]);el('question').value='';resizeInput();
  }catch(error){
    if(session!==state.session)return;waiting.remove();questionBubble.remove();el('welcome').hidden=el('messages').children.length>0;
    const auth=error?.status===401||error?.code==='SIGN_IN_REQUIRED';if(auth){clearConversation();clearContext();status('登录状态已失效，请重新登录。',true,true);}else formError(timedOut?'已等待超过 65 秒。请求可能仍在处理中，再次发送可能产生 API 费用，请稍后再试。':error?.message||'本次对话没有完成，问题已保留，请稍后重试。');
    if(error?.code==='AI_NOT_CONFIGURED'&&state.data){state.data.configuration.ready=false;el('config').hidden=false;el('config-message').textContent=error.message;}
  }finally{clearTimeout(timer);if(session===state.session){stopWaiting();state.sending=false;state.typing=false;state.sendController=null;controls();if(state.open)el('question').focus({preventScroll:true});}}
}
el('launcher').addEventListener('click',()=>open(el('launcher')));
el('close').addEventListener('click',close);el('minimize').addEventListener('click',close);
el('new').addEventListener('click',()=>{if(state.loading||state.sending)return;clearConversation();load();el('question').focus();});
el('form').addEventListener('submit',submit);
el('question').addEventListener('input',()=>{formError('');resizeInput();controls();});
el('question').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!el('send').disabled)submit();}});
el('retry').addEventListener('click',()=>{if(!state.loading&&!state.sending)load();});
root.querySelectorAll('[data-health-chat-question]').forEach((button)=>button.addEventListener('click',()=>{if(state.sending)return;el('question').value=button.dataset.healthChatQuestion;formError('');resizeInput();controls();el('question').focus();}));
root.querySelectorAll('[data-health-chat-days]').forEach((button)=>button.addEventListener('click',()=>{if(state.loading||state.sending)return;const days=Number(button.dataset.healthChatDays);if(![7,30,90,180,360].includes(days)||(!state.customRange&&days===state.days))return;state.days=days;state.customRange=null;clearConversation();load();}));
root.querySelectorAll('[data-health-chat-metric],#health-chat-include-nutrition,#health-chat-include-goals').forEach((field)=>field.addEventListener('change',()=>{if(state.loading||state.sending){setScope(state.scope);return;}const scope={metrics:[...root.querySelectorAll('[data-health-chat-metric]')].filter((input)=>input.checked).map((input)=>input.dataset.healthChatMetric),includeNutrition:el('include-nutrition').checked,includeGoals:el('include-goals').checked};if(!scope.metrics.length&&!scope.includeNutrition){setScope(state.scope);formError('请至少选择一项健康指标或饮食摘要。');return;}setScope(scope);clearConversation();load();}));
window.addEventListener('health-assistant-open',(event)=>{const detail=event.detail;if(state.sending){open(el('launcher'));formError('请先等待本轮回复完成，再分析其他图表。');return;}let selected;try{if(!detail||!Object.hasOwn(metricNames,detail.metric))throw new Error();selected=resolveDateRange(detail.from!==undefined||detail.to!==undefined?{from:detail.from,to:detail.to}:{days:detail.days});if(selected.days!==detail.days)throw new Error();}catch{open(el('launcher'));formError('该图表资料尚不支持直接分析，请在助手内选择有效范围。');return;}state.days=selected.days;state.customRange=detail.from!==undefined?{from:selected.from,to:selected.to}:null;setScope({metrics:[detail.metric],includeNutrition:false,includeGoals:false});clearConversation();state.data=null;state.sequence++;state.loadController?.abort();state.loading=false;el('question').value=typeof detail.question==='string'?detail.question.slice(0,1000):'请分析这段'+metricNames[detail.metric]+'趋势，并说明实际日期与缺失记录。';resizeInput();open(el('launcher'));});
document.addEventListener('click',(event)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor||anchor.hasAttribute('download')||anchor.target==='_blank')return;let url;try{url=new URL(anchor.href,location.origin);}catch{return;}if(url.origin===location.origin&&url.pathname==='/health/assistant'){event.preventDefault();open(anchor);}});
document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&state.open&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){event.preventDefault();close();}});
window.addEventListener('pagehide',()=>{state.waitStarted=0;state.cooldownUntil=0;clearTimeout(state.clockTimer);state.clockTimer=null;state.session++;state.sequence++;state.loadController?.abort();state.sendController?.abort();state.loadController=null;state.sendController=null;state.sending=false;state.typing=false;state.loading=false;clearContext();clearConversation();status('');});
window.addEventListener('pageshow',(event)=>{if(event.persisted){clearConversation();if(state.open)load();}});
setScope(state.scope);controls();if(location.pathname==='/health/assistant')open(el('launcher'));
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initHealthChat,{once:true});else initHealthChat();
})();</script>`;
}
