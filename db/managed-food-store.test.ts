import assert from 'node:assert/strict';
import test from 'node:test';
import { managedDefinition,managedFoodFixture } from '../tests/fixtures/managed-food.ts';
import { listManagedFoodAdmin,listManagedFoodLibrary,mutateManagedFood } from './managed-food-store.ts';
import { ManagedFoodError } from '../lib/managed-food-catalog.ts';
const NOW='2026-11-14T01:00:00.000Z';
const key=()=>crypto.randomUUID();
const conflict=(error:unknown)=>error instanceof ManagedFoodError&&error.status===409;

test('draft, publication, editing, archive and restore keep public values and every published version immutable',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());
  const create=key(),saved=await mutateManagedFood(f.db,'admin',{action:'save',expectedRevision:0,definition:managedDefinition,replacesId:'luckin-cn:1'},create,NOW);
  assert.equal(saved.item.status,'draft');assert.deepEqual((await listManagedFoodLibrary(f.db)).foods,[]);
  assert.deepEqual((await listManagedFoodLibrary(f.db)).overrides,[]);
  const published=await mutateManagedFood(f.db,'admin',{action:'publish',id:saved.item.id,expectedRevision:1},key(),NOW);
  let publicFoods=await listManagedFoodLibrary(f.db);assert.equal(publicFoods.foods[0].reference.calories,179);assert.deepEqual(publicFoods.overrides,['luckin-cn:1']);
  assert.equal(publicFoods.foods[0].reference.protein,0);assert.equal(Object.hasOwn(publicFoods.foods[0].reference,'fat'),false);
  const changed=await mutateManagedFood(f.db,'admin',{action:'save',id:saved.item.id,expectedRevision:2,replacesId:'luckin-cn:1',definition:{...managedDefinition,calories:'99.0'}},key(),NOW);
  assert.equal(changed.item.status,'published');assert.equal(changed.item.hasDraftChanges,true);
  assert.equal((await listManagedFoodLibrary(f.db)).foods[0].reference.calories,179,'saving a draft cannot change public nutrition');
  const next=await mutateManagedFood(f.db,'admin',{action:'publish',id:saved.item.id,expectedRevision:3},key(),NOW);
  assert.equal(next.item.publishedRevision,4);assert.equal((await listManagedFoodLibrary(f.db)).foods[0].reference.calories,99);
  const old=JSON.parse(String(f.sqlite.prepare('SELECT definition_json FROM managed_food_versions WHERE item_id=? AND revision=2').get(saved.item.id)?.definition_json));assert.equal(old.calories,'179.0');
  assert.throws(()=>f.sqlite.prepare('UPDATE managed_food_versions SET definition_json=? WHERE item_id=?').run('{}',saved.item.id),/immutable/);
  const archived=await mutateManagedFood(f.db,'admin',{action:'archive',id:saved.item.id,expectedRevision:4},key(),NOW);
  publicFoods=await listManagedFoodLibrary(f.db);assert.equal(publicFoods.foods.length,0);assert.deepEqual(publicFoods.overrides,['luckin-cn:1']);
  const restored=await mutateManagedFood(f.db,'admin',{action:'restore',id:saved.item.id,expectedRevision:archived.item.revision},key(),NOW);
  assert.equal(restored.item.publishedRevision,next.item.publishedRevision);assert.equal((await listManagedFoodLibrary(f.db)).foods[0].reference.calories,99);
  assert.equal((await listManagedFoodAdmin(f.db)).length,1);
  assert.equal(published.item.publishedRevision,2);
});

test('stable receipts replay the original result after edits and reject key reuse, stale updates and duplicate overlays',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());const operation=key();const command={action:'save',expectedRevision:0,replacesId:'luckin-cn:1',definition:managedDefinition};
  const first=await mutateManagedFood(f.db,'admin',command,operation,NOW);
  await mutateManagedFood(f.db,'admin',{action:'publish',id:first.item.id,expectedRevision:1},key(),NOW);
  const replay=await mutateManagedFood(f.db,'admin',command,operation,NOW);assert.equal(replay.replayed,true);assert.deepEqual(replay.item,first.item);
  await assert.rejects(mutateManagedFood(f.db,'admin',{...command,definition:{...managedDefinition,name:'other'}},operation,NOW),conflict);
  await assert.rejects(mutateManagedFood(f.db,'admin',{action:'archive',id:first.item.id,expectedRevision:1},key(),NOW),conflict);
  await assert.rejects(mutateManagedFood(f.db,'admin',command,key(),NOW),conflict);
  assert.equal((await listManagedFoodLibrary(f.db)).foods[0].name,managedDefinition.name);
});

