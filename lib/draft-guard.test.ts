import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { DRAFT_GUARD_SCRIPT } from './draft-guard.ts';

interface Guard { reset(): void; saved(): void; failed(): void; close(): boolean; readonly dirty: boolean }
function fixture() {
  const { window, document } = parseHTML('<!doctype html><html><head></head><body><a href="/next" id="next">下一页</a><dialog id="edit"><form id="form"><input id="value" name="value" value="原值"><button type="submit">保存</button></form></dialog></body></html>');
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(proto, 'open', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('open'); } });
  proto.showModal = function(this: HTMLElement) { this.setAttribute('open', ''); };
  proto.close = function(this: HTMLElement) { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  proto.getBoundingClientRect = () => ({ left: 10, top: 10, right: 400, bottom: 400 });
  const location = new URL('https://draft.example/edit'); const navigated: string[] = [];
  Object.assign(location, { assign(url: string) { navigated.push(url); location.href = url; } });
  const history = { state: { marker: 'original' }, replaceState(state: { marker: string }, _title: string, url: string) { history.state = state; location.href = url; } };
  runInNewContext(DRAFT_GUARD_SCRIPT, { window, document, location, history, URL, queueMicrotask });
  const dialog = document.getElementById('edit')! as HTMLElement & { open: boolean; showModal(): void; close(): void };
  const form = document.getElementById('form')! as HTMLFormElement;
  form.requestSubmit = () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  const input = document.getElementById('value')! as HTMLInputElement;
  let blocked = false; let busy = false; let discarded = 0;
  const service = (window as unknown as { JiashuDraftGuards: { register(options: object): Guard } }).JiashuDraftGuards;
  const guard = service.register({ form, dialog, label: '合成编辑', isBusy: () => busy, isBlocked: () => blocked, onDiscard: () => { discarded++; } });
  dialog.showModal(); guard.reset();
  const event = (name: string, target: Element | typeof window = input, data: object = {}) => { const e = new window.Event(name, { bubbles: true, cancelable: true }); Object.assign(e, data); target.dispatchEvent(e); return e; };
  const edit = (value: string) => { input.value = value; event('input'); };
  const choice = (name: string) => event('click', document.querySelector('[data-draft-choice="' + name + '"]')!, { button: 0 });
  const sheetOpen = () => document.getElementById('draft-guard-dialog')?.hasAttribute('open') === true;
  return { window, document, dialog, form, input, guard, event, edit, choice, sheetOpen, location, history, navigated, block(value: boolean) { blocked = value; }, busy(value: boolean) { busy = value; }, service, get discarded() { return discarded; } };
}

test('unchanged or reverted values close directly without a draft prompt', () => {
  const f = fixture(); assert.equal(f.guard.dirty, false); f.guard.close();
  assert.equal(f.dialog.open, false); assert.equal(f.sheetOpen(), false);
  f.dialog.showModal(); f.edit('改过'); f.edit('原值'); assert.equal(f.guard.dirty, false); f.guard.close(); assert.equal(f.dialog.open, false);
});

test('close, Escape and backdrop protect edited fields while continue keeps the draft', () => {
  const f = fixture(); f.edit('尚未保存'); f.guard.close();
  assert.equal(f.dialog.open, true); assert.equal(f.sheetOpen(), true); f.choice('continue');
  assert.equal(f.input.value, '尚未保存'); assert.equal(f.sheetOpen(), false);
  const cancel = f.event('cancel', f.dialog); assert.equal(cancel.defaultPrevented, true); assert.equal(f.sheetOpen(), true); f.choice('continue');
  f.event('click', f.dialog, { clientX: 0, clientY: 0, button: 0 }); assert.equal(f.sheetOpen(), true);
  f.choice('discard'); assert.equal(f.dialog.open, false); assert.equal(f.discarded, 1);
});

test('save uses the original submit path; failure retains fields and success clears the guard', async () => {
  const f = fixture(); let succeed = false; let saves = 0;
  f.form.addEventListener('submit', (event) => { event.preventDefault(); saves++; if (succeed) f.guard.saved(); else f.guard.failed(); });
  f.edit('待确认填写'); f.guard.close(); f.choice('save');
  assert.equal(saves, 1); assert.equal(f.dialog.open, true); assert.equal(f.guard.dirty, true); assert.equal(f.input.value, '待确认填写');
  succeed = true; f.guard.close(); f.choice('save'); await Promise.resolve();
  assert.equal(saves, 2); assert.equal(f.guard.dirty, false); assert.equal(f.dialog.open, false);
});

test('pending operations are never exposed as discardable drafts', () => {
  const f = fixture(); f.edit('原提交'); f.block(true); f.guard.close();
  assert.equal(f.dialog.open, false); assert.equal(f.sheetOpen(), false); assert.equal(f.discarded, 0); assert.equal(f.input.value, '原提交');
});

test('internal navigation waits for an explicit choice and does not persist field values', () => {
  const f = fixture(); f.edit('个人填写'); const link = f.document.getElementById('next')!;
  const first = f.event('click', link, { button: 0 }); assert.equal(first.defaultPrevented, true); assert.equal(f.navigated.length, 0);
  f.choice('continue'); assert.equal(f.input.value, '个人填写');
  f.event('click', link, { button: 0 }); f.choice('discard');
  assert.deepEqual(f.navigated, ['https://draft.example/next']); assert.equal(f.discarded, 1);
});

