import type { HealthTrendPoint, SleepStages } from './health.ts';

export type SleepAnalysisPoint=Pick<HealthTrendPoint,'day'|'value'|'sleepStages'|'sleepTiming'>;

export interface SleepScheduleDay {
  day:string;hours:number;onset:string|null;wake:string|null;clipped:boolean;stages:SleepStages|null;
}
export interface SleepScheduleSummary {
  recordedDays:number;timingDays:number;clippedDays:number;stageDays:number;
  meanOnset:string|null;meanWake:string|null;onsetDeviationMinutes:number|null;wakeDeviationMinutes:number|null;
  stagePercent:Record<'unspecified'|'core'|'deep'|'rem',number>|null;
}
export interface SleepAnalysis extends SleepScheduleSummary {
  from:string;to:string;days:SleepScheduleDay[];
  weeks:Array<SleepScheduleSummary&{from:string;to:string}>;
  timingMethod:'longest-sleep-group-v1';
}
export const SLEEP_ANALYSIS_CSS=String.raw`.sleep-analysis{margin:18px 18px 0;border-top:1px solid var(--line);padding:16px 0}.sleep-analysis h3{font-size:14px;margin:0 0 12px}.sleep-schedule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.sleep-schedule-grid p,.sleep-analysis-note{color:var(--muted);font-size:11px;line-height:1.8;margin:5px 0}.sleep-schedule-grid strong{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}.sleep-analysis table{width:100%;border-collapse:collapse;min-width:460px;font-size:12px}.sleep-analysis th,.sleep-analysis td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;font-variant-numeric:tabular-nums}.sleep-analysis th{font-size:11px;color:var(--muted);font-weight:500}.sleep-analysis-scroll{overflow:auto;max-height:360px;margin-top:12px}.sleep-stage-share{display:flex;height:8px;width:100%;min-width:70px;border-radius:4px;overflow:hidden;background:var(--subtle);margin-top:4px}.sleep-analysis details{margin-top:12px}.sleep-analysis summary{cursor:pointer;color:var(--primary-hover);font-size:12px}@media(max-width:560px){.sleep-analysis{margin-left:16px;margin-right:16px}}@media(max-width:450px){.sleep-schedule-grid strong{font-size:19px}}`;


/** All browser dependencies stay inside one typed factory so minification cannot break embedded helper references. */
export function createSleepAnalysisRuntime(){
function clockMinutes(timestamp:string){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));return Number(parts.find((part)=>part.type==='hour')!.value)*60+Number(parts.find((part)=>part.type==='minute')!.value);}
function circular(values:readonly number[]){
  if(!values.length)return{mean:null,deviation:null};
  const sine=values.reduce((sum,value)=>sum+Math.sin(value/1440*2*Math.PI),0),cosine=values.reduce((sum,value)=>sum+Math.cos(value/1440*2*Math.PI),0);
  if(Math.hypot(sine,cosine)/values.length<0.05)return{mean:null,deviation:null};
  const minutes=(Math.atan2(sine,cosine)/2/Math.PI*1440+1440)%1440,rounded=Math.round(minutes)%1440;
  return{mean:String(Math.floor(rounded/60)).padStart(2,'0')+':'+String(rounded%60).padStart(2,'0'),deviation:values.length<2?null:values.reduce((sum,value)=>sum+Math.min(Math.abs(value-minutes),1440-Math.abs(value-minutes)),0)/values.length};
}
function summarize(days:readonly SleepScheduleDay[]):SleepScheduleSummary{
  const timed=days.filter((day)=>day.onset!==null&&day.wake!==null&&!day.clipped),staged=days.filter((day)=>day.stages!==null);
  const onset=circular(timed.map((day)=>clockMinutes(day.onset!))),wake=circular(timed.map((day)=>clockMinutes(day.wake!)));
  const keys=['unspecified','core','deep','rem'] as const,totals=Object.fromEntries(keys.map((key)=>[key,staged.reduce((sum,day)=>sum+day.stages![key],0)])) as Record<typeof keys[number],number>,total=Object.values(totals).reduce((a,b)=>a+b,0);
  return{recordedDays:days.length,timingDays:timed.length,clippedDays:days.filter((day)=>day.clipped).length,stageDays:staged.length,meanOnset:onset.mean,meanWake:wake.mean,onsetDeviationMinutes:onset.deviation,wakeDeviationMinutes:wake.deviation,stagePercent:total>0?Object.fromEntries(keys.map((key)=>[key,totals[key]/total*100])) as Record<typeof keys[number],number>:null};
}
/** Daily source-selected rows only. Missing times remain absent; report windows never become bedtimes. */
function buildSleepAnalysis(points:readonly SleepAnalysisPoint[],range:{from:string;to:string}):SleepAnalysis{
  const byDay=new Map<string,SleepScheduleDay>();
  for(const point of points){
    if(point.day<range.from||point.day>range.to||!Number.isFinite(point.value)||point.value<0||point.value>24)continue;
    const timing=point.sleepTiming,valid=timing?.method==='longest-sleep-group-v1'&&Number.isFinite(Date.parse(timing.onset))&&Number.isFinite(Date.parse(timing.wake))&&Date.parse(timing.wake)>Date.parse(timing.onset);
    const stages=point.sleepStages,keys=['unspecified','core','deep','rem','awake','inBed'] as const;
    const validStages=stages&&keys.every((key)=>Number.isFinite(stages[key])&&stages[key]>=0&&stages[key]<=24)&&Math.abs(stages.unspecified+stages.core+stages.deep+stages.rem-point.value)<1e-8;
    byDay.set(point.day,{day:point.day,hours:point.value,onset:valid?timing.onset:null,wake:valid?timing.wake:null,clipped:valid&&timing.clipped,stages:validStages?{...stages}:null});
  }
  const days=[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)),weeks:SleepAnalysis['weeks']=[];
  const toTime=Date.parse(range.to+'T12:00:00Z');
  for(let time=Date.parse(range.from+'T12:00:00Z');time<=toTime;time+=7*86400000){const from=new Date(time).toISOString().slice(0,10),to=new Date(Math.min(toTime,time+6*86400000)).toISOString().slice(0,10);weeks.push({...summarize(days.filter((day)=>day.day>=from&&day.day<=to)),from,to});}
  return{...summarize(days),from:range.from,to:range.to,days,weeks,timingMethod:'longest-sleep-group-v1'};
}

