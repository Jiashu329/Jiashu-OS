import { buildWeightPlanReview, parseWeightPlanInput, WeightPlanValidationError } from './weight-plan.ts';
import type { WeightChangeRate, WeightPlanInput, WeightPlanSettings, WeightPlanReview } from './weight-plan.ts';
import { normalizeTimestamp, shanghaiDay } from './health.ts';
import type { HealthMeasurement } from './health.ts';

export type WeightCycleCommand = {action:'archive';expectedRevision:number} | {action:'start';expectedRevision:number;plan:WeightPlanInput};
export interface WeightCycleSummary {
  version:1; asOf:string; latestWeight:number|null; latestDate:string|null; average7:number|null; recordedDays7:number;
  rate7:WeightChangeRate; rate30:WeightChangeRate; progress:WeightPlanReview['progress'];
}
export interface WeightCycleArchive { id:string;settings:WeightPlanSettings;summary:WeightCycleSummary;startedAt:string;archivedAt:string }
function fail(message:string):never{throw new WeightPlanValidationError([{path:'cycle',message}]);}
export function parseWeightCycleCommand(input:unknown,now:Date|number=Date.now()):WeightCycleCommand{
  if(!input||typeof input!=='object'||Array.isArray(input))return fail('请提交完整的周期操作。');
  const raw=input as Record<string,unknown>;
  if(!Number.isSafeInteger(raw.expectedRevision)||Number(raw.expectedRevision)<0)return fail('请先读取最新体重计划版本。');
  if(raw.action==='archive'&&Object.keys(raw).every((key)=>['action','expectedRevision'].includes(key)))return{action:'archive',expectedRevision:Number(raw.expectedRevision)};
  if(raw.action==='start'&&Object.keys(raw).every((key)=>['action','expectedRevision','plan'].includes(key)))return{action:'start',expectedRevision:Number(raw.expectedRevision),plan:parseWeightPlanInput(raw.plan,now)};
  return fail('请选择归档当前周期或开始新周期。');
}
export function buildWeightCycleSummary(settings:WeightPlanSettings,measurements:readonly HealthMeasurement[],now:Date|number=Date.now()):WeightCycleSummary{
  const review=buildWeightPlanReview(settings,measurements,now),observation=review.observations;
  return{version:1,asOf:new Date(now).toISOString(),latestWeight:observation.latestWeight,latestDate:observation.latestDate,average7:observation.average7,recordedDays7:observation.recordedDays7,rate7:observation.rate7,rate30:observation.rate30,progress:review.progress};
}
/** Shared with backup parsing: archived settings/summary must remain bounded, typed snapshots. */
export function validateWeightCycleArchive(value:unknown,now:Date|number=Date.now()):WeightCycleArchive{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('体重周期归档格式无效。');
  const raw=value as Record<string,unknown>,settings=raw.settings as WeightPlanSettings,summary=raw.summary as WeightCycleSummary;
  if(Object.keys(raw).some((key)=>!['id','settings','summary','startedAt','archivedAt'].includes(key))||typeof raw.id!=='string'||!/^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(raw.id))return fail('体重周期标识无效。');
  const started=normalizeTimestamp(raw.startedAt),archived=normalizeTimestamp(raw.archivedAt);
  if(!started||!archived||Date.parse(started)>Date.parse(archived)||Date.parse(archived)>Number(new Date(now))+300000)return fail('体重周期归档时间无效。');
  if(!settings||typeof settings!=='object'||Array.isArray(settings))return fail('体重周期设置无效。');
  const {createdAt,updatedAt,revision,...fields}=settings;parseWeightPlanInput(fields,Date.parse(archived));
  if(!Number.isSafeInteger(revision)||Number(revision)<0||(Number(revision)===0&&raw.id!=='legacy')||!normalizeTimestamp(createdAt)||!normalizeTimestamp(updatedAt)||Date.parse(updatedAt)>Date.parse(archived)||Date.parse(createdAt)>Date.parse(updatedAt)||createdAt!==raw.startedAt)return fail('体重周期设置版本无效。');
  const nullable=(number:unknown)=>number===null||(typeof number==='number'&&Number.isFinite(number)&&number>=10&&number<=600);
  if(!summary||typeof summary!=='object'||Array.isArray(summary)||summary.version!==1||Object.keys(summary).some((key)=>!['version','asOf','latestWeight','latestDate','average7','recordedDays7','rate7','rate30','progress'].includes(key))||summary.asOf!==raw.archivedAt||!nullable(summary.latestWeight)||!nullable(summary.average7)||!Number.isSafeInteger(summary.recordedDays7)||summary.recordedDays7<0||summary.recordedDays7>7)return fail('体重周期总结无效。');
  const validDay=(day:unknown)=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Boolean(normalizeTimestamp(day+'T12:00:00+08:00'));
  const today=shanghaiDay(archived);
  if((summary.latestWeight===null)!==(summary.latestDate===null)||(summary.latestDate!==null&&(!validDay(summary.latestDate)||summary.latestDate>today))||(summary.average7===null)!==(summary.recordedDays7===0))return fail('体重周期总结覆盖范围无效。');
  for(const [rate,days]of [[summary.rate7,7],[summary.rate30,30]] as const){
    if(!rate||typeof rate!=='object'||Array.isArray(rate)||Object.keys(rate).some((key)=>!['from','to','recordedDays','daysBetween','changeKg','kgPerWeek'].includes(key))||!Number.isSafeInteger(rate.recordedDays)||rate.recordedDays<0||rate.recordedDays>days||!Number.isSafeInteger(rate.daysBetween)||rate.daysBetween<0||rate.daysBetween>=days)return fail('体重周期变化速度无效。');
    if(rate.recordedDays===0){if(rate.from!==null||rate.to!==null||rate.daysBetween!==0||rate.changeKg!==null||rate.kgPerWeek!==null)return fail('空的体重速度不能补零。');}
    else if(!validDay(rate.from)||!validDay(rate.to)||String(rate.from)>String(rate.to)||String(rate.to)>today||String(rate.from)<new Date(Date.parse(today+'T12:00:00Z')+(1-days)*86400000).toISOString().slice(0,10)||Math.round((Date.parse(String(rate.to)+'T12:00:00Z')-Date.parse(String(rate.from)+'T12:00:00Z'))/86400000)!==rate.daysBetween||rate.recordedDays>rate.daysBetween+1)return fail('体重变化日期无效。');
    if(rate.daysBetween===0){if(rate.changeKg!==null||rate.kgPerWeek!==null)return fail('单日记录不能计算变化速度。');}
    else if(typeof rate.changeKg!=='number'||!Number.isFinite(rate.changeKg)||Math.abs(rate.changeKg)>590||typeof rate.kgPerWeek!=='number'||!Number.isFinite(rate.kgPerWeek)||Math.abs(rate.kgPerWeek-rate.changeKg/rate.daysBetween*7)>1e-8)return fail('体重变化速度与跨度不一致。');
  }
  if(summary.rate7.recordedDays!==summary.recordedDays7||summary.rate30.recordedDays<summary.recordedDays7||(summary.rate30.recordedDays>0&&summary.rate30.to!==summary.latestDate))return fail('体重周期总结与变化窗口覆盖不一致。');
  if(settings.enabled!==(summary.progress!==null))return fail('体重周期启用状态与进度不一致。');
  if(summary.progress!==null){const progress=summary.progress;
    if(!progress||typeof progress!=='object'||Object.keys(progress).some((key)=>!['direction','gapKg','progressPercent','referenceWeight','referencePoints','remainingDays','status','sustained'].includes(key))||!['loss','gain','maintain'].includes(progress.direction)||!['active','achieved','ended','missing'].includes(progress.status)||typeof progress.referenceWeight!=='number'||!Number.isFinite(progress.referenceWeight)||progress.referenceWeight<10||progress.referenceWeight>600||!(progress.gapKg===null||(Number.isFinite(progress.gapKg)&&progress.gapKg>=0&&progress.gapKg<=590))||!(progress.progressPercent===null||(Number.isFinite(progress.progressPercent)&&progress.progressPercent>=0&&progress.progressPercent<=100))||!Number.isSafeInteger(progress.remainingDays)||progress.remainingDays<0||!Array.isArray(progress.referencePoints)||progress.referencePoints.length!==2||progress.referencePoints.some((point)=>!validDay(point.day)||point.value===null||!nullable(point.value)))return fail('体重周期进度无效。');
    const expected=buildWeightPlanReview(settings,summary.average7===null?[]:[{id:'archive-validation',metric:'weight',value:summary.average7,unit:'kg',startDate:archived,aggregation:'sample'}],Date.parse(archived)).progress!;
    for(const field of ['direction','gapKg','progressPercent','referenceWeight','referencePoints','remainingDays','status'] as const)if(JSON.stringify(progress[field])!==JSON.stringify(expected[field]))return fail('体重周期进度与计划及归档日均不一致。');
    const sustained=progress.sustained;if(!sustained||sustained.requiredDays!==7||!Number.isSafeInteger(sustained.recordedDays)||sustained.recordedDays<0||sustained.recordedDays>7||!Number.isSafeInteger(sustained.qualifyingDays)||sustained.qualifyingDays<0||sustained.qualifyingDays>sustained.recordedDays||typeof sustained.achieved!=='boolean'||sustained.achieved!==(progress.direction!=='maintain'&&sustained.recordedDays===7&&sustained.qualifyingDays===7))return fail('体重持续达成覆盖范围无效。');
  }
  return value as WeightCycleArchive;
}
