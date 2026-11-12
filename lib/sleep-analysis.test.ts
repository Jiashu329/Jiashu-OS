import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { buildSleepAnalysis, renderSleepAnalysis, SLEEP_ANALYSIS_CLIENT_SCRIPT } from './sleep-analysis.ts';
import { buildHealthSummary, parseSyncPayload, HealthValidationError } from './health.ts';
import type { HealthMeasurement, HealthTrendPoint } from './health.ts';
import { parseMobileSyncPayload } from './mobile-sync.ts';

function point(day:string,onset?:string,wake?:string):HealthTrendPoint{return{day,value:7,measuredAt:day+'T04:00:00Z',source:'synthetic',...(onset&&wake?{sleepTiming:{onset,wake,clipped:false,method:'longest-sleep-group-v1' as const}}:{})};}
const range={from:'2026-11-01',to:'2026-11-03'};
test('sleep averages wrap midnight and missing duration-only days never become bedtimes',()=>{
  const result=buildSleepAnalysis([point('2026-11-01','2026-10-31T23:30:00+08:00','2026-11-01T07:30:00+08:00'),point('2026-11-02','2026-11-02T00:30:00+08:00','2026-11-02T08:30:00+08:00'),point('2026-11-03')],range);
  assert.equal(result.recordedDays,3);assert.equal(result.timingDays,2);assert.equal(result.meanOnset,'00:00');assert.equal(result.meanWake,'08:00');assert.ok(Math.abs(result.onsetDeviationMinutes!-30)<1e-8);assert.equal(result.days[2].onset,null);
});
test('clipped bounds stay visible but never affect regularity and selected range is exact',()=>{
  const clipped=point('2026-11-02','2026-11-01T12:00:00+08:00','2026-11-02T07:00:00+08:00');clipped.sleepTiming!.clipped=true;
  const result=buildSleepAnalysis([point('2026-10-31','2026-10-30T20:00:00+08:00','2026-10-31T04:00:00+08:00'),point('2026-11-01','2026-10-31T23:00:00+08:00','2026-11-01T07:00:00+08:00'),clipped],range);
  assert.equal(result.recordedDays,2);assert.equal(result.clippedDays,1);assert.equal(result.timingDays,1);assert.equal(result.meanOnset,'23:00');assert.equal(result.onsetDeviationMinutes,null);
  assert.match(renderSleepAnalysis(result),/被报告窗口截断/);assert.match(renderSleepAnalysis(result),/窗口截断 1 天/);
});
test('stage shares weight known durations and exclude awake, in-bed and legacy-only totals',()=>{
  const a=point('2026-11-01'),b=point('2026-11-02'),legacy=point('2026-11-03');
  a.value=4;a.sleepStages={unspecified:0,core:2,deep:1,rem:1,awake:1,inBed:8};b.value=8;b.sleepStages={unspecified:2,core:4,deep:1,rem:1,awake:2,inBed:10};
  const result=buildSleepAnalysis([a,b,legacy],range);assert.equal(result.stageDays,2);assert.equal(result.stagePercent?.core,50);assert.ok(Math.abs(result.stagePercent!.deep-100/6)<1e-8);assert.equal(result.weeks.length,1);
});
test('mobile sleep adapter retains real longest-group bounds instead of noon report edges or late naps',()=>{
  const payload=parseMobileSyncPayload({version:1,source:'apple-health-shortcuts',timezone:'Asia/Shanghai',exportedAt:'2026-11-03T05:00:00Z',measurements:[],sleepReport:{day:'2026-11-03',source:'synthetic-watch',segments:[{state:'core',startDate:'2026-11-02T23:00:00+08:00',endDate:'2026-11-03T03:00:00+08:00'},{state:'deep',startDate:'2026-11-03T03:20:00+08:00',endDate:'2026-11-03T07:00:00+08:00'},{state:'core',startDate:'2026-11-02T14:00:00+08:00',endDate:'2026-11-02T14:30:00+08:00'}]}});
  assert.deepEqual(payload.measurements[0].sleepTiming,{onset:'2026-11-02T15:00:00.000Z',wake:'2026-11-02T23:00:00.000Z',clipped:false,method:'longest-sleep-group-v1'});
  const summary=buildHealthSummary(payload.measurements);assert.deepEqual(summary.metrics.sleep.points[0].sleepTiming,payload.measurements[0].sleepTiming);
});
test('timing contract rejects fabricated report edges, wrong metric, malformed dates and unmarked clipping',()=>{
  const measurement:HealthMeasurement={id:'sleep:one',metric:'sleep',value:7,unit:'hours',aggregation:'daily',source:'synthetic',startDate:'2026-11-02T04:00:00Z',endDate:'2026-11-03T04:00:00Z',sleepTiming:{onset:'2026-11-02T15:00:00Z',wake:'2026-11-02T22:00:00Z',clipped:false,method:'longest-sleep-group-v1'}};
  const parse=(value:unknown)=>parseSyncPayload({version:1,source:'apple-health-shortcuts',timezone:'Asia/Shanghai',exportedAt:'2026-11-03T05:00:00Z',measurements:[value]});
  assert.ok(parse(measurement).measurements[0].sleepTiming);
  for(const timing of [{...measurement.sleepTiming,onset:'2026-11-01T00:00:00Z'},{...measurement.sleepTiming,wake:'bad'},{...measurement.sleepTiming,clipped:undefined},{...measurement.sleepTiming,method:'guessed'}])assert.throws(()=>parse({...measurement,sleepTiming:timing}),HealthValidationError);
  assert.throws(()=>parse({...measurement,id:'steps',metric:'steps',value:1,unit:'count'}),HealthValidationError);
});
test('the typed sleep browser factory compiles with every dependency inside its emitted script',()=>{assert.doesNotThrow(()=>new Script(SLEEP_ANALYSIS_CLIENT_SCRIPT+'sleepAnalysisRuntime.renderSleepAnalysis(sleepAnalysisRuntime.buildSleepAnalysis([],{from:"2026-11-01",to:"2026-11-02"}));'));});
