import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderNutritionPage } from '../nutrition-page.ts';
import { renderNutritionScript } from './nutrition-ui.ts';
import { parseNutritionCreate } from './nutrition.ts';

const DAY = '2026-11-11';
const NOW = Date.parse(DAY + 'T04:00:00Z');
const ID = 'ad0c5a3c-6105-4b6b-b065-1472594b5e03';
const food = { id: 'synthetic-rice', name: '测试熟米饭', aliases: ['测试饭'], category: '谷物', state: '熟', kcalPer100g: 120,
  carbsPer100g: 25.6, proteinPer100g: 2.3, fatPer100g: 0,
  source: { name: 'Synthetic fixture', url: 'https://example.test/food', recordId: 'test-1', version: 'test' },
  portions: [{ unit: '碗', grams: 150, estimated: true }] };
const meals = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const emptyMealStates = () => ({ breakfast: 'unrecorded', lunch: 'unrecorded', dinner: 'unrecorded', snack: 'unrecorded' });
const summary = (entries: Array<Record<string, any>>) => {
  const active = entries.filter((entry) => !entry.deleted);
  const summarize = (rows: Array<Record<string, any>>) => {
    const known = rows.filter((entry) => entry.calories !== null);
    return { entryCount: rows.length, knownCount: known.length, unknownCount: rows.length - known.length,
      knownCalories: known.length ? known.reduce((sum, entry) => sum + Number(entry.calories), 0).toFixed(1) : null };
  };
  return { ...summarize(active), meals: Object.entries(meals).map(([meal, label]) => ({ meal, label, ...summarize(active.filter((entry) => entry.meal === meal)) })) };
};
const entry = (patch: Record<string, any> = {}) => ({ id: ID, date: DAY, meal: 'lunch', name: '合成食物', portion: '1份', calories: '120.0', note: '', revision: 1, deleted: false, ...patch });
const draft = (patch: Record<string, any> = {}) => ({ date: DAY, meal: 'lunch', name: '合成食物', portion: '1份', calories: null, note: '', food: null, candidates: [], warnings: [], ...patch });

async function settled(check: () => boolean) {
  for (let count = 0; count < 60; count++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'The nutrition UI operation did not settle');
}

type RequestLog = { url: string; method: string; body: any; key: string | null };
function fixture(options: { entries?: Array<Record<string, any>>; storageFails?: boolean; storage?: Map<string, string>; drafts?: Array<Record<string, any>>; yesterdayEntries?: Array<Record<string, any>>; search?: string; goals?: Record<string, any>; review?: Record<string, any>; history?: Array<Record<string, any>>; durable?: Map<string, any>; durableFails?: boolean } = {}) {
  const { window, document } = parseHTML(renderNutritionPage('test'));
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const selected = this.querySelector('option[selected]') || this.querySelector('option'); return selected?.getAttribute('value') ?? selected?.textContent ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === String(value)) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const event = (name: string, details: Record<string, unknown> = {}) => {
    const result = new window.Event(name, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(details)) Object.defineProperty(result, key, { value });
    return result;
  };
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', { configurable: true, get() { return dialog.hasAttribute('open'); } });
    Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); dialog.dispatchEvent(event('close')); }, getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 900 }; } });
  }
  for (const form of document.querySelectorAll('form')) Object.assign(form, { reset() { for (const control of form.querySelectorAll('input,textarea,select')) { if (control.tagName === 'SELECT') { for (const item of control.querySelectorAll('option')) item.removeAttribute('selected'); control.querySelector('option')?.setAttribute('selected', ''); } else (control as unknown as HTMLInputElement).value = ''; } } });
  class FixedDate extends Date { constructor(value?: string | number) { super(value === undefined ? NOW : value); } static now() { return NOW; } }
  const storage = options.storage ?? new Map<string, string>();
  const requests: RequestLog[] = [];
  const entries = [...(options.entries ?? [])];
  const favorites: Array<Record<string, any>> = [];
  let nextBatch: (() => Promise<Response>) | undefined;
  let nextGoal: (() => Promise<Response>) | undefined;
  let nextRestore: (() => Promise<Response>) | undefined;
  let goals={calories:null,carbs:null,protein:null,fat:null,revision:0,createdAt:null,updatedAt:null,...options.goals};
  let dayStatus = { date: DAY, complete: false, meals: emptyMealStates(), revision: 0 };
  const baseData = (date: string) => {
    const rows = date === '2026-11-10' ? options.yesterdayEntries ?? [] : entries.filter((item) => item.date === date);
    return { date, today: DAY, entries: rows, summary: summary(rows), recentFrom: '2026-11-05', recentTo: date,
      recent7days: [{ date, summary: summary(rows) }], recentFoods: rows, dayStatus: { ...dayStatus, date } };
  };
  const fetch = async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'https://synthetic-nutrition.example');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    requests.push({ url, method, body, key: headers.get('Idempotency-Key') });
    if (parsed.pathname.endsWith('/goals')) {
      if(method==='PUT'){const handler=nextGoal;nextGoal=undefined;if(handler)return handler();if(body.expectedRevision!==goals.revision)return Response.json({error:'目标已经更新',code:'NUTRITION_CONFLICT'},{status:409});goals={...goals,...body,revision:goals.revision+1};}
      return Response.json({goals,weightPlan:null});
    }
    if(parsed.pathname.endsWith('/history'))return Response.json({entryId:ID,history:options.history??[]});
    if(parsed.pathname.endsWith('/restore')){const handler=nextRestore;nextRestore=undefined;if(handler)return handler();const current=entries.find(item=>item.id===ID)!;const target=options.history?.find(item=>item.revision===body.revision)?.after;if(!target)return Response.json({error:'找不到这个版本'},{status:404});Object.assign(current,target,{revision:current.revision+1});return Response.json({entry:current,replayed:false});}
    if (parsed.pathname.endsWith('/foods')) return Response.json({ foods: [food] });
    if (parsed.pathname.endsWith('/parse')) return Response.json({ drafts: options.drafts ?? [draft()], warnings: [], provider: 'MiniMax', model: 'synthetic' });
    if (parsed.pathname.endsWith('/batch')) {
      const handler = nextBatch; nextBatch = undefined;
      if (handler) return handler();
      const created = body.entries.map((item: any, index: number) => entry({ ...item, id: index ? 'ad0c5a3c-6105-4b6b-b065-1472594b5e04' : ID }));
      entries.push(...created); return Response.json({ entries: created, replayed: false });
    }
    if (parsed.pathname.endsWith('/reuse') && method === 'POST') { const item=entries.find((item)=>item.id===body.entryId)!; favorites.push({...item,id:headers.get('Idempotency-Key')}); return Response.json({operationId:headers.get('Idempotency-Key'),favorite:favorites.at(-1)}); }
    if (parsed.pathname.endsWith('/favorites')) {
      if (method === 'POST') { const item = entries.find((item) => item.id === body.entryId)!; favorites.push({ ...item, id: 'ad0c5a3c-6105-4b6b-b065-1472594b5e06' }); return Response.json({ favorite: favorites.at(-1) }); }
      if (method === 'DELETE') { favorites.splice(0); return Response.json({ deleted: true }); }
      return Response.json({ favorites });
    }
    if (parsed.pathname.endsWith('/status')) { dayStatus = { ...body, revision: dayStatus.revision + 1 }; return Response.json({ dayStatus }); }
    if (parsed.pathname.endsWith('/review')) return Response.json(options.review??{ range: { from: '2026-11-05', to: DAY, days: Number(parsed.searchParams.get('days')) || 7 },
      days: [{ date: DAY, knownCalories: null, entryCount: 0, knownCount: 0, unknownCount: 0, complete: false, meals: emptyMealStates() }],
      summary: { recordedDays: 0, completeDays: 0, comparableDays: 0, knownCalories: null, averageCompleteKcal: null, unknownCount: 0 }, meals: Object.entries(meals).map(([meal, label]) => ({ meal, label, knownCalories: null, entryCount: 0 })), limitations: ['未记录不表示未进食。'] });
    if (parsed.pathname === '/api/health/nutrition' && method === 'POST') { const created = entry(body); entries.push(created); return Response.json({ entry: created, replayed: false }); }
    if (parsed.pathname === '/api/health/nutrition/' + ID) {
      const current = entries.find((item) => item.id === ID)!;
      if (method === 'PATCH') Object.assign(current, body, { revision: current.revision + 1 });
      return Response.json({ entry: current });
    }
    if (parsed.pathname === '/api/health/nutrition') return Response.json(baseData(parsed.searchParams.get('date') || DAY));
    throw new Error('Unexpected request: ' + method + ' ' + url);
  };
  const location = { pathname: '/health/nutrition', search: options.search ?? '?date=' + DAY, origin: 'https://synthetic-nutrition.example' };
  const history = { replaceState(_state: unknown, _title: string, path: string) { const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; } };
  const sessionStorage = { getItem(key: string) { return storage.get(key) ?? null; }, setItem(key: string, value: string) { if (options.storageFails) throw new Error('Synthetic storage unavailable'); storage.set(key, value); }, removeItem(key: string) { storage.delete(key); } };
  (window as unknown as Record<string,unknown>).JiashuDrafts=undefined;
  if(options.durable){const saved=options.durable;Object.assign(window,{JiashuDrafts:{setOwner(){},storage(){return sessionStorage;},save(id:string,label:string,data:unknown,meta:Record<string,unknown>={}){if(options.durableFails)return false;saved.set(id,{id,label,data:structuredClone(data),updatedAt:NOW,...meta});return true;},get(id:string){return saved.get(id)??null;},list(){return [...saved.values()];},remove(id:string){return saved.delete(id);},clearConfirmed(id:string){return saved.delete(id);}}});}
  let focused: Element | null = null;
  for (const node of document.querySelectorAll('input,button,textarea,select')) Object.defineProperty(node, 'focus', { configurable: true, value() { focused = node; } });
  const source = renderNutritionScript('test').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  runInNewContext(source, { window, document, Element: window.Element, Event: window.Event, fetch, location, history, sessionStorage, Date: FixedDate, Intl, URL, URLSearchParams, Headers, AbortController, crypto: webcrypto, setTimeout, clearTimeout, queueMicrotask });
  const el = (id: string) => document.getElementById('nutrition-' + id)! as unknown as HTMLElement & { value: string; checked: boolean; disabled: boolean; open: boolean };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click', { button: 0 }));
  const input = (target: string | Element, value: string, kind = 'input') => { const node = typeof target === 'string' ? el(target) : target as unknown as typeof el extends (...args: any[]) => infer R ? R : never; (node as any).value = value; node.dispatchEvent(event(kind)); };
  const submit = (id: string) => el(id).dispatchEvent(event('submit'));
  return { window, document, requests, entries, favorites, storage, el, click, input, submit, event, get focused() { return focused; },
    nextBatch(handler: () => Promise<Response>) { nextBatch = handler; },
    nextGoal(handler: () => Promise<Response>) { nextGoal = handler; },
    nextRestore(handler: () => Promise<Response>) { nextRestore = handler; },
    setGoals(value: Record<string,any>) { goals={...goals,...value}; },
    async ready() { await settled(() => !el('content').hidden); },
    async history() { el('history').open = true; el('history').setAttribute('open', ''); el('history').dispatchEvent(event('toggle')); await settled(() => el('review-status').textContent?.includes('已记录部分') === true); },
    async parse() { input('ai-text', '午餐吃了测试食物'); click('ai-parse'); await settled(() => el('batch-dialog').open); },
  };
}

