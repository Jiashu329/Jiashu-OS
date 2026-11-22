import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';
import { HEALTH_NAVIGATION_SCRIPT } from './health-navigation.ts';

export function renderHealthWeeklyScript(): string {
  return String.raw`<script type="module">(()=>{
${CLIENT_REQUEST_SCRIPT}
${HEALTH_NAVIGATION_SCRIPT}
const el=(id)=>document.getElementById('weekly-'+id);
const keys=['steps','sleep','active_energy','weight'];
const labels={steps:'步数',sleep:'睡眠',active_energy:'活动能量',weight:'体重'};
const units={steps:'步',sleep:'小时',active_energy:'千卡',weight:'kg'};
const state={week:'',followCurrent:true,today:'',sequence:0,controller:null,data:null,saving:false,conflict:false,actionBaseline:'',feedbackBaseline:'',pending:null,suggestedDraft:null};
let nextGuard=null,feedbackGuard=null;
const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const format=(value)=>typeof value==='number'&&Number.isFinite(value)?number.format(value):'—';
function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1969-12-29'||value>'2100-12-31')return false;const time=Date.parse(value+'T12:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
function today(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=(key)=>parts.find((part)=>part.type===key).value;return get('year')+'-'+get('month')+'-'+get('day');}
function addDays(day,count){return new Date(Date.parse(day+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);}
function monday(day){const value=new Date(day+'T12:00:00Z');return addDays(day,-((value.getUTCDay()+6)%7));}
function path(){return '/health/review?'+new URLSearchParams({week:state.week});}
function restoreUrl(){const raw=new URLSearchParams(location.search).get('week');state.today=today();const current=monday(state.today);state.week=validDay(raw)&&monday(raw)<=current?monday(raw):current;state.followCurrent=state.week===current;}
function changedAccount(){return Boolean(window.JiashuAccountSession?.changed);}
function feedbackValue(){return JSON.stringify([el('action-status').value,el('action-feedback').value]);}
function nextDirty(){return Boolean(state.data)&&el('action-text').value!==state.actionBaseline;}
function feedbackDirty(){return Boolean(state.data?.actions.current)&&feedbackValue()!==state.feedbackBaseline;}
function dirty(){return nextDirty()||feedbackDirty();}
function draftValues(){return{text:el('action-text').value,status:el('action-status').value,feedback:el('action-feedback').value};}
function setBaselines(){state.actionBaseline=el('action-text').value;state.feedbackBaseline=feedbackValue();nextGuard?.reset();feedbackGuard?.reset();}
function controls(){state.today=today();const current=monday(state.today);el('date').value=state.week;el('date').max=state.today;el('date').disabled=state.saving||changedAccount()||Boolean(state.controller);el('next').disabled=state.saving||changedAccount()||Boolean(state.controller)||state.week>=current;el('previous').disabled=state.saving||changedAccount()||Boolean(state.controller)||state.week<='1969-12-29';el('range').textContent=state.week+' — '+addDays(state.week,6);if(location.pathname+location.search!==path())history.replaceState(null,'',path());el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(path());}
function status(message,error=false,login=false){el('status').hidden=!message;el('status').classList.toggle('error',error);el('status-text').textContent=message;el('retry').hidden=!error;el('login').hidden=!login;el('login').href='/signin-with-chatgpt?return_to='+encodeURIComponent(path());}
function confirmNavigate(action){
 if(state.saving||changedAccount()){status(changedAccount()?'登录账号已变化，请刷新后继续。':'正在保存行动，请等待结果。');el('date').value=state.week;return;}
 if(!dirty()){state.pending=null;el('discard').hidden=true;action();return;}
 el('date').value=state.week;
 if(nextGuard?.confirm&&feedbackGuard?.confirm){nextGuard.confirm(()=>feedbackGuard.confirm(action));return;}
 state.pending=action;status('有未保存的行动或反馈，请先保存，或明确放弃后继续。');el('discard').hidden=false;
}
const actionStatus={planned:'计划中',completed:'已完成',not_completed:'未完成'};
function actionSummary(action,empty){return action?'<p><strong>'+esc(action.text)+'</strong></p><p>'+esc(action.weekStart)+' 开始 · '+(actionStatus[action.status]||'待核对')+'</p>'+(action.feedback?'<p>反馈：'+esc(action.feedback)+'</p>':''):'<p>'+empty+'</p>';}
function renderActions(data){
 if(data.supplementalStatus?.actions==='unavailable'){el('previous-action').textContent='行动暂时无法读取，请重试。';el('current-action-summary').textContent='行动暂时无法读取，请重试后再保存，避免覆盖原计划。';el('feedback-form').hidden=true;el('action-form').hidden=true;return;}
 el('action-form').hidden=false;const actions=data.actions;el('previous-action').innerHTML=actionSummary(actions.previous,'上一周尚未保存行动。');
 el('current-action-summary').innerHTML=actionSummary(actions.current,'这周尚未保存行动。先从上方重点为下一周选一件事。');el('feedback-form').hidden=!actions.current;
 el('action-status').value=actions.current?.status||'planned';el('action-feedback').value=actions.current?.feedback||'';
 el('next-action-week').textContent=addDays(data.weekStart,7)+' — '+addDays(data.weekStart,13);el('action-text').value=actions.next?.text||'';
 el('next-action-saved').innerHTML=actions.next?'<p>已保存 · '+(actionStatus[actions.next.status]||'待核对')+(actions.next.feedback?' · '+esc(actions.next.feedback):'')+'</p>':'';
 el('action-message').textContent='';el('feedback-message').textContent='';
}
function safeFocusHref(raw){try{if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//'))return null;const url=new URL(raw,location.origin);return url.origin===location.origin&&['/health','/health/nutrition','/health/records','/health/weight-plan','/sync'].includes(url.pathname)?url.pathname+url.search+url.hash:null;}catch{return null;}}
function focusTag(item){return item.kind==='attention'?'优先关注':item.kind==='positive'?'值得保持':['record-coverage','nutrition-coverage'].includes(item.id)?'记录待补充':item.id==='steady-records'?'保持观察':'记录变化';}
function focusLink(item){const href=safeFocusHref(item.href);return href?'<a class="weekly-focus-link" href="'+esc(href)+'">'+esc(item.linkLabel||'查看相关记录')+' →</a>':'';}
function focusItem(item,primary=false){if(!item||typeof item.title!=='string'||typeof item.evidence!=='string'||typeof item.interpretation!=='string')return'';return '<p class="weekly-focus-tag">'+focusTag(item)+'</p>'+(primary?'':'<h3>'+esc(item.title)+'</h3>')+'<p class="'+(primary?'weekly-focus-evidence':'')+'">'+esc(item.evidence)+'</p><p class="weekly-focus-interpretation">'+esc(item.interpretation)+'</p>'+focusLink(item);}
function suggestionBlocked(){
 if(changedAccount())return'登录账号已变化，请刷新后继续。';if(state.saving||state.controller)return'正在读取或保存，请稍候。';
 const suggestion=state.data?.focus?.suggestedAction;if(!suggestion||typeof suggestion.text!=='string'||!suggestion.text.trim()||suggestion.text.length>200)return'暂无可采用的行动建议。';if(state.data.supplementalStatus?.actions==='unavailable')return'行动暂时无法读取，请先重试后再采用建议。';
 if(state.conflict)return'行动已在其他页面更新，请先读取最新行动并核对。';if(state.data.actions.next)return'已保存行动，请在下方核对原计划。';if(dirty())return'有未保存的行动或反馈，请先保存或放弃填写。';return null;
}
function refreshSuggestion(){const reason=suggestionBlocked();el('focus-use-action').disabled=Boolean(reason);el('focus-action-message').textContent=state.suggestedDraft&&el('action-text').value===state.suggestedDraft?'已填入下方行动草稿，核对后点击“保存行动”才会生效。':state.data?.focus?.suggestedAction?(reason||'采用建议只填写草稿，仍需核对并保存。'):'';}
function renderFocus(data){
 const focus=data.focus;if(!focus||typeof focus.headline!=='string'||typeof focus.summary!=='string'||typeof focus.coverageNote!=='string'){el('focus-headline').textContent='这周的重点暂时无法读取';el('focus-summary').textContent='可以先展开详细数据查看记录，再重试获取本周重点。';el('focus-summary').hidden=false;el('focus-primary').textContent='';el('focus-secondary').textContent='';el('focus-coverage').textContent='';el('focus-action').hidden=true;return;}
 el('focus-headline').textContent=focus.headline;el('focus-summary').textContent=focus.summary;el('focus-summary').hidden=focus.summary===focus.primary?.evidence;el('focus-primary').innerHTML=focusItem(focus.primary,true);
 el('focus-secondary').innerHTML=(Array.isArray(focus.secondary)?focus.secondary.slice(0,2):[]).map(item=>'<article>'+focusItem(item)+'</article>').join('');el('focus-coverage').textContent=focus.coverageNote;
 const action=focus.suggestedAction;el('focus-action').hidden=!action||typeof action.text!=='string'||!action.text.trim()||action.text.length>200;el('focus-action-text').textContent=action?.text||'';el('focus-use-action').textContent='用作下一周行动';refreshSuggestion();
}
function renderNutrition(data){const current=data.nutrition.current,previous=data.nutrition.previous;
  if(data.supplementalStatus?.nutrition==='unavailable'){el('nutrition').textContent='饮食记录暂时无法读取，请重试；健康指标仍可查看。';return;}
  function period(value,label){return '<article class="weekly-card"><h3>'+label+'</h3><div class="weekly-number"><strong'+(value.knownCalories===null?' class="empty"':'')+'>'+(value.knownCalories===null?'暂无已知热量':esc(value.knownCalories))+'</strong>'+(value.knownCalories===null?'':'<span>kcal 已知小计</span>')+'</div><p>有饮食记录 '+value.recordedDays+' / '+data.comparisonDays+' 天 · '+value.entryCount+' 条食物</p><p>已填热量 '+value.knownCount+' 条 · 未知热量 '+value.unknownCount+' 条</p></article>';}
  el('nutrition').innerHTML=period(current,'本期饮食')+period(previous,'上周同期饮食');
}
function renderWeightPlan(data){if(data.supplementalStatus?.weightPlan==='unavailable'){el('weight-plan').textContent='体重计划暂时无法读取，请重试；实测健康指标仍可查看。';return;}const plan=data.weightPlan.review,obs=plan.observations,progress=plan.progress;let html='<p>截至 '+esc(data.weightPlan.asOfDay)+'，近7天有体重记录 '+obs.recordedDays7+' 天；记录日均 '+format(obs.average7)+' kg。</p>';
  if(plan.settings&&progress){const direction={loss:'减重',gain:'增重',maintain:'维持'}[progress.direction];const stateLabel={active:'进行中',achieved:'已达到目标',ended:'计划日期已结束',missing:'近7天暂无记录'}[progress.status];html+='<p>'+direction+' · '+stateLabel+'；目标 '+format(plan.settings.targetWeight)+' kg，截止 '+esc(plan.settings.deadline)+'。</p><p>'+(progress.progressPercent===null?'与目标差距 '+format(progress.gapKg)+' kg':'实测进度 '+format(progress.progressPercent)+'% · 距目标 '+format(progress.gapKg)+' kg')+'</p>';}
  else html+='<p>'+(!plan.settings?'所选日期尚无可用体重计划。':'体重计划已停用，实测记录仍保留。')+'</p>';
  el('weight-plan').innerHTML=html;
}
function weeklyHealthHref(metric,period){
  const range=isCalendarDay(period?.from)&&isCalendarDay(period?.to)?{from:period.from,to:period.to,day:period.to}:undefined;
  return esc(healthViewPath(metric,7,false,range));
}
function periodDays(period){return Math.round((Date.parse(period.to+'T12:00:00Z')-Date.parse(period.from+'T12:00:00Z'))/86400000)+1;}
function appleCoverage(days,period){return format(days)+' / '+periodDays(period)+' 天';}
function weeklyHeart(period,key){
  const metric=period?.[key];
  return metric?format(metric.average)+' 次/分 · '+appleCoverage(metric.days,period):'暂无记录';
}
function weeklyOxygen(period,field){
  const metric=period?.oxygenSaturation;
  if(!metric)return '暂无记录';
  return field==='days'?appleCoverage(metric.days,period):format(metric.samples)+' 次';
}
function weeklyWorkout(period,field){
  const metric=period?.workouts;
  if(!metric)return '暂无已同步训练';
  return field==='duration'?format(metric.durationSeconds/60)+' 分钟':format(metric.count)+' 次';
}
function weeklyAppleRow(label,metric,current,previous,value){
  const heading=metric?'<a href="'+weeklyHealthHref(metric,current)+'">'+label+'</a>':'<span>'+label+'</span>';
  return '<div class="weekly-apple-row">'+heading+'<div><strong>'+esc(value(current))+'</strong>'
    +'<small>上周同期 '+esc(value(previous))+'</small></div></div>';
}
function weeklyAppleCard(label,metric,period,rows){
  const heading=metric==='heart_rate'?label:'<a href="'+weeklyHealthHref(metric,period)+'">'+label+'</a>';
  return '<article class="weekly-card weekly-apple-card '+metric+'"><h3>'+heading+'</h3>'+rows.join('')+'</article>';
}
function renderWeeklyApple(activity){
  const section=el('apple-section'),today=el('apple-today');
  if(!section||!today)return;
  section.hidden=!activity;
  today.hidden=true;
  today.replaceChildren();
  if(!activity)return;
  const result=el('apple-activity');
  if(activity.status!=='ready'){
    result.textContent='训练、心率和血氧暂时无法读取。';
    return;
  }
  const {current,previous}=activity;
  if(!current||!previous){
    result.textContent='本周尚无已结束的日期可比较。';
  }else{
    const summary='已结束日期 '+current.from+' 至 '+current.to+' · 上周同期 '+previous.from+' 至 '+previous.to+'（各 '+periodDays(current)+' 天）';
    const row=(label,metric,value)=>weeklyAppleRow(label,metric,current,previous,value);
    result.innerHTML='<p class="weekly-note weekly-apple-date">'+esc(summary)+'</p><div class="weekly-apple-grid">'
      +weeklyAppleCard('活动与训练','workouts',current,[
        row('训练次数',null,period=>weeklyWorkout(period,'count')),
        row('实际训练时长',null,period=>weeklyWorkout(period,'duration')),
      ])
      +weeklyAppleCard('心率','heart_rate',current,[
        row('日均心率','heart_rate',period=>weeklyHeart(period,'heartRate')),
        row('静息心率','resting_heart_rate',period=>weeklyHeart(period,'restingHeartRate')),
      ])
      +weeklyAppleCard('血氧','oxygen_saturation',current,[
        row('有记录天数',null,period=>weeklyOxygen(period,'days')),
        row('采样次数',null,period=>weeklyOxygen(period,'samples')),
      ])+'</div>';
  }
  const day=activity.today;
  if(day){
    const values=[
      ['训练','workouts',day.workouts?weeklyWorkout(day,'count')+' · '+weeklyWorkout(day,'duration'):weeklyWorkout(day,'count')],
      ['日均心率','heart_rate',day.heartRate?format(day.heartRate.average)+' 次/分':'暂无记录'],
      ['静息心率','resting_heart_rate',day.restingHeartRate?format(day.restingHeartRate.average)+' 次/分':'暂无记录'],
      ['血氧','oxygen_saturation',day.oxygenSaturation?'采样 '+weeklyOxygen(day,'samples'):'暂无记录'],
    ];
    today.innerHTML='<h3>今天的记录 <small>'+esc(day.to)+'</small></h3><div class="weekly-apple-today-grid">'
      +values.map(([label,metric,value])=>'<a href="'+weeklyHealthHref(metric,day)+'"><span>'+label+'</span><strong>'+esc(value)+'</strong></a>').join('')+'</div>';
    today.hidden=false;
  }
}
function render(data,drafts=null){
  state.data=data;state.conflict=false;state.suggestedDraft=null;renderNutrition(data);renderWeightPlan(data);renderWeeklyApple(data.appleActivity);renderActions(data);setBaselines();if(drafts){el('action-text').value=drafts.text;if(data.actions.current){el('action-status').value=drafts.status;el('action-feedback').value=drafts.feedback;}}renderFocus(data);
  el('range').textContent=data.weekStart+' — '+data.weekEnd;el('partial').hidden=!data.partial;el('comparison').textContent='详细数据涵盖本期 '+data.weekStart+' — '+data.cutoffDay+'；对比上周同期 '+data.previousStart+' — '+data.previousCutoffDay+'（各 '+data.comparisonDays+' 天）。';
  const byMetric=new Map(data.metrics.map((metric)=>[metric.metric,metric]));
  el('metrics').innerHTML=keys.map((key)=>{const metric=byMetric.get(key);return '<article class="weekly-card"><h3>'+labels[key]+' · 记录日均</h3><div class="weekly-number"><strong'+(metric.currentAverage===null?' class="empty"':'')+'>'+(metric.currentAverage===null?'暂无记录':format(metric.currentAverage))+'</strong>'+(metric.currentAverage===null?'':'<span>'+units[key]+'</span>')+'</div><p>本期有记录 '+metric.currentRecordedDays+' / '+data.comparisonDays+' 天</p><p>上周同期 '+(metric.previousAverage===null?'暂无记录':format(metric.previousAverage)+' '+units[key])+' · '+metric.previousRecordedDays+' 天</p><p class="weekly-delta">'+(metric.delta===null?'暂无可比日均':metric.delta===0?'与上周同期持平':'记录日均差值 '+(metric.delta>0?'+':'')+format(metric.delta)+' '+units[key])+'</p></article>';}).join('');
  el('goals').innerHTML=keys.slice(0,3).map((key)=>{const metric=byMetric.get(key);const currentSet=metric.currentAchievedDays!==null,previousSet=metric.previousAchievedDays!==null,set=currentSet||previousSet;const timeline=[...(metric.targetsInPeriod||[]),...(metric.previousPoints||[]).filter((point)=>Object.hasOwn(point,'target')).map((point)=>({day:point.day,target:point.target,effectiveFrom:point.targetEffectiveFrom}))].map((point)=>point.day+'：'+(point.target===null?'未设置':format(point.target)+' '+units[key])+(point.effectiveFrom==='1970-01-01'?'（历史基线）':point.effectiveFrom?'（'+point.effectiveFrom+' 起）':''));return '<article class="weekly-card"><h3>'+labels[key]+'</h3><div class="weekly-goal-value'+(!set||!metric.currentRecordedDays?' empty':'')+'">'+(!currentSet?'本期未设置目标':metric.currentRecordedDays?'达成 '+metric.currentAchievedDays+' 天':'暂无记录')+'</div><p>'+(!set?'不计算目标达成天数':'按当日生效目标统计')+'</p><p>本期'+(set?'达成 '+metric.currentAchievedDays+' / ':'')+'有记录 '+metric.currentRecordedDays+' 天</p><p>上周同期'+(set?'达成 '+metric.previousAchievedDays+' / ':'')+'有记录 '+metric.previousRecordedDays+' 天</p>'+(timeline.length?'<details><summary>查看两周每日目标</summary><p>'+timeline.map(esc).join('<br>')+'</p></details>':'')+'</article>';}).join('');
  el('completeness').innerHTML=keys.map((key)=>'<li>'+labels[key]+'<strong>'+byMetric.get(key).currentRecordedDays+' / '+data.comparisonDays+' 天</strong></li>').join('')+'<li>饮食<strong>'+(data.supplementalStatus?.nutrition==='unavailable'?'暂不可用':data.nutrition.current.recordedDays+' / '+data.comparisonDays+' 天')+'</strong></li>';el('coverage-note').textContent=(data.isCurrent?'本周尚未结束，仅比较截至今天的 '+data.comparisonDays+' 天。':'历史周按完整 '+data.comparisonDays+' 天比较。')+'各指标单独统计有记录天数，缺失留空；有饮食记录不代表当天饮食已记全。';
  el('daily-rows').innerHTML=Array.from({length:data.comparisonDays},(_,index)=>{const first=byMetric.get('steps');return '<tr><th scope="row">'+first.currentPoints[index].day+'<small style="display:block;font-weight:400">上周 '+first.previousPoints[index].day+'</small></th>'+keys.map((key)=>{const metric=byMetric.get(key);const current=metric.currentPoints[index].value;const previous=metric.previousPoints[index].value;return '<td><strong'+(current===null?' class="empty"':'')+'>'+format(current)+'</strong><small>'+format(previous)+'</small></td>';}).join('')+'</tr>';}).join('');
  el('empty').hidden=data.metrics.some((metric)=>metric.currentRecordedDays>0);el('content').hidden=false;
}
async function load(preserve=false){
 if(state.saving||changedAccount())return;if(dirty()&&!preserve){status('有未保存的行动或反馈，请先保存或放弃填写。');return;}
 const drafts=preserve?draftValues():null,keepVisible=preserve&&Boolean(state.data);if(state.followCurrent&&!preserve)state.week=monday(today());controls();const sequence=++state.sequence;state.controller?.abort();const controller=new AbortController();state.controller=controller;const week=state.week;el('page').setAttribute('aria-busy','true');if(!keepVisible)el('content').hidden=true;formControls(true);el('partial').hidden=true;el('comparison').textContent='';status('正在归纳这周最值得关注的记录…');refreshSuggestion();
 try{const data=await requestJSON('/api/health/review?'+new URLSearchParams({week}),{signal:controller.signal,redirect:'error'});if(sequence!==state.sequence||changedAccount())return;
  if(data?.weekStart!==week||!validDay(data.cutoffDay)||!Array.isArray(data.metrics)||!data.nutrition?.current||!data.nutrition?.previous||!data.weightPlan?.review||!data.actions||!Number.isInteger(data.comparisonDays)||data.comparisonDays<1||data.comparisonDays>7||!keys.every(key=>data.metrics.some(metric=>metric.metric===key&&Array.isArray(metric.currentPoints)&&metric.currentPoints.length===data.comparisonDays&&Array.isArray(metric.previousPoints)&&metric.previousPoints.length===data.comparisonDays)))throw new Error('每周回顾内容暂时无法读取，请重试。');
  if(preserve&&data.supplementalStatus?.actions==='unavailable')throw new Error('行动暂时无法读取，原填写已保留，请稍后重试。');
  state.week=data.weekStart;state.today=data.today;render(data,drafts);el('reload-actions').hidden=true;const partial=data.appleActivity?.status==='unavailable'||Boolean(data.supplementalStatus&&Object.values(data.supplementalStatus).some(value=>value==='unavailable'));status(preserve?'已读取最新行动，原填写已保留，请核对后再保存。':partial?'部分补充信息暂时无法读取，现有健康重点仍可查看。':'',Boolean(partial));
 }catch(error){if(sequence!==state.sequence||error?.name==='AbortError')return;status(error?.message||'每周回顾读取失败，请重试。',true,error?.status===401||error?.code==='SIGN_IN_REQUIRED');}
 finally{if(sequence===state.sequence){state.controller=null;el('page').setAttribute('aria-busy','false');formControls(changedAccount());refreshSuggestion();}}
}
function choose(day){confirmNavigate(()=>{if(!validDay(day)||monday(day)>monday(today())){el('date').value=state.week;status('请选择本周或更早的日期。',true);return;}state.week=monday(day);state.followCurrent=state.week===monday(today());load();});}
function formControls(disabled){for(const id of ['action-form','feedback-form'])el(id).querySelectorAll('button,input,textarea,select').forEach(node=>node.disabled=disabled);controls();refreshSuggestion();}
async function saveAction(kind){
 if(state.saving||state.controller||!state.data||changedAccount())return;const data=state.data;const existing=kind==='next'?data.actions.next:data.actions.current;if(kind==='feedback'&&!existing||data.supplementalStatus?.actions==='unavailable')return;
 const message=el(kind==='next'?'action-message':'feedback-message'),guard=kind==='next'?nextGuard:feedbackGuard;
 if(state.conflict){message.textContent='行动已更新，请先读取最新行动并核对填写。';return;}
 const input=kind==='next'?{weekStart:addDays(data.weekStart,7),text:el('action-text').value.trim(),status:existing?.status||'planned',feedback:existing?.feedback||'',expectedRevision:existing?.revision||0}:{weekStart:data.weekStart,text:existing.text,status:el('action-status').value,feedback:el('action-feedback').value.trim(),expectedRevision:existing.revision};
 if(!input.text){message.textContent='先填写一项具体行动。';return;}state.saving=true;formControls(true);message.textContent='正在保存…';
 try{const result=await requestJSON('/api/health/actions',{method:'PUT',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  if(changedAccount()||state.data!==data)return;if(!result.action||result.action.weekStart!==input.weekStart||!Number.isSafeInteger(result.action.revision))throw new Error('暂时无法确认保存结果；请保留内容并读取最新行动。');
  data.actions[kind==='next'?'next':'current']=result.action;if(kind==='next'){state.actionBaseline=el('action-text').value;state.suggestedDraft=null;el('next-action-saved').innerHTML='<p>已保存 · '+(actionStatus[result.action.status]||'待核对')+'</p>';}else{state.feedbackBaseline=feedbackValue();el('current-action-summary').innerHTML=actionSummary(result.action,'');}guard?.saved();message.textContent=kind==='next'?'下一周行动已保存。':'行动反馈已保存。';el('reload-actions').hidden=true;if(!dirty()){state.pending=null;el('discard').hidden=true;}window.dispatchEvent(new Event('health-weekly-action-saved'));
 }catch(error){guard?.failed();if(error?.status===409){state.conflict=true;message.textContent=(error.message||'行动已更新。')+' 点击“读取最新行动”后再核对保存。';}else message.textContent=error?.message||'保存失败，填写已保留，请重试。';el('reload-actions').hidden=false;if(error?.status===401)status('登录已过期或账号已变化；请重新登录后继续。',true,true);}
 finally{state.saving=false;formControls(changedAccount());refreshSuggestion();}
}
nextGuard=window.JiashuDraftGuards?.register({form:el('action-form'),label:'下一周行动',durable:false,isDirty:nextDirty,isBusy:()=>state.saving,isBlocked:()=>state.saving,canSave:()=>!state.conflict&&!changedAccount()&&!state.controller,onDiscard:()=>{el('action-text').value=state.actionBaseline;state.suggestedDraft=null;refreshSuggestion();}})||null;
feedbackGuard=window.JiashuDraftGuards?.register({form:el('feedback-form'),label:'行动反馈',durable:false,isDirty:feedbackDirty,isBusy:()=>state.saving,isBlocked:()=>state.saving,canSave:()=>!state.conflict&&!changedAccount()&&!state.controller,onDiscard:()=>{const value=JSON.parse(state.feedbackBaseline||'["planned",""]');el('action-status').value=value[0];el('action-feedback').value=value[1];refreshSuggestion();}})||null;
el('focus-use-action').addEventListener('click',async()=>{
 if(suggestionBlocked())return;const data=state.data,suggestion=data.focus.suggestedAction;
 try{if(window.JiashuAccountSession?.verify)await window.JiashuAccountSession.verify();if(suggestionBlocked()||state.data!==data)return;el('action-text').value=suggestion.text;state.suggestedDraft=suggestion.text;el('action-text').dispatchEvent(new Event('input',{bubbles:true}));refreshSuggestion();el('action-text').focus();el('next-action-panel').scrollIntoView?.({behavior:'smooth',block:'center'});}
 catch(error){el('focus-action-message').textContent=error?.message||'暂时无法核对当前账号，行动未填入。';}
});
el('action-form').addEventListener('submit',event=>{event.preventDefault();saveAction('next');});el('feedback-form').addEventListener('submit',event=>{event.preventDefault();saveAction('feedback');});
el('reload-actions').addEventListener('click',()=>{if(!state.saving)load(true);});
['action-text','action-feedback','action-status'].forEach(id=>{el(id).addEventListener('input',refreshSuggestion);el(id).addEventListener('change',refreshSuggestion);});
el('discard').addEventListener('click',()=>{if(state.saving||changedAccount()||!state.pending)return;const action=state.pending;state.pending=null;renderActions(state.data);setBaselines();el('discard').hidden=true;action();});
el('previous').addEventListener('click',()=>choose(addDays(state.week,-7)));el('next').addEventListener('click',()=>choose(addDays(state.week,7)));el('date').addEventListener('change',()=>choose(el('date').value));el('retry').addEventListener('click',()=>confirmNavigate(()=>load()));
window.addEventListener('popstate',()=>{const raw=new URLSearchParams(location.search).get('week'),current=monday(today()),target=validDay(raw)&&monday(raw)<=current?monday(raw):current;if(dirty())history.replaceState(null,'',path());confirmNavigate(()=>{state.week=target;state.followCurrent=target===current;load();});});window.addEventListener('pageshow',event=>{if(event.persisted&&!state.saving&&!dirty())load();});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!state.saving&&!dirty())load();});
document.addEventListener('jiashu-account-changed',()=>{state.controller?.abort();state.sequence++;state.controller=null;el('page').setAttribute('aria-busy','false');status('登录账号已变化，当前填写仍保留。请刷新后继续。',true,true);formControls(true);refreshSuggestion();});restoreUrl();load();
})();</script>`;
}