test('beforeunload warns only for active unsaved fields', () => {
  const f = fixture(); assert.equal(f.event('beforeunload', f.window).defaultPrevented, false);
  f.edit('修改'); assert.equal(f.event('beforeunload', f.window).defaultPrevented, true);
  f.guard.saved(); assert.equal(f.event('beforeunload', f.window).defaultPrevented, false);
});

test('same-document Back does not rewrite browser history and keeps the existing form draft', () => {
  const f = fixture(); f.edit('修改'); f.location.href = 'https://draft.example/previous';
  f.event('popstate', f.window); assert.equal(f.sheetOpen(), false); assert.equal(f.location.pathname, '/previous');
  assert.equal(f.input.value, '修改'); assert.equal(f.navigated.length, 0); assert.deepEqual(f.history.state, { marker: 'original' });
  assert.equal(f.event('beforeunload', f.window).defaultPrevented, true);
});

test('adopting newly loaded settings establishes a clean baseline without submitting', () => {
  const f = fixture(); f.edit('旧草稿'); f.input.value = '已采用服务器最新设置'; f.event('draft-baseline', f.form);
  assert.equal(f.guard.dirty, false); f.guard.close(); assert.equal(f.dialog.open, false);
});

test('navigation confirms every active dirty form before leaving', () => {
  const f = fixture(); f.edit('第一个未保存');
  const second = f.document.createElement('dialog'); second.innerHTML = '<form><input value="第二个原值"></form>'; f.document.body.appendChild(second);
  const form = second.querySelector('form')! as HTMLFormElement;
  const input = second.querySelector('input')! as HTMLInputElement;
  const guard = f.service.register({ form, dialog: second, label: '第二个表单' });
  (second as unknown as { showModal(): void }).showModal(); guard.reset(); input.value = '第二个未保存'; f.event('input', input);
  const link = f.document.getElementById('next')!; f.event('click', link, { button: 0 }); f.choice('discard');
  assert.equal(f.navigated.length, 0); assert.equal(f.dialog.open, false);
  assert.match(f.document.getElementById('draft-guard-description')!.textContent!, /第二个表单/);
  f.choice('continue'); assert.equal(input.value, '第二个未保存');
  f.event('click', link, { button: 0 }); f.choice('discard'); assert.deepEqual(f.navigated, ['https://draft.example/next']);
});

test('saving fields block internal navigation and unload without offering discard', () => {
  const f = fixture(); f.edit('保存中的填写'); f.busy(true); f.block(true);
  f.event('click', f.document.getElementById('next')!, { button: 0 });
  assert.equal(f.sheetOpen(), true); assert.match(f.document.getElementById('draft-guard-description')!.textContent!, /正在保存/);
  for (const name of ['save', 'discard']) { assert.equal((f.document.querySelector('[data-draft-choice="' + name + '"]') as HTMLButtonElement).disabled, true); f.choice(name); }
  assert.equal(f.navigated.length, 0); assert.equal(f.discarded, 0); assert.equal(f.event('beforeunload', f.window).defaultPrevented, true);
  f.choice('continue'); f.busy(false); f.block(false); f.guard.saved();
  assert.equal(f.event('beforeunload', f.window).defaultPrevented, false);
});

test('successful completion dismisses its busy sheet without creating a navigation request', async () => {
  const f = fixture(); f.edit('正在保存'); f.busy(true); f.block(true);
  f.event('click', f.document.getElementById('next')!, { button: 0 }); assert.equal(f.sheetOpen(), true);
  f.busy(false); f.block(false); f.guard.saved(); await Promise.resolve();
  assert.equal(f.sheetOpen(), false); assert.equal(f.navigated.length, 0); assert.equal(f.guard.dirty, false);
  // A different navigation already authorized through the ordinary Save choice
  // must survive a second, busy-only wait sheet opened while that save runs.
  f.edit('第二次保存');
  f.form.addEventListener('submit', (event) => { event.preventDefault(); f.busy(true); f.block(true); });
  f.event('click', f.document.getElementById('next')!, { button: 0 }); f.choice('save');
  f.event('click', f.document.getElementById('next')!, { button: 0 }); assert.equal(f.sheetOpen(), true);
  f.busy(false); f.block(false); f.guard.saved(); await Promise.resolve();
  assert.equal(f.sheetOpen(), false); assert.deepEqual(f.navigated, ['https://draft.example/next']);
});

test('failed completion dismisses its busy sheet while retaining the editable draft', () => {
  const f = fixture(); f.edit('保存失败仍保留'); f.busy(true); f.block(true);
  f.event('click', f.document.getElementById('next')!, { button: 0 }); assert.equal(f.sheetOpen(), true);
  // Error handlers may run before their finally clause releases busy controls.
  f.guard.failed(); assert.equal(f.sheetOpen(), false); assert.equal(f.navigated.length, 0);
  f.busy(false); f.block(false); assert.equal(f.guard.dirty, true); assert.equal(f.input.value, '保存失败仍保留');
  f.guard.close(); assert.equal(f.sheetOpen(), true);
  assert.equal((f.document.querySelector('[data-draft-choice="discard"]') as HTMLButtonElement).disabled, false);
});