test('opening nutrition keeps history closed and only requests the review when the user expands it', async () => {
  const f = fixture(); await f.ready();
  assert.ok(f.requests.every((request) => request.method === 'GET'));
  assert.ok(f.requests.every((request) => !request.url.includes('/parse')));
  assert.equal(f.el('dialog').open, false); assert.equal(f.el('batch-dialog').open, false);
  assert.ok(!f.requests.some((request) => request.url.includes('/review')));
  await f.history();
  assert.match(f.el('review-chart').textContent ?? '', /—/);
  assert.equal(f.el('review-chart').querySelectorAll('.is-missing').length, 1);
  assert.match(f.el('review-summary').textContent ?? '', /暂无可比较日期/);
  f.el('history').dispatchEvent(f.event('toggle'));
  assert.equal(f.requests.filter((request) => request.url.includes('/review')).length, 1);
});

test('daily goals show recorded partial progress, real zero and leave unset targets hidden', async () => {
  const f=fixture({goals:{calories:'200.0',protein:'50.0',fat:'0.0',revision:1},entries:[entry({protein:'0.0',fat:'0.0'}),entry({id:ID+'1',calories:null,protein:null,fat:null})]});
  await f.ready();await settled(()=>!f.el('goal-progress').hidden);
  assert.match(f.el('goal-progress').textContent??'',/蛋白质0.0 g.*50.0 g/);
  assert.match(f.el('goal-progress').textContent??'',/1 项未填，仅比较已记录部分/);
  assert.match(f.el('goal-progress').textContent??'',/脂肪0.0 g.*0.0 g/);
  assert.equal(f.el('goal-progress').querySelectorAll('article').length,3);
  assert.ok(!f.requests.some(request=>request.method!=='GET'));
});

test('goal conflicts preserve typed values and require reading the latest revision before retrying', async () => {
  const f=fixture({goals:{protein:'80.0',revision:1}});await f.ready();await settled(()=>f.el('goal-protein').value==='80.0');
  f.input('goal-protein','95');f.setGoals({protein:'90.0',revision:2});f.submit('goals-form');
  await settled(()=>f.el('goals-status').textContent?.includes('其他页面更新')===true);
  assert.equal(f.el('goal-protein').value,'95');assert.equal(f.el('goals-save').disabled,true);
  f.click('goals-reload');await settled(()=>f.el('goals-save').disabled===false);
  assert.equal(f.el('goal-protein').value,'95');f.submit('goals-form');
  await settled(()=>f.el('goals-status').textContent?.includes('目标已保存')===true);
  const writes=f.requests.filter(request=>request.method==='PUT');
  assert.deepEqual(writes.map(request=>request.body.expectedRevision),[1,2]);
  assert.equal(writes[1].body.protein,'95.0');
});