test('owner identity and revision are rechecked atomically and failed mutations leave no receipt or publication',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());
  await assert.rejects(mutateManagedFood(f.db,'member',{action:'save',expectedRevision:0,definition:managedDefinition},key(),NOW),(error:unknown)=>error instanceof ManagedFoodError&&error.status===403);
  const saved=await mutateManagedFood(f.db,'admin',{action:'save',expectedRevision:0,definition:managedDefinition},key(),NOW);
  f.beforeBatch(()=>f.sqlite.prepare('UPDATE managed_foods SET revision=revision+1 WHERE id=?').run(saved.item.id));
  await assert.rejects(mutateManagedFood(f.db,'admin',{action:'publish',id:saved.item.id,expectedRevision:1},key(),NOW),conflict);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_versions').get()?.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_operations').get()?.n,1);
  f.beforeBatch(()=>f.sqlite.prepare("UPDATE app_owner_identity SET user_id='new-owner' WHERE id='owner'").run());
  await assert.rejects(mutateManagedFood(f.db,'admin',{action:'publish',id:saved.item.id,expectedRevision:2},key(),NOW),(error:unknown)=>error instanceof ManagedFoodError&&error.status===403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_versions').get()?.n,0);
});

test('an explicit archive can retire an untouched built-in without ever publishing draft nutrition',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());
  const saved=await mutateManagedFood(f.db,'admin',{action:'save',expectedRevision:0,replacesId:'luckin-cn:1',definition:{...managedDefinition,calories:null}},key(),NOW);
  assert.deepEqual((await listManagedFoodLibrary(f.db)).overrides,[]);
  const archived=await mutateManagedFood(f.db,'admin',{action:'archive',id:saved.item.id,expectedRevision:1},key(),NOW);
  assert.deepEqual((await listManagedFoodLibrary(f.db)).overrides,['luckin-cn:1']);
  assert.equal((await listManagedFoodLibrary(f.db)).foods.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_versions').get()?.n,0);
  await mutateManagedFood(f.db,'admin',{action:'restore',id:saved.item.id,expectedRevision:archived.item.revision},key(),NOW);
  assert.deepEqual((await listManagedFoodLibrary(f.db)).overrides,[]);
});

test('a deployment-configured owner remains authorized without bootstrap writes to the identity table',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());f.sqlite.prepare('DELETE FROM app_owner_identity').run();
  const saved=await mutateManagedFood(f.db,'configured-owner',{action:'save',expectedRevision:0,definition:managedDefinition},key(),NOW,'configured-owner');
  assert.equal(saved.item.revision,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM app_owner_identity').get()?.n,0);
  await assert.rejects(mutateManagedFood(f.db,'other',{action:'publish',id:saved.item.id,expectedRevision:1},key(),NOW,'configured-owner'),(error:unknown)=>error instanceof ManagedFoodError&&error.status===403);
});

test('a receipt committed between the initial receipt read and item read still acknowledges the same operation',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());const operation=key(),command={action:'save',expectedRevision:0,definition:managedDefinition};
  let injected=false;
  const interleaved={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);
    if(sql.includes('SELECT actor_user_id AS actorUserId')&&!injected){const first=statement.first.bind(statement);
      statement.first=(async()=>{const result=await first();if(!injected){injected=true;await mutateManagedFood(f.db,'admin',command,operation,NOW);}return result;}) as typeof statement.first;
    }return statement;
  }};
  const result=await mutateManagedFood(interleaved,'admin',command,operation,NOW);
  assert.equal(result.replayed,true);assert.equal(result.item.id,operation);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_operations').get()?.n,1);
});

test('an unconfirmed write retains a retryable operation while a lost response after commit replays safely',async(t)=>{
  const f=managedFoodFixture();t.after(()=>f.close());const operation=key(),command={action:'save',expectedRevision:0,definition:managedDefinition};
  f.beforeBatch(()=>{throw new Error('Synthetic transport unavailable');});
  await assert.rejects(mutateManagedFood(f.db,'admin',command,operation,NOW),(error:unknown)=>error instanceof ManagedFoodError&&error.status===503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_food_operations').get()?.n,0);
  const lost={...f.db,async batch(statements:Parameters<typeof f.db.batch>[0]){await f.db.batch(statements);throw new Error('Synthetic lost confirmation');}};
  const saved=await mutateManagedFood(lost,'admin',command,operation,NOW);
  assert.equal(saved.replayed,true);assert.equal(saved.item.id,operation);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_foods').get()?.n,1);
});
