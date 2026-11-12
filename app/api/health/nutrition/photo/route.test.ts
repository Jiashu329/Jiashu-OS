import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import * as photo from '../../../../../lib/nutrition-photo.ts';
import * as images from '../../../../../lib/nutrition-photo-image.ts';
import * as provider from '../../../../../lib/ai-provider.ts';
import { TINY_JPEG_DATA_URL } from '../../../../../tests/fixtures/nutrition-photo.ts';
import { AISettingsConflictError } from '../../../../../db/ai-settings-store.ts';
import { SiteAISettingsUnavailableError } from '../../../../../db/site-ai-settings-store.ts';
import { AISettingsCryptoError } from '../../../../../lib/ai-settings-crypto.ts';
import { shanghaiDay } from '../../../../../lib/health.ts';

const ORIGIN='https://synthetic-photo.example';
type Handler=(request:Request)=>Promise<Response>;
function load(path:URL,bindings:Record<string,unknown>,names:string[]){
  const source=stripTypeScriptTypes(readFileSync(path,'utf8'),{mode:'strip'}).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
  return new Function(...Object.keys(bindings),source+'\nreturn {'+names.join(',')+'};')(...Object.values(bindings))as Record<string,Handler>;
}
function fixture(){
  let user:string|null='alice',configured=true,model='MiniMax-M3',allowed=true,revision=1,storageFailure:unknown,providerFailure:unknown,changeOnQuota=false,clearOnQuota=false;
  let answer=JSON.stringify({items:[{name:'图片中的熟米饭',evidence:'盘中可见一团白色饭粒',confidence:'medium',estimate:{calories:180,carbs:40,protein:3,fat:null,portion:'约一小碗，假设150g',basis:'按画面容器大小估算，实际份量未知'}}]});
  const today=shanghaiDay(new Date().toISOString()),base={image:{dataUrl:TINY_JPEG_DATA_URL},date:today,meal:'lunch'};
  const env={DB:{}as D1Database,APP_OWNER_USER_ID:'site-owner',AI_SETTINGS_ENCRYPTION_KEY:'PRIVATE-MASTER'};
  const configs:Array<{user:string;revision?:number}>=[],quotaUsers:string[]=[],outgoing:Array<{user:string|null;input:photo.NutritionPhotoRequest}>=[];
  const shared=load(new URL('../../../_shared.ts',import.meta.url),{getChatGPTUser:async()=>user?{userId:user}:null},['apiUser','json','unauthenticated','invalidOrigin','isSameOrigin']);
  const nutrition=load(new URL('../_shared.ts',import.meta.url),{...shared},['nutritionGuard']);
  const handlers=load(new URL('./route.ts',import.meta.url),{env,...shared,...nutrition,...photo,...images,...provider,AISettingsConflictError,AISettingsCryptoError,SiteAISettingsUnavailableError,
    readSiteAISettings:async(_db:unknown,configurationEnv:typeof env)=>{if(storageFailure)throw storageFailure;assert.equal(configurationEnv,env);return{revision};},
    resolveSiteAIConfiguration:async(_db:unknown,configurationEnv:typeof env,expectedRevision?:number)=>{
      assert.equal(configurationEnv,env);configs.push({user:env.APP_OWNER_USER_ID,revision:expectedRevision});if(expectedRevision!==revision)throw new AISettingsConflictError();
      return provider.readAIConfiguration({MINIMAX_API_KEY:configured?'PRIVATE-SHARED-KEY':'',MINIMAX_MODEL:model});
    },
    consumeAIQuota:async(_db:unknown,id:string)=>{quotaUsers.push(id);if(changeOnQuota){revision++;if(clearOnQuota)configured=false;}return{allowed,retryAfter:37};},
    callNutritionPhotoParser:async(_config:provider.AIConfiguration,input:photo.NutritionPhotoRequest)=>{
      outgoing.push({user,input});if(providerFailure)throw providerFailure;return{answer,model,provider:'MiniMax'};
    },
  },['POST']);
  return{today,configs,quotaUsers,outgoing,
    signIn(value:string|null){user=value;},setConfigured(value:boolean){configured=value;},setAllowed(value:boolean){allowed=value;},setModel(value:string){model=value;},setStorageFailure(value:unknown){storageFailure=value;},setProviderFailure(value:unknown){providerFailure=value;},setAnswer(value:string){answer=value;},changeDuringQuota(clear=false){changeOnQuota=true;clearOnQuota=clear;},
    post(body:unknown=base,options:{origin?:string|null;type?:string;length?:string;raw?:boolean;owner?:string}={}){
      const headers=new Headers({'Content-Type':options.type??'application/json'});if(options.origin!==null)headers.set('Origin',options.origin??ORIGIN);if(options.length)headers.set('Content-Length',options.length);if(options.owner)headers.set('X-Page-Owner',options.owner);
      return handlers.POST(new Request(ORIGIN+'/api/health/nutrition/photo',{method:'POST',headers,body:options.raw?String(body):JSON.stringify(body)}));
    },
  };
}
test('photo recognition requires login and same-origin JSON before any config or quota work',async()=>{
  const f=fixture();f.signIn(null);assert.equal((await f.post()).status,401);f.signIn('alice');
  for(const options of [{origin:null},{origin:'https://foreign.test'},{type:'text/plain'},{type:'application/json-extra'}])assert.ok([403,415].includes((await f.post(undefined,options)).status));
  assert.equal(f.configs.length,0);assert.equal(f.quotaUsers.length,0);assert.equal(f.outgoing.length,0);
});
test('a changed login cannot upload an old page photo using the new account configuration',async()=>{
  const f=fixture();f.signIn('bob');const response=await f.post(undefined,{owner:'alice'});
  assert.equal(response.status,409);assert.equal((await response.json() as {code:string}).code,'NUTRITION_PHOTO_OWNER_CHANGED');
  assert.equal(f.configs.length,0);assert.equal(f.quotaUsers.length,0);assert.equal(f.outgoing.length,0);
});
test('invalid and oversized images or descriptions are rejected before reading credentials or spending quota',async()=>{
  const f=fixture();
  for(const body of [null,[],{}, {image:{dataUrl:'https://private.test/image.jpg'},date:f.today}, {image:{dataUrl:'data:image/svg+xml;base64,PHN2Zy8+'},date:f.today},
    {image:{dataUrl:TINY_JPEG_DATA_URL},date:'2099-01-01'}, {image:{dataUrl:TINY_JPEG_DATA_URL},date:f.today,meal:'system'},
    {image:{dataUrl:TINY_JPEG_DATA_URL},date:f.today,text:'字'.repeat(2001)}, {image:{dataUrl:TINY_JPEG_DATA_URL},date:f.today,userId:'other'}])assert.equal((await f.post(body)).status,400);
  assert.equal((await f.post('{bad-json',{raw:true})).status,400);
  assert.equal((await f.post(undefined,{length:String(photo.MAX_NUTRITION_PHOTO_REQUEST_BYTES+1)})).status,413);
  assert.equal(f.configs.length,0);assert.equal(f.quotaUsers.length,0);assert.equal(f.outgoing.length,0);
});
test('successful photo recognition creates only editable estimated drafts using selected date and meal',async()=>{
  const f=fixture(),response=await f.post();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const result=await response.json()as{drafts:ReturnType<typeof photo.buildNutritionPhotoDrafts>['drafts'];provider:string;model:string};
  const draft=result.drafts[0];assert.equal(draft.date,f.today);assert.equal(draft.meal,'lunch');assert.equal(draft.amount,null);assert.equal(draft.unit,null);assert.equal(draft.food,null);assert.equal(draft.calorieSource,'ai');assert.equal(draft.calories,'180.0');assert.equal(draft.fat,null);assert.match(draft.note,/AI 图片估算/);
  assert.equal(result.provider,'MiniMax');assert.equal(result.model,'MiniMax-M3');assert.equal(f.outgoing.length,1);assert.deepEqual(f.quotaUsers,['alice']);assert.ok(f.configs.every((row)=>row.user==='site-owner'&&row.revision===1));
  assert.ok(!JSON.stringify(result).includes('PRIVATE-'));assert.ok(!JSON.stringify(result).includes('data:image'));
  f.signIn('bob');assert.equal((await f.post()).status,200);assert.equal(f.configs.at(-1)?.user,'site-owner');assert.equal(f.quotaUsers.at(-1),'bob');
});
test('metadata is removed before the provider receives image bytes and never appears in returned drafts',async()=>{
  const raw=Buffer.from(TINY_JPEG_DATA_URL.split(',')[1],'base64'),secret=Buffer.from('Exif\0\0GPS-PRIVATE-LOCATION'),app=Buffer.concat([Buffer.from([0xff,0xe1,(secret.length+2)>>8,(secret.length+2)&255]),secret]);
  const dataUrl='data:image/jpeg;base64,'+Buffer.concat([raw.subarray(0,2),app,raw.subarray(2)]).toString('base64');
  const f=fixture(),response=await f.post({image:{dataUrl},date:f.today,meal:'dinner'});assert.equal(response.status,200);assert.equal(f.outgoing[0].input.image.dataUrl,TINY_JPEG_DATA_URL);assert.ok(!(await response.text()).includes('GPS-PRIVATE'));
});
test('missing config, unsupported image model, quota exhaustion and concurrent key changes stop before recognition',async()=>{
  const f=fixture();f.setConfigured(false);assert.equal((await f.post()).status,503);assert.equal(f.quotaUsers.length,0);
  f.setConfigured(true);f.setModel('MiniMax-M2.5');const unsupported=await f.post();assert.equal(unsupported.status,400);assert.equal((await unsupported.json()as{code:string}).code,'AI_VISION_UNSUPPORTED');assert.equal(f.quotaUsers.length,0);
  f.setModel('MiniMax-M3');f.setAllowed(false);const limited=await f.post();assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'37');assert.equal(f.outgoing.length,0);
  f.setAllowed(true);f.changeDuringQuota();assert.equal((await f.post()).status,409);assert.equal(f.outgoing.length,0);
});
test('no food remains a valid empty result while malformed, date-changing or unbounded model output is rejected safely',async()=>{
  const f=fixture();f.setAnswer('{"items":[]}');const empty=await f.post();assert.equal(empty.status,200);assert.deepEqual((await empty.json()as{drafts:unknown[]}).drafts,[]);
  for(const answer of ['PRIVATE-UPSTREAM','{"items":[],"system":"PRIVATE-UPSTREAM"}',JSON.stringify({items:[{name:'米饭',evidence:'可见米饭',confidence:'high',estimate:null,meal:'breakfast'}]})]){
    f.setAnswer(answer);const response=await f.post();assert.equal(response.status,502);assert.ok(!(await response.text()).includes('PRIVATE-'));
  }
});
test('storage, encryption and provider failures return only safe classifications without image content or key material',async()=>{
  const f=fixture();f.setStorageFailure(new Error('PRIVATE-STORAGE '+TINY_JPEG_DATA_URL));const storage=await f.post();assert.equal(storage.status,503);assert.ok(!(await storage.text()).includes('PRIVATE-STORAGE'));
  f.setStorageFailure(new AISettingsCryptoError());assert.equal((await f.post()).status,503);f.setStorageFailure(undefined);
  f.setProviderFailure(new provider.AIProviderError('MiniMax 暂时不可用。','AI_NETWORK_ERROR',502,{networkReason:'EGRESS_DENIED'}));const failed=await f.post();assert.equal(failed.status,502);const result=await failed.json()as{diagnostics:unknown};assert.deepEqual(result.diagnostics,{networkReason:'EGRESS_DENIED'});assert.ok(!JSON.stringify(result).includes('data:image'));assert.equal(f.outgoing.length,1);
});

test('shared configuration unavailable and encryption errors direct photo members to the site creator',async()=>{
  for(const error of [new SiteAISettingsUnavailableError(),new AISettingsCryptoError()]){
    const f=fixture();f.signIn('bob');f.setStorageFailure(error);
    const response=await f.post();assert.equal(response.status,503);
    const result=await response.json()as{error:string;code:string};assert.match(result.error,/联系网站创建者/);
    assert.equal(result.code,error instanceof SiteAISettingsUnavailableError?'SITE_AI_NOT_CONFIGURED':'AI_SETTINGS_ENCRYPTION_UNAVAILABLE');
    assert.equal(f.quotaUsers.length,0);assert.equal(f.outgoing.length,0);
  }
});
test('clearing the shared key while a member quota reservation is pending stops photo upload',async()=>{
  const f=fixture();f.signIn('bob');f.changeDuringQuota(true);
  const response=await f.post();assert.equal(response.status,409);assert.deepEqual(f.quotaUsers,['bob']);assert.equal(f.outgoing.length,0);
  assert.ok(f.configs.every((read)=>read.user==='site-owner'&&read.revision===1));
});