test('nutrient review switches trends and uses only complete days with that nutrient filled for averages', async () => {
  const stat=(total:string|null,knownCount=1,unknownCount=0)=>({total,knownCount,unknownCount});
  const review={range:{from:'2026-11-10',to:DAY,days:7},days:[
    {date:'2026-11-10',entryCount:1,complete:true,knownCalories:'200.0',nutrients:{protein:stat('80.0')}},
    {date:DAY,entryCount:2,complete:false,knownCalories:'300.0',nutrients:{protein:stat('90.0',1,1)}},
  ],summary:{recordedDays:2,completeDays:1,comparableDays:1,knownCalories:'500.0',unknownCount:0,nutrients:{protein:stat('170.0',2,1)}},meals:[{meal:'lunch',label:'午餐',entryCount:3,knownCalories:'500.0',nutrients:{protein:stat('170.0',2,1)}}],limitations:['仅已记录值']};
  const f=fixture({review});await f.ready();await f.history();
  f.click(f.document.querySelector('[data-nutrition-review-metric="protein"]')!);
  assert.match(f.el('review-summary').textContent??'',/170.0 g/);
  assert.match(f.el('review-summary').textContent??'',/80.0 g（1 天）/);
  assert.match(f.el('review-summary').textContent??'',/1 项蛋白质未填/);
  assert.match(f.el('review-meals').textContent??'',/午餐：170.0 g/);
  assert.equal(f.el('review-chart').getAttribute('aria-label'),'每日已记录蛋白质');
});

test('packaging provenance is editable and submitted independently of notes with a valid server payload', async () => {
  const f=fixture();await f.ready();f.click('add');f.input('name','测试包装食品');f.input('calories','120');f.input('protein','8.5');
  f.input('source-protein','label','change');f.input('basis-protein','包装标注当前份量8.5g蛋白质');f.submit('form');
  await settled(()=>f.entries.length===1&&!f.el('dialog').open);
  const post=f.requests.find(request=>request.method==='POST'&&request.url==='/api/health/nutrition')!;
  assert.deepEqual(post.body.provenance.protein,{source:'label',basis:'包装标注当前份量8.5g蛋白质'});
  assert.equal(post.body.note,'');
  const parsed=parseNutritionCreate(post.body,new Date(NOW));assert.equal(parsed.provenance?.protein?.source,'label');
  assert.match(f.el('list').textContent??'',/包装标签.*当前份量8.5g/);
});

test('structured AI provenance survives manual correction and keeps the original estimate without note inference', async () => {
  const provenance={calories:{source:'ai',basis:'按常见烹饪方式估算',originalValue:'350.0'},protein:{source:'ai',basis:'按肉类份量估算',originalValue:'25.0'}};
  const f=fixture({drafts:[draft({calories:'350.0',protein:'25.0',note:'普通备注',provenance})]});await f.ready();await f.parse();
  const node=f.el('batch-rows');f.input(node.querySelector('[data-draft-field="protein"]')!,'30.0');f.submit('batch-form');
  await settled(()=>!f.el('batch-dialog').open);
  const body=f.requests.find(request=>request.url.endsWith('/batch'))!.body.entries[0];
  assert.equal(body.provenance.protein.source,'manual');assert.equal(body.provenance.protein.originalValue,'25.0');
  assert.equal(body.provenance.calories.source,'ai');assert.equal(body.provenance.calories.basis,'按常见烹饪方式估算');
  assert.equal(parseNutritionCreate(body,new Date(NOW)).provenance?.protein?.source,'manual');
});

test('history renders field sources safely and uncertain restores retry the identical revision and request key', async () => {
  const first=entry({revision:1,calories:'100.0',provenance:{calories:{source:'label',basis:'<img src=x onerror=bad()>'}}});
  const current=entry({revision:2,calories:'120.0'});const f=fixture({entries:[current],history:[{revision:1,action:'create',createdAt:'2026-11-11T01:00:00Z',before:null,after:first},{revision:2,action:'edit',createdAt:'2026-11-11T02:00:00Z',before:first,after:current}]});
  await f.ready();f.click(f.el('list').querySelector('[data-nutrition-history]')!);
  await settled(()=>f.el('record-history-rows').querySelectorAll('.nt-audit-row').length===2);
  assert.equal(f.el('record-history-rows').querySelectorAll('img,script').length,0);
  f.nextRestore(async()=>new Response('not json',{status:200,headers:{'Content-Type':'application/json'}}));
  f.click(f.el('record-history-rows').querySelector('[data-restore-nutrition-revision="1"]')!);
  await settled(()=>!f.el('record-history-retry').hidden&&!f.el('record-history-retry').disabled);
  assert.ok([...f.el('record-history-rows').querySelectorAll('button')].every(button=>button.hasAttribute('disabled')));
  f.click('record-history-retry');await settled(()=>f.el('record-history-status').textContent?.includes('已恢复为所选内容')===true);
  const writes=f.requests.filter(request=>request.url.endsWith('/restore'));assert.equal(writes.length,2);
  assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);
  assert.deepEqual(writes[0].body,{revision:1,expectedRevision:2});assert.equal(f.entries[0].calories,'100.0');
});

test('durable description and batch drafts restore explicitly after restart without calling AI or saving', async () => {
  const durable=new Map<string,any>();const first=fixture({durable});await first.ready();first.input('ai-text','午餐吃了2个肉包子');
  assert.equal(durable.get('nutrition-description')?.data.text,'午餐吃了2个肉包子');
  const second=fixture({durable});await second.ready();assert.equal(second.el('ai-text').value,'');
  assert.equal(second.el('draft-recovery').hidden,false);second.click(second.el('draft-recovery-list').querySelector('[data-recover-nutrition-draft="nutrition-description"]')!);
  assert.equal(second.el('ai-text').value,'午餐吃了2个肉包子');assert.ok(second.requests.every(request=>request.method==='GET'));
  await second.parse();assert.ok(durable.has('nutrition-batch'));
  const third=fixture({durable});await third.ready();assert.equal(third.el('batch-dialog').open,false);
  third.click(third.el('draft-recovery-list').querySelector('[data-recover-nutrition-draft="nutrition-batch"]')!);
  assert.equal(third.el('batch-dialog').open,true);assert.ok(third.requests.every(request=>request.method==='GET'));
});

