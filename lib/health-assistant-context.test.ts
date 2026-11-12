import assert from 'node:assert/strict';
import test from 'node:test';
import type { HealthMeasurement, SleepStages } from './health.ts';
import type { NutritionDayStatus, NutritionEntry } from './nutrition.ts';
import { assistantRange, buildHealthAssistantContext, HealthAssistantContextError, MAX_HEALTH_ASSISTANT_CONTEXT_BYTES } from './health-assistant-context.ts';

const NOW = Date.parse('2026-11-11T10:00:00+08:00');
const privateSource = 'PRIVATE_DEVICE_owner@example.com';
const stages: SleepStages = { unspecified: 1, core: 4, deep: 1, rem: 2, awake: 0.5, inBed: 9 };
const shift = (day: string, offset: number) => new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
function daily(metric: 'steps' | 'active_energy' | 'sleep', day = '2026-11-10', value = metric === 'steps' ? 8000 : metric === 'sleep' ? 8 : 400): HealthMeasurement {
  return {
    id: 'PRIVATE_SAMPLE_' + metric + ':' + day, metric, value, unit: metric === 'steps' ? 'count' : metric === 'sleep' ? 'hours' : 'kcal',
    startDate: metric === 'sleep' ? shift(day, -1) + 'T12:00:00+08:00' : day + 'T00:00:00+08:00',
    endDate: metric === 'sleep' ? day + 'T12:00:00+08:00' : shift(day, 1) + 'T00:00:00+08:00',
    source: privateSource, aggregation: 'daily',
  };
}
function mass(metric: 'weight' | 'lean_body_mass', day = '2026-11-10', value = metric === 'weight' ? 70 : 56, time = '08:00:00'): HealthMeasurement {
  return { id: 'PRIVATE_SAMPLE_' + metric + day + time, metric, value, unit: 'kg', startDate: `${day}T${time}+08:00`, source: privateSource, aggregation: 'sample' };
}
function food(date = '2026-11-10', caloriesTenth: number | null = 1001, deleted = false): NutritionEntry {
  return {
    id: 'PRIVATE_FOOD_ID', date, meal: 'lunch', name: 'PRIVATE_FOOD_NAME', portion: 'PRIVATE_PORTION', note: 'PRIVATE_NOTE',
    caloriesTenth, revision: 1, createdAt: date + 'T09:00:00+08:00', updatedAt: date + 'T09:00:00+08:00',
    deletedAt: deleted ? date + 'T09:30:00+08:00' : null,
  };
}

void test('scope filtering happens before validating or projecting unshared nutrition and goals', () => {
  const scope = { metrics:['sleep' as const], includeNutrition:false, includeGoals:false };
  const result = buildHealthAssistantContext({measurements:[daily('sleep'),daily('steps')],nutrition:[food('2026-11-10',NaN)],days:30,now:NOW,scope,
    goals:{targets:{steps:12345,sleep:9,active_energy:null}},weightPlan:{enabled:true,baselineWeight:90,targetWeight:65,startDate:'2026-01-01',deadline:'2027-01-01'}});
  assert.deepEqual(result.context.health.map((m)=>m.metric),['sleep']);
  assert.deepEqual(result.context.nutrition,{recordedDays:0,days:[]});
  assert.equal(result.context.goals,undefined);
  assert.ok(result.sources.every((source)=>source.id.startsWith('H5-')));
  assert.ok(!JSON.stringify(result.context).includes('12345'));
});

