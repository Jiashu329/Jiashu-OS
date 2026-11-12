import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { SHORTCUT_TEMPLATES, shortcutTemplate, withShortcutInstallCard } from './shortcut-templates.ts';
import { SHORTCUT_TEMPLATE_SCRIPT } from './shortcut-templates-ui.ts';
import { renderShortcutTemplatesPage } from '../shortcut-templates-page.ts';

function fixture(template = 'weight', clockOffset = 0) {
  const { window, document } = parseHTML(renderShortcutTemplatesPage(template));
  const responses: unknown[] = []; const requests: string[] = [];
  class ClientDate extends Date { static now() { return Date.now() + clockOffset; } }
  const context = vm.createContext({ window, document, Date: ClientDate, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string) => { requests.push(url); return Response.json({ checkedAt: new Date().toISOString(), attempts: responses.shift() ?? [] }); } });
  vm.runInContext(SHORTCUT_TEMPLATE_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, ''), context);
  const click = (id: string) => document.getElementById(id)!.dispatchEvent(new window.Event('click', { bubbles: true }));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const attempt = (metrics: string[], options: { status?: string; older?: boolean; emptySleepWindow?: unknown; changed?: boolean; source?: string } = {}) => ({
    status: options.status ?? 'success', createdAt: new Date(Date.now() + (options.older ? -60000 : 1000)).toISOString(),
    summary: { version: 1, known: true, emptySleepWindow: options.emptySleepWindow ?? null,
      metrics: metrics.map((metric) => ({ metric, received: 1, added: options.changed === false ? 0 : 1, updated: 0,
        unchanged: options.changed === false ? 1 : 0, older: 0, from: '2026-11-10', to: '2026-11-10', sources: [options.source ?? 'synthetic source'] })) },
  });
  return { window, document, requests, responses, click, settle, attempt };
}

test('four provided installation links stay on iCloud and guide query input cannot become a link or HTML', () => {
  assert.equal(SHORTCUT_TEMPLATES.length, 4);
  for (const item of SHORTCUT_TEMPLATES) {
    const url = new URL(item.url); assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'www.icloud.com');
    assert.match(url.pathname, /^\/shortcuts\/[a-f0-9]{32}$/); assert.equal(url.search, ''); assert.equal(url.hash, '');
  }
  assert.equal(shortcutTemplate('<img onerror=alert(1)>').id, 'steps');
  assert.doesNotMatch(renderShortcutTemplatesPage('<img onerror=alert(1)>'), /<img onerror/);
  const guide = withShortcutInstallCard('<main><header>Guide</header><section>Existing instructions</section></main>', 'sleep');
  assert.match(guide, /Existing instructions/); assert.match(guide, /4e28e8e6257e4a2fa39ee94ff631c03a/);
  assert.match(guide, /尚未在当前环境检查/); assert.doesNotMatch(guide, /jso_sync_/);
});

test('first-run check requires a valid new batch for every selected metric and explicit phone confirmation', async () => {
  const f = fixture(); const check = f.document.getElementById('template-check-now') as HTMLButtonElement;
  const confirm = f.document.getElementById('template-confirm') as HTMLInputElement;
  assert.equal(check.disabled, true); assert.equal(confirm.disabled, true); assert.equal(f.requests.length, 0);
  f.click('template-start'); await f.settle();
  f.responses.push([f.attempt(['weight', 'lean_body_mass'], { older: true }), f.attempt(['weight', 'lean_body_mass'], { status: 'duplicate', changed: false })]);
  f.click('template-check-now'); await f.settle(); assert.equal(confirm.disabled, true);
  f.responses.push([f.attempt(['weight'])]); f.click('template-check-now'); await f.settle(); assert.equal(confirm.disabled, true);
  f.responses.push([f.attempt(['weight', 'lean_body_mass'], { source: '<img src=x onerror=alert(1)>' })]);
  f.click('template-check-now'); await f.settle(); assert.equal(confirm.disabled, false); assert.equal(Boolean(confirm.checked), false);
  assert.equal(f.document.querySelectorAll('#template-results img').length, 0);
  assert.doesNotMatch(f.document.getElementById('template-status')!.textContent!, /本次核对完成/);
  confirm.checked = true; confirm.dispatchEvent(new f.window.Event('change'));
  assert.match(f.document.getElementById('template-status')!.textContent!, /本次核对完成/);
  assert.ok(f.requests.every((url) => url === '/api/health/import'));
});

test('sleep outside an empty requested window and failed or empty attempts cannot pass phone verification', async () => {
  const f = fixture('sleep'); f.click('template-start'); await f.settle();
  f.responses.push([f.attempt(['sleep'], { emptySleepWindow: { from: '2026-11-10', to: '2026-11-10' } }),
    f.attempt(['sleep'], { status: 'failed' }), f.attempt([], { status: 'empty' })]);
  f.click('template-check-now'); await f.settle();
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.match(f.document.getElementById('template-status')!.textContent!, /尚未收到全部指标/);
});

test('same-value new batches support manual checking and use the server clock rather than the phone clock', async () => {
  const f = fixture('steps', 86400000); f.click('template-start'); await f.settle();
  f.responses.push([f.attempt(['steps'], { status: 'unchanged', changed: false })]);
  f.click('template-check-now'); await f.settle();
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, false);
  assert.match(f.document.getElementById('template-results')!.textContent!, /数值未变化/);
  assert.doesNotMatch(f.document.getElementById('template-status')!.textContent!, /本次核对完成/);
});

test('a missing lean-mass sample can be explicitly excluded without claiming it was connected', async () => {
  const f = fixture('weight');
  const lean = f.document.getElementById('template-metric-lean_body_mass') as HTMLInputElement;
  // linkedom omits the native checked default on input elements.
  f.document.querySelectorAll<HTMLInputElement>('[data-check-metric]').forEach((field) => { field.checked = true; });
  lean.checked = false; lean.dispatchEvent(new f.window.Event('change'));
  f.click('template-start'); await f.settle();
  f.responses.push([f.attempt(['weight'])]); f.click('template-check-now'); await f.settle();
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, false);
  assert.equal(f.document.querySelectorAll('#template-results li').length, 1);
  assert.match(f.document.getElementById('template-results')!.textContent!, /体重/);
  assert.doesNotMatch(f.document.getElementById('template-results')!.textContent!, /去脂体重/);
  lean.checked = true; lean.dispatchEvent(new f.window.Event('change'));
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.equal((f.document.getElementById('template-check-now') as HTMLButtonElement).disabled, true);
});
