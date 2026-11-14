import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseDoubanImportFiles } from './douban-import.ts';
import { renderDoubanBrowserHelperBookmarklet, renderDoubanBrowserHelperScript } from './douban-browser-helper.ts';

function row(id: number, layout = 'grid') {
  const content = '<img src="https://img3.doubanio.com/view/subject/s/public/s123.jpg"><div class="title"><a href="https://book.douban.com/subject/' + id + '/"><em>合成 &amp; 书籍 ' + id + '</em></a></div><span class="rating4-t"></span><span class="date">2026-11-14 读过</span><p class="comment">个人 &lt;短评&gt;</p>';
  return layout === 'list' ? '<div class="item-show">' + content + '</div>' : '<div class="item">' + content + '</div>';
}
function page(ids: number[], total = ids.length, next: number | null = null, layout = 'grid') {
  return '<!DOCTYPE html><html><head><title>合成用户读过的书</title></head><body><h1>合成用户读过的书（' + total + '）</h1><span class="subject-num">1-' + ids.length + ' / ' + total + '</span>'
    + (layout === 'list' ? ids.map(id => row(id, layout)).join('') : '<div class="grid-view">' + ids.map(id => row(id)).join('') + '</div>')
    + (next === null ? '' : '<div class="paginator"><span class="next"><a href="https://book.douban.com/people/mine/collect?start=' + next + '">后页</a></span></div>') + '</body></html>';
}
async function settle(check: () => boolean) { for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } assert.ok(check()); }
function fixture(options: { html?: string; url?: string; fetch?: (url: string, init: RequestInit) => Promise<Response>; maximumFastTimeout?: boolean } = {}) {
  const { window, document } = parseHTML(options.html ?? page([12345]));
  const requests: Array<{ url: string; init: RequestInit }> = [], alerts: string[] = [], blobs: Blob[] = [], downloads: Array<{ href: string; name: string }> = [], delays: number[] = [];
  class BrowserURL extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:local-export-' + blobs.length; }
    static revokeObjectURL() {}
  }
  const originalCreate = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const element = originalCreate(tag);
    if (tag === 'a') Object.assign(element, { click() { downloads.push({ href: element.getAttribute('href') ?? '', name: element.getAttribute('download') ?? '' }); } });
    return element;
  }) as typeof document.createElement;
  let cancelledTimers = new Set<ReturnType<typeof setTimeout>>();
  const context = { window, document, location: { href: options.url ?? 'https://book.douban.com/people/mine/collect' }, alert: (text: string) => alerts.push(text), URL: BrowserURL, URLSearchParams,
    AbortController, TextEncoder, TextDecoder, Blob, Date, Set, Error, Promise,
    fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : new Response(page([12346], 2), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); },
    setTimeout(callback: () => void, delay: number) {
      delays.push(delay);
      const timer = setTimeout(() => { if (!cancelledTimers.has(timer)) callback(); }, delay === 1500 || delay === 1000 || options.maximumFastTimeout ? 0 : delay);
      return timer;
    }, clearTimeout(timer: ReturnType<typeof setTimeout>) { cancelledTimers.add(timer); clearTimeout(timer); },
  };
  function execute(bookmarklet = renderDoubanBrowserHelperBookmarklet('mine')) { runInNewContext(decodeURIComponent(bookmarklet.slice('javascript:'.length)), context); }
  execute();
  const control = (action: string) => document.querySelector('[data-douban-book-export="' + action + '"]') as unknown as HTMLButtonElement;
  const message = () => document.querySelector('[role="status"]')?.textContent ?? '';
  return { document, context, alerts, requests, blobs, downloads, delays, execute, control, message, click(action: string) { const element = control(action); assert.ok(element); if (!element.disabled) element.dispatchEvent(new window.Event('click')); } };
}