test('an unrecovered older description is not overwritten by new typing and storage failure is visible', async () => {
  const durable=new Map<string,any>([['nutrition-description',{id:'nutrition-description',label:'旧饮食描述',updatedAt:NOW-3600000,data:{text:'昨天吃了旧早餐',date:DAY,meal:'breakfast'}}]]);
  const f=fixture({durable});await f.ready();f.input('ai-text','今天的新午餐');
  assert.equal(durable.get('nutrition-description').data.text,'昨天吃了旧早餐');
  assert.match(f.el('draft-save-status').textContent??'',/旧草稿待恢复或丢弃/);
  f.click(f.el('draft-recovery-list').querySelector('[data-discard-nutrition-draft="nutrition-description"]')!);
  assert.equal(durable.get('nutrition-description').data.text,'今天的新午餐');assert.equal(f.el('draft-recovery').hidden,true);
  const blocked=fixture({durable:new Map(),durableFails:true});await blocked.ready();blocked.input('ai-text','无法持久化的描述');
  assert.equal(blocked.el('draft-save-status').hidden,false);assert.match(blocked.el('draft-save-status').textContent??'',/暂时无法保存跨会话草稿/);
  assert.ok(blocked.requests.every(request=>request.method==='GET'));
});

test('a pending history restore remains resumable after viewing a different entry and clears its banner on success', async () => {
  const otherId='ad0c5a3c-6105-4b6b-b065-1472594b5e04';
  const first=entry({revision:1,calories:'100.0'}),current=entry({revision:2,calories:'120.0'});
  const f=fixture({entries:[current,entry({id:otherId,name:'另一项食物'})],history:[{revision:1,action:'create',createdAt:'2026-11-11T01:00:00Z',before:null,after:first}]});
  await f.ready();f.click(f.el('list').querySelector('[data-nutrition-history="'+ID+'"]')!);
  await settled(()=>f.el('record-history-rows').querySelector('[data-restore-nutrition-revision="1"]')!==null);
  f.nextRestore(async()=>{throw new TypeError('Lost restore acknowledgement');});f.click(f.el('record-history-rows').querySelector('[data-restore-nutrition-revision="1"]')!);
  await settled(()=>!f.el('record-history-retry').hidden&&!f.el('record-history-retry').disabled);assert.equal(f.el('history-pending').hidden,false);
  f.click('record-history-close');f.click(f.el('list').querySelector('[data-nutrition-history="'+otherId+'"]')!);
  await settled(()=>f.el('record-history-status').textContent?.includes('另一条记录')===true);
  assert.ok([...f.el('record-history-rows').querySelectorAll('button')].every(button=>button.hasAttribute('disabled')));
  f.click('record-history-close');f.click('history-pending-resume');
  await settled(()=>!f.el('record-history-retry').hidden);f.click('record-history-retry');
  await settled(()=>f.el('record-history-status').textContent?.includes('已恢复为所选内容')===true);
  const calls=f.requests.filter(request=>request.url.endsWith('/restore'));assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body);
  assert.equal(f.el('history-pending').hidden,true);
});

test('daily nutrient totals add exact tenths, retain a real zero and disclose incomplete entries', async () => {
  const f = fixture({ entries: [entry({ carbs: '0.1', protein: '0.0', fat: null }),
    entry({ id: ID + '1', carbs: '0.2', protein: null, fat: null }),
    entry({ id: ID + '2', carbs: '100.0', protein: '100.0', fat: '100.0', deleted: true })] });
  await f.ready();
  assert.equal(f.el('carbs').closest('dialog') !== null, true, 'Existing editable macro control remains available');
  const cards = f.el('summary').querySelectorAll('.nt-card');
  assert.equal(cards.length, 4);
  assert.match(cards[1].textContent ?? '', /碳水化合物0.3g/);
  assert.match(cards[2].textContent ?? '', /蛋白质0.0g1 项待补充/);
  assert.match(cards[3].textContent ?? '', /脂肪—2 项待补充/);
  const ids = [...f.document.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'Summary IDs must not shadow editable nutrition fields');
});

test('saved food rows keep a visible estimate badge and tuck destructive actions and source notes behind details', async () => {
  const f = fixture({ entries: [entry({ calories: '420.0', note: 'AI 估算：按中等份量估算。' })] });
  await f.ready();
  const row = f.el('list').querySelector('[data-nutrition-entry]')!;
  assert.equal(row.querySelector('.nt-estimate-badge')?.textContent, '含 AI 估算');
  assert.equal(row.querySelector('.nt-row-menu')?.hasAttribute('open'), false);
  assert.equal(row.querySelector('.nt-food-detail')?.hasAttribute('open'), false);
  f.click(row.querySelector('[data-nutrition-action="edit"]')!);
  assert.equal(f.el('dialog').open, true);
});

test('entry methods preserve the description and prefill manual date and meal while revealing invalid optional fields', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.el('entry-ai').hidden, false); assert.equal(f.el('entry-quick').hidden, true);
  assert.equal(f.el('ai-meal').value, 'lunch');
  f.input('ai-text', '晚餐吃了半碗饭');
  f.click(f.document.querySelector('[data-entry-method="quick"]')!);
  assert.equal(f.el('entry-quick').hidden, false); assert.equal(f.el('ai-text').value, '晚餐吃了半碗饭');
  f.input('ai-meal', 'dinner', 'change');
  f.click(f.document.querySelector('[data-entry-method="manual"]')!);
  assert.equal(f.el('dialog').open, true); assert.equal(f.el('form-day').value, DAY); assert.equal(f.el('meal').value, 'dinner');
  assert.equal(f.el('form-nutrients').hasAttribute('open'), false);
  f.input('name', '合成食物'); f.input('fat', '-1'); f.submit('form');
  assert.equal(f.el('form-nutrients').hasAttribute('open'), true);
  assert.match(f.el('form-error').textContent ?? '', /脂肪/);
  assert.equal(f.requests.filter((request) => request.method !== 'GET').length, 0);
});

test('a meal record shortcut and compose link focus the primary entry without opening a dialog or calling AI', async () => {
  const f = fixture({ search: '?date=' + DAY + '&compose=1' }); await f.ready();
  await settled(() => f.focused?.id === 'nutrition-ai-text');
  assert.equal(f.el('dialog').open, false); assert.equal(f.el('batch-dialog').open, false);
  f.click(f.el('list').querySelector('[data-nutrition-add-meal="breakfast"]')!);
  assert.equal(f.el('ai-meal').value, 'breakfast'); assert.equal(f.el('entry-ai').hidden, false);
  assert.equal(f.focused?.id, 'nutrition-ai-text');
  f.click('add'); assert.equal(f.el('meal').value, 'breakfast');
  assert.equal(f.requests.filter((request) => request.method !== 'GET').length, 0);
});