void test('360-day summaries cover the actual full range within provider budget with explicit group semantics', () => {
  const measurements:HealthMeasurement[]=[];const nutrition:NutritionEntry[]=[];
  for(let index=1;index<360;index++){const date=shift('2026-11-11',-index);measurements.push(daily('steps',date,1000+index),daily('sleep',date,7),daily('active_energy',date,200),mass('weight',date,70),mass('lean_body_mass',date,55));nutrition.push({...food(date,1234),carbsTenth:2000,proteinTenth:800,fatTenth:600});}
  const nutritionStatuses=nutrition.map((row):NutritionDayStatus=>({date:row.date,complete:true,revision:1,meals:{breakfast:'skipped',lunch:'recorded',dinner:'skipped',snack:'unrecorded'}}));
  const result=buildHealthAssistantContext({measurements,nutrition,nutritionStatuses,days:360,now:NOW});
  assert.equal(result.context.range.days,360);assert.equal(result.context.health[0].recordedDays,359);
  assert.ok(result.context.health.every((metric)=>metric.points.length<=26));
  assert.ok(result.context.limitations.some((text)=>text.includes('14日分组')));
  assert.ok(new TextEncoder().encode(JSON.stringify(result.context)).byteLength<=MAX_HEALTH_ASSISTANT_CONTEXT_BYTES);
  for(const metric of result.context.health)for(const point of metric.points){const source=result.sources.find((s)=>s.id===point.sourceRef);assert.ok(source);assert.equal(source.to,point.to);assert.equal(source.recordedDays,point.recordedDays);}
});

void test('nutrition citations map each daily statement to that exact date and expired plans are not treated as active targets', () => {
  const result=buildHealthAssistantContext({measurements:[mass('weight')],nutrition:[food('2026-11-09'),food('2026-11-10')],days:7,now:NOW,
    scope:{metrics:['weight'],includeNutrition:true,includeGoals:true},goals:{targets:{steps:null,sleep:null,active_energy:null}},weightPlan:{enabled:true,baselineWeight:75,targetWeight:70,startDate:'2025-01-01',deadline:'2025-12-01'}});
  for(const point of result.context.nutrition.days){const source=result.sources.find((s)=>s.id===point.sourceRef)!;assert.equal(source.url,'/health/nutrition?date='+point.date);}
  assert.equal(result.context.goals?.weightPlan,null);assert.match(result.context.goals!.notes.join(''),/过期/);
});

void test('recovered target baselines are not misrepresented as an actual 1970 goal date',()=>{
  const result=buildHealthAssistantContext({measurements:[daily('steps')],nutrition:[],days:7,now:NOW,scope:{metrics:['steps'],includeNutrition:false,includeGoals:true},goals:{targets:{steps:6000,sleep:null,active_energy:null},effectiveFrom:'1970-01-01'}});
  assert.equal(result.context.goals?.targets[0].effectiveFrom,null);assert.match(result.context.goals!.notes.join(''),/实际设置日期未知/);
});

void test('ranges use Shanghai calendar dates, including UTC midnight, leap days and year boundaries', () => {
  assert.deepEqual(assistantRange(7, Date.parse('2026-11-10T16:30:00Z')), { days: 7, from: '2026-11-05', to: '2026-11-11', today: '2026-11-11' });
  assert.deepEqual(assistantRange(30, Date.parse('2024-03-01T12:00:00+08:00')), { days: 30, from: '2024-02-01', to: '2024-03-01', today: '2024-03-01' });
  assert.equal(assistantRange(7, Date.parse('2026-01-01T08:00:00+08:00')).from, '2025-12-26');
  for (const [days, now] of [[91, NOW], [7, NaN], [30, Infinity], [7, 9e99], [7, Date.parse('2101-01-01T12:00:00Z')]]) {
    assert.throws(() => assistantRange(days as 7 | 30, now), HealthAssistantContextError);
  }
});

void test('empty inputs preserve missingness with no invented zeroes or citations', () => {
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [], days: 7, now: NOW });
  assert.equal(result.hasData, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.context.version, 1);
  assert.equal(result.context.timezone, 'Asia/Shanghai');
  assert.equal(result.context.health.length, 5);
  for (const metric of result.context.health) {
    assert.equal(metric.recordedDays, 0);
    assert.deepEqual(metric.points, []);
  }
  assert.deepEqual(result.context.nutrition, { recordedDays: 0, days: [] });
});

