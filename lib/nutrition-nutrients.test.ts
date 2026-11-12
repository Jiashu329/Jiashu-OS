import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeNutrients } from './nutrition-nutrients.ts';
import { parseNutritionGoals, nutritionGoalProgress } from './nutrition-goals.ts';
import { NutritionValidationError, parseNutritionCreate } from './nutrition.ts';
import type { NutritionEntry } from './nutrition.ts';

const NOW=Date.parse('2026-11-12T04:00:00Z');
const row=(patch:Partial<NutritionEntry>={}):NutritionEntry=>({id:'synthetic',date:'2026-11-12',meal:'lunch',name:'合成食物',portion:'1份',note:'',caloriesTenth:1001,revision:1,createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString(),deletedAt:null,...patch});

test('server nutrient totals independently preserve exact decimals, missing values and real zero',()=>{
  const result=summarizeNutrients([row({carbsTenth:1,proteinTenth:0}),row({carbsTenth:2,proteinTenth:null,fatTenth:20}),row({carbsTenth:900,deletedAt:new Date(NOW).toISOString()})]);
  assert.deepEqual(result.carbs,{total:'0.3',knownCount:2,unknownCount:0});
  assert.deepEqual(result.protein,{total:'0.0',knownCount:1,unknownCount:1});
  assert.deepEqual(result.fat,{total:'2.0',knownCount:1,unknownCount:1});
  assert.equal(result.calories.total,'200.2');
  assert.deepEqual(summarizeNutrients([]).protein,{total:null,knownCount:0,unknownCount:0});
  for(const invalid of [NaN,-1,0.5,200001])assert.throws(()=>summarizeNutrients([row({proteinTenth:invalid})]));
});

test('user goals validate independently and progress never invents unknown intake or a zero-target ratio',()=>{
  const command=parseNutritionGoals({calories:'01800',carbs:null,protein:'80.5',fat:'0',expectedRevision:0});
  assert.deepEqual(command.targets,{calories:'1800.0',carbs:null,protein:'80.5',fat:'0.0'});
  const progress=nutritionGoalProgress(summarizeNutrients([row({proteinTenth:105,fatTenth:0})]),command.targets);
  assert.equal(progress.protein.remaining,'70.0');assert.equal(progress.carbs.remaining,null);assert.equal(progress.fat.percent,null);
  assert.equal(progress.calories.partial,false);
  for(const patch of [{protein:'-1'},{fat:1},{carbs:'1.00'},{calories:'20000.1'},{expectedRevision:-1},{extra:'x'}])assert.throws(()=>parseNutritionGoals({calories:null,carbs:null,protein:null,fat:null,expectedRevision:0,...patch}),NutritionValidationError);
});

test('structured provenance preserves estimates without allowing untrusted catalog claims or control characters',()=>{
  const input={date:'2026-11-12',meal:'lunch',name:'合成肉包',portion:'2个',calories:'420',protein:'18',provenance:{calories:{source:'ai',basis:'按两个中等包子估算',portion:'2个',originalValue:'420'},protein:{source:'label',basis:'包装标签'}}};
  const parsed=parseNutritionCreate(input,NOW);
  assert.deepEqual(parsed.provenance?.calories,{source:'ai',basis:'按两个中等包子估算',portion:'2个',originalValue:'420.0'});
  assert.equal(parsed.provenance?.protein?.source,'label');
  for(const provenance of [{calories:{source:'catalog'}},{calories:{source:'ai'}},{calories:{source:'manual',basis:'x\n'}},{calories:{source:'manual',originalValue:'1e2'}},{owner:'other'}])assert.throws(()=>parseNutritionCreate({...input,provenance},NOW),NutritionValidationError);
});