test('compact AI rows show the destination and estimates, update changed values, and reveal validation errors', async () => {
  const f = fixture({ drafts: [draft({ name: '合成米饭', calories: '180.0', carbs: '40.0', protein: '3.0', fat: '0.0',
    calorieSource: 'ai', note: 'AI 估算：按1碗米饭估算。' })] });
  await f.ready(); await f.parse();
  const details = f.el('batch-rows').querySelector('details')!;
  assert.equal(details.hasAttribute('open'), false);
  assert.match(details.querySelector('summary')?.textContent ?? '', /合成米饭.*180.0 kcal.*含 AI 估算/);
  f.input(details.querySelector('[data-draft-field="meal"]')!, 'dinner', 'change');
  f.input(details.querySelector('[data-draft-field="date"]')!, '2026-11-10', 'change');
  f.input(details.querySelector('[data-draft-field="calories"]')!, '200');
  assert.match(details.querySelector('[data-draft-summary-context]')?.textContent ?? '', /晚餐 · 2026-11-10/);
  assert.match(details.querySelector('[data-draft-summary-calories]')?.textContent ?? '', /200 kcal/);
  f.input(details.querySelector('[data-draft-field="protein"]')!, '-2'); f.submit('batch-form');
  assert.equal(details.hasAttribute('open'), true); assert.match(f.el('batch-error').textContent ?? '', /蛋白质/);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
});

test('confirmed AI batch save clears only the exact consumed description and its old status', async () => {
  const f = fixture(); await f.ready();
  f.input('ai-text', '  午餐吃了测试食物  '); f.click('ai-parse'); await settled(() => f.el('batch-dialog').open);
  assert.equal(f.el('ai-text').value, '  午餐吃了测试食物  ');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  assert.equal(f.el('ai-text').value, ''); assert.equal(f.el('ai-status').hidden, true);
  assert.equal(f.el('ai-status').textContent, '');
  assert.equal(f.requests.filter((request) => request.url.endsWith('/parse')).length, 1);
});

test('failed AI save retains the consumed description until the original batch is confirmed', async () => {
  const f = fixture(); await f.ready(); await f.parse();
  const description=f.el('ai-text').value;
  f.nextBatch(async () => { throw new Error('Synthetic uncertain save'); });
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden && !f.el('batch-save').disabled);
  assert.equal(f.el('ai-text').value, description); assert.equal(f.el('ai-status').hidden, false);
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  assert.equal(f.el('ai-text').value, '');
  const posts=f.requests.filter((request) => request.url.endsWith('/batch'));
  assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);
});

test('saving copied batches or an AI batch with unrelated new text does not discard the unsent description', async () => {
  const copied=fixture({yesterdayEntries:[entry({date:'2026-11-10'})]});await copied.ready();
  copied.input('ai-text','晚餐还没有识别的描述');
  copied.click(copied.el('list').querySelector('[data-nutrition-copy-meal="lunch"]')!);
  await settled(()=>copied.el('batch-dialog').open);copied.submit('batch-form');await settled(()=>!copied.el('batch-dialog').open);
  assert.equal(copied.el('ai-text').value,'晚餐还没有识别的描述');
  assert.equal(copied.requests.filter((request)=>request.url.endsWith('/parse')).length,0);

  const changed=fixture();await changed.ready();await changed.parse();
  changed.input('ai-text','另外一餐尚未识别');changed.submit('batch-form');await settled(()=>!changed.el('batch-dialog').open);
  assert.equal(changed.el('ai-text').value,'另外一餐尚未识别');
});

test('save and continue retains date and meal but clears the previous food, and closing restores an unsent draft', async () => {
  const f = fixture(); await f.ready(); f.click('add');
  f.input('meal', 'lunch', 'change'); f.input('name', '合成午饭'); f.input('portion', '1份'); f.input('calories', '250');
  f.click('save-continue');
  await settled(() => f.entries.length === 1 && f.el('dialog').open && f.el('name').value === '');
  assert.equal(f.el('form-day').value, DAY); assert.equal(f.el('meal').value, 'lunch');
  const first = f.requests.find((request) => request.method === 'POST')!;
  assert.equal(first.body.calories, '250.0'); assert.ok(first.key);
  f.input('name', '尚未提交的食物'); f.input('portion', '半份');
  f.click('dialog-close'); assert.equal(f.el('dialog').open, false);
  f.click('add'); assert.equal(f.el('name').value, '尚未提交的食物'); assert.equal(f.el('portion').value, '半份');
  assert.equal(f.el('draft-hint').hidden, false);
});

test('catalog selection previews sourced calories and submits a food selection for server recomputation', async () => {
  const f = fixture(); await f.ready(); f.click('add'); f.input('meal', 'lunch', 'change');
  f.input('food-search', '测试饭'); f.click('food-search-button');
  await settled(() => !!f.el('food-results').querySelector('[data-food-id]'));
  f.click(f.el('food-results').querySelector('[data-food-id]')!);
  assert.equal(f.el('food-selection').hidden, false); assert.equal(f.el('name').value, food.name);
  f.input('food-quantity', '150'); assert.match(f.el('food-preview').textContent ?? '', /180.0 kcal/);
  f.submit('form'); await settled(() => f.entries.length === 1 && !f.el('dialog').open);
  const post = f.requests.find((request) => request.method === 'POST')!;
  assert.deepEqual(post.body.food, { id: food.id, amount: 150, unit: 'g' });
  assert.equal(post.body.calories, '180.0');
});

test('manual nutrient grams preserve zero and blanks through draft restore, saving and editing older records', async () => {
  const f = fixture(); await f.ready(); f.click('add');
  f.input('meal', 'lunch', 'change'); f.input('name', '合成食物');
  f.input('carbs', '0'); f.input('protein', '12.3'); f.input('fat', '');
  f.click('dialog-close'); f.click('add');
  assert.equal(f.el('carbs').value, '0'); assert.equal(f.el('protein').value, '12.3'); assert.equal(f.el('fat').value, '');
  f.click('save-continue'); await settled(() => f.entries.length === 1 && f.el('name').value === '');
  const created = f.requests.find((request) => request.method === 'POST')!.body;
  assert.equal(created.carbs, '0.0'); assert.equal(created.protein, '12.3'); assert.equal(created.fat, null);
  assert.equal(f.el('carbs').value, ''); assert.equal(f.el('protein').value, ''); assert.equal(f.el('fat').value, '');
  assert.match(f.el('list').textContent ?? '', /碳水化合物 0.0g.*蛋白质 12.3g.*脂肪 未填/);
  f.click('dialog-close');

  const older = fixture({ entries: [entry()] }); await older.ready();
  older.click(older.el('list').querySelector('[data-nutrition-action="edit"]')!);
  assert.equal(older.el('carbs').value, ''); assert.equal(older.el('protein').value, '');
  older.input('carbs', '28.6'); older.input('protein', '7'); older.input('fat', '3.2');
  older.submit('form'); await settled(() => !older.el('dialog').open);
  const edit = older.requests.find((request) => request.method === 'PATCH' && request.url.endsWith(ID))!.body;
  assert.equal(edit.expectedRevision, 1); assert.equal(edit.carbs, '28.6'); assert.equal(edit.protein, '7.0'); assert.equal(edit.fat, '3.2');
});

