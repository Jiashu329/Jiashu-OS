import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { NUTRITION_NEEDS_CONTENT, NUTRITION_NEEDS_SCRIPT } from './nutrition-needs-ui.ts';
import { renderNutritionPage } from '../nutrition-page.ts';
import { NUTRITION_P1_SCRIPT } from './nutrition-p1-ui.ts';

const response={estimate:{bmr:1568.75,maintenanceCalories:1883,activityMultiplier:1.2,goalAdjustmentPercent:0,effectiveAdjustmentPercent:0,targets:{calories:'1883',carbs:'235.4',protein:'94.2',fat:'62.8'},warnings:['这是参考估算。']},ai:{status:'ready',text:'<img src=x onerror=bad()>\n从维持体重开始观察。',message:null}};
async function settle(check:()=>boolean){for(let n=0;n<50;n++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check());}
function fixture(options:{request?:()=>Promise<unknown>}={}){
 const {window,document}=parseHTML('<html><body>'+NUTRITION_NEEDS_CONTENT+'</body></html>');
 for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return select.querySelector('option[selected]')?.getAttribute('value')??select.querySelector('option')?.getAttribute('value')??'';},set(value:string){for(const option of select.querySelectorAll('option'))if(option.getAttribute('value')===value)option.setAttribute('selected','');else option.removeAttribute('selected');}});
 const requests:Array<{path:string;options:RequestInit}>=[],applied:unknown[]=[],registrations:Record<string,unknown>[]=[];
 let blocked:string|null=null,verify:()=>Promise<unknown>=async()=>{};
 const session={changed:false,problem:'账号已变化。',verify:()=>verify()};
 const draft={reset(){},saved(){},failed(){}};
 Object.assign(window,{JiashuAccountSession:session,JiashuDraftGuards:{register(options:Record<string,unknown>){registrations.push(options);return draft;}}});
 const adapter={async request(path:string,init:RequestInit){requests.push({path,options:init});return options.request?options.request():structuredClone(response);},goalBlocked:()=>blocked,apply(targets:unknown){if(blocked)return blocked;applied.push(targets);return null;}};
 runInNewContext(NUTRITION_NEEDS_SCRIPT+';window.control=installNutritionNeeds(adapter);',{window,document,AbortController,Event:window.Event,adapter,JSON,Number,Math});
 const control=(window as unknown as {control:{refresh():void}}).control;
 const el=(id:string)=>document.getElementById('nutrition-needs-'+id)! as HTMLElement&{value:string;disabled:boolean;hidden:boolean};
 return{window,document,requests,applied,registrations,session,control,el,block(value:string|null){blocked=value;control.refresh();},verify(value:()=>Promise<unknown>){verify=value;},input(id:string,value:string){el(id).value=value;el(id).dispatchEvent(new window.Event('input',{bubbles:true}));},complete(){for(const[id,value]of Object.entries({age:'30',sex:'male',height:'170',weight:'65',activity:'sedentary',goal:'maintain'})){el(id).value=value;el(id).dispatchEvent(new window.Event('input',{bubbles:true}));}},submit(){el('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));},click(id:string){el(id).dispatchEvent(new window.Event('click',{bubbles:true}));}};
}

test('the calculator is explicitly opened, selects its coefficient, and never persists body-profile drafts',()=>{
 const f=fixture();assert.equal(f.requests.length,0);assert.equal(f.el('sex').value,'');assert.equal(f.el('activity').value,'');assert.equal(f.el('result').hidden,true);assert.equal(f.registrations[0].durable,false);assert.equal((f.registrations[0].canSave as ()=>boolean)(),false);
 f.submit();assert.equal(f.requests.length,0);assert.match(f.el('status').textContent??'',/完整填写/);
 const {document}=parseHTML(renderNutritionPage('synthetic-owner'));const ids=[...document.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);assert.ok(document.getElementById('nutrition-goals')?.contains(document.getElementById('nutrition-needs')));assert.equal(document.querySelectorAll('#nutrition-goals-form #nutrition-needs-form').length,0);
});

test('an explicit calculation posts only the chosen profile and previews escaped AI text before separate application',async()=>{
 const f=fixture();f.complete();f.submit();await settle(()=>!f.el('result').hidden);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/health/nutrition/needs');assert.equal(f.requests[0].options.method,'POST');assert.deepEqual(JSON.parse(String(f.requests[0].options.body)),{age:30,heightCm:170,weightKg:65,sex:'male',activity:'sedentary',goal:'maintain'});
 assert.match(f.el('basis').textContent??'',/活动系数 ×1.2.*调整 0%/);assert.equal(f.applied.length,0);assert.equal(f.el('bmr').textContent,'1569 kcal');assert.equal(f.el('carbs').textContent,'235.4 g');assert.match(f.el('ai').textContent??'',/<img src=x onerror=bad\(\)>/);assert.equal(f.el('ai').querySelector('img'),null);
 f.click('apply');await settle(()=>f.applied.length===1);assert.deepEqual(JSON.parse(JSON.stringify(f.applied[0])),response.estimate.targets);assert.equal(f.requests.length,1);assert.equal(f.el('apply').disabled,true);assert.match(f.el('apply-status').textContent??'',/保存每日目标/);
 f.click('apply');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.applied.length,1);
});

test('changing an input invalidates the old numbers and a late response cannot restore them',async()=>{
 let finish!:(value:unknown)=>void;const f=fixture({request:()=>new Promise(resolve=>{finish=resolve;})});f.complete();f.submit();assert.equal(f.el('calculate').disabled,true);f.input('weight','66');finish(response);await settle(()=>!f.el('calculate').disabled);assert.equal(f.el('result').hidden,true);assert.equal(f.el('apply').disabled,true);f.click('apply');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.applied.length,0);
});

