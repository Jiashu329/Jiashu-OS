export function renderHealthWeeklyScript(): string {
  return String.raw`<script type="module">(()=>{
const el=(id)=>document.getElementById('weekly-'+id);
const keys=['steps','sleep','active_energy','weight'];
const labels={steps:'步数',sleep:'睡眠',active_energy:'活动能量',weight:'体重'};
const units={steps:'步',sleep:'小时',active_energy:'千卡',weight:'kg'};
const state={week:'',followCurrent:true,today:'',sequence:0,controller:null,data:null,saving:false,dirty:false};
const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const format=(value)=>typeof value==='number'&&Number.isFinite(value)?number.format(value):'—';
function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1969-12-29'||value>'2100-12-31')return false;const time=Date.parse(value+'T12:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function today(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=(key)=>parts.find((part)=>part.type===key).value;return get('year')+'-'+get('month')+'-'+get('day');}
function addDays(day,count){return new Date(Date.parse(day+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);}
function monday(day){const value=new Date(day+'T12:00:00Z');return addDays(day,-((value.getUTCDay()+6)%7));}
function path(){return '/health/review?'+new URLSearchParams({week:state.week});}
function restoreUrl(){const raw=new URLSearchParams(location.search).get('week');state.today=today();const current=monday(state.today);state.week=validDay(raw)&&monday(raw)<=current?monday(raw):current;state.followCurrent=state.week===current;}
function controls(){state.today=today();const current=monday(state.today);if(state.followCurrent)state.week=current;el('date').value=state.week;el('date').max=state.today;el('next').disabled=state.week>=current;el('previous').disabled=state.week<='1969-12-29';el('range').textContent=state.week+' — '+addDays(state.week,6);if(location.pathname+location.search!==path())history.replaceState(null,'',path());el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(path());}
function status(message,error=false,login=false){el('status').hidden=!message;el('status').classList.toggle('error',error);el('status-text').textContent=message;el('retry').hidden=!error;el('login').hidden=!login;el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(path());}
const actionStatus={planned:'计划中',completed:'已完成',not_completed:'未完成'};
function actionSummary(action,empty){return action?'<p><strong>'+esc(action.text)+'</strong></p><p>'+esc(action.weekStart)+' 开始 · '+actionStatus[action.status]+'</p>'+(action.feedback?'<p>反馈：'+esc(action.feedback)+'</p>':''):'<p>'+empty+'</p>';}
function renderActions(data){
  const actions=data.actions;el('previous-action').innerHTML=actionSummary(actions.previous,'上一周尚未保存行动。');
  el('current-action-summary').innerHTML=actionSummary(actions.current,'这周尚未保存行动；可以先为下一周定一件具体的事。');el('feedback-form').hidden=!actions.current;
  if(actions.current){el('action-status').value=actions.current.status;el('action-feedback').value=actions.current.feedback;}
  el('next-action-week').textContent=addDays(data.weekStart,7)+' — '+addDays(data.weekStart,13);el('action-text').value=actions.next?.text||'';
  el('next-action-saved').innerHTML=actions.next?'<p>已保存 · '+actionStatus[actions.next.status]+(actions.next.feedback?' · '+esc(actions.next.feedback):'')+'</p>':'';
  el('action-message').textContent='';el('feedback-message').textContent='';
}
function renderNutrition(data){const current=data.nutrition.current,previous=data.nutrition.previous;
  function period(value,label){return '<article class="weekly-card"><h3>'+label+'</h3><div class="weekly-number"><strong'+(value.knownCalories===null?' class="empty"':'')+'>'+(value.knownCalories===null?'暂无已知热量':esc(value.knownCalories))+'</strong>'+(value.knownCalories===null?'':'<span>kcal 已知小计</span>')+'</div><p>有饮食记录 '+value.recordedDays+' / '+data.comparisonDays+' 天 · '+value.entryCount+' 条食物</p><p>已填热量 '+value.knownCount+' 条 · 未知热量 '+value.unknownCount+' 条</p></article>';}
  el('nutrition').innerHTML=period(current,'本期饮食')+period(previous,'上周同期饮食');
}
function renderWeightPlan(data){const plan=data.weightPlan.review,obs=plan.observations,progress=plan.progress;let html='<p>截至 '+esc(data.weightPlan.asOfDay)+'，近7天有体重记录 '+obs.recordedDays7+' 天；记录日均 '+format(obs.average7)+' kg。</p>';
  if(plan.settings&&progress){const direction={loss:'减重',gain:'增重',maintain:'维持'}[progress.direction];const stateLabel={active:'进行中',achieved:'已达到目标',ended:'计划日期已结束',missing:'近7天暂无记录'}[progress.status];html+='<p>'+direction+' · '+stateLabel+'；目标 '+format(plan.settings.targetWeight)+' kg，截止 '+esc(plan.settings.deadline)+'。</p><p>'+(progress.progressPercent===null?'与目标差距 '+format(progress.gapKg)+' kg':'实测进度 '+format(progress.progressPercent)+'% · 距目标 '+format(progress.gapKg)+' kg')+'</p>';}
  else html+='<p>'+(!plan.settings?'所选日期尚无可用体重计划。':'体重计划已停用，实测记录仍保留。')+'</p>';
  el('weight-plan').innerHTML=html;
}
function render(data){
  state.data=data;state.dirty=false;renderNutrition(data);renderWeightPlan(data);renderActions(data);
  el('range').textContent=data.weekStart+' — '+data.weekEnd;el('partial').hidden=!data.partial;el('comparison').textContent='本期 '+data.weekStart+' — '+data.cutoffDay+'；对比上周同期 '+data.previousStart+' — '+data.previousCutoffDay+'（各 '+data.comparisonDays+' 天）。';
  const byMetric=new Map(data.metrics.map((metric)=>[metric.metric,metric]));
  el('metrics').innerHTML=keys.map((key)=>{const metric=byMetric.get(key);return '<article class="weekly-card"><h3>'+labels[key]+' · 记录日均</h3><div class="weekly-number"><strong'+(metric.currentAverage===null?' class="empty"':'')+'>'+(metric.currentAverage===null?'暂无记录':format(metric.currentAverage))+'</strong>'+(metric.currentAverage===null?'':'<span>'+units[key]+'</span>')+'</div><p>本期有记录 '+metric.currentRecordedDays+' / '+data.comparisonDays+' 天</p><p>上周同期 '+(metric.previousAverage===null?'暂无记录':format(metric.previousAverage)+' '+units[key])+' · '+metric.previousRecordedDays+' 天</p><p class="weekly-delta">'+(metric.delta===null?'暂无可比日均':metric.delta===0?'与上周同期持平':'日均差值 '+(metric.delta>0?'+':'')+format(metric.delta)+' '+units[key])+'</p></article>';}).join('');
  el('goals').innerHTML=keys.slice(0,3).map((key)=>{const metric=byMetric.get(key);const set=metric.target!==null;return '<article class="weekly-card"><h3>'+labels[key]+'</h3><div class="weekly-goal-value'+(!set||!metric.currentRecordedDays?' empty':'')+'">'+(!set?'未设置目标':metric.currentRecordedDays?'达成 '+metric.currentAchievedDays+' 天':'暂无记录')+'</div><p>'+(!set?'不计算目标达成天数':'当前目标 '+format(metric.target)+' '+units[key]+' / 天')+'</p><p>本期'+(set?'达成 '+metric.currentAchievedDays+' / ':'')+'有记录 '+metric.currentRecordedDays+' 天</p><p>上周同期'+(set?'达成 '+metric.previousAchievedDays+' / ':'')+'有记录 '+metric.previousRecordedDays+' 天</p></article>';}).join('');
  el('completeness').innerHTML=keys.map((key)=>'<li>'+labels[key]+'<strong>'+byMetric.get(key).currentRecordedDays+' / '+data.comparisonDays+' 天</strong></li>').join('')+'<li>饮食<strong>'+data.nutrition.current.recordedDays+' / '+data.comparisonDays+' 天</strong></li>';el('coverage-note').textContent=(data.isCurrent?'本周尚未结束，仅比较截至今天的 '+data.comparisonDays+' 天。':'历史周按完整 '+data.comparisonDays+' 天比较。')+'各指标单独统计有记录天数，缺失留空；有饮食记录不代表当天饮食已记全。';
  el('daily-rows').innerHTML=Array.from({length:data.comparisonDays},(_,index)=>{const first=byMetric.get('steps');return '<tr><th scope="row">'+first.currentPoints[index].day+'<small style="display:block;font-weight:400">上周 '+first.previousPoints[index].day+'</small></th>'+keys.map((key)=>{const metric=byMetric.get(key);const current=metric.currentPoints[index].value;const previous=metric.previousPoints[index].value;return '<td><strong'+(current===null?' class="empty"':'')+'>'+format(current)+'</strong><small>'+format(previous)+'</small></td>';}).join('')+'</tr>';}).join('');
  el('empty').hidden=data.metrics.some((metric)=>metric.currentRecordedDays>0);el('content').hidden=false;
}
async function load(){
  if(state.saving)return;
  controls();const sequence=++state.sequence;state.controller?.abort();const controller=new AbortController();state.controller=controller;const week=state.week;el('page').setAttribute('aria-busy','true');el('content').hidden=true;el('partial').hidden=true;el('comparison').textContent='';status('正在读取这周的健康回顾…');
  try{const response=await fetch('/api/health/review?'+new URLSearchParams({week}),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});let data;try{data=await response.json();}catch{const error=new Error(response.status===401?'请先登录网站，再查看每周回顾。':'每周回顾暂时无法读取，请重试。');error.status=response.status;throw error;}if(sequence!==state.sequence)return;if(!response.ok){const error=new Error(typeof data?.error==='string'?data.error:'每周回顾暂时不可用，请稍后重试。');error.status=response.status;error.code=data?.code;throw error;}
    if(data?.weekStart!==week||!validDay(data.cutoffDay)||!Array.isArray(data.metrics)||!data.nutrition?.current||!data.nutrition?.previous||!data.weightPlan?.review||!data.actions||!Number.isInteger(data.comparisonDays)||data.comparisonDays<1||data.comparisonDays>7||!keys.every((key)=>data.metrics.some((metric)=>metric.metric===key&&Array.isArray(metric.currentPoints)&&metric.currentPoints.length===data.comparisonDays&&Array.isArray(metric.previousPoints)&&metric.previousPoints.length===data.comparisonDays)))throw new Error('每周回顾内容暂时无法读取，请重试。');
    state.week=data.weekStart;state.today=data.today;render(data);status('');
  }catch(error){if(sequence!==state.sequence||error?.name==='AbortError')return;status(error?.message||'每周回顾读取失败，请重试。',true,error?.status===401||error?.code==='SIGN_IN_REQUIRED');}
  finally{if(sequence===state.sequence){state.controller=null;el('page').setAttribute('aria-busy','false');}}
}
function choose(day){if(state.saving)return;if(!validDay(day)||monday(day)>monday(today())){el('date').value=state.week;status('请选择本周或更早的日期。',true);return;}state.week=monday(day);state.followCurrent=state.week===monday(today());load();}
async function saveAction(kind){
  if(state.saving||!state.data)return;const data=state.data;const existing=kind==='next'?data.actions.next:data.actions.current;if(kind==='feedback'&&!existing)return;
  const message=el(kind==='next'?'action-message':'feedback-message');const form=el(kind==='next'?'action-form':'feedback-form');
  const input=kind==='next'?{weekStart:addDays(data.weekStart,7),text:el('action-text').value.trim(),status:existing?.status||'planned',feedback:existing?.feedback||'',expectedRevision:existing?.revision||0}:{weekStart:data.weekStart,text:existing.text,status:el('action-status').value,feedback:el('action-feedback').value.trim(),expectedRevision:existing.revision};
  if(!input.text){message.textContent='先填写一项具体行动。';return;}state.saving=true;form.querySelectorAll('button,input,textarea,select').forEach((node)=>node.disabled=true);message.textContent='正在保存…';
  try{const response=await fetch('/api/health/actions',{method:'PUT',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});let result;try{result=await response.json();}catch{throw new Error('暂时无法确认保存结果；请保留内容并重试。');}if(!response.ok){if(response.status===409){message.textContent=(result.error||'行动已更新。')+' 点击“读取最新行动”后再核对保存。';el('reload-actions').hidden=false;return;}const error=new Error(result.error||'行动暂时无法保存，请重试。');error.status=response.status;throw error;}if(!result.action)throw new Error('暂时无法确认保存结果；请保留内容并重试。');
    if(state.data===data){data.actions[kind==='next'?'next':'current']=result.action;if(kind==='next'){el('next-action-saved').innerHTML='<p>已保存 · '+actionStatus[result.action.status]+'</p>';}else{el('current-action-summary').innerHTML=actionSummary(result.action,'');}message.textContent=kind==='next'?'下周行动已保存。':'行动反馈已保存。';el('reload-actions').hidden=true;}window.dispatchEvent(new Event('health-weekly-action-saved'));
  }catch(error){message.textContent=error?.message||'保存失败，请重试。';if(error?.status===401)status('登录已过期；请重新登录后保存行动。',true,true);}
  finally{state.saving=false;form.querySelectorAll('button,input,textarea,select').forEach((node)=>node.disabled=false);}
}
el('action-form').addEventListener('submit',(event)=>{event.preventDefault();saveAction('next');});el('feedback-form').addEventListener('submit',(event)=>{event.preventDefault();saveAction('feedback');});el('reload-actions').addEventListener('click',()=>{if(!state.saving){el('reload-actions').hidden=true;load();}});
['action-text','action-feedback','action-status'].forEach((id)=>el(id).addEventListener('input',()=>{state.dirty=true;}));
el('previous').addEventListener('click',()=>choose(addDays(state.week,-7)));el('next').addEventListener('click',()=>choose(addDays(state.week,7)));el('date').addEventListener('change',()=>choose(el('date').value));el('retry').addEventListener('click',load);
window.addEventListener('popstate',()=>{if(!state.saving){restoreUrl();load();}});window.addEventListener('pageshow',(event)=>{if(event.persisted&&!state.saving&&!state.dirty)load();});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!state.saving&&!state.dirty)load();});restoreUrl();load();
})();</script>`;
}