void test('provider projection excludes identifiers, sample timestamps and free text while local sources remain traceable', () => {
  const input = {
    measurements: [Object.assign(mass('weight'), { userId: 'PRIVATE_USER', email: 'PRIVATE_EMAIL', note: 'PRIVATE_HEALTH_NOTE', rawSamples: ['PRIVATE_RAW'] })],
    nutrition: [Object.assign(food(), { userId: 'PRIVATE_USER', email: 'PRIVATE_EMAIL' })], days: 7 as const, now: NOW,
  };
  const before = structuredClone(input);
  const result = buildHealthAssistantContext(input);
  assert.deepEqual(input, before);
  const providerJson = JSON.stringify(result.context);
  for (const secret of ['PRIVATE_', privateSource, 'userId', 'email', 'createdAt', 'updatedAt', 'startDate', 'endDate', 'portion', 'note', 'rawSamples']) {
    assert.ok(!providerJson.includes(secret), 'unexpected provider field/value: ' + secret);
  }
  assert.deepEqual(result.sources.map((source) => source.id), ['H1-20261110', 'N1-20261110']);
  assert.deepEqual(result.sources[0].sources, [privateSource]);
  assert.equal(result.sources[0].url, '/health/records?metric=weight&from=2026-11-10&to=2026-11-10');
  assert.equal(result.sources[1].url, '/health/nutrition?date=2026-11-10');
  assert.equal(result.context.health[0].points[0].sourceRef, 'H1-20261110');
  assert.equal(result.context.nutrition.days[0].sourceRef, 'N1-20261110');
});

void test('all five raw metrics retain fixed citations and daily totals replace rather than sum', () => {
  const steps = daily('steps', '2026-11-10', 1000);
  const result = buildHealthAssistantContext({
    measurements: [mass('weight'), mass('lean_body_mass'), steps, { ...steps, id: 'revised', value: 2000 }, daily('active_energy'), daily('sleep')],
    nutrition: [], days: 7, now: NOW,
  });
  assert.equal(result.hasData, true);
  assert.deepEqual(result.context.health.map((metric) => [metric.metric, metric.points[0].sourceRef, metric.recordedDays]), [
    ['weight', 'H1-20261110', 1], ['lean_body_mass', 'H2-20261110', 1], ['steps', 'H3-20261110', 1], ['active_energy', 'H4-20261110', 1], ['sleep', 'H5-20261110', 1],
  ]);
  assert.equal(result.context.health.find((metric) => metric.metric === 'steps')!.points[0].value, 2000);
  assert.ok(!result.context.health.some((metric) => String(metric.metric) === 'body_fat'));
});

void test('health range and future-instant filters run before selecting the last mass sample of a day', () => {
  const earlier = mass('weight', '2026-11-11', 70, '08:00:00');
  const result = buildHealthAssistantContext({ measurements: [
    mass('weight', '2026-11-04', 69), { ...earlier, endDate: '2026-11-12T00:00:00+08:00' },
    mass('weight', '2026-11-11', 72, '11:00:00'), mass('weight', '2026-11-12', 74),
    daily('steps', '2026-11-05', 0), daily('steps', '2026-11-07', 5000), daily('steps', '2026-11-11', 2000),
    daily('sleep', '2026-11-05'),
  ], nutrition: [], days: 7, now: NOW });
  assert.deepEqual(result.context.health[0].points, [{ date: '2026-11-11', value: 70, sourceRef: 'H1-20261111' }]);
  assert.deepEqual(result.context.health.find((metric) => metric.metric === 'steps')!.points.map((point) => [point.date, point.value]), [['2026-11-05', 0], ['2026-11-07', 5000]]);
  assert.deepEqual(result.context.health.find((metric) => metric.metric === 'sleep')!.points.map((point) => point.date), ['2026-11-05']);
  assert.equal(result.sources.filter((source) => source.id.startsWith('H3-')).length, 2);
});

void test('invalid health values and timestamps do not become usable context', () => {
  const result = buildHealthAssistantContext({ measurements: [
    { ...daily('steps'), value: NaN }, { ...daily('steps'), value: 0.5 },
    { ...mass('weight'), unit: 'hours' }, { ...mass('weight'), startDate: '2026-02-30T08:00:00+08:00' },
    { ...daily('sleep'), endDate: undefined }, { ...daily('sleep'), endDate: '2026-11-08T10:00:00+08:00' },
  ], nutrition: [], days: 7, now: NOW });
  assert.equal(result.hasData, false);
});