test('catalog portion changes recalculate nutrients while explicit manual gram corrections remain editable', async () => {
  const f = fixture(); await f.ready(); f.click('add'); f.input('meal', 'lunch', 'change');
  f.input('food-search', '测试饭'); f.click('food-search-button');
  await settled(() => !!f.el('food-results').querySelector('[data-food-id]')); f.click(f.el('food-results').querySelector('[data-food-id]')!);
  f.input('food-quantity', '200');
  assert.equal(f.el('carbs').value, '51.2'); assert.equal(f.el('protein').value, '4.6'); assert.equal(f.el('fat').value, '0.0');
  assert.equal(f.el('protein').disabled, false); f.input('protein', '8.5');
  f.submit('form'); await settled(() => f.entries.length === 1 && !f.el('dialog').open);
  const saved = f.requests.find((request) => request.method === 'POST')!.body;
  assert.equal(saved.carbs, '51.2'); assert.equal(saved.protein, '8.5'); assert.equal(saved.fat, '0.0');
  assert.deepEqual(saved.food, { id: food.id, amount: 200, unit: 'g' });
});

test('editing a saved catalog record preserves manual grams until a new quantity requires recalculation', async () => {
  const snapshot = { foodId: food.id, foodName: food.name, kcalPer100g: food.kcalPer100g,
    carbsPer100g: food.carbsPer100g, proteinPer100g: food.proteinPer100g, fatPer100g: food.fatPer100g,
    carbsTenth: 8, proteinTenth: 1, fatTenth: 0, grams: 3, amount: 3, unit: 'g', source: food.source };
  const f = fixture({ entries: [entry({ food: snapshot, carbs: '5.0', protein: '7.0', fat: '0.0' })] });
  await f.ready(); f.click(f.el('list').querySelector('[data-nutrition-action="edit"]')!);
  assert.equal(f.el('carbs').value, '5.0'); assert.equal(f.el('protein').value, '7.0');
  f.input('food-quantity', '200');
  assert.equal(f.el('carbs').value, '51.2'); assert.equal(f.el('protein').value, '4.6');
  f.submit('form'); await settled(() => !f.el('dialog').open);
  const updated = f.requests.find((request) => request.method === 'PATCH' && request.url.endsWith(ID))!.body;
  assert.equal(updated.carbs, '51.2'); assert.equal(updated.protein, '4.6');
});

test('catalog nutrient rounding uses decimal half-up instead of losing tenths to binary float error', async () => {
  const fatty = { ...food, fatPer100g: 34.3 };
  const f = fixture({ drafts: [draft({ name: fatty.name, food: { id: fatty.id, amount: 100, unit: 'g' }, candidates: [fatty] })] });
  await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="amount"]')!, '50');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="fat"]') as HTMLInputElement).value, '17.2');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  assert.equal(f.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0].fat, '17.2');
});

test('invalid nutrient values are rejected locally without creating records', async () => {
  const f = fixture(); await f.ready(); f.click('add'); f.input('meal', 'lunch', 'change'); f.input('name', '测试食物');
  for (const value of ['-1', '1.23', '20000.1', '3g', '1e2', '1\n']) {
    f.input('protein', value); f.submit('form'); await settled(() => !f.el('form-error').hidden);
    assert.match(f.el('form-error').textContent ?? '', /蛋白质/);
  }
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
});

test('AI runs only after clicking identify, generates editable drafts, and waits for an explicit batch save', async () => {
  const f = fixture({ drafts: [draft({ meal: null, name: '<img src=x onerror=alert(1)>', warnings: ['<script>bad()</script>'] })] });
  await f.ready(); await f.parse();
  assert.equal(f.requests.filter((request) => request.url.endsWith('/parse')).length, 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  assert.equal(f.el('batch-rows').querySelectorAll('img,script').length, 0);
  const name = f.el('batch-rows').querySelector('[data-draft-field="name"]')! as HTMLInputElement;
  assert.equal(name.value, '<img src=x onerror=alert(1)>');
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden);
  assert.match(f.el('batch-error').textContent ?? '', /选择餐次/);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  f.input(f.el('batch-rows').querySelector('[data-draft-field="meal"]')!, 'lunch', 'change');
  f.input(name, '修改后的食物'); f.submit('batch-form');
  await settled(() => !f.el('batch-dialog').open);
  const post = f.requests.find((request) => request.url.endsWith('/batch'))!;
  assert.equal(post.body.entries[0].name, '修改后的食物'); assert.equal(post.body.entries[0].meal, 'lunch');
  assert.equal(post.body.entries[0].calories, null);
});

test('AI estimated calories are visible, editable and saved with their serving assumptions', async () => {
  const note = 'AI 估算：2个中等肉包子（每个约80g）；按常见肉馅和用油估算。';
  const f = fixture({ drafts: [draft({ name: '肉包子', portion: '2个中等肉包子（每个约80g）',
    calories: '420.0', calorieSource: 'ai', note })] });
  await f.ready(); await f.parse();
  assert.match(f.el('batch-rows').querySelector('[data-draft-preview]')?.textContent ?? '', /AI 估算.*420.0 kcal/);
  const field = f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement;
  assert.equal(field.hasAttribute('readonly'), false); assert.equal(field.value, '420.0');
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const saved = f.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0];
  assert.equal(saved.calories, '420.0'); assert.equal(saved.note, note); assert.equal(saved.food, undefined);
  assert.match(f.el('list').textContent ?? '', /AI 估算/);
});

test('AI grams stay editable and retry the exact original values and provenance after a lost confirmation', async () => {
  const note = 'AI 估算：2个肉包子；按常见份量估算。碳水化合物、蛋白质、脂肪也为 AI 估算。';
  const f = fixture({ drafts: [draft({ calories: '420.0', carbs: '54.2', protein: '18.5', fat: '15.0',
    calorieSource: 'ai', macroSources: { carbs: 'ai', protein: 'ai', fat: 'ai' }, note })] });
  await f.ready(); await f.parse();
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="protein"]') as HTMLInputElement).value, '18.5');
  f.input(f.el('batch-rows').querySelector('[data-draft-field="protein"]')!, '20');
  f.nextBatch(async () => { throw new TypeError('Synthetic lost confirmation'); });
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden && !f.el('batch-save').disabled);
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="protein"]') as HTMLInputElement).disabled, true);
  f.click(f.el('batch-dialog').querySelector('[data-nutrition-batch-close]')!); f.click('resume-batch');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const posts = f.requests.filter((request) => request.url.endsWith('/batch'));
  assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key); assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(posts[0].body.entries[0].carbs, '54.2'); assert.equal(posts[0].body.entries[0].protein, '20.0');
  assert.equal(posts[0].body.entries[0].fat, '15.0'); assert.match(posts[0].body.entries[0].note, /蛋白质已手动调整/);
});