test('a visible estimate becomes unusable on changes and clear removes all profile values and the result',async()=>{
 const f=fixture();f.complete();f.submit();await settle(()=>!f.el('result').hidden);f.input('goal','lose');assert.equal(f.el('result').hidden,true);assert.equal(f.el('apply').disabled,true);f.click('clear');assert.equal(f.el('age').value,'');assert.equal(f.el('sex').value,'');assert.equal(f.el('goal').value,'maintain');assert.equal(f.el('ai').textContent,'');assert.equal(f.el('calories').textContent,'');assert.equal(f.requests.length,1);
});

test('draft, loading, conflict and save blockers protect existing targets and are checked again after identity verification',async()=>{
 const f=fixture();f.complete();f.submit();await settle(()=>!f.el('result').hidden);
 for(const message of ['目标读取失败','已有未保存目标','目标发生冲突','正在保存目标']){f.block(message);assert.equal(f.el('apply').disabled,true);f.click('apply');assert.equal(f.applied.length,0);assert.equal(f.el('apply-status').textContent,message);}
 f.block(null);let finish!:(value:unknown)=>void;f.verify(()=>new Promise(resolve=>{finish=resolve;}));f.click('apply');f.block('已有未保存目标');finish(undefined);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.applied.length,0);
});

test('AI degradation honestly keeps formula targets available without pretending an AI explanation succeeded',async()=>{
 const f=fixture({request:async()=>({...response,ai:{status:'rateLimited',text:null,message:'AI 今日额度已用完，先参考公式估算。'}})});f.complete();f.submit();await settle(()=>!f.el('result').hidden);assert.match(f.el('status').textContent??'',/AI 解读本次未生成/);assert.match(f.el('ai').textContent??'',/今日额度已用完/);assert.equal(f.el('apply').disabled,false);
});

test('account changes hide results, abort a pending request and prevent further calculation or target application',async()=>{
 let finish!:(value:unknown)=>void;const f=fixture({request:()=>new Promise(resolve=>{finish=resolve;})});f.complete();f.submit();f.session.changed=true;f.document.dispatchEvent(new f.window.Event('jiashu-account-changed'));assert.equal((f.requests[0].options.signal as AbortSignal).aborted,true);finish(response);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.el('result').hidden,true);assert.equal(f.el('calculate').disabled,true);assert.equal(f.el('apply').disabled,true);f.submit();f.click('apply');assert.equal(f.requests.length,1);assert.equal(f.applied.length,0);
});

test('failed or malformed results leave profile inputs intact and never enable applying partial targets',async()=>{
 for(const answer of [async()=>({...response,estimate:{...response.estimate,targets:{calories:'1883'}}}),async()=>{throw new Error('网络暂时不可用');},async()=>({...response,ai:{status:'ready',text:null,message:null}})]){const f=fixture({request:answer});f.complete();f.submit();await settle(()=>!f.el('calculate').disabled);assert.equal(f.el('result').hidden,true);assert.equal(f.el('weight').value,'65');assert.equal(f.el('apply').disabled,true);}
});


test('the actual goal integration blocks failed loading, pending recovery, conflicts and unsaved target changes',()=>{
 const {window,document}=parseHTML('<form id="nutrition-goals-form">'+['calories','carbs','protein','fat'].map(key=>'<input id="nutrition-goal-'+key+'">').join('')+'</form>');
 const el=(id:string)=>document.getElementById('nutrition-'+id)!;
 runInNewContext(NUTRITION_P1_SCRIPT+`;window.check=p1NeedsGoalBlocked;window.setState=(value)=>Object.assign(p1State,value);window.setDirty=(value)=>{p1GoalGuard={dirty:value};};`,{window,document,el});
 const access=window as unknown as {check():string|null;setState(value:unknown):void;setDirty(value:boolean):void};
 assert.match(access.check()??'',/读取最新/);access.setState({goalLoading:true});assert.match(access.check()??'',/正在读取/);
 access.setState({goalLoading:false,goals:{calories:'2000.0',carbs:null,protein:null,fat:null}});(el('goal-calories') as unknown as HTMLInputElement).value='2000';assert.equal(access.check(),null);
 access.setState({goalLoadFailed:true});assert.match(access.check()??'',/读取最新/);access.setState({goalLoadFailed:false,goalBusy:true});assert.match(access.check()??'',/正在保存/);
 access.setState({goalBusy:false,goalConflict:true});assert.match(access.check()??'',/其他页面变化/);access.setState({goalConflict:false});
 const recovery=document.createElement('div');recovery.setAttribute('data-durable-recovery','');el('goals-form').appendChild(recovery);assert.match(access.check()??'',/草稿待恢复/);recovery.remove();
 access.setDirty(true);assert.match(access.check()??'',/未保存/);access.setDirty(false);(el('goal-carbs') as unknown as HTMLInputElement).value='100';assert.match(access.check()??'',/未保存/);
 (el('goal-carbs') as unknown as HTMLInputElement).value='';assert.equal(access.check(),null);
});
