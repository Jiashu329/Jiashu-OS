import { DOMParser } from 'linkedom/worker';

export interface RecipeLinkSource {
  source: 'xiaohongshu' | 'xiachufang';
  url: string;
  key: string;
}

export interface RecipeLinkPreview {
  title?: string;
  author?: string;
  description?: string;
  ingredients?: string[];
  steps?: string[];
}

const XIAOHONGSHU_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com', 'm.xiaohongshu.com']);
const XIAOHONGSHU_SHARE_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const XIACHUFANG_HOSTS = new Set(['xiachufang.com', 'www.xiachufang.com', 'm.xiachufang.com', 'mip.xiachufang.com']);
const MAX_URL_LENGTH = 2048;
const MAX_SHARE_LENGTH = 8192;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const PREVIEW_TIMEOUT_MS = 4000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const GENERIC_TITLE = /^(?:小红书|下厨房|rednote)(?:\s*[-|_·]\s*.*)?$/i;
const ACCESS_TITLE = /访问受限|禁止访问|页面不存在|内容不存在|当前笔记无法浏览|安全验证|人机验证|滑动验证|^请(?:先)?登录|^登录(?:页|下厨房|小红书|\s|$)|^(?:access denied|sign in|log in|security verification|captcha|404 not found)\b/i;
// oxlint-disable-next-line no-control-regex -- Reject characters the URL parser may otherwise discard or reinterpret.
const UNSAFE_URL_CHARACTERS = /[\\\u0000-\u001f\u007f]/;
// oxlint-disable-next-line no-control-regex -- External metadata is returned as display text.
const INVISIBLE_TEXT_CHARACTERS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function sourceUrl(raw: string): RecipeLinkSource | null {
  if (raw.length > MAX_URL_LENGTH || !/^https?:\/\/[a-z0-9.-]+(?=[/?#]|$)/i.test(raw) || /\s/.test(raw) || UNSAFE_URL_CHARACTERS.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.port) return null;
  url.protocol = 'https:';
  url.hash = '';

  if (XIACHUFANG_HOSTS.has(url.hostname)) {
    const id = /^\/recipe\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1];
    if (!id) return null;
    url.pathname = `/recipe/${id}/`;
    url.search = '';
    return { source: 'xiachufang', url: url.href, key: `xiachufang:${id}` };
  }

  if (XIAOHONGSHU_SHARE_HOSTS.has(url.hostname)) {
    const path = /^\/(?:[aom]\/)?[a-z0-9]{4,64}\/?$/i.exec(url.pathname)?.[0]?.replace(/\/$/, '');
    if (!path) return null;
    url.pathname = path;
    url.search = '';
    return { source: 'xiaohongshu', url: url.href, key: `xiaohongshu:share${path}` };
  }

  if (!XIAOHONGSHU_HOSTS.has(url.hostname)) return null;
  const id = /^\/(?:explore|discovery\/item|user\/profile\/[a-f0-9]{24})\/([a-f0-9]{24})\/?$/i.exec(url.pathname)?.[1];
  if (!id) return null;
  url.pathname = url.pathname.replace(/\/$/, '');
  const token = url.searchParams.get('xsec_token');
  const source = url.searchParams.get('xsec_source');
  url.search = '';
  if (token && /^[A-Za-z0-9_+./=-]{1,512}$/.test(token)) url.searchParams.set('xsec_token', token);
  if (source && /^[A-Za-z0-9_-]{1,64}$/.test(source)) url.searchParams.set('xsec_source', source);
  return { source: 'xiaohongshu', url: url.href, key: `xiaohongshu:${id.toLowerCase()}` };
}

/** Parse a supported link or the first supported URL in copied share text. */
export function normalizeRecipeLink(input: unknown): RecipeLinkSource | null {
  if (typeof input !== 'string' || input.length > MAX_SHARE_LENGTH) return null;
  for (const match of input.matchAll(/(?:^|[^A-Za-z0-9_+.:/=-])(https?:\/\/[^\s<>"'“”‘’《》〈〉【】（）。，、；：！？]+)/gi)) {
    const link = sourceUrl(match[1].replace(/[.!?,;:)\]}]+$/, ''));
    if (link) return link;
  }
  return null;
}

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(INVISIBLE_TEXT_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') || undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function authorName(value: unknown): string | undefined {
  const author = Array.isArray(value) ? value[0] : value;
  return cleanText(record(author)?.name ?? author, 100);
}

function publicInstructions(raw: unknown): string[] {
  const steps: string[] = [];
  let examined = 0;
  function add(value: unknown, depth: number): void {
    if (depth > 4 || ++examined > 100 || steps.length >= 24) return;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 24)) add(child, depth + 1);
      return;
    }
    const instruction = record(value);
    const text = cleanText(instruction?.text ?? value, 250);
    if (text) steps.push(text);
    else if (instruction?.itemListElement) add(instruction.itemListElement, depth + 1);
  }
  add(raw, 0);
  return steps;
}

function reference(raw: string, link: RecipeLinkSource): RecipeLinkSource | null {
  if (raw.length > MAX_URL_LENGTH || UNSAFE_URL_CHARACTERS.test(raw)) return null;
  const value = raw.trim();
  try {
    // Check absolute URLs before URL normalization can remove an explicit port.
    const target = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : value.startsWith('//') ? `https:${value}` : new URL(value, link.url).href;
    return sourceUrl(target);
  } catch { return null; }
}