test('a reloaded page restores pending grams without changing the original batch or legacy absent fields', async () => {
  const original = { key: 'bd0c5a3c-6105-4b6b-b065-1472594b5e09', body: { entries: [
    { date: DAY, meal: 'lunch', name: '待确认食物', portion: '1份', calories: '200.0', carbs: '0.0', protein: '18.5', fat: null, note: '' },
  ] } };
  const storage = new Map([['jiashu-nutrition-batch:test', JSON.stringify(original)]]);
  const f = fixture({ storage }); await f.ready(); f.click('resume-batch');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="carbs"]') as HTMLInputElement).value, '0.0');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const submitted = f.requests.find((request) => request.url.endsWith('/batch'))!;
  assert.equal(submitted.key, original.key); assert.deepEqual(submitted.body, original.body);

  const legacy = { key: original.key, body: { entries: [
    { date: DAY, meal: 'lunch', name: '旧版待确认食物', portion: '1份', calories: null, note: '' },
  ] } };
  const old = fixture({ storage: new Map([['jiashu-nutrition-batch:test', JSON.stringify(legacy)]]) });
  await old.ready(); old.click('resume-batch'); old.submit('batch-form');
  await settled(() => !old.el('batch-dialog').open);
  assert.deepEqual(old.requests.find((request) => request.url.endsWith('/batch'))!.body, legacy.body);
});

test('changing an AI serving clears its estimated macros, including when calories came from the catalog', async () => {
  const f = fixture({ drafts: [draft({ calories: '180.0', carbs: '38.4', protein: '5.0', fat: '2.0',
    calorieSource: 'catalog', macroSources: { carbs: 'catalog', protein: 'ai', fat: 'ai' },
    note: 'AI 营养估算：蛋白质、脂肪；1份；按普通烹饪估算。' })] });
  await f.ready(); await f.parse();
  assert.match(f.el('batch-rows').querySelector('[data-draft-preview]')?.textContent ?? '', /营养素含 AI 估算/);
  f.input(f.el('batch-rows').querySelector('[data-draft-field="portion"]')!, '半份');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="protein"]') as HTMLInputElement).value, '');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="fat"]') as HTMLInputElement).value, '');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="note"]') as HTMLInputElement).value, '');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="carbs"]') as HTMLInputElement).value, '38.4');
});

test('manual corrections keep their source after save and reopen while remaining AI grams expire on a serving change', async () => {
  const note = 'AI 估算：1份食物；按普通份量估算。碳水化合物、蛋白质、脂肪也为 AI 估算。热量已手动调整。蛋白质已手动调整。';
  const f = fixture({ entries: [entry({ calories: '380.0', carbs: '54.2', protein: '20.0', fat: '15.0', note })] });
  await f.ready(); f.click(f.el('list').querySelector('[data-nutrition-action="edit"]')!);
  f.input('portion', '半份');
  assert.equal(f.el('calories').value, '380.0'); assert.equal(f.el('protein').value, '20.0');
  assert.equal(f.el('carbs').value, ''); assert.equal(f.el('fat').value, ''); assert.equal(f.el('note').value, '');
});

test('copied, recent and favorite foods keep gram values when reopened as editable records', async () => {
  const macros = { carbs: '32.0', protein: '6.5', fat: '0.0' };
  const copied = fixture({ yesterdayEntries: [entry({ date: '2026-11-10', ...macros })] });
  await copied.ready(); copied.click(copied.el('list').querySelector('[data-nutrition-copy-meal="lunch"]')!);
  await settled(() => copied.el('batch-dialog').open);
  assert.equal((copied.el('batch-rows').querySelector('[data-draft-field="carbs"]') as HTMLInputElement).value, '32.0');
  copied.submit('batch-form'); await settled(() => !copied.el('batch-dialog').open);
  const body = copied.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0];
  assert.equal(body.carbs, '32.0'); assert.equal(body.protein, '6.5'); assert.equal(body.fat, '0.0');

  const reused = fixture({ entries: [entry(macros)] }); await reused.ready();
  reused.click(reused.el('quick-list').querySelector('[data-recent-add]')!);
  assert.equal(reused.el('carbs').value, '32.0'); assert.equal(reused.el('protein').value, '6.5');
  reused.click('dialog-close'); reused.click(reused.el('list').querySelector('[data-nutrition-action="favorite"]')!);
  await settled(() => !!reused.el('quick-list').querySelector('[data-favorite-add]'));
  reused.click(reused.el('quick-list').querySelector('[data-favorite-add]')!);
  assert.equal(reused.el('fat').value, '0.0'); assert.equal(reused.el('protein').value, '6.5');
});

test('changing estimated servings clears stale calories; catalog replacements calculate from the selected food', async () => {
  const estimate = draft({ name: '肉包子', portion: '2个中等肉包子', calories: '420.0', calorieSource: 'ai',
    amount: 2, unit: '个', note: 'AI 估算：2个中等肉包子；按常见份量估算。', candidates: [food] });
  const f = fixture({ drafts: [estimate] }); await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="portion"]')!, '1个小肉包子');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement).value, '');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="note"]') as HTMLInputElement).value, '');
  assert.match(f.el('batch-rows').querySelector('[data-draft-preview]')?.textContent ?? '', /重新填写/);
  f.input(f.el('batch-rows').querySelector('[data-draft-field="calories"]')!, '160');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  assert.equal(f.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0].calories, '160.0');

  const catalog = fixture({ drafts: [estimate] }); await catalog.ready(); await catalog.parse();
  catalog.input(catalog.el('batch-rows').querySelector('[data-draft-field="candidate"]')!, food.id, 'change');
  catalog.input(catalog.el('batch-rows').querySelector('[data-draft-field="amount"]')!, '150');
  catalog.submit('batch-form'); await settled(() => !catalog.el('batch-dialog').open);
  const saved = catalog.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0];
  assert.equal(saved.calories, '180.0'); assert.equal(saved.note, ''); assert.equal(saved.food.id, food.id);
});

test('manually correcting an AI calorie clears its automatic attribution without discarding other notes', async () => {
  const f = fixture({ drafts: [draft({ calories: '420.0', calorieSource: 'ai', note: 'AI 估算：按常见份量估算。' })] });
  await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="note"]')!, 'AI 估算：按常见份量估算。\n包装已核对');
  f.input(f.el('batch-rows').querySelector('[data-draft-field="calories"]')!, '380');
  assert.match(f.el('batch-rows').querySelector('[data-draft-preview]')?.textContent ?? '', /手动填写/);
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const saved = f.requests.find((request) => request.url.endsWith('/batch'))!.body.entries[0];
  assert.equal(saved.calories, '380.0'); assert.equal(saved.note, '包装已核对');
});

test('an uncertain batch freezes edits and repeats the same key and body after a bad JSON confirmation', async () => {
  const f = fixture(); await f.ready(); await f.parse();
  f.nextBatch(async () => new Response('not JSON', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden && !f.el('batch-save').disabled);
  assert.match(f.el('batch-status').textContent ?? '', /原内容已固定/);
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="name"]') as HTMLInputElement).disabled, true);
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const posts = f.requests.filter((request) => request.url.endsWith('/batch'));
  assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key); assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(f.storage.size, 0);
});

