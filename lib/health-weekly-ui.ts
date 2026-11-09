export function renderHealthWeeklyScript(): string {
  return String.raw`<script type="module">(()=>{
const el=(id)=>document.getElementById('weekly-'+id);
const keys=['steps','sleep','active_energy','weight'];
const labels={steps:'步数',sleep:'睡眠',active_energy:'活动能量',weight:'体重'};
const units={steps:'步',sleep:'小时',active_energy:'千卡',weight:'kg'};
const state={week:'',followCurrent:true,today:'',sequence:0,controller:null};
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
function render(data){
  el('range').textContent=data.weekStart+' — '+data.weekEnd;el('partial').hidden=!data.partial;el('comparison').textContent='本期 '+data.weekStart+' — '+data.cutoffDay+'；对比上周同期 '+data.previousStart+' — '+data.previousCutoffDay+'（各 '+data.comparisonDays+' 天）。';
  const byMetric=new Map(data.metrics.map((metric)=>[metric.metric,metric]));
  el('metrics').innerHTML=keys.map((key)=>{const metric=byMetric.get(key);return '<article class="weekly-card"><h3>'+labels[key]+' · 记录日均</h3><div class="weekly-number"><strong'+(metric.currentAverage===null?' class="empty"':'')+'>'+(metric.currentAverage===null?'暂无记录':format(metric.currentAverage))+'</strong>'+(metric.currentAverage===null?'':'<span>'+units[key]+'</span>')+'</div><p>本期有记录 '+metric.currentRecordedDays+' / '+data.comparisonDays+' 天</p><p>上周同期 '+(metric.previousAverage===null?'暂无记录':format(metric.previousAverage)+' '+units[key])+' · '+metric.previousRecordedDays+' 天</p><p class="weekly-delta">'+(metric.delta===null?'暂无可比日均':metric.delta===0?'与上周同期持平':'日均差值 '+(metric.delta>0?'+':'')+format(metric.delta)+' '+units[key])+'</p></article>';}).join('');
  el('goals').innerHTML=keys.slice(0,3).map((key)=>{const metric=byMetric.get(key);const set=metric.target!==null;return '<article class="weekly-card"><h3>'+labels[key]+'</h3><div class="weekly-goal-value'+(!set||!metric.currentRecordedDays?' empty':'')+'">'+(!set?'未设置目标':metric.currentRecordedDays?'达成 '+metric.currentAchievedDays+' 天':'暂无记录')+'</div><p>'+(!set?'不计算目标达成天数':'当前目标 '+format(metric.target)+' '+units[key]+' / 天')+'</p><p>本期'+(set?'达成 '+metric.currentAchievedDays+' / ':'')+'有记录 '+metric.currentRecordedDays+' 天</p><p>上周同期'+(set?'达成 '+metric.previousAchievedDays+' / ':'')+'有记录 '+metric.previousRecordedDays+' 天</p></article>';}).join('');
  el('completeness').innerHTML=keys.map((key)=>'<li>'+labels[key]+'<strong>'+byMetric.get(key).currentRecordedDays+' / '+data.comparisonDays+' 天</strong></li>').join('');el('coverage-note').textContent=(data.isCurrent?'本周尚未结束，仅比较截至今天的 '+data.comparisonDays+' 天。':'历史周按完整 '+data.comparisonDays+' 天比较。')+'各指标单独统计有记录天数，缺失留空。';
  el('daily-rows').innerHTML=Array.from({length:data.comparisonDays},(_,index)=>{const first=byMetric.get('steps');return '<tr><th scope="row">'+first.currentPoints[index].day+'<small style="display:block;font-weight:400">上周 '+first.previousPoints[index].day+'</small></th>'+keys.map((key)=>{const metric=byMetric.get(key);const current=metric.currentPoints[index].value;const previous=metric.previousPoints[index].value;return '<td><strong'+(current===null?' class="empty"':'')+'>'+format(current)+'</strong><small>'+format(previous)+'</small></td>';}).join('')+'</tr>';}).join('');
  el('empty').hidden=data.metrics.some((metric)=>metric.currentRecordedDays>0);el('content').hidden=false;
}
async function load(){
  controls();const sequence=++state.sequence;state.controller?.abort();const controller=new AbortController();state.controller=controller;const week=state.week;el('page').setAttribute('aria-busy','true');el('content').hidden=true;el('partial').hidden=true;el('comparison').textContent='';status('正在读取这周的健康回顾…');
  try{const response=await fetch('/api/health/review?'+new URLSearchParams({week}),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});let data;try{data=await response.json();}catch{const error=new Error(response.status===401?'请先登录网站，再查看每周回顾。':'每周回顾暂时无法读取，请重试。');error.status=response.status;throw error;}if(sequence!==state.sequence)return;if(!response.ok){const error=new Error(typeof data?.error==='string'?data.error:'每周回顾暂时不可用，请稍后重试。');error.status=response.status;error.code=data?.code;throw error;}
    if(data?.weekStart!==week||!validDay(data.cutoffDay)||!Array.isArray(data.metrics)||!Number.isInteger(data.comparisonDays)||data.comparisonDays<1||data.comparisonDays>7||!keys.every((key)=>data.metrics.some((metric)=>metric.metric===key&&Array.isArray(metric.currentPoints)&&metric.currentPoints.length===data.comparisonDays&&Array.isArray(metric.previousPoints)&&metric.previousPoints.length===data.comparisonDays)))throw new Error('每周回顾内容暂时无法读取，请重试。');
    state.week=data.weekStart;state.today=data.today;render(data);status('');
  }catch(error){if(sequence!==state.sequence||error?.name==='AbortError')return;status(error?.message||'每周回顾读取失败，请重试。',true,error?.status===401||error?.code==='SIGN_IN_REQUIRED');}
  finally{if(sequence===state.sequence){state.controller=null;el('page').setAttribute('aria-busy','false');}}
}
function choose(day){if(!validDay(day)||monday(day)>monday(today())){el('date').value=state.week;status('请选择本周或更早的日期。',true);return;}state.week=monday(day);state.followCurrent=state.week===monday(today());load();}
el('previous').addEventListener('click',()=>choose(addDays(state.week,-7)));el('next').addEventListener('click',()=>choose(addDays(state.week,7)));el('date').addEventListener('change',()=>choose(el('date').value));el('retry').addEventListener('click',load);
window.addEventListener('popstate',()=>{restoreUrl();load();});window.addEventListener('pageshow',(event)=>{if(event.persisted)load();});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load();});restoreUrl();load();
})();</script>`;
}