/** Self-contained renderer for embedding in the health page's typed client helpers. */
function renderSleepAnalysis(analysis:SleepAnalysis):string{
  const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const percent=(value:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(value)+'%',deviation=(value:number|null)=>value===null?'至少需要2天完整时刻记录。':'与平均时刻的平均偏离 '+Math.round(value)+' 分钟。';
  const colors={deep:'#6454a4',core:'#729bdd',rem:'#54b9be',unspecified:'#9ba5b8'},labels={deep:'深度',core:'核心',rem:'REM',unspecified:'未分类'};
  const shares=(value:SleepScheduleSummary['stagePercent'])=>value?Object.entries(colors).map(([key,color])=>'<span style="width:'+value[key as keyof typeof value]+'%;background:'+color+'" title="'+labels[key as keyof typeof labels]+' '+percent(value[key as keyof typeof value])+'"></span>').join(''):'';
  const clock=(value:string|null)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)):'未提供';
  const rows=analysis.weeks.map((week)=>'<tr><td>'+esc(week.from)+'<br>'+esc(week.to)+'</td><td>'+week.timingDays+'天 · '+esc(week.meanOnset??'—')+'／'+esc(week.meanWake??'—')+'</td><td>'+week.stageDays+'天'+(week.stagePercent?'<div class="sleep-stage-share" role="img" aria-label="'+esc(Object.entries(labels).map(([key,label])=>label+percent(week.stagePercent![key as keyof typeof labels])).join('，'))+'">'+shares(week.stagePercent)+'</div>':' · 无分期记录')+'</td></tr>').join('');
  return'<section class="sleep-analysis" aria-label="睡眠作息分析"><h3>作息与分期</h3><div class="sleep-schedule-grid"><div><p>主睡眠平均入睡时刻（上海）</p><strong>'+esc(analysis.meanOnset??'暂无完整时刻')+'</strong><p>'+deviation(analysis.onsetDeviationMinutes)+'</p></div><div><p>主睡眠平均起床时刻（上海）</p><strong>'+esc(analysis.meanWake??'暂无完整时刻')+'</strong><p>'+deviation(analysis.wakeDeviationMinutes)+'</p></div></div><p class="sleep-analysis-note">范围内有睡眠记录 '+analysis.recordedDays+' 天；可比较完整时刻 '+analysis.timingDays+' 天，窗口截断 '+analysis.clippedDays+' 天；有分期 '+analysis.stageDays+' 天。仅有总时长的旧记录不推算入睡、起床时间。</p><p class="sleep-analysis-note">主睡眠选取同一来源的最长睡眠组，间隔不超过1小时的片段合并；含午睡的总时长仍保持原统计。时刻平均按跨午夜的圆周计算，偏离仅描述记录规律。</p><details><summary>查看分周作息与分期占比趋势</summary><p class="sleep-analysis-note">分期占比按有分期记录的睡眠总时长加权；清醒与卧床不计入分母。'+Object.entries(labels).map(([key,label])=>'<span style="color:'+colors[key as keyof typeof colors]+'">'+label+'</span>').join(' · ')+'</p><div class="sleep-analysis-scroll" tabindex="0" role="region" aria-label="分周睡眠作息与分期趋势"><table><thead><tr><th>日期（上海）</th><th>完整时刻覆盖 · 入睡／起床</th><th>分期覆盖与占比</th></tr></thead><tbody>'+rows+'</tbody></table></div></details><details><summary>查看真实睡眠时刻明细</summary><div class="sleep-analysis-scroll" tabindex="0" role="region" aria-label="睡眠时刻明细"><table><thead><tr><th>归属日期</th><th>主睡眠入睡</th><th>主睡眠起床</th><th>时刻状态</th></tr></thead><tbody>'+[...analysis.days].reverse().map((day)=>'<tr><td>'+esc(day.day)+'</td><td>'+esc(clock(day.onset))+'</td><td>'+esc(clock(day.wake))+'</td><td>'+(day.clipped?'被报告窗口截断，不参与规律计算':day.onset?'真实区间':'仅有总时长')+'</td></tr>').join('')+'</tbody></table></div></details></section>';
}

return{buildSleepAnalysis,renderSleepAnalysis};
}
export const {buildSleepAnalysis,renderSleepAnalysis}=createSleepAnalysisRuntime();
export const SLEEP_ANALYSIS_CLIENT_SCRIPT='const sleepAnalysisRuntime=('+createSleepAnalysisRuntime.toString()+')();';
