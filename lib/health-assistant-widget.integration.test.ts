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

function fixture({ reducedMotion = true } = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body><a id="original-entry" href="/health/assistant">健康助手</a>' + renderHealthAssistantWidget() + '</body></html>');
  const epoch = Date.now();
  let now = 0, timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const setTimer = (callback: () => void, delay = 0) => {
    const id = ++timerId; timers.set(id, { due: now + delay, callback }); return id;
  };
  class ClockDate extends Date { static now() { return epoch + now; } }
  Object.assign(window, { matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }) });
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
    URL, URLSearchParams, TextEncoder, AbortController, Intl, Date: ClockDate,
    setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id) });
  const el = (id: string) => document.getElementById('health-chat-' + id)! as unknown as HTMLElement & { value: string; disabled: boolean };
  const event = (name: string, details: Record<string, unknown> = {}) => {
    const value = new window.Event(name, { bubbles: true, cancelable: true });
    for (const [key, item] of Object.entries(details)) Object.defineProperty(value, key, { value: item });
    return value;
  };
  const click = (target: string | Element) => (typeof target === 'string' ? el(target) : target).dispatchEvent(event('click', { button: 0 }));
  const question = (text: string) => { el('question').value = text; el('question').dispatchEvent(event('input')); };
  const send = () => el('form').dispatchEvent(event('submit'));
  return { window, document, requests, location, el, event, click, question, send,
    timerCount() { return timers.size; },
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; timers.delete(id); now = timer.due; timer.callback();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    postNext(handler: () => Promise<Response>) { nextPost = handler; },
    async open() { click('launcher'); await settled(() => !el('context').hidden); },
    async sendText(text: string) { question(text); send(); await settled(() => !el('question').disabled); },
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

test('asking a chart carries its exact long range and only that metric without calling a model',async()=>{
  const f=fixture();
  f.window.dispatchEvent(f.event('health-assistant-open',{detail:{metric:'sleep',days:180,question:'解释这张睡眠图'}}));
  await settled(()=>!f.el('context').hidden);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');
  const query=new URL(f.requests[0].url,f.location.origin).searchParams;
  assert.equal(query.get('days'),'180');assert.equal(query.get('metrics'),'sleep');assert.equal(query.get('nutrition'),'0');assert.equal(query.get('goals'),'0');
  assert.equal(f.el('question').value,'解释这张睡眠图');
  f.send();await settled(()=>!f.el('question').disabled);
  const body=f.requests.find((r)=>r.method==='POST')!.body!;
  assert.deepEqual(JSON.parse(JSON.stringify(body.scope)),{metrics:['sleep'],includeNutrition:false,includeGoals:false});assert.equal(body.days,180);
});

test('scope changes clear history and reread only the explicitly selected sources',async()=>{
  const f=fixture();await f.open();await f.sendText('上一轮问题');
  const nutrition=f.el('include-nutrition') as unknown as HTMLInputElement;nutrition.checked=false;nutrition.dispatchEvent(f.event('change'));
  await settled(()=>!f.el('context').hidden);
  assert.equal(f.el('messages').children.length,0);
  await f.sendText('新范围问题');
  const body=f.requests.filter((r)=>r.method==='POST').at(-1)!.body!;
  assert.deepEqual(body.history,[]);assert.equal((body.scope as {includeNutrition:boolean}).includeNutrition,false);
  assert.ok(typeof body.historyScope==='string');
});

test('waiting remains observable while minimized and a 429 preserves the question until an active retry',async()=>{
  const f=fixture();await f.open();let finish!:(r:Response)=>void;
  f.postNext(()=>new Promise((resolve)=>{finish=resolve;}));f.question('需要保留的问题');f.send();
  await settled(()=>f.requests.some((r)=>r.method==='POST'));f.click('minimize');await f.advance(2500);
  assert.match(f.el('messages').textContent||'',/已等待 2 秒/);assert.equal(f.el('panel').hidden,true);
  finish(Response.json({error:'应用限流',code:'AI_RATE_LIMITED',usage:{remainingToday:17,retryAfter:2}},{status:429,headers:{'Retry-After':'2'}}));
  await settled(()=>!f.el('question').disabled);assert.equal(f.el('question').value,'需要保留的问题');assert.equal(f.el('send').disabled,true);
  assert.match(f.el('usage').textContent||'',/17 \/ 20/);assert.match(f.el('usage').textContent||'',/Token Plan/);
  await f.advance(2200);assert.equal(f.el('send').disabled,false);assert.equal(f.requests.filter((r)=>r.method==='POST').length,1);
  f.click('launcher');f.send();await settled(()=>!f.el('question').disabled);assert.equal(f.requests.filter((r)=>r.method==='POST').length,2);
});

test('a late rate-limit response after page departure cannot restart countdown timers or restore private conversation',async()=>{
  const f=fixture();await f.open();let finish!:(r:Response)=>void;f.postNext(()=>new Promise((resolve)=>{finish=resolve;}));
  f.question('离页前的问题');f.send();await settled(()=>f.requests.some((r)=>r.method==='POST'));
  f.window.dispatchEvent(f.event('pagehide'));
  finish(Response.json({error:'限流',code:'AI_RATE_LIMITED',usage:{remainingToday:0,retryAfter:60}},{status:429,headers:{'Retry-After':'60'}}));
  await new Promise<void>((resolve)=>setImmediate(resolve));await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(f.timerCount(),0);assert.equal(f.el('messages').children.length,0);assert.equal(f.el('question').value,'');
});

test('consecutive messages carry successful history and show safe Markdown while user text stays inert', async () => {
  const f = fixture(); await f.open();
  f.question('总结 <img src=x onerror=alert(1)>');
  assert.equal(f.document.getElementById('health-chat-consent'), null);
  assert.equal(f.el('form').querySelector('input[type=checkbox]'), null);
  assert.equal(f.el('send').disabled, false);
  f.send(); await settled(() => !f.el('question').disabled);
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

test('minimizing an in-flight reply preserves it, while range changes and leaving clear conversation without requiring another consent step', async () => {
  const f = fixture(); await f.open();
  let resolvePost!: (response: Response) => void;
  f.postNext(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
  f.question('等待回复'); f.send(); f.click('minimize');
  assert.equal(f.el('panel').hidden, true); assert.equal(f.el('question').disabled, true);
  resolvePost(Response.json(completion())); await settled(() => !f.el('question').disabled);
  f.click('launcher'); assert.equal(f.el('messages').querySelectorAll('article').length, 2);
  f.click(f.document.querySelector('[data-health-chat-days="30"]')!);
  await settled(() => !f.el('context').hidden);
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.document.getElementById('health-chat-consent'), null);
  await f.sendText('总结三十天');
  const last = f.requests.filter((item) => item.method === 'POST').at(-1)!;
  assert.equal(last.body?.days, 30); assert.deepEqual(last.body?.history, []);
  f.window.dispatchEvent(f.event('pagehide'));
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.document.getElementById('health-chat-consent'), null);
  assert.equal(f.el('context').hidden, true);
});

test('IME and Shift+Enter do not submit, and a new conversation clears history without adding a consent step', async () => {
  const f = fixture(); await f.open(); f.question('中文输入');
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', isComposing: true }));
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', shiftKey: true }));
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 0);
  f.el('question').dispatchEvent(f.event('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }));
  await settled(() => !f.el('question').disabled);
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 1);
  f.click('new'); await settled(() => !f.el('context').hidden);
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.document.getElementById('health-chat-consent'), null);
  await f.sendText('新对话直接发送');
  const latest = f.requests.filter((item) => item.method === 'POST').at(-1)!;
  assert.deepEqual(latest.body?.history, []); assert.equal(latest.body?.shareHealthData, true);
});

test('new replies reveal progressively and immediately showing the rest preserves safe Markdown and full follow-up history', async () => {
  const f = fixture({ reducedMotion: false }); await f.open();
  f.question('看看我的记录'); f.send();
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  const bubble = f.el('messages').querySelector('.hc-markdown')!;
  const article = bubble.closest('article')!;
  const reveal = article.querySelector('.hc-reveal')! as HTMLElement;
  assert.equal(article.getAttribute('aria-busy'), 'true');
  assert.equal(reveal.hidden, false); assert.equal(reveal.textContent, '立即显示');
  assert.equal(f.el('question').disabled, true); assert.equal(f.el('new').disabled, true);
  await f.advance(24);
  const partial = bubble.querySelector('h2')!.textContent ?? '';
  assert.ok(partial.length > 0 && partial.length < '先看睡眠'.length, 'The heading must visibly grow before the rest of the answer');
  f.click(reveal); await settled(() => !f.el('question').disabled);
  assert.equal(article.getAttribute('aria-busy'), 'false');
  assert.equal(bubble.classList.contains('is-typing'), false); assert.equal(reveal.hidden, true);
  assert.equal(bubble.innerHTML, renderAssistantMarkdown(answer));
  assert.equal(bubble.querySelectorAll('table').length, 1); assert.equal(bubble.querySelectorAll('strong').length, 1);
  f.question('继续'); f.send();
  await settled(() => f.requests.filter((item) => item.method === 'POST').length === 2);
  assert.deepEqual(f.requests.filter((item) => item.method === 'POST')[1].body?.history,
    [{ role: 'user', content: '看看我的记录' }, { role: 'assistant', content: answer }]);
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  f.click(f.el('messages').querySelectorAll('.hc-reveal')[1]);
  await settled(() => !f.el('question').disabled);
});

test('plain-text fallback reveals complete graphemes and finishes naturally within the duration budget', async () => {
  const f = fixture({ reducedMotion: false }); await f.open();
  const text = '你👩‍⚕️e\u0301🇨🇳好，今天也要照顾自己。';
  f.postNext(async () => Response.json({ ...completion(), answer: text, answerHtml: undefined }));
  f.question('给我一句建议'); f.send();
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  const bubble = f.el('messages').querySelector('.hc-markdown')!;
  const segments = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
  const prefixes = new Set(segments.map((_, index) => segments.slice(0, index + 1).join('')));
  prefixes.add('');
  for (let index = 0; index < 12; index++) {
    const clone = bubble.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    assert.ok(prefixes.has(clone.textContent ?? ''), 'Every visible prefix must end at a grapheme boundary');
    await f.advance(24);
  }
  await f.advance(12000);
  assert.equal(bubble.textContent, text); assert.equal(bubble.classList.contains('is-typing'), false);
  assert.equal(f.el('question').disabled, false); assert.equal(f.timerCount(), 0);
});

test('reduced motion renders a complete reply immediately with no reveal timer', async () => {
  const f = fixture({ reducedMotion: true }); await f.open(); await f.sendText('总结睡眠');
  const bubble = f.el('messages').querySelector('.hc-markdown')!;
  assert.equal(bubble.innerHTML, renderAssistantMarkdown(answer));
  assert.equal(bubble.classList.contains('is-typing'), false);
  assert.equal((bubble.closest('article')!.querySelector('.hc-reveal') as HTMLElement | null)?.hidden ?? true, true);
  assert.equal(f.timerCount(), 0);
});

test('a maximum-size reply completes without forcing a character-by-character multi-minute wait', async () => {
  const f = fixture({ reducedMotion: false }); await f.open();
  const text = '健康记录'.repeat(2500);
  f.postNext(async () => Response.json({ ...completion(), answer: text, answerHtml: undefined }));
  f.question('给我完整分析'); f.send();
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  await f.advance(12100);
  assert.equal(f.el('messages').querySelector('.hc-markdown')!.textContent, text);
  assert.equal(f.el('question').disabled, false); assert.equal(f.timerCount(), 0);
});

test('minimizing preserves reveal progress and leaving the page cancels every reveal callback', async () => {
  const f = fixture({ reducedMotion: false }); await f.open();
  f.question('继续看看'); f.send();
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  const bubble = f.el('messages').querySelector('.hc-markdown')!;
  await f.advance(48);
  const before = bubble.querySelector('h2')!.textContent ?? '';
  f.click('minimize'); assert.equal(f.el('panel').hidden, true);
  await f.advance(24);
  f.click('launcher');
  assert.equal(f.el('messages').querySelector('.hc-markdown'), bubble);
  assert.ok((bubble.querySelector('h2')!.textContent ?? '').startsWith(before));
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 1);
  f.window.dispatchEvent(f.event('pagehide'));
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.document.getElementById('health-chat-consent'), null);
  assert.equal(f.timerCount(), 0);
  await f.advance(20000);
  assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('question').disabled, false);
});

test('revealing a reply does not pull a reader away from earlier messages', async () => {
  const f = fixture({ reducedMotion: false }); await f.open();
  const scroll = f.el('scroll');
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1400 }, clientHeight: { configurable: true, value: 400 } });
  f.question('给我详细建议'); f.send();
  await settled(() => !!f.el('messages').querySelector('.is-typing'));
  scroll.scrollTop = 50;
  scroll.dispatchEvent(f.event('scroll'));
  await f.advance(120);
  assert.equal(scroll.scrollTop, 50);
  f.click(f.el('messages').querySelector('.hc-reveal')!);
  await settled(() => !f.el('question').disabled);
  assert.equal(scroll.scrollTop, 50);
});