test('storage failures stop a batch before network submission', async () => {
  const f = fixture({ storageFails: true }); await f.ready(); await f.parse(); f.submit('batch-form');
  await settled(() => !f.el('batch-error').hidden);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  assert.match(f.el('batch-error').textContent ?? '', /storage unavailable/);
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="name"]') as HTMLInputElement).disabled, false);
});

test('copying yesterday opens a reviewable batch dated today, and favorite actions remain explicit', async () => {
  const f = fixture({ entries: [entry()], yesterdayEntries: [entry({ date: '2026-11-10', name: '昨天的午餐' })] });
  await f.ready(); f.click(f.el('list').querySelector('[data-nutrition-copy-meal="lunch"]')!);
  await settled(() => f.el('batch-dialog').open);
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="date"]') as HTMLInputElement).value, DAY);
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="name"]') as HTMLInputElement).value, '昨天的午餐');
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  f.click(f.el('batch-dialog').querySelector('[data-nutrition-batch-close]')!);
  f.click(f.el('list').querySelector('[data-nutrition-action="favorite"]')!);
  await settled(() => f.favorites.length === 1 && !!f.el('quick-list').querySelector('[data-favorite-add]'));
  assert.equal(f.requests.filter((request) => request.url.endsWith('/reuse') && request.method === 'POST').length, 1);
});

test('day completeness requires a status for all main meals, while skipped meals are explicit mutations', async () => {
  const f = fixture(); await f.ready(); f.click('day-complete');
  assert.match(f.el('status-text').textContent ?? '', /早餐、午餐和晚餐/);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/status')).length, 0);
  f.click(f.el('list').querySelector('[data-nutrition-skip-meal="breakfast"]')!);
  await settled(() => f.requests.some((request) => request.url.endsWith('/status')) && !f.el('day-complete').disabled);
  const request = f.requests.find((request) => request.url.endsWith('/status'))!;
  assert.equal(request.method, 'PATCH'); assert.equal(request.body.meals.breakfast, 'skipped');
  assert.equal(request.body.complete, false); assert.equal(request.body.expectedRevision, 0);
  assert.match(f.el('list').textContent ?? '', /这餐未进食/);
});

test('matched AI drafts retain their food IDs and recalculate editable quantities before batch save', async () => {
  const f = fixture({ drafts: [draft({ name: food.name, portion: '150 g', calories: '180.0',
    food: { id: food.id, amount: 150, unit: 'g' }, candidates: [food] })] });
  await f.ready(); await f.parse();
  const amount = f.el('batch-rows').querySelector('[data-draft-field="amount"]')!;
  assert.ok(amount, 'Matched food should display an editable source-backed quantity');
  f.input(amount, '200');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement).value, '240.0');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const post = f.requests.find((request) => request.url.endsWith('/batch'))!;
  assert.deepEqual(post.body.entries[0].food, { id: food.id, amount: 200, unit: 'g' });
  assert.equal(post.body.entries[0].calories, '240.0');
});

test('network failure preserves the batch operation across closing and reopening its dialog', async () => {
  const f = fixture(); await f.ready(); await f.parse();
  f.nextBatch(async () => { throw new TypeError('Synthetic lost connection'); });
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden && !f.el('batch-save').disabled);
  f.click(f.el('batch-dialog').querySelector('[data-nutrition-batch-close]')!);
  assert.equal(f.el('batch-dialog').open, false); assert.equal(f.el('resume-batch').hidden, false);
  f.click('resume-batch'); assert.equal(f.el('batch-dialog').open, true);
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const posts = f.requests.filter((request) => request.url.endsWith('/batch'));
  assert.equal(posts.length, 2); assert.equal(posts[0].key, posts[1].key); assert.deepEqual(posts[0].body, posts[1].body);
});

test('unsaved AI drafts remain available after closing and can be explicitly discarded', async () => {
  const f = fixture(); await f.ready(); await f.parse();
  f.click(f.el('batch-dialog').querySelector('[data-nutrition-batch-close]')!);
  assert.equal(f.el('ai-parse').disabled, true);
  f.click('resume-batch');
  assert.equal(f.el('batch-rows').querySelectorAll('[data-draft-index]').length, 1);
  f.click('batch-discard');
  assert.equal(f.el('batch-dialog').open, false);
  assert.equal(f.el('resume-batch').hidden, true); assert.equal(f.el('ai-parse').disabled, false);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
});

test('changing a matched candidate preserves the user-edited gram amount and recalculates using the new food', async () => {
  const alternative = { ...food, id: 'synthetic-second-rice', name: '另一种测试熟饭', kcalPer100g: 200 };
  const f = fixture({ drafts: [draft({ name: food.name, portion: '150 g', calories: '180.0',
    food: { id: food.id, amount: 150, unit: 'g' }, candidates: [food, alternative] })] });
  await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="amount"]')!, '200');
  f.input(f.el('batch-rows').querySelector('[data-draft-field="candidate"]')!, alternative.id, 'change');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="amount"]') as HTMLInputElement).value, '200');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement).value, '400.0');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const post = f.requests.find((request) => request.url.endsWith('/batch'))!;
  assert.deepEqual(post.body.entries[0].food, { id: alternative.id, amount: 200, unit: 'g' });
});

test('selecting a candidate for an unmatched AI draft retains an explicitly recognized gram quantity', async () => {
  const f = fixture({ drafts: [draft({ name: '测试饭', amount: 150, unit: 'g', portion: '150克', food: null, candidates: [food] })] });
  await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="candidate"]')!, food.id, 'change');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="amount"]') as HTMLInputElement).value, '150');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement).value, '180.0');
  f.submit('batch-form'); await settled(() => !f.el('batch-dialog').open);
  const post = f.requests.find((request) => request.url.endsWith('/batch'))!;
  assert.deepEqual(post.body.entries[0].food, { id: food.id, amount: 150, unit: 'g' });
});

test('count quantities without a food-specific unit weight require grams instead of silently assuming 100g', async () => {
  const f = fixture({ drafts: [draft({ name: '两个测试食物', amount: 2, unit: '个', portion: '2个', food: null, candidates: [food] })] });
  await f.ready(); await f.parse();
  f.input(f.el('batch-rows').querySelector('[data-draft-field="candidate"]')!, food.id, 'change');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="amount"]') as HTMLInputElement).value, '');
  assert.equal((f.el('batch-rows').querySelector('[data-draft-field="calories"]') as HTMLInputElement).value, '');
  assert.match(f.el('batch-rows').textContent ?? '', /实际克重/);
  f.submit('batch-form'); await settled(() => !f.el('batch-error').hidden);
  assert.match(f.el('batch-error').textContent ?? '', /份量/);
  assert.equal(f.requests.filter((request) => request.url.endsWith('/batch')).length, 0);
  assert.equal(f.el('batch-dialog').open, true);
});
