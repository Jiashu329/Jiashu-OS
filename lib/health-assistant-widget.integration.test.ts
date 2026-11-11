import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderHealthAssistantWidget } from './health-assistant-widget.ts';
import { renderHealthAssistantWidgetScript } from './health-assistant-widget-ui.ts';
import { renderAssistantMarkdown } from './assistant-markdown.ts';

const answer = '## 先看睡眠\n\n**已有记录**支持这个观察 [H1]。\n\n| 指标 | 覆盖 |\n| --- | --- |\n| 睡眠 | 5 天 |';
const metadata = (days = 7) => ({
  configuration: { ready: true, provider: 'MiniMax', model: 'MiniMax-M3', message: '已配置' }, hasData: true,
  context: { version: 1, timezone: 'Asia/Shanghai', range: { from: days === 7 ? '2026-11-05' : '2026-10-13', to: '2026-11-11', today: '2026-11-11', days },
    health: [{ label: '睡眠', recordedDays: 5, points: [] }], nutrition: { recordedDays: 3, days: [] }, limitations: ['缺失日期不是零。'] },
  sources: [{ id: 'H1', label: '睡眠', url: '/health?metric=sleep', from: '2026-11-05', to: '2026-11-11', recordedDays: 5 }],
});
const completion = (days = 7) => ({ answer, answerHtml: renderAssistantMarkdown(answer), provider: 'MiniMax', model: 'MiniMax-M3',
  range: metadata(days).context.range, sources: metadata(days).sources, generatedAt: '2026-11-11T12:00:00Z' });

async function settled(check: () => boolean) {
  for (let index = 0; index < 30; index++) { if (check()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.ok(check(), 'The synthetic DOM operation did not settle');
}

function fixture() {
  const { window, document } = parseHTML('<!doctype html><html><body><a id="original-entry" href="/health/assistant">健康助手</a>' + renderHealthAssistantWidget() + '</body></html>');
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const location = { origin: 'https://synthetic-widget.example', pathname: '/health', search: '?metric=sleep' };
  let nextPost: (() => Promise<Response>) | undefined;
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    if (method === 'POST') {
      const handler = nextPost; nextPost = undefined;
      return handler ? handler() : Response.json(completion(body?.days as number));
    }
    return Response.json(metadata(Number(new URL(url, location.origin).searchParams.get('days'))));
  };
  const source = renderHealthAssistantWidgetScript().replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  runInNewContext(source, { window, document, Element: window.Element, location, navigator: {}, fetch,
    URL, URLSearchParams, TextEncoder, AbortController, Intl, Date, setTimeout, clearTimeout });
  const el = (id: string) => document.getElementById('health-chat-' + id)! as unknown as HTMLElement & { value: string; checked: boolean; disabled: boolean };
  const event = (name: string, details: Record<string, unknown> = {}) => {
    const value = new window.Event(name, { bubbles: true, cancelable: true });
    for (const [key, item] of Object.entries(details)) Object.defineProperty(value, key, { value: item });
    return value;
  };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click', { button: 0 }));
  const question = (text: string) => { el('question').value = text; el('question').dispatchEvent(event('input')); };
  const consent = () => { el('consent').checked = true; el('consent').dispatchEvent(event('change')); };
  const send = () => el('form').dispatchEvent(event('submit'));
  return { window, document, requests, location, el, event, click, question, consent, send,
    postNext(handler: () => Promise<Response>) { nextPost = handler; },
    async open() { click('launcher'); await settled(() => !el('context').hidden); },
    async sendText(text: string) { question(text); consent(); send(); await settled(() => !el('question').disabled); },
  };
}

test('the original health-assistant entry opens lazily without navigation or a model call', async () => {
  const f = fixture();
  assert.equal(f.el('panel').hidden, true); assert.equal(f.requests.length, 0);
  const click = f.event('click', { button: 0 });
  f.document.getElementById('original-entry')!.dispatchEvent(click);
  await settled(() => !f.el('context').hidden);
  assert.equal(click.defaultPrevented, true); assert.equal(f.el('panel').hidden, false);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.location.pathname + f.location.search, '/health?metric=sleep');
  f.document.dispatchEvent(f.event('keydown', { key: 'Escape' })); assert.equal(f.el('panel').hidden, true);
});

