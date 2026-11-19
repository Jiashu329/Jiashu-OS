import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRecipeLinkPreview, normalizeRecipeLink } from './recipe-link.ts';

const NOTE_ID = '67abcdef1234567890abcdef';
const XHS_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
const XHS_SHORT_CODE = '99ExampleAb';
const XHS_SHORT_URL = `https://xhslink.cn/o/${XHS_SHORT_CODE}`;
const RECIPE_URL = 'https://www.xiachufang.com/recipe/107111111/';
const HEAD = '<title>菌菇汤 · 下厨房</title><meta name="author" content="厨房朋友">';

function html(content = HEAD, options: ResponseInit = {}): Response {
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=UTF-8');
  return new Response(`<html><head>${content}</head></html>`, { ...options, headers });
}

function link(url: string) {
  const parsed = normalizeRecipeLink(url);
  assert.ok(parsed);
  return parsed;
}

void test('recognizes copied share text and preserves the parameters needed to open a Xiaohongshu note', () => {
  const copied = `今天想做这个！【菌菇汤】 ${XHS_URL}/?xsec_token=AB%2Bcd%3D&xsec_source=app_share&shareId=remove-me#app，复制打开小红书`;
  assert.deepEqual(normalizeRecipeLink(copied), {
    source: 'xiaohongshu', url: `${XHS_URL}?xsec_token=AB%2Bcd%3D&xsec_source=app_share`, key: `xiaohongshu:${NOTE_ID}`,
  });
  assert.equal(link(`https://m.xiaohongshu.com/discovery/item/${NOTE_ID}`).key, link(XHS_URL).key);
  assert.deepEqual(link(`https://www.rednote.com/zh/discovery/item/${NOTE_ID}?xsec_token=example&track_code=remove-me`), {
    source: 'xiaohongshu', url: `https://www.rednote.com/zh/discovery/item/${NOTE_ID}?xsec_token=example`, key: `xiaohongshu:${NOTE_ID}`,
  });
  assert.deepEqual(normalizeRecipeLink('2 【点开笔记】 http://xhslink.com/o/Abcd23456，复制本条信息'), {
    source: 'xiaohongshu', url: 'https://xhslink.com/o/Abcd23456', key: 'xiaohongshu:share/o/Abcd23456',
  });
  assert.equal(link('https://xhslink.cn/a/Abcd23456').key, link('https://xhslink.com/a/Abcd23456').key);
  assert.deepEqual(normalizeRecipeLink(`【菌菇汤】 ${XHS_SHORT_URL} 复制分享链接`), {
    source: 'xiaohongshu', url: XHS_SHORT_URL, key: `xiaohongshu:share/o/${XHS_SHORT_CODE}`,
  });
});

void test('uses one recipe identity across Xiachufang mobile, desktop and tracked links', () => {
  assert.deepEqual(normalizeRecipeLink('下厨房分享【https://m.xiachufang.com/recipe/107111111?from=share】'), {
    source: 'xiachufang', url: 'https://m.xiachufang.com/recipe/107111111/', key: 'xiachufang:107111111',
  });
  assert.equal(link(RECIPE_URL).key, link('https://mip.xiachufang.com/recipe/107111111/#steps').key);
});

void test('rejects unsupported hosts, authority tricks, paths outside the supported public content and oversized shares', () => {
  for (const raw of [
    'https://www.xiachufang.com.example.org/recipe/107111111/',
    'https://www.xiachufang.com@www.example.org/recipe/107111111/',
    'https://name@www.xiachufang.com/recipe/107111111/',
    'https://@www.xiachufang.com/recipe/107111111/',
    'https://www.xiachufang.com:443/recipe/107111111/',
    'https://www.xiachufang.com./recipe/107111111/',
    'https://www.xiachufang.com\\recipe\\107111111',
    `https://example.org?next=${XHS_URL}`,
    'https://www.xiachufang.com/cook/107111111/',
    'https://www.xiaohongshu.com/explore',
    'https://www.rednote.com/login',
    'https://xhslink.com/not/a/share',
    `${'大'.repeat(8193)} ${RECIPE_URL}`,
    {},
  ]) assert.equal(normalizeRecipeLink(raw), null, JSON.stringify(raw).slice(0, 300));
});