void test('sleep phases are copied through a whitelist only when they agree with the effective total', () => {
  const sleep = { ...daily('sleep'), sleepStages: Object.assign({ ...stages }, { note: 'PRIVATE_PHASE_NOTE' }) };
  const result = buildHealthAssistantContext({ measurements: [sleep], nutrition: [], days: 7, now: NOW });
  const point = result.context.health.find((metric) => metric.metric === 'sleep')!.points[0];
  assert.deepEqual(point.sleepStages, stages);
  assert.notEqual(point.sleepStages, sleep.sleepStages);
  for (const sleepStages of [undefined, { ...stages, core: 3 }, { ...stages, rem: NaN }, { ...stages, awake: -1 }, { ...stages, inBed: 25 }]) {
    const context = buildHealthAssistantContext({ measurements: [{ ...sleep, sleepStages }], nutrition: [], days: 7, now: NOW }).context;
    assert.ok(!Object.hasOwn(context.health.find((metric) => metric.metric === 'sleep')!.points[0], 'sleepStages'));
  }
  const corrected = buildHealthAssistantContext({ measurements: [{ ...sleep, value: 7 }], nutrition: [], days: 7, now: NOW });
  assert.equal(corrected.context.health.find((metric) => metric.metric === 'sleep')!.points[0].value, 7);
  assert.ok(!corrected.context.health.find((metric) => metric.metric === 'sleep')!.points[0].sleepStages);
});

void test('nutrition totals preserve true zero and unknown calories while excluding deleted and unselected days', () => {
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [
    food('2026-11-04', 9999), food('2026-11-07', 0), food('2026-11-08', null),
    food('2026-11-09', 1001), food('2026-11-09', 2002), food('2026-11-09', null),
    food('2026-11-09', 5000, true), food('2026-11-12', 9999),
  ], days: 7, now: NOW });
  assert.equal(result.hasData, true);
  assert.deepEqual({...result.context.nutrition,days:result.context.nutrition.days.map(({nutrients:_nutrients,...day})=>day)}, { recordedDays: 3, days: [
    { date: '2026-11-07', entryCount: 1, knownCalorieCount: 1, unknownCalorieCount: 0, recordedKnownKcal: '0.0', sourceRef: 'N1-20261107' },
    { date: '2026-11-08', entryCount: 1, knownCalorieCount: 0, unknownCalorieCount: 1, recordedKnownKcal: null, sourceRef: 'N1-20261108' },
    { date: '2026-11-09', entryCount: 3, knownCalorieCount: 2, unknownCalorieCount: 1, recordedKnownKcal: '300.3', sourceRef: 'N1-20261109' },
  ] });
  const unknownOnly = buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', null)], days: 7, now: NOW });
  assert.equal(unknownOnly.hasData, true);
  assert.equal(unknownOnly.context.nutrition.days[0].recordedKnownKcal, null);
  assert.equal(buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', 100, true)], days: 7, now: NOW }).hasData, false);
});

void test('invalid calorie storage produces a clear error instead of pretending the projection is complete', () => {
  for (const caloriesTenth of [NaN, -1, 0.5, 200001]) {
    assert.throws(() => buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-10', caloriesTenth)], days: 7, now: NOW }),
      (error: unknown) => error instanceof HealthAssistantContextError && error.code === 'INVALID_HEALTH_ASSISTANT_CONTEXT' && error.message.includes('饮食热量'));
  }
});

void test('a complete 30-day context stays bounded without truncating records and states the operating limitations', () => {
  const measurements = Array.from({ length: 30 }, (_, index) => {
    const day = shift('2026-11-10', -index);
    return [mass('weight', day), mass('lean_body_mass', day),
      { ...daily('steps', day), endDate: day + 'T22:00:00+08:00' },
      { ...daily('active_energy', day), endDate: day + 'T22:00:00+08:00' },
      { ...daily('sleep', day), sleepStages: stages }];
  }).flat();
  const nutrition = Array.from({ length: 30 }, (_, index) => food(shift('2026-11-10', -index)));
  const result = buildHealthAssistantContext({ measurements, nutrition, days: 30, now: Date.parse('2026-11-10T23:00:00+08:00') });
  for (const metric of result.context.health) assert.equal(metric.recordedDays, 30);
  assert.equal(result.context.nutrition.recordedDays, 30);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.context)).byteLength <= MAX_HEALTH_ASSISTANT_CONTEXT_BYTES);
  assert.equal(MAX_HEALTH_ASSISTANT_CONTEXT_BYTES, 50 * 1024);
  const limitations = result.context.limitations.join('；');
  for (const rule of ['缺失日期不补0', '今日尚未结束', '并非全天真实总摄入', '不是全天总能量消耗', '未知热量不按0计算']) assert.ok(limitations.includes(rule));
});

