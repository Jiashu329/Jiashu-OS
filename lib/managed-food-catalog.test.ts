import assert from 'node:assert/strict';
import test from 'node:test';
import { managedDefinition } from '../tests/fixtures/managed-food.ts';
import { managedLibraryFood,parseManagedFoodCommand,parseManagedFoodDefinition } from './managed-food-catalog.ts';

test('managed references preserve unknown and real zero without claiming an immutable official catalog snapshot',()=>{
  const definition=parseManagedFoodDefinition(managedDefinition),id=crypto.randomUUID();
  const food=managedLibraryFood(id,2,definition);
  assert.equal(food.basis,'managed');assert.equal(food.reference.calories,179);assert.equal(food.reference.protein,0);
  assert.equal(Object.hasOwn(food.reference,'carbs'),false);assert.equal(Object.hasOwn(food,'serving'),false);
  assert.equal(food.id,`managed:${id}:2`);assert.equal(food.source.version,'网站维护版本2');
  const unknown=managedLibraryFood(id,3,{...definition,calories:null});assert.equal(unknown.reference.calories,null);
});

test('food definitions and commands reject unsupported data, unsafe links, malformed units and stale revision formats',()=>{
  for(const change of [{name:''},{sourceUrl:'javascript:alert(1)'},{imageUrl:'http://bad.example/image.png'},{imageUrl:'https://name:secret@images.example/a.png'},{imageUrl:'https://127.0.0.1/image.png'},{calories:'-1'},{fat:'0.01'},{brandId:'other'},{aliases:['']},{portionLabel:''}]) assert.throws(()=>parseManagedFoodDefinition({...managedDefinition,...change}));
  assert.throws(()=>parseManagedFoodCommand({action:'save',expectedRevision:1,definition:managedDefinition}));
  assert.throws(()=>parseManagedFoodCommand({action:'publish',id:crypto.randomUUID(),expectedRevision:0}));
  assert.throws(()=>parseManagedFoodCommand({action:'save',expectedRevision:0,definition:managedDefinition,replacesId:'tfda:123'}));
  assert.throws(()=>parseManagedFoodCommand({action:'publish',id:crypto.randomUUID(),expectedRevision:1,definition:managedDefinition}));
});