void test('reads only public title, author and explicit recipe data from the expected item', async () => {
  const markup = '<meta property="og:title" content="备用标题"><script type="application/ld+json">' + JSON.stringify({
    '@graph': [
      { '@type': 'Recipe', name: '别的菜', url: 'https://www.xiachufang.com/recipe/107222222/' },
      { '@type': 'Recipe', name: '菌菇汤', mainEntityOfPage: { '@id': RECIPE_URL }, author: { name: '厨房朋友' }, description: '  清淡   适口 ',
        recipeIngredient: ['菌菇 100 克', '水 400 毫升'], recipeInstructions: [
          { '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: '焯水。' }, { '@type': 'HowToStep', text: '加水煮。' }] },
        ] },
    ],
  }) + '</script><script>throw new Error("should never run")</script>';
  assert.deepEqual(await fetchRecipeLinkPreview(link(RECIPE_URL), { fetch: async () => html(markup) }), {
    title: '菌菇汤', author: '厨房朋友', description: '清淡 适口', ingredients: ['菌菇 100 克', '水 400 毫升'], steps: ['焯水。', '加水煮。'],
  });
  assert.deepEqual(await fetchRecipeLinkPreview(link(RECIPE_URL), { fetch: async () => html() }), {
    title: '菌菇汤 · 下厨房', author: '厨房朋友',
  });
  assert.equal(await fetchRecipeLinkPreview(link(RECIPE_URL), { fetch: async () => html(
    `${HEAD}<link rel="canonical" href="/recipe/107222222/">`,
  ) }), null);
});

void test('reads recipe microdata and ignores unstructured body and script data', async () => {
  const page = `<html><head><title>菌菇汤 · 下厨房</title></head><body><article itemscope itemtype="https://schema.org/Recipe">
    <h1 itemprop="name">菌菇汤</h1><a itemprop="author">厨房朋友</a>
    <span itemprop="recipeIngredient">菌菇 100 克</span><span itemprop="recipeIngredient" hidden>忽略该值</span>
    <p itemprop="recipeInstructions">加水煮。</p><p>不要导入普通正文。</p>
    <script>window.__INITIAL_STATE__ = {ingredients: ['不读取']};</script>
  </article></body></html>`;
  const result = await fetchRecipeLinkPreview(link(RECIPE_URL), { fetch: async () => new Response(page, { headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(result, { title: '菌菇汤', author: '厨房朋友', ingredients: ['菌菇 100 克'], steps: ['加水煮。'] });
});

void test('does not request Xiaohongshu notes or shared redirects for a preview', async () => {
  let requests = 0;
  const transport = async () => { requests++; return html(); };
  const short = link(XHS_SHORT_URL);
  for (const source of [
    short,
    link('https://xhslink.com/a/Abcd23456'),
    link(`${XHS_URL}?xsec_token=example`),
    link(`https://www.rednote.com/discovery/item/${NOTE_ID}`),
    { ...short, source: 'xiachufang' as const },
    { ...link(RECIPE_URL), url: XHS_URL },
  ]) assert.equal(await fetchRecipeLinkPreview(source, { fetch: transport }), null);
  assert.equal(requests, 0);
});

void test('follows only bounded same-recipe Xiachufang redirects with anonymous requests', async () => {
  const first = link('https://m.xiachufang.com/recipe/107111111/');
  const sameRecipe = [first.url, 'https://mip.xiachufang.com/recipe/107111111/',
    'https://xiachufang.com/recipe/107111111/', RECIPE_URL];
  const requests: string[] = [];
  const preview = await fetchRecipeLinkPreview(first, { fetch: async (url, init) => {
    assert.equal(typeof url, 'string');
    if (typeof url === 'string') requests.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    if (requests.length < sameRecipe.length) {
      return new Response(null, { status: 302, headers: { location: sameRecipe[requests.length].replace('https:', '') } });
    }
    return html();
  } });
  assert.deepEqual(requests, sameRecipe);
  assert.deepEqual(preview, { title: '菌菇汤 · 下厨房', author: '厨房朋友' });

  for (const target of ['https://example.org', 'https://127.0.0.1/recipe/107111111/',
    'https://www.xiachufang.com/recipe/107222222/', XHS_URL, XHS_SHORT_URL, first.url]) {
    let calls = 0;
    assert.equal(await fetchRecipeLinkPreview(first, { fetch: async () => { calls++; return Response.redirect(target, 302); } }), null);
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(await fetchRecipeLinkPreview(first, { fetch: async () => {
    return Response.redirect(sameRecipe[++calls % sameRecipe.length], 302);
  } }), null);
  assert.equal(calls, sameRecipe.length);
});

void test('treats access restrictions, unsupported bodies, and length violations as unavailable previews', async () => {
  const source = link(RECIPE_URL);
  for (const response of [
    html(HEAD, { status: 403 }),
    html(HEAD, { status: 429 }),
    html('<title>请滑动完成安全验证</title><meta property="og:title" content="菌菇汤">'),
    html(`${HEAD}<meta http-equiv="Refresh" content="0; url=/login">`),
    html(`${HEAD}<meta name="robots" content="nosnippet">`),
    html(HEAD, { headers: { 'x-robots-tag': 'noindex, nosnippet' } }),
    html(HEAD, { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    html(HEAD + ' '.repeat(1024 * 1024)),
    new Response('file', { headers: { 'Content-Type': 'application/pdf' } }),
  ]) assert.equal(await fetchRecipeLinkPreview(source, { fetch: async () => response }), null);
  let calls = 0;
  assert.equal(await fetchRecipeLinkPreview(source, { fetch: async () => {
    calls++;
    return Response.redirect('https://www.xiachufang.com/auth/humancheck_captcha/', 302);
  } }), null);
  assert.equal(calls, 1);
  assert.equal(source.url, RECIPE_URL);
});

void test('aborts the preview deadline even when the fetch transport does not recover', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const promise = fetchRecipeLinkPreview(link(RECIPE_URL), { fetch: async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } });
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(5000);
  assert.equal(await promise, null);
  assert.equal(signal?.aborted, true);
});