void test('nutrition completion is a whitelisted user label and excludes incomplete or unknown days from comparison counts', () => {
  const status = (date: string): NutritionDayStatus => ({ date, complete: true, revision: 4,
    meals: { breakfast: 'skipped', lunch: 'recorded', dinner: 'skipped', snack: 'unrecorded' } });
  const marked = Object.assign(status('2026-11-08'), { note: 'PRIVATE_STATUS_NOTE', userId: 'PRIVATE_OWNER' });
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [food('2026-11-08', 0), food('2026-11-09', null), food('2026-11-10', 1000)],
    nutritionStatuses: [marked, status('2026-11-09')], days: 7, now: NOW });
  assert.equal(result.context.nutrition.recordedDays, 3);
  assert.equal(result.context.nutrition.completeDays, 2);
  assert.equal(result.context.nutrition.comparableDays, 1);
  assert.deepEqual(result.context.nutrition.days.map((day) => [day.date, day.complete]), [
    ['2026-11-08', true], ['2026-11-09', true], ['2026-11-10', false],
  ]);
  assert.deepEqual(result.context.nutrition.days[0].meals, { breakfast: 'skipped', lunch: 'recorded', dinner: 'skipped', snack: 'unrecorded' });
  assert.ok(!JSON.stringify(result.context).includes('PRIVATE_'));
  assert.match(result.context.limitations.join(' '), /用户标记的记录状态/);
});

void test('explicit skipped-meal status can be discussed without inventing food or zero calories', () => {
  const status: NutritionDayStatus = { date: '2026-11-10', complete: true, revision: 3,
    meals: { breakfast: 'skipped', lunch: 'skipped', dinner: 'skipped', snack: 'unrecorded' } };
  const result = buildHealthAssistantContext({ measurements: [], nutrition: [], nutritionStatuses: [status], days: 7, now: NOW });
  assert.equal(result.hasData, true);
  assert.equal(result.context.nutrition.recordedDays, 0);
  assert.equal(result.context.nutrition.completeDays, 1);
  assert.equal(result.context.nutrition.comparableDays, 0);
  assert.equal(result.context.nutrition.days[0].recordedKnownKcal, null);
  assert.equal(result.context.nutrition.days[0].entryCount, 0);
  assert.equal(result.sources[0].recordedDays, 0);
  status.complete = false; status.meals = { breakfast: 'unrecorded', lunch: 'unrecorded', dinner: 'unrecorded', snack: 'unrecorded' };
  assert.equal(buildHealthAssistantContext({ measurements: [], nutrition: [], nutritionStatuses: [status], days: 7, now: NOW }).hasData, false);
});

void test('long nutrition groups keep complete-day comparison denominators separate from partial recorded totals',()=>{
  const first=assistantRange(90,NOW).from;
  const status=(date:string):NutritionDayStatus=>({date,complete:true,revision:1,meals:{breakfast:'skipped',lunch:'recorded',dinner:'skipped',snack:'unrecorded'}});
  const result=buildHealthAssistantContext({measurements:[],nutrition:[food(first,1000),food(shift(first,1),null),food(shift(first,2),3000)],nutritionStatuses:[status(first),status(shift(first,1))],days:90,now:NOW});
  const group=result.context.nutrition.days[0];
  assert.equal(group.recordedKnownKcal,'400.0');assert.equal(group.complete,undefined);assert.equal(group.completeDays,2);assert.equal(group.comparableDays,1);assert.equal(group.comparableKnownKcal,'100.0');
  assert.equal(result.context.nutrition.comparableDays,1);assert.equal(result.sources.find((source)=>source.id===group.sourceRef)?.recordedDays,3);
  assert.match(result.context.limitations.join(' '),/不能用整组合计/);
});