test('bookmarklet is bounded and self-contained, builder registration never runs it', () => {
  const bookmarklet = renderDoubanBrowserHelperBookmarklet('mine'); assert.ok(bookmarklet.startsWith('javascript:')); assert.ok(bookmarklet.length < 60000);
  for (const profile of ['../other', 'mine?x=1', '', '<script>', 'a'.repeat(65)]) assert.throws(() => renderDoubanBrowserHelperBookmarklet(profile));
  const context = { window: {} as { JiashuDoubanBrowserHelper?: { bookmarklet: (id: string) => string } } };
  runInNewContext(renderDoubanBrowserHelperScript().replace(/^<script>/, '').replace(/<\/script>$/, ''), context);
  assert.equal(context.window.JiashuDoubanBrowserHelper?.bookmarklet('mine'), bookmarklet);
  const alerts: string[] = [];
  runInNewContext(decodeURIComponent(context.window.JiashuDoubanBrowserHelper!.bookmarklet('mine').slice('javascript:'.length)), { URL, location: { href: 'https://synthetic.example/life/douban' }, alert: (text: string) => alerts.push(text) });
  assert.equal(alerts.length, 1, 'registered builder source remains executable after HTML-safe serialization');
  assert.throws(() => context.window.JiashuDoubanBrowserHelper?.bookmarklet('bad/path'));
  assert.equal(/document\.cookie|localStorage|sessionStorage|clipboard|XMLHttpRequest|sendBeacon/.test(decodeURIComponent(bookmarklet)), false);
});

test('helper rejects other origins, profiles and non-completed paths before touching content or fetching', () => {
  for (const url of ['https://book.douban.com/people/other/collect', 'https://movie.douban.com/people/mine/collect', 'http://book.douban.com/people/mine/collect', 'https://book.douban.com:999/people/mine/collect', 'https://book.douban.com/people/mine/wish', 'https://book.douban.com/people/mine/collect?start=1&start=2']) {
    const f = fixture({ url }); assert.equal(f.alerts.length, 1); assert.equal(f.document.getElementById('jiashu-douban-book-export'), null); assert.equal(f.requests.length, 0);
  }
});

test('opening is local; explicit current-page read produces import-compatible book JSON only after download', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0); assert.equal(f.blobs.length, 0); assert.equal(f.control('download').disabled, true);
  f.click('current'); await settle(() => !f.control('close').disabled); assert.match(f.message(), /已读取至.*末页/); assert.equal(f.requests.length, 0); assert.equal(f.blobs.length, 0);
  f.click('download'); assert.equal(f.blobs.length, 1); assert.equal(f.downloads[0].href, 'blob:local-export-1');
  const json = await f.blobs[0].text(); assert.equal(json.includes('<html'), false);
  const parsed = parseDoubanImportFiles([{ name: 'books.json', text: json }], { profileId: 'mine' });
  assert.equal(parsed.items.length, 1); assert.deepEqual({ ...parsed.items[0] }, { domain: 'book', subjectId: '12345', url: 'https://book.douban.com/subject/12345/', kind: 'book', title: '合成 & 书籍 12345', coverUrl: 'https://img3.doubanio.com/view/subject/s/public/s123.jpg', rating: 4, markedDate: '2026-11-14', comment: '个人 <短评>', publishedAt: null, source: 'import' });
});

test('continuous export reads only verified next offsets sequentially with normal same-origin credentials', async () => {
  let active = 0;
  const f = fixture({ html: page([12345], 3, 1, 'list'), fetch: async (url, init) => {
    active++; assert.equal(active, 1); const parsed = new URL(url), start = Number(parsed.searchParams.get('start'));
    assert.equal(parsed.origin, 'https://book.douban.com'); assert.equal(parsed.pathname, '/people/mine/collect'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'same-origin');
    assert.equal(new Headers(init.headers).get('cookie'), null); assert.equal(new Headers(init.headers).get('authorization'), null); active--;
    return new Response(page([12345 + start], 3, start === 1 ? 2 : null), { headers: { 'Content-Type': 'text/html' } });
  } });
  f.click('all'); await settle(() => !f.control('close').disabled); assert.equal(f.requests.length, 2); assert.equal(f.delays.filter(delay => delay === 1500).length, 2); assert.match(f.message(), /已收集 3 条/); assert.equal(f.blobs.length, 0);
  f.click('download'); assert.equal(JSON.parse(await f.blobs[0].text()).items.length, 3);
});

test('an unsafe next link or non-completed collection cannot become a false empty or trigger an arbitrary request', async () => {
  for (const html of [page([12345], 2, 1).replace('https://book.douban.com/people/mine/collect?start=1', 'https://evil.example/steal?start=1'), page([12345], 2, 1).replace('/people/mine/collect?start=1', '/people/other/collect?start=1'), page([12345]).replaceAll('读过的书', '想读的书'), '<title>安全验证</title><h1>读过的书（0）</h1>']) {
    const f = fixture({ html }); f.click('all'); await settle(() => !f.control('close').disabled); assert.equal(f.requests.length, 0); assert.equal(f.control('download').disabled, true); assert.match(f.message(), /停止|未确认|要求/);
  }
});

