import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedFoodHandlers } from './managed-food-api.ts';
import { managedDefinition,managedFoodFixture } from '../tests/fixtures/managed-food.ts';
import { listManagedFoodLibrary } from '../db/managed-food-store.ts';

const ORIGIN='https://managed-food.example';
function fixture(){
  const f=managedFoodFixture();let user:{userId:string;isOwner:boolean}|null={userId:'admin',isOwner:true};
  const handlers=createManagedFoodHandlers({user:async()=>user,database:()=>f.db,ownerId:async()=>String(f.sqlite.prepare("SELECT user_id FROM app_owner_identity WHERE id='owner'").get()?.user_id),builtin:()=>[{id:'luckin-cn:1'}],json:(body,status=200)=>Response.json(body,{status})});
  return {...f,signIn(value:typeof user){user=value;},get(query=''){return handlers.GET(new Request(ORIGIN+'/api/health/foods/manage'+query));},
    post(body:unknown,options:{origin?:string|null;type?:string;owner?:string;operation?:string}={}){const headers=new Headers({'Content-Type':options.type??'application/json','X-Page-Owner':options.owner??'admin','Idempotency-Key':options.operation??crypto.randomUUID()});if(options.origin!==null)headers.set('Origin',options.origin??ORIGIN);return handlers.POST(new Request(ORIGIN+'/api/health/foods/manage',{method:'POST',headers,body:JSON.stringify(body)}));},
  };
}

test('management requires verified owner and same-page same-origin JSON, with no member access to drafts',async(t)=>{
  const f=fixture();t.after(()=>f.close());const command={action:'save',expectedRevision:0,definition:managedDefinition};
  f.signIn(null);assert.equal((await f.get()).status,401);assert.equal((await f.post(command)).status,401);
  f.signIn({userId:'member',isOwner:false});assert.equal((await f.get()).status,403);assert.equal((await f.post(command,{owner:'member'})).status,403);
  f.signIn({userId:'not-real-owner',isOwner:true});assert.equal((await f.get()).status,403);assert.equal((await f.post(command,{owner:'not-real-owner'})).status,403);
  f.signIn({userId:'admin',isOwner:true});
  assert.equal((await f.post(command,{origin:null})).status,403);assert.equal((await f.post(command,{type:'text/plain'})).status,415);
  assert.equal((await f.post(command,{owner:'old-account'})).status,401);assert.equal((await f.post(command,{operation:'wrong'})).status,400);
  assert.equal((await f.get('?all=1')).status,400);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_foods').get()?.n,0);
});

test('save and explicit publication expose bounded public references while repeat requests keep exact receipts',async(t)=>{
  const f=fixture();t.after(()=>f.close());const key=crypto.randomUUID();const command={action:'save',expectedRevision:0,definition:managedDefinition,replacesId:'luckin-cn:1'};
  const savedResponse=await f.post(command,{operation:key});assert.equal(savedResponse.status,200);const saved=await savedResponse.json() as {item:{id:string;revision:number}};
  assert.equal((await listManagedFoodLibrary(f.db)).foods.length,0);
  assert.equal((await f.post(command,{operation:key})).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM managed_foods').get()?.n,1);
  const publish=await f.post({action:'publish',id:saved.item.id,expectedRevision:1});assert.equal(publish.status,200);
  assert.equal((await listManagedFoodLibrary(f.db)).foods[0].reference.calories,179);
  assert.equal((await f.post({action:'archive',id:saved.item.id,expectedRevision:1})).status,409);
  const list=await (await f.get()).json() as {items:unknown[];builtin:unknown[];images:Record<string,unknown>};
  assert.equal(list.items.length,1);assert.equal(list.builtin.length,1);assert.ok(list.images['luckin-cn:1']);
  assert.equal((await f.post({...command,replacesId:'luckin-cn:999999'})).status,400);
});
