import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DOUBAN_PERSONAL_BULK_CONTENT, DOUBAN_PERSONAL_SCRIPT } from './douban-personal-ui.ts';

const movie = { profileId: 'mine', domain: 'screen', subjectId: '12345', kind: 'screen', title: '合成影视', updatedAt: '2026-11-14T08:00:00.000Z', local: { note: '', tags: [] as string[], hidden: false, revision: 0 } };
type Item = typeof movie;
type Result = { item?: Item; items?: Item[]; dataEpoch: number };
interface UI {
  detailHTML(item: Item): string;
  bindDetail(container: HTMLElement, item: Item): void;
  bindBulk(container: HTMLElement, items: Item[]): void;
  reset(): void;
  update(): void;
  isBusy(): boolean;
  isDirty(): boolean;
  confirm(action: () => void): boolean;
}

function fixture(item = structuredClone(movie)) {
  const { window, document } = parseHTML('<html><body><section id="library">' + DOUBAN_PERSONAL_BULK_CONTENT + '<ul id="items"></ul></section><dialog><div id="detail"></div></dialog></body></html>');
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', { configurable: true, get() { return this.hasAttribute('checked'); }, set(value: boolean) { if (value) this.setAttribute('checked', ''); else this.removeAttribute('checked'); } });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? ''; }, set(value: string) { for (const option of this.querySelectorAll('option')) if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } });
  let epoch = 3, changed = false, locked = false, afterSave: (() => void) | null = null;
  let onSavedHandler: () => Promise<void> = async () => {};
  const saved: Result[] = [], requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [], registrations: Array<Record<string, unknown>> = [];
  let handler: (body: Record<string, unknown>, method: string) => Promise<Result> = async body => ({ dataEpoch: epoch, item: { ...item, local: { note: body.note as string, tags: body.tags as string[], hidden: body.hidden as boolean, revision: item.local.revision + 1 } } });
  const options = {
    getDataEpoch: () => epoch, isAccountChanged: () => changed, isLocked: () => locked,
    async requestJSON(path: string, init: RequestInit) { const body = JSON.parse(String(init.body)); requests.push({ path, method: String(init.method), body }); return handler(body, String(init.method)); },
    async onSaved(result: Result) { saved.push(result); await onSavedHandler(); },
  };
  Object.assign(window, { JiashuDraftGuards: { register(value: Record<string, unknown>) { registrations.push(value); return { dispose() {}, saved() { const action = afterSave; afterSave = null; if (action) queueMicrotask(action); }, failed() { afterSave = null; }, reset() {}, confirm(action: () => void) { if ((value.isDirty as () => boolean)() || (value.isBusy as () => boolean)()) { afterSave = action; return false; } action(); return true; } }; } } });
  const ui = runInNewContext(DOUBAN_PERSONAL_SCRIPT + '\nwindow.JiashuDoubanPersonalUI.create(options);', { window, document, options }) as UI;
  const detail = document.getElementById('detail')!;
  detail.innerHTML = ui.detailHTML(item); ui.bindDetail(detail, item);
  const field = (selector: string) => detail.querySelector(selector)! as HTMLInputElement;
  function input(selector: string, value: string) { field(selector).value = value; field(selector).dispatchEvent(new window.Event('input', { bubbles: true })); }
  function submit() { detail.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  const library = document.getElementById('library')!;
  function bindRows(rows: Item[]) { document.getElementById('items')!.innerHTML = rows.map((row, index) => '<li>' + (row.domain === 'screen' ? '<label><input type="checkbox" data-douban-select="' + index + '">选择分类</label>' : '') + '</li>').join(''); ui.bindBulk(library, rows); }
  function change(selector: string, value: boolean | string) { const control = library.querySelector(selector)! as HTMLInputElement; if (typeof value === 'boolean') control.checked = value; else control.value = value; control.dispatchEvent(new window.Event('change', { bubbles: true })); }
  function click(selector: string) { library.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true })); }
  return { window, document, detail, library, field, input, submit, ui, requests, saved, registrations, bindRows, change, click, setEpoch(value: number) { epoch = value; }, setChanged(value: boolean) { changed = value; }, setLocked(value: boolean) { locked = value; ui.update(); }, setHandler(value: typeof handler) { handler = value; }, setOnSaved(value: typeof onSavedHandler) { onSavedHandler = value; } };
}
async function settle(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.ok(check()); }

void test('personal text renders inertly and saves separate fields with owner key, epoch and local revision', async () => {
  const item = { ...structuredClone(movie), local: { note: '</textarea><img src=x onerror=alert(1)>', tags: ['" autofocus onfocus="x'], hidden: true, revision: 7 } };
  const f = fixture(item);
  assert.equal(f.detail.querySelector('img'), null);
  assert.equal(f.field('[data-douban-note]').value, item.local.note);
  assert.equal(f.field('[data-douban-tags]').value, item.local.tags[0]);
  f.input('[data-douban-note]', '只在本站记录的感受'); f.input('[data-douban-tags]', '想重看，经典,想重看');
  f.field('[data-douban-hidden]').checked = false; f.submit();
  await settle(() => !f.ui.isBusy());
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/api/life/douban/library');
  assert.deepEqual(f.requests[0].body, { profileId: 'mine', domain: 'screen', subjectId: '12345', expectedDataEpoch: 3, expectedLocalRevision: 7, note: '只在本站记录的感受', tags: ['想重看', '经典'], hidden: false });
  assert.equal(f.requests[0].method, 'PUT');
  assert.equal(f.saved.length, 1); assert.equal(f.ui.isDirty(), false);
  assert.equal(f.field('[data-douban-tags]').value, '想重看，经典');
});

