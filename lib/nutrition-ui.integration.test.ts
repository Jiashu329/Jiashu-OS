import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderNutritionPage } from '../nutrition-page.ts';
import { renderNutritionScript } from './nutrition-ui.ts';

const DAY = '2026-11-11';
const NOW = Date.parse(DAY + 'T04:00:00Z');
const ID = 'ad0c5a3c-6105-4b6b-b065-1472594b5e03';
const food = { id: 'synthetic-rice', name: '测试熟米饭', aliases: ['测试饭'], category: '谷物', state: '熟', kcalPer100g: 120,
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
function fixture(options: { entries?: Array<Record<string, any>>; storageFails?: boolean; drafts?: Array<Record<string, any>>; yesterdayEntries?: Array<Record<string, any>> } = {}) {
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
  const storage = new Map<string, string>();
  const requests: RequestLog[] = [];
  const entries = [...(options.entries ?? [])];
  const favorites: Array<Record<string, any>> = [];
  let nextBatch: (() => Promise<Response>) | undefined;
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
    if (parsed.pathname.endsWith('/review')) return Response.json({ range: { from: '2026-11-05', to: DAY, days: Number(parsed.searchParams.get('days')) || 7 },
      days: [{ date: DAY, knownCalories: null, entryCount: 0, knownCount: 0, unknownCount: 0, complete: false, meals: emptyMealStates() }],
      summary: { recordedDays: 0, completeDays: 0, comparableDays: 0, knownCalories: null, averageCompleteKcal: null, unknownCount: 0 }, meals: Object.entries(meals).map(([meal, label]) => ({ meal, label, knownCalories: null, entryCount: 0 })), limitations: ['未记录不表示未进食。'] });
    if (parsed.pathname === '/api/health/nutrition' && method === 'POST') { const created = entry(body); entries.push(created); return Response.json({ entry: created, replayed: false }); }
    if (parsed.pathname === '/api/health/nutrition') return Response.json(baseData(parsed.searchParams.get('date') || DAY));
    throw new Error('Unexpected request: ' + method + ' ' + url);
  };
  const location = { pathname: '/health/nutrition', search: '?date=' + DAY, origin: 'https://synthetic-nutrition.example' };
  const history = { replaceState(_state: unknown, _title: string, path: string) { const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; } };
  const sessionStorage = { getItem(key: string) { return storage.get(key) ?? null; }, setItem(key: string, value: string) { if (options.storageFails) throw new Error('Synthetic storage unavailable'); storage.set(key, value); }, removeItem(key: string) { storage.delete(key); } };
  const source = renderNutritionScript('test').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  runInNewContext(source, { window, document, Element: window.Element, Event: window.Event, fetch, location, history, sessionStorage, Date: FixedDate, Intl, URL, URLSearchParams, Headers, AbortController, crypto: webcrypto, setTimeout, clearTimeout, queueMicrotask });
  const el = (id: string) => document.getElementById('nutrition-' + id)! as unknown as HTMLElement & { value: string; checked: boolean; disabled: boolean; open: boolean };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click', { button: 0 }));
  const input = (target: string | Element, value: string, kind = 'input') => { const node = typeof target === 'string' ? el(target) : target as unknown as typeof el extends (...args: any[]) => infer R ? R : never; (node as any).value = value; node.dispatchEvent(event(kind)); };
  const submit = (id: string) => el(id).dispatchEvent(event('submit'));
  return { window, document, requests, entries, favorites, storage, el, click, input, submit, event,
    nextBatch(handler: () => Promise<Response>) { nextBatch = handler; },
    async ready() { await settled(() => !el('content').hidden); await settled(() => el('review-status').textContent?.includes('已记录部分') === true); },
    async parse() { input('ai-text', '午餐吃了测试食物'); click('ai-parse'); await settled(() => el('batch-dialog').open); },
  };
}

test('opening nutrition only reads data, favorites and review, and unknown intake is shown as a gap', async () => {
  const f = fixture(); await f.ready();
  assert.ok(f.requests.every((request) => request.method === 'GET'));
  assert.ok(f.requests.every((request) => !request.url.includes('/parse')));
  assert.equal(f.el('dialog').open, false); assert.equal(f.el('batch-dialog').open, false);
  assert.match(f.el('review-chart').textContent ?? '', /—/);
  assert.equal(f.el('review-chart').querySelectorAll('.is-missing').length, 1);
  assert.match(f.el('review-summary').textContent ?? '', /暂无可比较日期/);
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
  assert.match(f.el('list').textContent ?? '', /已标记这餐未进食/);
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