test('consecutive messages carry successful history and show safe Markdown while user text stays inert', async () => {
  const f = fixture(); await f.open();
  f.question('总结 <img src=x onerror=alert(1)>');
  assert.equal(f.el('send').disabled, true);
  f.consent(); f.send(); await settled(() => !f.el('question').disabled);
  const first = f.requests.find((item) => item.method === 'POST')!;
  assert.deepEqual(first.body?.history, []); assert.equal(first.body?.shareHealthData, true);
  assert.equal(f.el('messages').querySelectorAll('img').length, 0);
  assert.match(f.el('messages').textContent ?? '', /<img src=x/);
  assert.equal(f.el('messages').querySelectorAll('.hc-markdown h2').length, 1);
  assert.equal(f.el('messages').querySelectorAll('.hc-markdown table').length, 1);
  const sourceLink = f.el('messages').querySelector('.hc-source-list a')!;
  assert.equal(sourceLink.getAttribute('target'), '_blank');
  assert.equal(sourceLink.getAttribute('rel'), 'noopener noreferrer');
  f.click('close'); assert.equal(f.el('panel').hidden, true);
  f.click('launcher'); assert.equal(f.el('messages').querySelectorAll('article').length, 2);
  await f.sendText('那我明天应该怎么做？');
  const posts = f.requests.filter((item) => item.method === 'POST');
  assert.deepEqual(posts[1].body?.history, [{ role: 'user', content: first.body?.question }, { role: 'assistant', content: answer }]);
  assert.equal(f.el('messages').querySelectorAll('article').length, 4);
});

test('failed messages preserve the draft and never become model history', async () => {
  const f = fixture(); await f.open(); await f.sendText('先总结睡眠');
  f.postNext(async () => Response.json({ error: '当前模型无权访问。', code: 'AI_MODEL_ACCESS_DENIED', diagnostics: { upstreamStatus: 200, upstreamCode: 2061 } }, { status: 502 }));
  await f.sendText('这次失败的问题');
  assert.equal(f.el('question').value, '这次失败的问题'); assert.equal(f.el('form-error').hidden, false);
  assert.match(f.el('form-error').textContent ?? '', /2061/);
  assert.equal(f.el('messages').querySelectorAll('article').length, 2);
  await f.sendText('重新追问');
  const latest = f.requests.filter((item) => item.method === 'POST').at(-1)!;
  assert.equal(JSON.stringify(latest.body?.history).includes('这次失败的问题'), false);
});

test('minimizing an in-flight reply preserves it, while range changes and leaving clear conversation and consent', async () => {
  const f = fixture(); await f.open();
  let resolvePost!: (response: Response) => void;
  f.postNext(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
  f.question('等待回复'); f.consent(); f.send(); f.click('minimize');
  assert.equal(f.el('panel').hidden, true); assert.equal(f.el('question').disabled, true);
  resolvePost(Response.json(completion())); await settled(() => !f.el('question').disabled);
  f.click('launcher'); assert.equal(f.el('messages').querySelectorAll('article').length, 2);
  f.click(f.document.querySelector('[data-health-chat-days="30"]')!);
  await settled(() => !f.el('context').hidden);
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('consent').checked, false);
  await f.sendText('总结三十天');
  const last = f.requests.filter((item) => item.method === 'POST').at(-1)!;
  assert.equal(last.body?.days, 30); assert.deepEqual(last.body?.history, []);
  f.window.dispatchEvent(f.event('pagehide'));
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('consent').checked, false);
  assert.equal(f.el('context').hidden, true);
});

test('IME and Shift+Enter do not submit, and a new conversation resets authorization', async () => {
  const f = fixture(); await f.open(); f.question('中文输入'); f.consent();
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', isComposing: true }));
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', shiftKey: true }));
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 0);
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }));
  await settled(() => !f.el('question').disabled);
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 1);
  f.click('new'); await settled(() => !f.el('context').hidden);
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('consent').checked, false);
});
