import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DOUBAN_COVER_SELECTION_SCRIPT, normalizePreviewCoverUrl } from './douban-cover-selection-ui.ts';

type Item = {
  profileId: string; domain: string; subjectId: string; coverUrl: string | null;
  local: { note: string; tags: string[]; hidden: boolean; revision: number };
  cover: { mode: 'original' | 'url'; revision: number; url?: string };
};
type Result = { item: Item; dataEpoch: number };
interface UI {
  detailHTML(item: Item): string;
  bindDetail(container: HTMLElement, item: Item): void;
  updateItem(item: Item): void;
  open(): void; update(): void; reset(): void;
  isBusy(): boolean; isDirty(): boolean; confirm(action: () => void): boolean;
}
const original: Item = { profileId: 'mine', domain: 'book', subjectId: '12345', coverUrl: 'https://img1.doubanio.com/view/subject/public/s123.jpg',
  local: { note: '我的独立备注', tags: ['经典'], hidden: false, revision: 4 }, cover: { mode: 'original', revision: 4 } };

function fixture(input = structuredClone(original)) {
  const { window, document } = parseHTML('<html><body><dialog><section id="detail"></section></dialog></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } });
  let epoch = 3, changed = false, locked = false, afterSave: (() => void) | null = null;
  let savedItem = input;
  let onSaved: () => Promise<void> = async () => {};
  let beforeSave: ((action: () => void) => void) | null = null;
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [], saved: Result[] = [], registrations: Array<Record<string, unknown>> = [];
  let handler: (body: Record<string, unknown>) => Promise<Result> = async body => {
    const revision = Number(body.expectedLocalRevision) + 1, url = body.mode === 'url' ? String(body.url) : undefined;
    savedItem = { ...savedItem, local: { ...savedItem.local, revision }, cover: { mode: body.mode as 'url' | 'original', revision, ...(url ? { url } : {}) } };
    return { item: savedItem, dataEpoch: epoch };
  };
  Object.assign(window, { JiashuDraftGuards: { register(entry: Record<string, unknown>) { registrations.push(entry); return {
    dispose() {}, reset() { afterSave = null; }, failed() { afterSave = null; },
    saved() { const action = afterSave; afterSave = null; if (action) queueMicrotask(action); },
    confirm(action: () => void) { if ((entry.isDirty as () => boolean)() || (entry.isBusy as () => boolean)()) { afterSave = action; return false; } action(); return true; },
  }; } } });
  const options = { getDataEpoch: () => epoch, isAccountChanged: () => changed, isLocked: () => locked,
    originalCoverURL: () => '/api/life/douban/cover?profileId=mine&domain=book&subjectId=12345',
    beforeSave(action: () => void) { if (beforeSave) beforeSave(action); else action(); },
    async requestJSON(path: string, init: RequestInit) { const body = JSON.parse(String(init.body)); requests.push({ path, method: String(init.method), body }); return handler(body); },
    async onSaved(result: Result) { saved.push(result); await onSaved(); },
  };
  const ui = runInNewContext(DOUBAN_COVER_SELECTION_SCRIPT + '\nwindow.JiashuDoubanCoverSelectionUI.create(options);', { window, document, options, URL }) as UI;
  const detail = document.getElementById('detail')!;
  detail.innerHTML = ui.detailHTML(input); ui.bindDetail(detail, input);
  const field = (selector: string) => detail.querySelector(selector)! as HTMLInputElement;
  function changeMode(value: string) { field('[data-douban-cover-mode]').value = value; field('[data-douban-cover-mode]').dispatchEvent(new window.Event('change', { bubbles: true })); }
  function inputUrl(value: string) { field('[data-douban-cover-url]').value = value; field('[data-douban-cover-url]').dispatchEvent(new window.Event('input', { bubbles: true })); }
  function click(selector: string) { field(selector).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); }
  function submit() { detail.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  function imageEvent(type: 'load' | 'error') { field('[data-douban-cover-preview-image]').dispatchEvent(new window.Event(type)); }
  function chooseUrl(url = 'https://covers.example.org/book.jpg') { changeMode('url'); inputUrl(url); click('[data-douban-cover-preview]'); imageEvent('load'); }
  return { window, document, detail, field, ui, requests, saved, registrations, changeMode, inputUrl, click, submit, imageEvent, chooseUrl,
    setHandler(value: typeof handler) { handler = value; }, setEpoch(value: number) { epoch = value; }, setChanged(value: boolean) { changed = value; },
    setLocked(value: boolean) { locked = value; ui.update(); }, setOnSaved(value: typeof onSaved) { onSaved = value; }, setBeforeSave(value: typeof beforeSave) { beforeSave = value; } };
}
async function settle(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.ok(check()); }

void test('preview URLs reject credentials, local addresses, uploads and oversized canonical paths', () => {
  assert.equal(normalizePreviewCoverUrl('https://COVERS.example.org:443/a.jpg#part'), 'https://covers.example.org/a.jpg');
  for (const value of ['http://example.org/a.jpg', 'https://user:password@example.org/a.jpg', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://images.local/a', 'https://home.internal/a', 'https://example.org:8443/a', 'data:image/jpeg;base64,a', 'https://example.org/\\a', 'https://example.org/' + '中'.repeat(300)]) assert.throws(() => normalizePreviewCoverUrl(value), /HTTPS/);
});

void test('the optional link is explained as a fallback after Douban and TMDB, and original mode removes that fallback', () => {
  const f = fixture();
  assert.match(f.detail.textContent, /封面依次尝试豆瓣、TMDB、自定义图片链接/);
  assert.match(f.detail.textContent, /备用链接可选填，仅在豆瓣和 TMDB 封面都不可用时使用/);
  assert.equal(f.detail.querySelector('option[value="original"]')?.textContent, '自动封面（无备用链接）');
  assert.equal(f.detail.querySelector('option[value="url"]')?.textContent, '填写备用图片链接');
  assert.equal(f.field('[data-douban-cover-original]').textContent, '移除备用链接');
  assert.equal(f.field('[data-douban-cover-mode]').value, 'original');
  assert.equal(f.field('[data-douban-cover-original]').disabled, true);
  assert.doesNotMatch(f.detail.textContent, /手选封面|恢复豆瓣|Token/);
});

void test('opening and typing remain local; explicit current-image success is required before saving the owner-scoped selection', async () => {
  const f = fixture(); f.ui.open(); f.changeMode('url'); f.inputUrl('https://covers.example.org/book.jpg#preview');
  assert.equal(f.field('[data-douban-cover-preview-image]').hasAttribute('src'), false); assert.equal(f.requests.length, 0);
  assert.equal(f.field('[data-douban-cover-save]').disabled, true); f.submit(); assert.equal(f.requests.length, 0);
  f.click('[data-douban-cover-preview]'); const image = f.field('[data-douban-cover-preview-image]');
  assert.equal(image.getAttribute('src'), 'https://covers.example.org/book.jpg'); assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(f.field('[data-douban-cover-save]').disabled, true); f.imageEvent('load');
  assert.match(f.field('[data-douban-cover-preview-status]').textContent ?? '', /保存后仅在豆瓣和 TMDB 封面都不可用时显示/);
  assert.equal(f.field('[data-douban-cover-save]').disabled, false); f.submit(); await settle(() => !f.ui.isBusy());
  assert.deepEqual(f.requests, [{ path: '/api/life/douban/cover-selection', method: 'PUT', body: { profileId: 'mine', domain: 'book', subjectId: '12345', expectedDataEpoch: 3, expectedLocalRevision: 4, mode: 'url', url: 'https://covers.example.org/book.jpg' } }]);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].item.local.note, '我的独立备注'); assert.equal(f.ui.isDirty(), false);
  assert.equal(f.detail.querySelector('input[type="file"]'), null); assert.equal(f.detail.textContent.includes('上传'), false);
});

void test('failed or obsolete previews preserve the link and cannot unlock a changed draft', () => {
  const f = fixture(); f.changeMode('url'); f.inputUrl('https://covers.example.org/first.jpg'); f.click('[data-douban-cover-preview]');
  const oldLoad = (f.field('[data-douban-cover-preview-image]') as unknown as { onload: () => void }).onload;
  f.inputUrl('https://covers.example.org/second.jpg'); oldLoad();
  assert.equal(f.field('[data-douban-cover-save]').disabled, true); assert.equal(f.field('[data-douban-cover-preview-image]').hasAttribute('src'), false);
  f.click('[data-douban-cover-preview]'); f.imageEvent('error'); f.submit();
  assert.equal(f.requests.length, 0); assert.equal(f.field('[data-douban-cover-url]').value, 'https://covers.example.org/second.jpg');
  assert.match(f.field('[data-douban-cover-preview-status]').textContent ?? '', /更换可访问.*移除备用链接/);
  f.inputUrl('https://localhost/private'); f.click('[data-douban-cover-preview]'); assert.equal(f.field('[data-douban-cover-preview-image]').hasAttribute('src'), false);
});

void test('removing the fallback is an explicit save with no URL and note updates can advance the shared revision without losing a cover draft', async () => {
  const item: Item = { ...structuredClone(original), cover: { mode: 'url', url: 'https://covers.example.org/saved.jpg', revision: 4 } };
  const f = fixture(item); f.chooseUrl('https://covers.example.org/new.jpg');
  f.ui.updateItem({ ...item, local: { ...item.local, note: '新备注', revision: 9 }, cover: { ...item.cover, revision: 9 } });
  assert.equal(f.field('[data-douban-cover-url]').value, 'https://covers.example.org/new.jpg'); assert.equal(f.ui.isDirty(), true);
  f.submit(); await settle(() => !f.ui.isBusy()); assert.equal(f.requests[0].body.expectedLocalRevision, 9);
  f.click('[data-douban-cover-original]'); assert.equal(f.requests.length, 1); assert.equal(f.field('[data-douban-cover-save]').disabled, false);
  assert.match(f.field('[data-douban-cover-status]').textContent ?? '', /已选择移除备用链接/);
  f.submit(); await settle(() => !f.ui.isBusy()); assert.deepEqual(f.requests[1].body, { profileId: 'mine', domain: 'book', subjectId: '12345', expectedDataEpoch: 3, expectedLocalRevision: 10, mode: 'original' });
  assert.match(f.field('[data-douban-cover-status]').textContent ?? '', /备用链接已移除，将自动尝试豆瓣和 TMDB 封面/); assert.equal(f.ui.isDirty(), false);
});

void test('revision conflicts keep the draft and require a fresh record instead of overwriting a concurrent cover', async () => {
  const f = fixture(); f.chooseUrl(); f.setHandler(async () => { throw Object.assign(new Error('conflict'), { status: 409 }); });
  f.submit(); await settle(() => !f.ui.isBusy()); assert.equal(f.ui.isDirty(), true); assert.equal(f.field('[data-douban-cover-url]').value, 'https://covers.example.org/book.jpg');
  assert.match(f.field('[data-douban-cover-status]').textContent ?? '', /填写已保留/); assert.equal(f.field('[data-douban-cover-save]').disabled, true);
  f.submit(); assert.equal(f.requests.length, 1);
});

void test('late saves after account or epoch changes cannot refresh the library or resume a guarded action', async () => {
  for (const change of ['account', 'epoch']) {
    const f = fixture(); f.chooseUrl(); let finish!: (value: Result) => void;
    f.setHandler(() => new Promise(resolve => { finish = resolve; })); f.submit(); await settle(() => Boolean(finish));
    if (change === 'account') { f.setChanged(true); f.document.dispatchEvent(new f.window.Event('jiashu-account-changed')); } else f.setEpoch(4);
    finish({ item: { ...original, local: { ...original.local, revision: 5 }, cover: { mode: 'url', revision: 5, url: 'https://covers.example.org/book.jpg' } }, dataEpoch: 3 });
    await settle(() => !f.ui.isBusy()); assert.equal(f.saved.length, 0);
  }
});

void test('other drafts are confirmed before writing and saved continuation runs only after refresh and unlocking', async () => {
  const f = fixture(); f.chooseUrl(); let permitted!: () => void, refresh!: () => void, continued = 0;
  f.setBeforeSave(action => { permitted = action; }); f.setOnSaved(() => new Promise(resolve => { refresh = resolve; }));
  assert.equal(f.ui.confirm(() => { assert.equal(f.ui.isBusy(), false); continued++; }), false);
  f.submit(); assert.equal(f.requests.length, 0); permitted(); await settle(() => Boolean(refresh));
  assert.equal(f.ui.isBusy(), true); assert.equal(continued, 0); refresh(); await settle(() => continued === 1);
  assert.equal(f.ui.isDirty(), false); assert.equal(f.ui.isBusy(), false);
});