test('access restriction, login, challenge, redirect and repeated pages stop honestly and preserve previous pages', async () => {
  for (const response of [() => new Response('restricted', { status: 418 }), () => new Response('', { status: 302, headers: { Location: 'https://accounts.douban.com/login' } }), () => new Response('<title>安全验证</title>', { headers: { 'Content-Type': 'text/html' } }), () => new Response('<title>豆瓣 - 登录</title>', { headers: { 'Content-Type': 'text/html' } }), () => new Response(page([12345], 2), { headers: { 'Content-Type': 'text/html' } })]) {
    const f = fixture({ html: page([12345], 2, 1), fetch: async () => response() }); f.click('all'); await settle(() => !f.control('close').disabled);
    assert.equal(f.requests.length, 1); assert.equal(f.control('download').disabled, false); assert.match(f.message(), /已收集 1 条/); assert.doesNotMatch(f.message(), /已读取至.*末页/);
    assert.equal(f.control('next').getAttribute('href')?.includes('start=1'), true); f.click('download'); assert.equal(JSON.parse(await f.blobs[0].text()).items.length, 1);
  }
});

test('inert parsing does not execute scripts or attach fetched resources to the live document', async () => {
  const f = fixture({ html: page([12345], 2, 1), fetch: async () => new Response(page([12346], 2).replace('</body>', '<script>window.BAD=true</script><iframe src="https://evil.example/private"></iframe><img src="https://evil.example/track"></body>'), { headers: { 'Content-Type': 'text/html' } }) });
  f.click('all'); await settle(() => !f.control('close').disabled); assert.equal((f.context.window as unknown as { BAD?: unknown }).BAD, undefined); assert.equal(f.document.querySelector('iframe'), null); assert.equal(f.document.querySelector('img[src="https://evil.example/track"]'), null); assert.equal(f.requests.length, 1);
});

test('cancel aborts an active read and retains the completed pages for an explicit partial download', async () => {
  let aborted = false;
  const f = fixture({ html: page([12345], 2, 1), fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); }) });
  f.click('all'); await settle(() => f.requests.length === 1); f.click('cancel'); await settle(() => !f.control('close').disabled); assert.equal(aborted, true); assert.match(f.message(), /已停止/); assert.equal(f.control('download').disabled, false); assert.equal(f.requests.length, 1);
});

test('oversized responses and a response timeout retain earlier records and never automatically retry', async () => {
  for (const response of [async () => new Response('x', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(2 * 1024 * 1024 + 1) } }), async () => new Promise<Response>(() => {})]) {
    const f = fixture({ html: page([12345], 2, 1), fetch: response, maximumFastTimeout: true }); f.click('all'); await settle(() => !f.control('close').disabled); assert.equal(f.requests.length, 1); assert.equal(f.control('download').disabled, false); assert.match(f.message(), /超过|超时/); assert.doesNotMatch(f.message(), /已读取至.*末页/);
  }
});

test('a 500-record batch keeps a canonical continuation offset and labels the cap as partial', async () => {
  const ids = (start: number) => Array.from({ length: Math.min(30, 600 - start) }, (_, index) => 20000 + start + index);
  const f = fixture({ html: page(ids(0), 600, 30), fetch: async url => { const start = Number(new URL(url).searchParams.get('start')); return new Response(page(ids(start), 600, start + 30 < 600 ? start + 30 : null), { headers: { 'Content-Type': 'text/html' } }); } });
  f.click('all'); await settle(() => !f.control('close').disabled); assert.equal(f.requests.length, 16); assert.match(f.message(), /本批达到读取上限/); assert.match(f.message(), /已收集 500 条/); assert.equal(new URL(f.control('next').getAttribute('href')!).searchParams.get('start'), '500');
  f.click('download'); const json = await f.blobs[0].text(); assert.equal(parseDoubanImportFiles([{ name: 'batch.json', text: json }], { profileId: 'mine' }).items.length, 500);
});

test('starting midway never claims an entire history was exported, and foreign covers remain absent', async () => {
  const f = fixture({ url: 'https://book.douban.com/people/mine/collect?start=1', html: page([12346], 2).replace('https://img3.doubanio.com/view/subject/s/public/s123.jpg', 'https://evil.example/image.jpg') });
  f.click('current'); await settle(() => !f.control('close').disabled); assert.match(f.message(), /从第 2 条开始，不包含更早页面/); f.click('download'); assert.equal(JSON.parse(await f.blobs[0].text()).items[0].coverUrl, null);
});