void test('unshared nutrition includes neither completion labels nor food snapshot metadata',()=>{
  const row=Object.assign(food(),{food:{name:'PRIVATE_CATALOG_LABEL',source:'PRIVATE_CATALOG_SOURCE',protein:123}});
  const result=buildHealthAssistantContext({measurements:[daily('steps')],nutrition:[row],nutritionStatuses:[{date:'2026-11-10',complete:true,revision:1,meals:{breakfast:'skipped',lunch:'recorded',dinner:'skipped',snack:'unrecorded'}}],days:7,now:NOW,scope:{metrics:['steps'],includeNutrition:false,includeGoals:false}});
  assert.deepEqual(result.context.nutrition,{recordedDays:0,days:[]});assert.ok(result.sources.every((source)=>!source.id.startsWith('N')));assert.ok(!JSON.stringify(result.context).includes('PRIVATE_'));
});

void test('macro projection keeps per-field missingness, exact zero and private source notes out of model data',()=>{
  const row={...food(),carbsTenth:0,proteinTenth:123,fatTenth:null,provenance:{protein:{source:'ai' as const,basis:'PRIVATE_ESTIMATE_BASIS'}}};
  const context=buildHealthAssistantContext({measurements:[],nutrition:[row],days:7,now:NOW}).context;
  assert.deepEqual(context.nutrition.days[0].nutrients,{
    calories:{total:'100.1',knownCount:1,unknownCount:0},carbs:{total:'0.0',knownCount:1,unknownCount:0},
    protein:{total:'12.3',knownCount:1,unknownCount:0},fat:{total:null,knownCount:0,unknownCount:1},
  });
  assert.ok(!JSON.stringify(context).includes('PRIVATE_'));
  assert.throws(()=>buildHealthAssistantContext({measurements:[],nutrition:[{...food(),proteinTenth:NaN}],days:7,now:NOW}),/营养素/);
  assert.doesNotThrow(()=>buildHealthAssistantContext({measurements:[daily('steps')],nutrition:[{...food(),proteinTenth:NaN}],days:7,now:NOW,
    scope:{metrics:['steps'],includeNutrition:false,includeGoals:false}}));
});

void test('nutrition targets require both goal and nutrition sharing and long groups compare each nutrient on its own complete days',()=>{
  const first=assistantRange(90,NOW).from,second=shift(first,1);
  const status=(date:string):NutritionDayStatus=>({date,complete:true,revision:1,meals:{breakfast:'skipped',lunch:'recorded',dinner:'skipped',snack:'unrecorded'}});
  const input={measurements:[],nutrition:[{...food(first,1000),carbsTenth:0,proteinTenth:100,fatTenth:null},
    {...food(second,null),carbsTenth:200,proteinTenth:null,fatTenth:50}],nutritionStatuses:[status(first),status(second)],days:90 as const,now:NOW,
    nutritionGoals:{calories:'1800.0',carbs:'200.0',protein:'80.0',fat:'60.0'}};
  const result=buildHealthAssistantContext({...input,scope:{metrics:[],includeNutrition:true,includeGoals:true}}).context;
  const comparisons=result.nutrition.days[0].nutrientComparisons!;
  assert.deepEqual(comparisons.carbs,{comparableDays:2,total:'20.0',average:'10.0'});
  assert.deepEqual(comparisons.protein,{comparableDays:1,total:'10.0',average:'10.0'});
  assert.deepEqual(comparisons.calories,{comparableDays:1,total:'100.0',average:'100.0'});
  assert.deepEqual(result.goals?.nutritionTargets?.find((target)=>target.nutrient==='protein'),{nutrient:'protein',value:'80.0',unit:'g'});
  assert.equal(buildHealthAssistantContext({...input,scope:{metrics:[],includeNutrition:true,includeGoals:false}}).context.goals,undefined);
  const unshared=buildHealthAssistantContext({...input,measurements:[daily('steps')],scope:{metrics:['steps'],includeNutrition:false,includeGoals:true}}).context;
  assert.equal(unshared.goals?.nutritionTargets,undefined);assert.deepEqual(unshared.nutrition.days,[]);
});
