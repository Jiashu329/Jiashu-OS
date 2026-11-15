import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderDoubanSyncProgressScript } from './douban-sync-progress.ts';
import { DOUBAN_WORKSPACE_ACTIONS, renderDoubanWorkspaceScript, renderDoubanWorkspaceTools } from './douban-workspace.ts';

type Snapshot = {
  phase: 'collections' | 'details' | 'ratings' | 'done';
  state: 'running' | 'paused' | 'pending' | 'error' | 'partial' | 'done';
  current: number | null; total: number | null;
  title?: string; currentItem?: string; message?: string;
  metrics?: Array<{ label: string; value: number }>;
};
function script(source: string) { return source.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''); }
function fixture() {
  const { window, document } = parseHTML('<html><body><div id="progress" hidden></div></body></html>');
  runInNewContext(script(renderDoubanSyncProgressScript()), { window, document });
  const api = (window as unknown as { JiashuDoubanSyncProgress: { render(id: string, snapshot: Snapshot): void } }).JiashuDoubanSyncProgress;
  const element = document.getElementById('progress')!;
  const find = (key: string) => element.querySelector(`[data-sync-${key}]`)! as HTMLElement;
  return { element, find, render: (snapshot: Snapshot) => api.render('progress', snapshot) };
}

void test('phase progress uses confirmed counts and updates stable DOM without announcing every item', () => {
  const f = fixture();
  f.render({ phase: 'details', state: 'running', current: 3, total: 12, currentItem: '三体', metrics: [{ label: '已更新', value: 2 }, { label: '复用资料', value: 1 }] });
  const bar = f.find('bar'), card = f.find('metrics').firstElementChild, announcement = f.find('announcement').firstChild;
  assert.equal(f.element.hidden, false); assert.equal(f.element.getAttribute('aria-busy'), 'true');
  assert.equal(bar.getAttribute('max'), '12'); assert.equal(bar.getAttribute('value'), '3'); assert.equal(bar.getAttribute('aria-valuetext'), '3 / 12 项');
  assert.equal(f.element.querySelector('[data-sync-step="collections"]')?.getAttribute('data-status'), 'complete');
  assert.equal(f.element.querySelector('[aria-current="step"]')?.getAttribute('data-sync-step'), 'details');
  f.render({ phase: 'details', state: 'running', current: 4, total: 12, currentItem: '活着', metrics: [{ label: '已更新', value: 3 }] });
  assert.equal(f.find('bar'), bar); assert.equal(f.find('metrics').firstElementChild, card);
  assert.equal(f.find('announcement').firstChild, announcement);
  assert.equal(f.find('metrics').querySelector('[data-sync-metric-value]')?.textContent, '3');
  assert.equal(f.find('metrics').children[1]?.hasAttribute('hidden'), true);
});

void test('unknown totals stay indeterminate and pausing or pending writes never report completion', () => {
  const f = fixture();
  f.render({ phase: 'collections', state: 'running', current: 24, total: null });
  assert.equal(f.find('bar').hasAttribute('value'), false); assert.equal(f.find('bar').getAttribute('aria-valuetext'), '已核对 24 项 · 总量待确认');
  f.render({ phase: 'collections', state: 'paused', current: 24, total: null, currentItem: '收藏列表第 2 页' });
  assert.equal(f.find('state').textContent, '已暂停'); assert.equal(f.element.getAttribute('aria-busy'), 'false');
  assert.equal(f.find('bar').hasAttribute('value'), false); assert.equal(f.find('current').firstElementChild?.textContent, '当前条目');
  f.render({ phase: 'ratings', state: 'pending', current: 3, total: 8, message: '评分写入结果待核对，请恢复后继续。' });
  assert.equal(f.find('state').textContent, '等待核对'); assert.equal(f.find('bar').getAttribute('value'), '3');
  assert.equal(f.find('message').textContent, '评分写入结果待核对，请恢复后继续。');
  assert.doesNotMatch(f.element.textContent ?? '', /100%|已完成/);
});

void test('errors and partial results remain distinct from completion, including empty and unknown totals', () => {
  const f = fixture();
  f.render({ phase: 'details', state: 'error', current: 2, total: 7, message: '豆瓣暂时限制读取，可稍后继续。' });
  assert.equal(f.find('state').textContent, '同步中断'); assert.equal(f.find('bar').getAttribute('value'), '2');
  f.render({ phase: 'done', state: 'partial', current: 7, total: 7 });
  assert.equal(f.find('state').textContent, '部分完成'); assert.equal(f.find('bar').hidden, true);
  assert.equal(f.element.querySelector('[data-sync-step][data-status="complete"]'), null);
  f.render({ phase: 'done', state: 'done', current: 0, total: 0 });
  assert.equal(f.find('count').textContent, '0 项已核对'); assert.equal(f.find('bar').hidden, true);
  assert.doesNotMatch(f.element.outerHTML, /NaN|Infinity/);
  f.render({ phase: 'done', state: 'done', current: 16, total: null });
  assert.equal(f.find('count').textContent, '16 项已核对'); assert.equal(f.find('bar').hidden, true);
});

void test('source titles and messages remain inert text, with bounded current work on small screens', () => {
  const f = fixture(), unsafe = '<img src=x onerror="alert(1)">';
  f.render({ phase: 'details', state: 'running', current: 1, total: 2, title: unsafe, currentItem: '📚'.repeat(150), message: '</p><script>alert(2)</script>', metrics: [{ label: unsafe, value: Number.NaN }] });
  assert.equal(f.find('title').textContent, unsafe); assert.equal(f.element.querySelector('img,script'), null);
  assert.equal(Array.from(f.find('current-item').textContent ?? '').length, 100);
  assert.equal(f.find('metrics').querySelector('[data-sync-metric-value]')?.textContent, '0');
  assert.match(f.find('message').textContent ?? '', /<script>/);
});

void test('the compact workspace badge reaches metadata progress and can return to the browser tools', () => {
  const { window, document } = parseHTML('<html><body>' + DOUBAN_WORKSPACE_ACTIONS + '<div id="douban-metadata-progress" tabindex="-1"></div>' + renderDoubanWorkspaceTools({ browser: '', public: '', import: '', manage: '' }) + '</body></html>');
  const target = document.getElementById('douban-metadata-progress')!, button = document.getElementById('douban-workspace-progress')!, dialog = document.getElementById('douban-tools-dialog')!;
  const reached: string[] = [];
  target.scrollIntoView = () => { reached.push('scroll'); }; target.focus = () => { reached.push('focus'); };
  runInNewContext(script(renderDoubanWorkspaceScript()), { window, document });
  const api = (window as unknown as { JiashuDoubanWorkspace: { updateState(snapshot: Record<string, unknown>): void } }).JiashuDoubanWorkspace;
  api.updateState({ busy: true, target: 'metadata', progressText: '正在核对资料；' + '已更新很多资料'.repeat(30) });
  assert.equal(button.textContent, '正在核对资料'); assert.equal(button.getAttribute('aria-controls'), target.id);
  assert.equal(button.hasAttribute('data-douban-tools-open'), false);
  button.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(reached, ['scroll', 'focus']); assert.equal(dialog.hasAttribute('open'), false);
  api.updateState({ busy: true, section: 'public', progressText: '公开收藏核对中' });
  assert.equal(button.hasAttribute('data-douban-metadata-progress-open'), false);
  assert.equal(button.dataset.doubanToolsOpen, 'public');
  button.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(dialog.hasAttribute('open'), true); assert.equal(dialog.dataset.section, 'public');
});