void test('invalid tags never reach the API and unsaved personal changes guard detail closure', () => {
  const f = fixture(); f.input('[data-douban-tags]', Array.from({ length: 13 }, (_, i) => '标签' + i).join(',')); f.submit();
  assert.equal(f.requests.length, 0); assert.match(f.detail.textContent, /最多填写 12 个标签/);
  let closed = false; assert.equal(f.ui.confirm(() => { closed = true; }), false); assert.equal(closed, false);
  f.input('[data-douban-tags]', '长'.repeat(31)); f.submit(); assert.equal(f.requests.length, 0);
  assert.match(f.detail.textContent, /30 个字符/);
});

void test('conflict preserves the draft and blocks accidental overwrite until a fresh detail is opened', async () => {
  const f = fixture(); f.setHandler(async () => { throw Object.assign(new Error('changed'), { status: 409 }); });
  f.input('[data-douban-note]', '不能丢失的草稿'); f.submit(); await settle(() => !f.ui.isBusy());
  assert.equal(f.field('[data-douban-note]').value, '不能丢失的草稿'); assert.equal(f.ui.isDirty(), true);
  assert.match(f.detail.textContent, /填写已保留/); f.submit(); assert.equal(f.requests.length, 1); assert.equal(f.saved.length, 0);
});

void test('a delayed save after reset or account change cannot refresh the old library', async () => {
  for (const reason of ['epoch', 'account'] as const) {
    const f = fixture(); let finish: ((value: Result) => void) | null = null;
    f.setHandler(() => new Promise(resolve => { finish = resolve; })); f.input('[data-douban-note]', '旧操作'); f.submit();
    if (reason === 'epoch') { f.setEpoch(4); f.ui.reset(); } else { f.setChanged(true); f.document.dispatchEvent(new f.window.Event('jiashu-account-changed')); }
    assert.ok(finish); (finish as (value: Result) => void)({ item: { ...movie, local: { ...movie.local, note: '旧操作', revision: 1 } }, dataEpoch: 3 });
    await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(f.saved.length, 0); assert.equal(f.ui.isBusy(), false);
  }
});

void test('batch classification selects only screen records and sends original record versions atomically', async () => {
  const f = fixture(), series = { ...structuredClone(movie), subjectId: '22222', kind: 'series', updatedAt: '2026-11-14T09:00:00.000Z' }, book = { ...structuredClone(movie), domain: 'book', subjectId: '33333', kind: 'book' };
  f.bindRows([movie, book, series]);
  f.setHandler(async body => ({ dataEpoch: 3, items: (body.items as Array<{ subjectId: string }>).map(entry => ({ ...(entry.subjectId === movie.subjectId ? movie : series), kind: body.kind as string })) }));
  f.change('[data-douban-select-all]', true); f.change('[data-douban-bulk-kind]', 'movie');
  assert.match(f.library.textContent, /已选 2 条/); f.click('[data-douban-bulk-save]'); await settle(() => !f.ui.isBusy());
  assert.deepEqual(f.requests[0].body, { action: 'classify', kind: 'movie', expectedDataEpoch: 3, items: [movie, series].map(item => ({ profileId: item.profileId, domain: 'screen', subjectId: item.subjectId, expectedUpdatedAt: item.updatedAt })) });
  assert.equal(f.requests[0].method, 'POST'); assert.equal(f.saved.length, 1); assert.match(f.library.textContent, /已选 0 条/);
});

void test('changing library pages clears the selection instead of applying a batch to different cards', () => {
  const f = fixture(); f.bindRows([movie]); f.change('[data-douban-select="0"]', true); f.change('[data-douban-bulk-kind]', 'series');
  f.bindRows([{ ...structuredClone(movie), subjectId: '98765' }]); f.click('[data-douban-bulk-save]');
  assert.equal(f.requests.length, 0); assert.match(f.library.textContent, /已选 0 条/);
});

void test('saving a guarded personal draft resumes the requested action after the library refresh unlocks', async () => {
  const f = fixture(); let finishRefresh: (() => void) | null = null, continued = 0;
  f.setOnSaved(() => new Promise(resolve => { finishRefresh = resolve; }));
  f.input('[data-douban-note]', '先保存再补全');
  assert.equal(f.ui.confirm(() => { if (!f.ui.isBusy()) continued++; }), false);
  // Selecting Save in the shared draft dialog submits the original form.
  f.submit(); await settle(() => f.saved.length === 1);
  assert.equal(f.ui.isBusy(), true); assert.equal(continued, 0);
  assert.ok(finishRefresh); (finishRefresh as () => void)();
  await settle(() => continued === 1);
  assert.equal(f.ui.isBusy(), false); assert.equal(f.ui.isDirty(), false);
});

void test('a failed guarded save keeps the draft and never starts the requested action', async () => {
  const f = fixture(); let continued = false;
  f.setHandler(async () => { throw new Error('网络暂时不可用'); });
  f.input('[data-douban-note]', '失败后保留');
  f.ui.confirm(() => { continued = true; }); f.submit();
  await settle(() => !f.ui.isBusy());
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(continued, false); assert.equal(f.ui.isDirty(), true);
  assert.equal(f.field('[data-douban-note]').value, '失败后保留');
});