function recipeData(document: ReturnType<DOMParser['parseFromString']>, link: RecipeLinkSource): Record<string, unknown> | undefined {
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 12)) {
    const raw = script.textContent ?? '';
    if (raw.length > 128 * 1024) continue;
    let nodes: unknown[];
    try {
      const json: unknown = JSON.parse(raw);
      const graph = record(json)?.['@graph'];
      nodes = Array.isArray(json) ? json : Array.isArray(graph) ? graph : [json];
    } catch { continue; }
    for (const node of nodes.slice(0, 30)) {
      const item = record(node);
      if (!item || ![item['@type']].flat().some(type => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?Recipe$/i.test(type))) continue;
      const mainEntity = record(item.mainEntityOfPage)?.['@id'] ?? item.mainEntityOfPage;
      const references = [item.url, item['@id'], mainEntity].filter((url): url is string => typeof url === 'string');
      if (!references.length || references.every(url => reference(url, link)?.key === link.key)) return item;
    }
  }
  const scope = document.querySelector('[itemscope][itemtype="https://schema.org/Recipe"], [itemscope][itemtype="http://schema.org/Recipe"]');
  if (!scope) return undefined;
  const values = (property: string) => [...scope.querySelectorAll(`[itemprop~="${property}"]:not([hidden])`)].slice(0, 24)
    .map(node => node.getAttribute('content') ?? node.textContent);
  return { name: values('name')[0], author: values('author')[0], description: values('description')[0],
    recipeIngredient: values('recipeIngredient'), recipeInstructions: values('recipeInstructions') };
}

function excludesPreview(raw: string | null | undefined): boolean {
  return /(?:^|[\s,:])(?:none|nosnippet|noarchive|max-snippet\s*:\s*0)(?:$|[\s,;])/i.test(raw ?? '');
}

function parsePreview(html: string, link: RecipeLinkSource): RecipeLinkPreview | null {
  if (!html.trim() || /<!ENTITY\b|<!DOCTYPE(?!\s+html\s*>)/i.test(html)) return null;
  let tags = 0;
  for (const _ of html.matchAll(/</g)) if (++tags > 25000) return null;
  const document = new DOMParser().parseFromString(html, 'text/html');
  const meta = (selector: string) => document.querySelector(`meta[${selector}]`)?.getAttribute('content');
  if (excludesPreview(meta('name="robots"')) || document.querySelector('meta[http-equiv="refresh" i]')) return null;

  const pageTitle = cleanText(document.querySelector('title')?.textContent, 160);
  const ogTitle = cleanText(meta('property="og:title"'), 160);
  if ((pageTitle && ACCESS_TITLE.test(pageTitle)) || (ogTitle && ACCESS_TITLE.test(ogTitle))) return null;
  for (const url of [meta('property="og:url"'), document.querySelector('link[rel="canonical"]')?.getAttribute('href')]) {
    if (url && reference(url, link)?.key !== link.key) return null;
  }

  const recipe = recipeData(document, link);
  const title = [cleanText(recipe?.name, 160), ogTitle, pageTitle].find(value => value && !GENERIC_TITLE.test(value));
  if (!title) return null;
  const author = authorName(recipe?.author) ?? cleanText(meta('name="author"') ?? meta('property="article:author"'), 100);
  const description = cleanText(recipe?.description ?? meta('property="og:description"') ?? meta('name="description"'), 300);
  const ingredients = Array.isArray(recipe?.recipeIngredient)
    ? recipe.recipeIngredient.slice(0, 24).map(value => cleanText(value, 120)).filter((value): value is string => Boolean(value)) : [];
  const steps = publicInstructions(recipe?.recipeInstructions);
  return { title, ...(author ? { author } : {}), ...(description ? { description } : {}),
    ...(ingredients.length ? { ingredients } : {}), ...(steps.length ? { steps } : {}) };
}

function cancel(response: Response): void { void response.body?.cancel().catch(() => {}); }

async function readHtml(response: Response, signal: AbortSignal): Promise<string | null> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !response.body || (type !== 'text/html' && type !== 'application/xhtml+xml') ||
    Number(response.headers.get('content-length')) > MAX_HTML_BYTES || excludesPreview(response.headers.get('x-robots-tag'))) {
    cancel(response);
    return null;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  let size = 0;
  let html = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return signal.aborted ? null : html + decoder.decode();
      size += chunk.value.byteLength;
      if (size > MAX_HTML_BYTES) return null;
      html += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}

async function readPreview(initial: RecipeLinkSource, transport: typeof fetch, signal: AbortSignal): Promise<RecipeLinkPreview | null> {
  let link = initial;
  const seen = new Set<string>();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (signal.aborted || seen.has(link.url)) return null;
    seen.add(link.url);
    const response = await transport(link.url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'text/html, application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    if (signal.aborted || response.redirected) { cancel(response); return null; }
    const shortLink = link.key.startsWith('xiaohongshu:share/');
    if (REDIRECT_CODES.has(response.status)) {
      const target = response.headers.get('location');
      cancel(response);
      const resolved = target ? reference(target, link) : null;
      if (!resolved || resolved.source !== initial.source || (!shortLink && resolved.key !== link.key)) return null;
      link = resolved;
      continue;
    }
    if (shortLink) { cancel(response); return null; }
    const html = await readHtml(response, signal);
    return html === null ? null : parsePreview(html, link);
  }
  return null;
}

/** Best-effort anonymous preview. Its failure never invalidates the source link. */
export async function fetchRecipeLinkPreview(link: RecipeLinkSource, options: { fetch?: typeof fetch } = {}): Promise<RecipeLinkPreview | null> {
  const normalized = sourceUrl(link.url);
  if (!normalized || normalized.source !== link.source || normalized.key !== link.key) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, PREVIEW_TIMEOUT_MS); });
  try { return await Promise.race([readPreview(normalized, options.fetch ?? fetch, controller.signal), deadline]); }
  catch { return null; }
  finally { clearTimeout(timer); controller.abort(); }
}
