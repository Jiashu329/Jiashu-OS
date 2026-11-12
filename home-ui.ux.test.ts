import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHomeApp } from './home-ui.ts';

const metricKeys = ['steps', 'sleep', 'active_energy', 'weight', 'lean_body_mass', 'body_fat'];
const snapshot = () => ({
  asOf: '2026-11-11T12:00:00Z', today: '2026-11-11',
  health: { status: 'ready', lastSync: '2026-11-11T11:00:00Z', recordedMetricCount: 6,
    metrics: metricKeys.map((metric) => ({ metric, value: 0, day: '2026-11-11', freshness: 'current', points: [{ day: '2026-11-11', value: 0 }], average7: 0, observedDays7: 1 })) },
  finance: Object.fromEntries(['personal', 'family'].map((ledger) => [ledger, { status: 'ready', accountCount: 0, currencies: [], oldestBalanceDate: null, latestBalanceDate: null, staleAccountCount: 0 }])),
  priorities: [{ id: 'synthetic-priority', tone: 'attention', title: '核对最近记录', detail: '这是合成测试事项。', href: '/health', actionLabel: '查看记录' }],
});

async function fixture(data = snapshot(), drafts?: {ready:()=>Promise<string|null>;list:()=>Array<{id:string;label:string;url:string;kind:string}>;problem?:string}) {
  const { document, window } = parseHTML(renderHomeApp());
  if(drafts)Object.assign(window,{JiashuDrafts:drafts});
  const script = [...document.querySelectorAll('script[type="module"]')].find((node) => node.textContent?.includes('const metricLabels='))!.textContent!;
  runInNewContext(script, { document, window, Event: window.Event, fetch: async () => Response.json(data), AbortController, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  for (let index = 0; index < 25 && document.getElementById('refresh')!.hasAttribute('disabled'); index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(document.getElementById('refresh')!.hasAttribute('disabled'), false);
  return { document, window };
}

test('all home metric cards deep-link to the same metric and a useful persisted range', async () => {
  const { document } = await fixture();
  for (const metric of metricKeys) {
    const card = document.querySelector('.metric-card.' + metric)!;
    const url = new URL(card.getAttribute('href')!, 'https://synthetic-home.example');
    assert.equal(url.pathname, '/health');
    assert.equal(url.searchParams.get('metric'), metric);
    assert.equal(url.searchParams.get('days'), ['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? '90' : '30');
    assert.match(card.querySelector('.metric-value strong')!.textContent!, /^0$/);
    assert.match(card.querySelector('.metric-date')!.textContent!, /2026-11-11/);
  }
});

test('home keeps priorities ahead of the overview while goals are progressively disclosed and independently available', async () => {
  const { document } = await fixture();
  assert.equal(document.querySelector('main h1')!.textContent, '今日总览');
  const mainChildren = [...document.querySelector('main')!.children];
  assert.ok(mainChildren.indexOf(document.getElementById('focus-section')!) < mainChildren.indexOf(document.getElementById('overview-content')!));
  const disclosure = document.getElementById('home-goals-disclosure')!;
  assert.equal(disclosure.hasAttribute('open'), false);
  assert.ok(disclosure.querySelector('[data-goal-open]'));
  assert.ok(disclosure.querySelector('a[href="/health#goals"]'));
  assert.equal(document.getElementById('overview-content')!.contains(disclosure), false);
});

test('a failed overview does not remove the separate goals entry or misrepresent missing health values as zero', async () => {
  const data = snapshot();
  data.health.status = 'unavailable';
  data.finance.personal.status = 'unavailable'; data.finance.family.status = 'unavailable';
  const { document } = await fixture(data);
  assert.equal(document.getElementById('overview-content')!.hasAttribute('hidden'), true);
  assert.equal(document.getElementById('home-goals-disclosure')!.hasAttribute('hidden'), false);
  assert.match(document.getElementById('status-title')!.textContent!, /读取失败/);
  assert.match(document.querySelector('.metric-card.sleep .metric-value')!.textContent!, /暂时无法读取/);
});

test('recording food is one direct home-header action and remains available when overview data fails', async () => {
  const data = snapshot(); data.health.status = 'unavailable';
  const { document } = await fixture(data);
  const action = document.querySelector('main .heading .home-nutrition-action')!;
  assert.ok(action, 'The recording action should be in the home header');
  assert.equal(action.textContent, '记饮食');
  const target = new URL(action.getAttribute('href')!, 'https://synthetic-home.example');
  assert.equal(target.pathname, '/health/nutrition');
  assert.equal(target.searchParams.get('compose'), '1');
  assert.equal(action.closest('[hidden],details'), null);
  assert.equal(document.getElementById('overview-content')!.contains(action), false);
});

test('today hub shows partial nutrient values and targets without turning unknown grams into zero',async()=>{
  const data={...snapshot(),nutrition:{status:'ready',entryCount:1,complete:false,
    nutrients:{calories:{total:'120.0',knownCount:1,unknownCount:0},carbs:{total:'0.0',knownCount:1,unknownCount:0},
      protein:{total:'12.3',knownCount:1,unknownCount:0},fat:{total:null,knownCount:0,unknownCount:1}},
    targets:{calories:'1800.0',carbs:null,protein:'80.0',fat:'60.0'},meals:{breakfast:'skipped',lunch:'recorded',dinner:'unrecorded',snack:'unrecorded'}}};
  const {document}=await fixture(data);
  assert.match(document.getElementById('home-nutrition-nutrients')!.textContent!,/12\.3.*80\.0/);
  assert.match(document.getElementById('home-nutrition-nutrients')!.textContent!,/0\.0/);
  const fat=[...document.querySelectorAll('.home-nutrient')].find((node)=>node.querySelector('h3')?.textContent==='脂肪')!;
  assert.equal(fat.querySelector('strong')?.textContent,'—');assert.match(fat.textContent!,/1 项待补充/);
  assert.match(document.getElementById('home-nutrition-meals')!.textContent!,/早餐 未进食.*午餐 已记录/);
  assert.equal(document.querySelector('.home-weight-action')?.getAttribute('href'),'/health/records?metric=weight&compose=1');
});

test('an unavailable diet is independent of available health and local pending work only offers explicit continuation',async()=>{
  const data={...snapshot(),nutrition:{status:'unavailable'}};
  const rows=[{id:'pending',label:'原财务提交',url:'/finance?ledger=personal',kind:'pending'},
    {id:'draft',label:'<img src=x>尚未保存的饮食',url:'/health/nutrition?compose=1',kind:'draft'},
    {id:'unsafe',label:'外部页面',url:'https://elsewhere.example',kind:'pending'}];
  let ownerReads=0;const {document,window}=await fixture(data,{ready:async()=>{ownerReads++;return 'synthetic-owner';},list:()=>rows});
  assert.equal(document.getElementById('overview-content')!.hasAttribute('hidden'),false);
  assert.match(document.getElementById('home-nutrition-status')!.textContent!,/暂时无法读取/);
  assert.equal(document.getElementById('home-work-inbox')!.hasAttribute('hidden'),false);
  assert.equal(document.querySelectorAll('#home-work-items li').length,2);
  assert.equal(document.querySelectorAll('#home-work-items img, #home-work-items button').length,0);
  assert.match(document.getElementById('home-work-items')!.textContent!,/继续核对.*继续填写/);
  document.dispatchEvent(new window.Event('jiashu-work-changed'));assert.equal(ownerReads,1);
});

test('a failed owner lookup visibly explains why local work cannot be read without exposing drafts',async()=>{
  let localReads=0,ownerReads=0;
  const problem='请登录后再恢复本机草稿；当前填写不会自动提交。';
  const {document}=await fixture(snapshot(),{ready:async()=>{ownerReads++;return null;},list:()=>{localReads++;return [];},problem});
  assert.equal(document.getElementById('home-work-inbox')!.hasAttribute('hidden'),false);
  assert.equal(document.getElementById('home-work-status')!.textContent,problem);
  assert.equal(document.querySelectorAll('#home-work-items li').length,0);
  assert.equal(localReads,0);assert.equal(ownerReads,1);
  assert.equal(document.getElementById('overview-content')!.hasAttribute('hidden'),false);
});

test('an unreadable local store remains visible and clears its warning only after the manager recovers',async()=>{
  let ownerReads=0,unreadable=true;
  const manager={problem:'',ready:async()=>{ownerReads++;return 'synthetic-owner';},list:()=>{
    manager.problem=unreadable?'本地草稿暂时无法读取，当前填写仍会保留。':'';
    return unreadable?[]:[{id:'recovered',label:'待核对的食物',url:'/health/nutrition?resumeDraft=recovered',kind:'draft'}];
  }};
  const {document,window}=await fixture(snapshot(),manager);
  assert.equal(document.getElementById('home-work-inbox')!.hasAttribute('hidden'),false);
  assert.match(document.getElementById('home-work-status')!.textContent!,/暂时无法读取/);
  assert.equal(document.querySelectorAll('#home-work-items li').length,0);
  unreadable=false;document.dispatchEvent(new window.Event('jiashu-work-changed'));
  assert.equal(document.getElementById('home-work-inbox')!.hasAttribute('hidden'),false);
  assert.equal(document.getElementById('home-work-status')!.textContent,'只保存在当前浏览器，继续前可核对原内容。');
  assert.equal(document.querySelectorAll('#home-work-items li').length,1);
  assert.equal(ownerReads,1);
});
