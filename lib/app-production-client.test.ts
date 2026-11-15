import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeUserCoverUrl, userCoverDescriptor, type UserCoverDescriptor } from './douban-cover-selection.ts';
import ts from 'typescript';
import { buildHomeOverview } from './home-overview.ts';
import { buildHealthSummary, type HealthMeasurement } from './health.ts';
import { ACCOUNT_TYPES, CURRENCIES, buildFinanceSummary } from './finance.ts';
import { buildNutritionReview, parseNutritionQuery } from './nutrition.ts';
import { buildNutritionInsight, parseNutritionInsightQuery } from './nutrition-review.ts';
import { EMPTY_NUTRITION_GOALS } from './nutrition-goals.ts';
import { calculateNutritionNeeds, parseNutritionNeedsInput, type NutritionNeedsInput } from './nutrition-needs.ts';
import { buildHealthWeeklyReview, parseHealthWeekQuery, type HealthWeeklyReview } from './health-weekly.ts';
import { buildHealthWeeklyFocus } from './health-weekly-focus.ts';
import { emptyGoalSettings } from './health-goals.ts';
import type { DoubanRecord, DoubanConnection } from '../db/douban-store.ts';
import type { DoubanRecordInput } from './douban.ts';
import type { DoubanSubjectMetadata } from './douban-metadata.ts';
import { mergeDoubanDetails } from './douban-details.ts';
import { doubanMissingFields, type DoubanLocalRecord } from './douban-library.ts';
import { FOOD_CATALOG_SOURCES, getFood } from './food-catalog.ts';
import { FOOD_LIBRARY_BRANDS, foodLibraryCategories, browseFoodLibrary, getLibraryFood } from './food-library-catalog.ts';
import { foodCatalogImages } from './food-catalog-images.ts';
import { browseUnifiedFoodLibrary, unifiedLibraryFood } from './food-library-service.ts';
import { personalLibraryFood } from './personal-food-library.ts';
import { parseNutritionTemplate, type NutritionTemplate } from './nutrition-templates.ts';
import type { ManagedLibraryFood } from './managed-food-catalog.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notifications.ts';

// These are minified-output DOM checks. They exercise initialization and actions,
// not browser layout, CSS rendering, touch hit testing or iPhone integration.
const directory = resolve(import.meta.dirname, '../dist/server/_next/static');
const hasBuild = existsSync(directory);
// Node 22.13 supports asynchronous ESM loader registration; registerHooks is
// deliberately avoided so the release gate uses the supported Node baseline.
register(new URL('../scripts/worker-renderer-loader.mjs', import.meta.url), import.meta.url);
const htmlCache = new Map<string, Promise<string>>();
function rendererModule(original: string, path: string, marker: string): string | null {
  const tree = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map<string, ts.Node>();
  const responseBodies: ts.Expression[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer.body);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Response' && node.arguments?.[0]) responseBodies.push(node.arguments[0]);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith('.')) replacements.push({ start: node.moduleSpecifier.getStart(tree), end: node.moduleSpecifier.end,
        value: JSON.stringify(new URL(node.moduleSpecifier.text, pathToFileURL(path)).href) });
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const renderers = new Set<string>();
  for (const body of responseBodies) {
    // Response(withPageAccount(renderPage(owner), owner), options): follow the
    // HTML argument through wrappers and expose only the actual local renderer.
    // Looking at AST calls avoids matching serialized browser code in strings.
    let current = body;
    while (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) {
        const name = current.expression.text;
        if (functions.get(name)?.getText(tree).includes(marker)) renderers.add(name);
      }
      if (!current.arguments[0]) break;
      current = current.arguments[0];
    }
  }
  if (!renderers.size) return null;
  // Resolve only real module specifiers. Renderer bodies and the browser source
  // inside their template literals remain byte-for-byte as built.
  let source = original;
  for (const change of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, change.start) + change.value + source.slice(change.end);
  return source + '\nexport {' + [...renderers].map((name, index) => name + ' as __renderer' + index).join(',') + '};';
}
function productionHtml(marker: string) {
  if (!htmlCache.has(marker)) htmlCache.set(marker, (async () => {
    const candidates = readdirSync(directory).filter((name) => name.endsWith('.js') && readFileSync(resolve(directory, name), 'utf8').includes(marker));
    for (const name of candidates) {
      const path = resolve(directory, name), original = readFileSync(path, 'utf8');
      const source = rendererModule(original, path, marker);
      if (!source) continue;
      const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')) as Record<string, unknown>;
      for (const [name, value] of Object.entries(module)) {
        if (!name.startsWith('__renderer') || typeof value !== 'function') continue;
        const html: unknown = value('synthetic-production-owner');
        if (typeof html === 'string' && html.startsWith('<!doctype html>') && html.includes(marker)) return html;
      }
    }
    throw new Error('No minified production renderer for ' + marker);
  })());
  return htmlCache.get(marker)!;
}
async function settle(check: () => boolean) {
  for (let count = 0; count < 60; count++) {
    if (check()) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.ok(check(), 'The built client must finish initialization');
}
async function settleWork(check: () => boolean, description: () => string) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise<void>(done => setTimeout(done, 10));
  assert.ok(check(), description());
}
function storage(seed: Record<string,string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return { getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, String(value)); }, removeItem(key: string) { values.delete(key); }, clear() { values.clear(); }, snapshot() { return Object.fromEntries(values); } };
}
type SyntheticTMDBCover = { imdbId: string; mediaType: 'movie' | 'tv'; tmdbId: number; posterPath: string; language: 'zh' | 'en' | null; matchedAt: string };
type SyntheticTMDBResult = { status: 'matched' | 'not_configured' | 'missing_imdb' | 'no_match' | 'ambiguous' | 'episode_only' | 'no_poster' | 'rate_limited' | 'unavailable'; cover?: SyntheticTMDBCover; message?: string; retryAfter?: number };
async function fixture(marker: string, path: string, width = 1280, seedStorage: Record<string,string> = {}, catalog: { foods: readonly unknown[]; sources?: readonly unknown[]; aiCanManage?: boolean; aiConfigured?: boolean; tmdbCanManage?: boolean; tmdbConfigured?: boolean; financeBooks?: Array<Record<string, unknown>>; personalTemplates?: NutritionTemplate[]; managedFoods?: ManagedLibraryFood[]; managedOverrides?: string[]; canManageLibrary?: boolean; nutritionNeeds?: 'ready' | 'unavailable'; weeklyReview?: HealthWeeklyReview; douban?: { connection: DoubanConnection; items: DoubanRecord[]; dataEpoch?: number; lastRun?: unknown; allowReset?: boolean; allowImportPreview?: boolean; allowMetadata?: boolean; allowClassification?: boolean; allowCoverSelection?: boolean; allowTMDB?: boolean; tmdbResults?: Record<string, SyntheticTMDBResult>; browserExtensionItems?: DoubanRecordInput[]; browserSubjectMetadata?: Record<string, DoubanSubjectMetadata>; browserExtensionVersion?: string } } = { foods: [] }) {
  const html = await productionHtml(marker);
  const { window, document } = parseHTML(html);
  for (const input of document.querySelectorAll('input[type=checkbox]')) (input as unknown as HTMLInputElement).checked = input.hasAttribute('checked');
  // Linkedom delegates host globals between windows. Browser capabilities are
  // opt-in per fixture, so an earlier extension mock cannot affect fallback.
  Object.defineProperty(window, 'chrome', { configurable: true, value: undefined });
  Object.defineProperty(window, 'navigator', { configurable: true, value: {} });
  Object.defineProperty(window,'__JIASHU_PAGE_OWNER__',{value:'synthetic-production-owner',configurable:false});
  let current = new URL(path, 'https://synthetic-production.example');
  const location = {
    get origin() { return current.origin; }, get pathname() { return current.pathname; },
    get search() { return current.search; }, get hash() { return current.hash; }, get href() { return current.href; },
    replace(path: string) { current = new URL(path, current); },
  };
  const history = { state: null,
    replaceState(_data: unknown, _unused: string, path: string) { current = new URL(path, current); },
    pushState(_data: unknown, _unused: string, path: string) { current = new URL(path, current); } };
  document.querySelectorAll('dialog').forEach((dialog) => {
    Object.defineProperty(dialog,'open',{configurable:true,get(){return dialog.hasAttribute('open');}});
    Object.assign(dialog, {
      showModal() { dialog.setAttribute('open', ''); },
      close() { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); },
    });
  });
  // Dynamic dialogs create selects after initialization; model the native prototype setter.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const option = this.querySelector('option[selected]') ?? this.querySelector('option'); return option?.getAttribute('value') ?? option?.textContent ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === String(value)) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  document.querySelectorAll('form').forEach((form) => Object.assign(form, { reset() {
    form.querySelectorAll('input,textarea,select').forEach((element) => {
      const field = element as unknown as HTMLInputElement;
      field.value = element.tagName === 'SELECT' ? element.querySelector('option')?.getAttribute('value') ?? '' : element.getAttribute('value') ?? '';
    });
  } }));
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  const sessionStorage = storage(seedStorage);
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorage, configurable: true });
  const localStorage = storage();
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  const requests: Array<{ path: string; method: string }> = [];
  const identityRequests: Array<{ path: string; method: string }> = [];
  const needsBodies: NutritionNeedsInput[] = [];
  const doubanImportBodies: Array<Record<string, unknown>> = [];
  const doubanMetadataBodies: Array<Record<string, unknown>> = [];
  const doubanClassificationBodies: Array<Record<string, unknown>> = [];
  const doubanExtensionMessages: Array<Record<string, unknown>> = [];
  const doubanResetBodies: Array<Record<string, unknown>> = [];
  const doubanCoverSelectionBodies: Array<Record<string, unknown>> = [];
  const doubanTMDBBodies: Array<Record<string, unknown>> = [];
  const browserReceipts = new Map<string, Record<string, unknown>>();
  const resetReceipts = new Map<string, Record<string, unknown>>();
  if (catalog.douban?.browserExtensionItems || catalog.douban?.browserSubjectMetadata) {
    const imported = catalog.douban.browserExtensionItems ?? [];
    const source = (complete = false) => ({ status: complete ? 'complete' : 'pending', pages: complete ? 1 : 0, received: 0, total: complete ? 0 : null, errorCode: null });
    const progress = (complete = false) => ({ status: complete ? 'completed' : 'running', sources: { screen: source(complete), book: { ...source(complete), received: complete ? imported.length : 0, total: complete ? imported.length : null }, music: source(complete) }, received: complete ? imported.length : 0, pages: complete ? 3 : 0, accountProfileId: catalog.douban!.connection.profileId });
    Object.defineProperty(window, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Chrome/133.0.0.0 Safari/537.36' } });
    Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: { lastError: null, sendMessage(id: string, body: Record<string, unknown>, callback: (response: unknown) => void) {
      assert.equal(id, 'gbcgjkicjfbaakippafhhpadfkfifaeb'); doubanExtensionMessages.push(structuredClone(body));
      const data = body.action === 'START' ? { runId: '11111111-1111-4111-8111-111111111111', step: 0, done: false, progress: progress() }
        : body.action === 'STEP' ? { runId: body.runId, step: Number(body.step) + 1, done: true, items: imported, progress: progress(true) }
          : body.action === 'SUBJECT' ? { requestId: body.requestId, domain: body.domain, subjectId: body.subjectId, metadata: catalog.douban!.browserSubjectMetadata?.[body.domain + ':' + body.subjectId] }
            : body.action === 'SUBJECT_CANCEL' ? { cancelled: true } : { extensionVersion: catalog.douban!.browserExtensionVersion ?? '1.0.4', protocolVersion: 1 };
      queueMicrotask(() => callback({ ok: true, data }));
    } } } });
  }
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overview = buildHomeOverview({ health: { summary: buildHealthSummary([]), lastSync: null }, personal: { accounts: [] }, family: { accounts: [] }, nutrition: { entries: [], statuses: [], goals: EMPTY_NUTRITION_GOALS } });
  const fetch = async (url: string | URL, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET';
    // Initializing any page must remain read-only, even when session storage
    // contains another signed-in owner's original pending requests.
    if (method === 'POST' && path === '/api/health/nutrition/needs' && catalog.nutritionNeeds) {
      requests.push({ path, method });
      const input = parseNutritionNeedsInput(JSON.parse(String(options?.body)));
      needsBodies.push(input);
      return Response.json({ estimate: calculateNutritionNeeds(input), ai: catalog.nutritionNeeds === 'ready'
        ? { status: 'ready', text: '静息代谢与日常维持需求不同，活动程度会影响估算。', message: null, provider: 'MiniMax', model: 'MiniMax-M3' }
        : { status: 'unavailable', text: null, message: 'AI 解读暂不可用，公式估算仍可参考。' } });
    }
    if (method === 'POST' && path === '/api/life/douban/import' && (catalog.douban?.allowImportPreview || catalog.douban?.browserExtensionItems)) {
      requests.push({ path, method });
      const body = JSON.parse(String(options?.body));
      doubanImportBodies.push(body);
      assert.equal(body.expectedDataEpoch, catalog.douban.dataEpoch ?? 0, 'every minified import pins the current data epoch');
      assert.ok(Array.isArray(body.items));
      const plans = (body.items as DoubanRecordInput[]).map(input => {
        const index = catalog.douban!.items.findIndex(item => item.profileId === body.profile && item.domain === input.domain && item.subjectId === input.subjectId), old = catalog.douban!.items[index];
        const next = { ...old, ...input, profileId: body.profile } as DoubanRecord;
        if (old) {
          if (input.kind === 'screen' && ['movie', 'series'].includes(old.kind)) next.kind = old.kind;
          next.coverUrl = input.coverUrl ?? old.coverUrl;
        }
        const details = mergeDoubanDetails(old?.details, input.details);
        if (Object.keys(details).length) next.details = details;
        const fields = ['title', 'kind', 'coverUrl', 'rating', 'markedDate', 'comment', 'publishedAt', 'source', 'details'] as const;
        const changed = Boolean(old && fields.some(key => JSON.stringify(old[key]) !== JSON.stringify(next[key])));
        return { index, old, next, changed };
      });
      const added = plans.filter(plan => !plan.old).length, updated = plans.filter(plan => plan.changed).length;
      if (body.action === 'preview') return Response.json({ preview: { profileId: body.profile, dataEpoch: catalog.douban.dataEpoch ?? 0, profileUrl: 'https://www.douban.com/people/' + body.profile + '/',
        snapshotHash: 'a'.repeat(64), total: body.items.length, added, updated, unchanged: body.items.length - added - updated } });
      assert.ok(catalog.douban.browserExtensionItems, 'file-preview fixtures never commit private records');
      assert.equal(body.action, 'commit'); assert.equal(body.confirmed, true);
      if (!browserReceipts.has(body.requestId)) {
        for (const plan of plans) {
          const stamp = '2026-11-14T12:00:00.000Z', persisted: DoubanRecord = { ...plan.next, observedAt: stamp, createdAt: plan.old?.createdAt ?? stamp,
            updatedAt: plan.changed ? new Date(Date.parse(plan.old.updatedAt) + 1).toISOString() : plan.old?.updatedAt ?? stamp, metadataCheckedRunId: plan.old?.metadataCheckedRunId ?? null };
          if (plan.old) catalog.douban.items[plan.index] = persisted;
          else catalog.douban.items.push(persisted);
        }
        browserReceipts.set(body.requestId, { profileId: body.profile, dataEpoch: catalog.douban.dataEpoch ?? 0, requestId: body.requestId, total: body.items.length, added, updated, unchanged: body.items.length - added - updated });
      }
      return Response.json({ receipt: browserReceipts.get(body.requestId), ...(body.returnRecords === true ? { records: body.items.map((input: DoubanRecordInput) => catalog.douban!.items.find(item => item.profileId === body.profile && item.domain === input.domain && item.subjectId === input.subjectId)) } : {}) });
    }
    if (method === 'POST' && path === '/api/life/douban/reset' && catalog.douban?.allowReset) {
      requests.push({ path, method }); const body = JSON.parse(String(options?.body)); doubanResetBodies.push(body);
      const dataEpoch = catalog.douban.dataEpoch ?? 0, counts = { all: catalog.douban.items.length, movie: 0, series: 0, screen: 0, book: 0, music: 0 };
      for (const item of catalog.douban.items) counts[item.kind]++;
      if (body.action === 'preview') return Response.json({ preview: { epoch: dataEpoch, total: counts.all, counts, latestUpdatedAt: catalog.douban.items.map(item => item.updatedAt).sort().at(-1) ?? null, previewHash: 'b'.repeat(64) } });
      assert.equal(body.action, 'commit'); assert.equal(body.confirmed, true);
      if (resetReceipts.has(body.requestId)) return Response.json({ receipt: resetReceipts.get(body.requestId) });
      assert.equal(body.expectedEpoch, dataEpoch); assert.equal(body.expectedPreviewHash, 'b'.repeat(64));
      const receipt = { requestId: body.requestId, epoch: dataEpoch + 1, deleted: counts.all, counts, clearedAt: '2026-11-14T12:00:00.000Z' };
      resetReceipts.set(body.requestId, receipt); catalog.douban.dataEpoch = dataEpoch + 1; catalog.douban.items.splice(0); catalog.douban.lastRun = null; browserReceipts.clear();
      catalog.douban.connection = { ...catalog.douban.connection, revision: catalog.douban.connection.revision + 1, updatedAt: receipt.clearedAt };
      return Response.json({ receipt });
    }
    if (catalog.douban && (['POST', 'PUT'].includes(method) && path === '/api/life/douban/metadata' && catalog.douban.allowMetadata
      || method === 'PUT' && path === '/api/life/douban/classification' && catalog.douban.allowClassification)) {
      requests.push({ path, method });
      const body = JSON.parse(String(options?.body));
      const index = catalog.douban.items.findIndex(item => item.profileId === body.profileId && item.domain === body.domain && item.subjectId === body.subjectId);
      assert.ok(index >= 0, 'enrichment can only address an owned saved record');
      const previous = catalog.douban.items[index];
      assert.equal(body.expectedUpdatedAt, previous.updatedAt);
      const updatedAt = new Date(Date.parse(previous.updatedAt) + 1).toISOString();
      const item: DoubanRecord = { ...previous, updatedAt, observedAt: updatedAt };
      if (path === '/api/life/douban/metadata') {
        doubanMetadataBodies.push(body); assert.equal(body.confirmed, true);
        assert.equal(body.expectedDataEpoch ?? 0, catalog.douban.dataEpoch ?? 0);
        if (method === 'PUT') {
          if (body.metadata.coverUrl) item.coverUrl = body.metadata.coverUrl;
          if (body.metadata.kind && item.metadataCheckedRunId !== 'manual-kind') item.kind = body.metadata.kind;
          const details = mergeDoubanDetails(item.details, body.metadata.details);
          if (Object.keys(details).length) item.details = details;
        } else {
          item.coverUrl = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123450.jpg';
          if (item.domain === 'screen' && item.metadataCheckedRunId !== 'manual-kind') item.kind = 'series';
        }
      } else {
        doubanClassificationBodies.push(body); assert.ok(['movie', 'series'].includes(body.kind));
        item.kind = body.kind; item.metadataCheckedRunId = 'manual-kind';
      }
      catalog.douban.items[index] = item;
      return Response.json(path === '/api/life/douban/metadata' ? { item, changed: true, dataEpoch: catalog.douban.dataEpoch ?? 0, metadata: { status: 'complete' } } : { item });
    }
    if (method === 'POST' && path === '/api/life/douban/tmdb' && catalog.douban?.allowTMDB) {
      requests.push({ path, method });
      const body = JSON.parse(String(options?.body)); doubanTMDBBodies.push(body);
      assert.equal(body.expectedDataEpoch, catalog.douban.dataEpoch ?? 0);
      assert.equal(body.domain, 'screen'); assert.equal(body.confirmed, true);
      const index = catalog.douban.items.findIndex(item => item.profileId === body.profileId && item.domain === body.domain && item.subjectId === body.subjectId);
      assert.ok(index >= 0, 'TMDB lookup addresses only a saved owned work');
      const previous = catalog.douban.items[index] as DoubanRecord & { tmdb?: SyntheticTMDBCover | null };
      const result = catalog.douban.tmdbResults?.[previous.subjectId];
      assert.ok(result, 'every synthetic TMDB outcome is explicitly configured');
      const saved = result.status === 'matched' && previous.tmdb?.imdbId === previous.details?.imdbId && JSON.stringify(previous.tmdb) === JSON.stringify(result.cover);
      assert.ok(saved || body.expectedUpdatedAt === previous.updatedAt, 'TMDB pins the newly saved metadata version, or replays the same saved match');
      const item = { ...previous };
      if (result.status === 'matched' && !saved) {
        assert.ok(result.cover); assert.equal(result.cover.imdbId, item.details?.imdbId);
        item.tmdb = structuredClone(result.cover); item.updatedAt = new Date(Date.parse(previous.updatedAt) + 1).toISOString();
        catalog.douban.items[index] = item;
      }
      return Response.json({ item, changed: result.status === 'matched' && !saved, dataEpoch: catalog.douban.dataEpoch ?? 0,
        tmdb: { status: result.status, ...(result.message ? { message: result.message } : {}), ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
        ...(['rate_limited', 'unavailable'].includes(result.status) ? { error: result.message ?? 'TMDB 暂不可用。', code: result.status === 'rate_limited' ? 'TMDB_RATE_LIMITED' : 'TMDB_UNAVAILABLE' } : {}) },
        { status: result.status === 'rate_limited' ? 429 : result.status === 'unavailable' ? 503 : 200, ...(result.retryAfter ? { headers: { 'Retry-After': String(result.retryAfter) } } : {}) });
    }
    if (method === 'PUT' && path === '/api/life/douban/cover-selection' && catalog.douban?.allowCoverSelection) {
      requests.push({ path, method });const body=JSON.parse(String(options?.body));doubanCoverSelectionBodies.push(body);
      assert.equal(body.expectedDataEpoch,catalog.douban.dataEpoch??0,'selected covers pin the active epoch');
      const index=catalog.douban.items.findIndex(item=>item.profileId===body.profileId&&item.domain===body.domain&&item.subjectId===body.subjectId),previous=catalog.douban.items[index] as DoubanRecord & {local?:DoubanLocalRecord;cover?:UserCoverDescriptor};
      assert.ok(previous);assert.equal(body.expectedLocalRevision,previous.local?.revision??0,'selected covers pin the personal edit version');
      const selected=body.mode==='url'?normalizeUserCoverUrl(body.url):null,revision=(previous.local?.revision??0)+1;
      const item={...previous,local:{note:'',tags:[],hidden:false,...previous.local,revision},cover:userCoverDescriptor(selected,revision)};catalog.douban.items[index]=item;
      return Response.json({item,dataEpoch:catalog.douban.dataEpoch??0});
    }
    if (method !== 'GET') { requests.push({ path, method }); throw new Error('Unexpected automatic production write: ' + method + ' ' + path); }
    // The account chrome now performs an independent identity read. Preserve
    // the business-call assertions below while also enforcing its read-only,
    // payload-free contract instead of counting it as a data/model operation.
    if (path === '/api/session') {
      assert.equal(options?.body, undefined, 'identity checks cannot send cached form or draft contents');
      identityRequests.push({ path, method });
      return Response.json({ userId: 'synthetic-production-owner', displayName: 'Synthetic account', email: 'synthetic@example.invalid', isOwner: false });
    }
    requests.push({ path, method });
    if (path === '/api/overview') return Response.json(overview);
    if (path === '/api/finance/books') return Response.json({ books: catalog.financeBooks ?? [{ id: 'own', name: '我的家庭账本', ownerName: 'Synthetic account', role: 'owner', accessRevision: 0, canManageMembers: true, canExport: true }], invitations: [] });
    if (path.startsWith('/api/finance?')) { const ledger = new URL(path, location.origin).searchParams.get('ledger') === 'family' ? 'family' : 'personal'; return Response.json({ ledger, accounts: [], summary: buildFinanceSummary([], ledger), meta: { today, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES } }); }
    if (path === '/api/ai/settings') return Response.json({ scope: 'site', canManage: catalog.aiCanManage !== false, settings: { configured: catalog.aiConfigured === true, model: 'MiniMax-M3', region: 'cn', revision: 0, updatedAt: null, lastTestStatus: null, lastTestAt: null }, storageReady: true });
    if (path === '/api/media/tmdb/settings') return Response.json({ scope: 'site', canManage: catalog.tmdbCanManage !== false, settings: { configured: catalog.tmdbConfigured === true, revision: 3, updatedAt: null, lastTestStatus: null, lastTestAt: null }, storageReady: true });
    if (path === '/api/health/import') return Response.json({ checkedAt: new Date().toISOString(), attempts: [], batches: [], metricStatus: [] });
    const parsed = new URL(path, location.origin);
    if (parsed.pathname === '/api/life/douban/cover') {
      const item = catalog.douban?.items.find(value => value.profileId === parsed.searchParams.get('profileId') && value.domain === parsed.searchParams.get('domain') && value.subjectId === parsed.searchParams.get('subjectId'));
      assert.ok(item?.coverUrl, 'an explicit cover retry addresses only a stored owned image');
      assert.equal(options?.credentials, 'same-origin');
      return new Response(readFileSync(resolve(import.meta.dirname, '../public/brand/favicon-32.png')), { headers: { 'Content-Type': 'image/png' } });
    }
    if (parsed.pathname === '/api/life/douban') {
      const connection = catalog.douban?.connection ?? { profileId: null, revision: 0, updatedAt: null };
      const params = parsed.searchParams, query = params.get('q') ?? '', kind = params.get('kind') ?? '';
      const local = (item: DoubanRecord) => (item as DoubanRecord & { local?: DoubanLocalRecord }).local ?? { note: '', tags: [], hidden: false, revision: 0 };
      const scoped = (catalog.douban?.items ?? []).filter(item => (params.get('profile') !== 'current' || item.profileId === connection.profileId)
        && (params.get('hidden') === 'all' || local(item).hidden === (params.get('hidden') === 'hidden')));
      const years = [...new Set(scoped.filter(item => item.markedDate).map(item => Number(item.markedDate!.slice(0, 4))))].sort((left, right) => right - left);
      const tags = [...new Set(scoped.flatMap(item => local(item).tags))].sort();
      const rows = scoped.filter(item => [item.title, item.comment ?? '', local(item).note, ...local(item).tags, ...(item.details?.authors ?? []), ...(item.details?.directors ?? []), ...(item.details?.artists ?? [])].some(value => value.includes(query))
        && (!params.get('rating') || (params.get('rating') === 'unrated' ? item.rating === null : item.rating === Number(params.get('rating'))))
        && (!params.get('year') || item.markedDate?.startsWith(params.get('year')! + '-'))
        && (!params.get('tag') || local(item).tags.includes(params.get('tag')!))
        && (params.get('missing') !== '1' || doubanMissingFields(item).length > 0));
      const counts = { all: rows.length, movie: 0, series: 0, screen: 0, book: 0, music: 0 };
      for (const item of rows) counts[item.kind]++;
      const filtered = rows.filter(item => !kind || kind === 'all' || item.kind === kind);
      const sort = params.get('sort');
      if (sort === 'rating-asc' || sort === 'rating-desc') filtered.sort((left, right) => left.rating === null ? right.rating === null ? 0 : 1 : right.rating === null ? -1 : (left.rating - right.rating) * (sort === 'rating-asc' ? 1 : -1));
      else if (sort === 'date-asc') filtered.sort((left, right) => (left.markedDate ?? '').localeCompare(right.markedDate ?? ''));
      const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 24);
      return Response.json({ dataEpoch: catalog.douban?.dataEpoch ?? 0, connection: { ...connection, profileUrl: connection.profileId ? 'https://www.douban.com/people/' + connection.profileId + '/' : null },
        items: filtered.slice(offset, offset + limit).map(item => {const selected=(item as DoubanRecord & {cover?:UserCoverDescriptor}).cover;return { ...item, local: local(item),cover:userCoverDescriptor(selected?.mode==='url'?selected.url:null,local(item).revision) };}), years, tags, total: filtered.length, counts, offset, limit, hasMore: offset + limit < filtered.length, lastRun: catalog.douban?.lastRun ?? null });
    }
    if (parsed.pathname === '/api/health/review') {
      const review = catalog.weeklyReview ?? buildHealthWeeklyReview([], emptyGoalSettings(), parseHealthWeekQuery(parsed.searchParams));
      return Response.json({ ...review, focus: buildHealthWeeklyFocus(review) });
    }
    const emptyMealStates = { breakfast:'unrecorded',lunch:'unrecorded',dinner:'unrecorded',snack:'unrecorded' } as const;
    if (parsed.pathname === '/api/health/nutrition') {
      const selection = parseNutritionQuery(parsed.searchParams);
      return Response.json({...buildNutritionReview([],selection),recentFoods:[],dayStatus:{date:selection.date,complete:false,revision:0,meals:emptyMealStates}});
    }
    if (parsed.pathname === '/api/health/foods/manage') return Response.json({canManage:true,items:[],builtin:[0,50,100,150].flatMap(offset=>browseFoodLibrary({offset,limit:50}).foods),images:{}});
    if (parsed.pathname === '/api/notifications') return Response.json({items:[],total:0,unreadCount:0,unreadIds:[],offset:0,limit:20,hasMore:false,unavailable:[],truncated:false,settings:{categories:DEFAULT_NOTIFICATION_PREFERENCES,revision:0,updatedAt:null}});
    if (/^\/api\/finance\/books\/[^/]+\/activity$/.test(parsed.pathname)) return Response.json({items:[],offset:0,limit:30,hasMore:false});
    if (parsed.pathname === '/api/health/foods') {
      const blocked=new Set(catalog.managedOverrides??[]);
      const snapshot={publicFoods:[...[0,50,100,150].flatMap(offset=>browseFoodLibrary({offset,limit:50}).foods).filter(food=>!blocked.has(food.id)),...(catalog.managedFoods??[])],personalFoods:(catalog.personalTemplates??[]).map(item=>personalLibraryFood(item)),overrides:[...blocked],canManage:catalog.canManageLibrary===true};
      if (parsed.searchParams.has('id')) {
        const food=unifiedLibraryFood(snapshot,parsed.searchParams.get('id')!);
        const images=food?foodCatalogImages([food]):{};
        if(food?.basis==='managed'&&food.image)images[food.id]=food.image;
        return food?Response.json({food,images}):Response.json({code:'FOOD_NOT_FOUND',error:'当前食物库中没有这项食品。'}, {status:404});
      }
      return Response.json(browseUnifiedFoodLibrary(snapshot,{query:parsed.searchParams.get('q')??'',category:parsed.searchParams.get('category')??'',brand:parsed.searchParams.get('brand')??'',scope:parsed.searchParams.get('scope')??'all',offset:Number(parsed.searchParams.get('offset')??0),limit:Number(parsed.searchParams.get('limit')??24)}));
    }
    if (parsed.pathname === '/api/health/nutrition/foods') {
      if (parsed.searchParams.has('id')) {
        const food = getFood(parsed.searchParams.get('id')!);
        return food ? Response.json({food}) : Response.json({code:'FOOD_NOT_FOUND',error:'当前食物库中没有这项食品。'}, {status:404});
      }
      return Response.json({foods:catalog.foods,...(catalog.sources?{sources:catalog.sources}:{})});
    }
    if (parsed.pathname === '/api/health/nutrition/goals') return Response.json({ goals: EMPTY_NUTRITION_GOALS, weightPlan: null });
    if (parsed.pathname === '/api/health/nutrition/templates') return Response.json({ templates: catalog.personalTemplates??[] });
    if (/^\/api\/health\/nutrition\/templates\/[^/]+$/.test(parsed.pathname)) {const id=parsed.pathname.split('/').pop();const template=catalog.personalTemplates?.find(item=>item.id===id);return template?Response.json({template}):Response.json({error:'模板不存在'}, {status:404});}
    if (parsed.pathname === '/api/health/nutrition/reuse') return Response.json({favorites:[],recent:[]});
    if (parsed.pathname === '/api/health/nutrition/favorites') return Response.json({favorites:[]});
    if (parsed.pathname === '/api/health/nutrition/status') return Response.json({dayStatus:{date:parsed.searchParams.get('date') ?? today,complete:false,revision:0,meals:emptyMealStates}});
    if (parsed.pathname === '/api/health/nutrition/review') return Response.json(buildNutritionInsight([],[],parseNutritionInsightQuery(parsed.searchParams)));
    if (path.startsWith('/api/health/assistant?')) return Response.json({ configuration: { ready: false, provider: 'MiniMax', model: 'MiniMax-M3', message: '请先设置连接' }, hasData: false,
      context: { version: 1, timezone: 'Asia/Shanghai', range: { from: today, to: today, today, days: 7 }, health: [], nutrition: { recordedDays: 0, days: [] }, limitations: ['暂无合成测试记录'] }, sources: [] });
    throw new Error('Unexpected production client request: ' + method + ' ' + path);
  };
  const context = { window, document, location, history, navigator: {}, sessionStorage, localStorage, fetch, URL, Blob, URLSearchParams, TextEncoder, TextDecoder, AbortController, DOMParser: window.DOMParser,
    crypto: webcrypto, Intl, Date, Event: window.Event, Element: window.Element, innerWidth: width,
    Headers, setTimeout, clearTimeout, queueMicrotask, requestAnimationFrame: (callback: () => void) => { callback(); return 0; } };
  for (const [index, script] of [...document.querySelectorAll('script')].entries()) {
    if (script.getAttribute('src') || !script.textContent?.trim()) continue;
    runInNewContext(script.textContent, context, { timeout: 2000, filename: 'built-app-inline-' + index + '.js' });
  }
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  assert.ok(identityRequests.every((request) => request.path === '/api/session' && request.method === 'GET'));
  return { window, document, requests, identityRequests, html, sessionStorage, localStorage, needsBodies, doubanImportBodies, doubanMetadataBodies, doubanClassificationBodies, doubanExtensionMessages, doubanResetBodies, doubanCoverSelectionBodies, doubanTMDBBodies, location };
}

function openMediaTools(f: Awaited<ReturnType<typeof fixture>>, section: 'browser' | 'public' | 'import' | 'manage') {
  const event = () => new f.window.Event('click', { bubbles: true, cancelable: true });
  f.document.getElementById('douban-tools-open')!.dispatchEvent(event());
  f.document.querySelector('[data-douban-tools-tab="' + section + '"]')!.dispatchEvent(event());
  assert.equal(f.document.getElementById('douban-tools-dialog')?.hasAttribute('open'), true);
  assert.equal(f.document.querySelector('[data-douban-tools-tab="' + section + '"]')?.getAttribute('aria-selected'), 'true');
  assert.equal(f.document.getElementById('douban-tools-panel-' + section)?.hidden, false);
}

function mediaWorkspaceRecord(kind: DoubanRecord['kind'], subjectId: string, title: string): DoubanRecord {
  const domain = kind === 'movie' || kind === 'series' ? 'screen' : kind;
  const host = domain === 'screen' ? 'movie' : domain;
  return { domain, kind, subjectId, title, profileId: 'synthetic-profile', url: 'https://' + host + '.douban.com/subject/' + subjectId + '/',
    coverUrl: null, rating: 4, markedDate: '2026-11-12', comment: '独立的个人短评', publishedAt: null, source: 'import',
    observedAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', metadataCheckedRunId: null };
}

for (const width of [1280, 390]) {
  test(width + 'px minified media workspace starts with the library and opens every tool without external actions', { skip: !hasBuild }, async () => {
    const f = await fixture('id="douban-page"', '/life/douban', width, {}, { foods: [], douban: {
      connection: { profileId: null, revision: 0, updatedAt: null }, items: [],
    } });
    await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
    const main = [...f.document.querySelectorAll('.nav [data-navigation-page]')];
    assert.deepEqual(main.map(item => item.getAttribute('data-navigation-page')), ['home', 'health', 'nutrition', 'douban', 'finance', 'sync']);
    assert.equal(f.document.querySelector('[data-navigation-page="douban"]')?.getAttribute('aria-current'), 'page');
    assert.equal(f.document.querySelector('[data-navigation-page="health"]')?.hasAttribute('aria-current'), false);
    assert.equal(f.document.getElementById('douban-tools-dialog')?.hasAttribute('open'), false);
    assert.ok(f.html.indexOf('id="douban-library-title"') < f.html.indexOf('id="douban-tools-dialog"'), 'the library precedes the management panel');
    const before = f.requests.length;
    for (const section of ['browser', 'public', 'import', 'manage'] as const) {
      openMediaTools(f, section);
      f.document.getElementById('douban-tools-close')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
      assert.equal(f.document.getElementById('douban-tools-dialog')?.hasAttribute('open'), false);
    }
    assert.equal(f.requests.length, before, 'opening tools only changes local presentation');
    assert.equal(f.doubanExtensionMessages.length, 0); assert.ok(f.requests.every(request => request.method === 'GET'));
    assert.ok(f.document.querySelector('#douban-tools-panel-manage #douban-reset-panel'), 'destructive maintenance stays inside management');
  });

  test(width + 'px minified category navigation preserves import drafts while searches, URL state and clearing filters remain read-only', { skip: !hasBuild }, async () => {
    const items = [mediaWorkspaceRecord('movie', '8100001', '合成电影'), mediaWorkspaceRecord('book', '8100002', '合成书籍'), mediaWorkspaceRecord('music', '8100003', '合成音乐')];
    const f = await fixture('id="douban-page"', '/life/douban', width, {}, { foods: [], douban: {
      connection: { profileId: 'synthetic-profile', revision: 1, updatedAt: '2026-11-14T00:00:00.000Z' }, items,
    } });
    const get = (id: string) => f.document.getElementById('douban-' + id)!;
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 3);
    openMediaTools(f, 'import');
    const input = get('import-profile') as HTMLInputElement; input.value = 'draft-source'; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    const file = new File(['[]'], 'retained-private-draft.json', { type: 'application/json' });
    Object.defineProperty(get('import-files'), 'files', { configurable: true, value: [file] });
    get('import-files').dispatchEvent(new f.window.Event('change', { bubbles: true }));
    (get('import-completed') as HTMLInputElement).checked = true; get('import-completed').dispatchEvent(new f.window.Event('change', { bubbles: true }));
    get('tools-close').dispatchEvent(new f.window.Event('click', { bubbles: true }));
    const leave = new f.window.Event('beforeunload', { cancelable: true }); f.window.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, true, 'closing or hiding tools must retain file-draft departure protection');
    f.document.querySelector('#douban-kind-chips [data-douban-kind="book"]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 1 && f.location.search.includes('kind=book'));
    assert.match(f.document.querySelector('#douban-list h3')?.textContent ?? '', /合成书籍/);
    assert.equal(f.document.querySelector('[data-douban-kind="book"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(f.document.querySelector('[data-navigation-group="douban"] [data-context-kind="book"]')?.getAttribute('aria-current'), 'page');
    f.location.replace('/life/douban?kind=music'); f.window.dispatchEvent(new f.window.Event('popstate'));
    await settle(() => f.document.querySelector('#douban-list h3')?.textContent?.includes('合成音乐') === true);
    assert.equal(f.document.querySelector('[data-douban-kind="music"]')?.getAttribute('aria-pressed'), 'true');
    (get('query') as HTMLInputElement).value = '不存在的作品'; get('search-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 0 && !get('empty').hidden);
    assert.match(get('empty-text').textContent ?? '', /筛选|符合|没有/);
    get('reset-filters').dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 3 && !f.location.search);
    openMediaTools(f, 'import');
    assert.equal(input.value, 'draft-source'); assert.equal((get('import-completed') as HTMLInputElement).checked, true);
    assert.equal((get('import-files') as HTMLInputElement).files?.[0], file);
    assert.equal(f.doubanImportBodies.length, 0); assert.ok(f.requests.every(request => request.method === 'GET'));
  });
}

test('production home initializes and displays an empty but available overview without model calls', { skip: !hasBuild }, async () => {
  const f = await fixture('overview-content', '/');
  await settle(() => f.document.getElementById('refresh')?.getAttribute('disabled') === null);
  assert.equal(f.document.getElementById('overview-content')?.getAttribute('aria-busy'), 'false');
  assert.equal(f.document.getElementById('overview-content')?.hidden, false);
  assert.equal(f.requests.filter((item) => item.path === '/api/overview').length, 1);
  assert.ok(f.requests.every((item) => item.method === 'GET' && !item.path.includes('assistant')));
});

test('production finance initializes its selected ledger and finishes rendering the empty-account action', { skip: !hasBuild }, async () => {
  const f = await fixture('id="account-list"', '/finance?ledger=personal&currency=CNY');
  await settle(() => Boolean(f.document.querySelector('[data-create]')));
  assert.equal(f.document.getElementById('status-banner')?.hidden, true);
  assert.equal(f.requests.filter((item) => item.path.startsWith('/api/finance?')).length, 1);
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('minified shared family initialization keeps the selected book in reads and navigation without accepting invitations or writing', { skip: !hasBuild }, async () => {
  const book='11111111-1111-4111-8111-111111111111';
  const choices=[{id:'own',name:'我的家庭账本',ownerName:'Synthetic account',role:'owner',accessRevision:0,canManageMembers:true,canExport:true},
    {id:book,name:'家庭账本',ownerName:'另一位家庭拥有人',role:'editor',accessRevision:2,canManageMembers:false,canExport:false}];
  const f=await fixture('id="account-list"','/finance?ledger=family&currency=CNY&book='+book+'&bookRevision=2',1280,{}, {foods:[],financeBooks:choices});
  await settle(()=>Boolean(f.document.querySelector('[data-create]')));
  assert.equal((f.document.getElementById('finance-books-select') as unknown as HTMLSelectElement).value,book);
  assert.equal(f.document.getElementById('finance-books-manage')?.hidden,true);
  const read=f.requests.find(item=>item.path.startsWith('/api/finance?'))!;assert.ok(read);
  assert.equal(new URL(read.path,'https://synthetic.example').searchParams.get('book'),book);
  assert.equal(new URL(read.path,'https://synthetic.example').searchParams.get('bookRevision'),'2');
  for(const id of ['finance-review-link','balance-check-link','finance-goals-link','finance-runway-link']){
    const href=f.document.getElementById(id)?.getAttribute('href');assert.ok(href);
    assert.equal(new URL(href,'https://synthetic.example').searchParams.get('book'),book);
  }
  assert.ok(f.requests.every(item=>item.method==='GET'));
});

test('production AI settings reads metadata and keeps connection tests behind user action', { skip: !hasBuild }, async () => {
  const f = await fixture('id="ai-settings-page"', '/settings/ai');
  await settle(() => f.document.getElementById('ai-settings-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.document.getElementById('ai-settings-configured')?.textContent, '未配置');
  assert.equal((f.document.getElementById('ai-settings-api-key') as HTMLInputElement)?.value, '');
  assert.deepEqual(f.requests, [{ path: '/api/ai/settings', method: 'GET' }]);
});

test('production members use shared AI status without exposing configuration controls or dispatching settings writes', { skip: !hasBuild }, async () => {
  const f = await fixture('id="ai-settings-page"', '/settings/ai', 390, {}, { foods: [], aiCanManage: false, aiConfigured: true });
  await settle(() => f.document.getElementById('ai-settings-page')?.getAttribute('aria-busy') === 'false');
  for (const id of ['manage-panel', 'test-panel', 'delete-panel']) {
    assert.equal(f.document.getElementById('ai-settings-' + id)?.hidden, true);
  }
  assert.match(f.document.getElementById('ai-settings-shared-note')?.textContent ?? '', /无需/);
  assert.match(f.document.getElementById('ai-settings-summary-model')?.textContent ?? '', /MiniMax-M3/);
  assert.equal((f.document.getElementById('ai-settings-api-key') as HTMLInputElement).disabled, true);
  f.document.getElementById('ai-settings-form')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  for (const id of ['test', 'delete-open', 'delete-submit']) f.document.getElementById('ai-settings-' + id)!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.deepEqual(f.requests, [{ path: '/api/ai/settings', method: 'GET' }]);
});

test('390px production assistant fixture preserves navigation and accessible lazy chat controls', { skip: !hasBuild }, async () => {
  const f = await fixture('ha-intro-cards', '/health/assistant', 390);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /@media\(max-width:760px\)/);
  assert.equal(f.document.querySelectorAll('.nav-link').length, 6);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'), 'true');
  await settle(() => f.requests.length === 1 && f.document.getElementById('health-chat-context')?.hidden === false);
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, false);
  f.document.getElementById('health-chat-minimize')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, true);
  const launcher = f.document.getElementById('health-chat-launcher')!;
  launcher.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => f.requests.length === 1 && f.document.getElementById('health-chat-context')?.hidden === false);
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
  assert.equal(f.document.getElementById('health-chat-panel')?.getAttribute('role'), 'dialog');
  assert.equal(f.document.getElementById('health-chat-panel')?.hidden, false);
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('390px production backup page initializes every inline script and gates restore behind file preview and confirmation', async () => {
  const f = await fixture('id="backup-file"', '/data', 390);
  assert.match(f.html, /name="viewport"/);
  assert.match(f.html, /@media\(max-width:700px\)/);
  assert.equal(f.document.querySelectorAll('.nav-link').length, 6);
  assert.equal(f.document.querySelector('label[for="backup-file"]')?.textContent, '选择完整备份，或清单与全部分卷');
  const file = f.document.getElementById('backup-file')! as HTMLInputElement;
  const preview = f.document.getElementById('backup-preview')! as HTMLButtonElement;
  const restore = f.document.getElementById('backup-restore')! as HTMLButtonElement;
  const confirm = f.document.getElementById('backup-confirm')! as HTMLInputElement;
  assert.equal(file.disabled, false);
  assert.equal(preview.disabled, true);
  assert.equal(restore.disabled, true);
  assert.equal(Boolean(confirm.checked), false);
  assert.equal(f.document.getElementById('backup-summary')?.hidden, true);
  assert.equal(f.document.getElementById('backup-status')?.getAttribute('role'), 'status');
  assert.equal(f.document.getElementById('backup-status')?.getAttribute('aria-live'), 'polite');
  const download = f.document.getElementById('backup-export') as HTMLButtonElement;
  assert.ok(download, 'bounded backup export control is present');
  assert.equal(download.tagName, 'BUTTON');
  assert.equal(download.disabled, false);
  assert.equal(download.textContent, '下载完整备份 JSON');
  assert.equal(f.document.getElementById('backup-file')?.hasAttribute('multiple'), true);
  assert.ok(f.document.getElementById('backup-export-volumes'));
  assert.equal((f.document.getElementById('backup-saved') as HTMLButtonElement).disabled, true);
  assert.equal(f.document.querySelector('.backup-table-wrap th[scope="col"]')?.textContent, '数据范围');
  assert.equal(f.document.querySelectorAll('.backup-table-wrap th[scope="col"]').length, 5);
  // No data is read or restored just by opening the page. Even synthetic click
  // dispatches on gated controls cannot start a request before a file/preview.
  preview.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  restore.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  confirm.checked = true;
  confirm.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(restore.disabled, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'), 'true');
});

test('minified personal food templates open their lazy list and typed source fields without writing or parsing AI',async()=>{
  const f=await fixture('id="nutrition-page"','/health/nutrition',390);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  const panel=f.document.getElementById('nutrition-templates')!;
  panel.setAttribute('open','');Object.assign(panel,{open:true});panel.dispatchEvent(new f.window.Event('toggle'));
  await settle(()=>f.document.getElementById('nutrition-templates-status')?.textContent?.includes('还没有模板')===true);
  f.document.getElementById('nutrition-template-new')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(f.document.getElementById('nutrition-template-dialog')?.hasAttribute('open'),true);
  assert.ok(f.document.getElementById('nutrition-template-components')?.querySelector('[data-template-field="calories"]'));
  assert.ok(f.requests.some((request)=>request.path==='/api/health/nutrition/templates'));
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')));
});

test('390px minified photo entry stays local until recognition and preserves the original text draft',async()=>{
  const f=await fixture('id="nutrition-page"','/health/nutrition',390);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  const text=f.document.getElementById('nutrition-ai-text') as HTMLTextAreaElement;text.value='保留尚未使用的文字描述';
  f.document.getElementById('nutrition-method-photo')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(f.document.getElementById('nutrition-entry-photo')?.hidden,false);
  assert.equal((f.document.getElementById('nutrition-photo-recognize') as HTMLButtonElement).disabled,true);
  const album=f.document.getElementById('nutrition-photo-file')! as HTMLInputElement;
  assert.match(album.getAttribute('accept')??'',/image\/png/);assert.equal(album.hasAttribute('capture'),false);
  assert.equal(f.document.getElementById('nutrition-photo-camera')?.getAttribute('capture'),'environment');
  Object.defineProperty(album,'files',{configurable:true,value:[new File([],'empty.jpg',{type:'image/jpeg'})]});
  album.dispatchEvent(new f.window.Event('change',{bubbles:true}));
  await settle(()=>f.document.getElementById('nutrition-photo-status')?.textContent?.includes('非空')===true);
  assert.equal(f.document.getElementById('nutrition-photo-preview')?.hidden,true);
  f.document.querySelector('[data-entry-method="ai"]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(text.value,'保留尚未使用的文字描述');
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/photo')&&!request.path.includes('/parse')));
});

test('production shortcut installation page waits for user action before taking a server-clock baseline', async () => {
  const f = await fixture('id="template-check"', '/sync/templates', 390);
  assert.equal(f.document.querySelectorAll('.template-grid .template-card').length, 4);
  assert.equal(f.document.querySelector('[data-context-path="/sync/templates"]')?.getAttribute('aria-current'), 'page');
  assert.match(f.document.getElementById('template-install')?.getAttribute('href') ?? '', /^https:\/\/www\.icloud\.com\/shortcuts\/[a-f0-9]{32}$/);
  assert.equal((f.document.getElementById('template-check-now') as HTMLButtonElement).disabled, true);
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.equal(f.requests.length, 0);
  f.document.getElementById('template-start')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => (f.document.getElementById('template-check-now') as HTMLButtonElement).disabled === false);
  assert.equal((f.document.getElementById('template-check-now') as HTMLButtonElement).disabled, false);
  assert.equal((f.document.getElementById('template-confirm') as HTMLInputElement).disabled, true);
  assert.deepEqual(f.requests, [{ path: '/api/health/import', method: 'GET' }]);
});

test('390px minified nutrition opens direct recording with lazy history and protected drafts without automatic writes',async()=>{
  const today=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
  const foreignOwner='another-synthetic-owner',operation='11111111-1111-4111-8111-111111111111';
  const foreignStorage={
    ['jiashu-nutrition-create:'+foreignOwner]:JSON.stringify({key:operation,body:{date:today,meal:'breakfast',name:'OTHER_OWNER_PRIVATE_DRAFT',portion:'one',note:'',calories:null}}),
    ['jiashu-nutrition-copy:'+foreignOwner]:JSON.stringify({key:operation,body:{action:'copy',fromDate:today,fromMeal:'breakfast',toDate:today,toMeal:'lunch',previewToken:'a'.repeat(64)}}),
    ['jiashu-nutrition-favorite:'+foreignOwner]:JSON.stringify({key:operation,body:{entryId:operation,expectedRevision:1}}),
  };
  const f=await fixture('id="nutrition-page"','/health/nutrition?compose=1',390,foreignStorage);
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false'&&f.document.getElementById('nutrition-content')?.hidden===false);
  assert.match(f.html,/name="viewport"/);
  assert.equal(f.document.querySelectorAll('.nav-link').length,6);
  assert.equal(f.document.querySelector('[data-navigation-page="nutrition"]')?.getAttribute('aria-current'),'page');
  assert.equal(f.document.getElementById('nutrition-total')?.textContent,'—');
  const ids=[...f.document.querySelectorAll('[id]')].map((element)=>element.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const key of ['carbs','protein','fat'])assert.equal(f.document.getElementById('nutrition-'+key)?.tagName,'INPUT');
  assert.equal(f.document.getElementById('nutrition-entry-ai')?.hidden,false);
  assert.equal(f.document.querySelector('[data-entry-method="ai"]')?.getAttribute('aria-selected'),'true');
  assert.equal(f.document.querySelectorAll('[data-nutrition-add-meal]').length,4);
  assert.equal(f.document.querySelectorAll('[data-nutrition-copy-meal]').length,4);
  assert.equal(f.document.querySelectorAll('[data-nutrition-skip-meal]').length,4);
  assert.ok(f.document.querySelector('label[for="nutrition-day"]'));
  assert.ok(f.document.querySelector('label[for="nutrition-ai-text"]'));
  const historyPanel=f.document.getElementById('nutrition-history')! as unknown as HTMLDetailsElement;
  assert.equal(historyPanel.hasAttribute('open'),false);
  assert.ok(!f.requests.some((request)=>request.path.includes('/nutrition/review')));
  historyPanel.open=true;historyPanel.setAttribute('open','');historyPanel.dispatchEvent(new f.window.Event('toggle'));
  await settle(()=>Boolean(f.document.getElementById('nutrition-review-status')?.textContent?.includes('已记录部分')));
  assert.equal(f.document.getElementById('nutrition-review-chart')?.querySelectorAll('.is-missing').length,7);
  assert.match(f.document.getElementById('nutrition-review-summary')?.textContent ?? '',/暂无可比较日期/);
  assert.equal(f.document.getElementById('nutrition-pending')?.hidden,true);
  assert.equal(f.document.getElementById('nutrition-copy-pending')?.hidden,true);
  assert.equal(f.document.getElementById('nutrition-favorite-pending')?.hidden,true);
  assert.equal((f.document.getElementById('nutrition-add') as HTMLButtonElement).disabled,false);
  assert.equal((f.document.getElementById('nutrition-copy-open') as HTMLButtonElement).disabled,false);
  assert.equal(f.document.getElementById('nutrition-batch-dialog')?.hasAttribute('open'),false);
  assert.equal(f.document.getElementById('nutrition-copy-dialog')?.hasAttribute('open'),false);
  // Opening the manual form exercises its minified helper references without
  // parsing a meal, saving, marking status or invoking the provider.
  f.document.querySelector('[data-entry-method="manual"]')!.dispatchEvent(new f.window.Event('click',{bubbles:true,cancelable:true}));
  assert.equal(f.document.getElementById('nutrition-dialog')?.hasAttribute('open'),true);
  assert.equal((f.document.getElementById('nutrition-name') as HTMLInputElement).value,'');
  assert.ok(f.document.getElementById('nutrition-food-search-button'));
  assert.equal((f.document.getElementById('nutrition-save') as HTMLButtonElement).disabled,false);
  f.document.getElementById('nutrition-dialog-close')!.dispatchEvent(new f.window.Event('click',{bubbles:true,cancelable:true}));
  assert.equal(f.document.getElementById('nutrition-dialog')?.hasAttribute('open'),false);
  assert.equal(f.document.getElementById('health-chat')?.getAttribute('data-initialized'),'true');
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')&&!request.path.includes('/assistant')));
  assert.deepEqual(f.requests.map((request)=>new URL(request.path,'https://synthetic-production.example').pathname).sort(),['/api/health/nutrition','/api/health/nutrition/favorites','/api/health/nutrition/goals','/api/health/nutrition/review']);
  for(const [key,value] of Object.entries(foreignStorage))assert.equal(f.sessionStorage.getItem(key),value);
  assert.ok(!f.document.body.textContent?.includes('OTHER_OWNER_PRIVATE_DRAFT'));
});

for (const [width, ai] of [[390, 'ready'], [1280, 'unavailable']] as const) {
  test('minified daily-needs calculator explicitly previews and fills unsaved goals at ' + width + 'px with AI ' + ai, { skip: !hasBuild }, async () => {
    const f = await fixture('id="nutrition-page"', '/health/nutrition#nutrition-goals', width, {}, { foods: [], nutritionNeeds: ai });
    await settle(() => Boolean(f.document.getElementById('nutrition-goals-status')?.textContent?.includes('目标可分别留空')));
    assert.equal(f.needsBodies.length, 0, 'page initialization must not send body measurements to AI');
    const get = (id: string) => f.document.getElementById('nutrition-' + id)!;
    const initialLocal = f.localStorage.snapshot(), initialSession = f.sessionStorage.snapshot();
    const values = { age: '30', sex: 'male', height: '175', weight: '70', activity: 'moderate', goal: 'maintain' };
    for (const [key, value] of Object.entries(values)) {
      (get('needs-' + key) as unknown as HTMLInputElement).value = value;
      get('needs-' + key).dispatchEvent(new f.window.Event('input', { bubbles: true }));
    }
    get('needs-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(() => get('needs-result').hidden === false);
    assert.deepEqual(f.needsBodies, [{ age: 30, heightCm: 175, weightKg: 70, sex: 'male', activity: 'moderate', goal: 'maintain' }]);
    const targets = calculateNutritionNeeds(f.needsBodies[0]).targets;
    assert.equal(get('needs-calories').textContent, targets.calories + ' kcal');
    assert.match(get('needs-ai').textContent ?? '', ai === 'ready' ? /AI 解读/ : /AI 解读暂不可用/);
    assert.equal((get('goal-calories') as HTMLInputElement).value, '', 'a preview cannot change current goals');
    assert.deepEqual(f.localStorage.snapshot(), initialLocal, 'body measurements must not be written to durable drafts');
    assert.deepEqual(f.sessionStorage.snapshot(), initialSession, 'body measurements must not be written to session storage');
    assert.equal((get('needs-apply') as HTMLButtonElement).disabled, false);
    get('needs-apply').dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await settle(() => (get('goal-calories') as HTMLInputElement).value === targets.calories);
    for (const key of ['calories', 'carbs', 'protein', 'fat'] as const) assert.equal((get('goal-' + key) as HTMLInputElement).value, targets[key]);
    assert.equal(f.requests.filter(item => item.method !== 'GET').length, 1, 'filling a target form cannot save it automatically');
    assert.equal((get('needs-apply') as HTMLButtonElement).disabled, true);
    (get('needs-weight') as HTMLInputElement).value = '71';
    get('needs-weight').dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.equal(get('needs-result').hidden, true, 'changed inputs invalidate the older result');
    assert.equal((get('goal-calories') as HTMLInputElement).value, targets.calories, 'invalidating a preview must retain the separate goal draft');
  });
}

for (const width of [390, 1280]) {
  test('minified personal media library reads saved records and filters categories without starting a sync at ' + width + 'px', { skip: !hasBuild }, async () => {
    const timestamp = '2026-11-14T00:00:00.000Z';
    const items: DoubanRecord[] = (['movie', 'series', 'book', 'music', 'screen'] as const).map((kind, index) => {
      const domain = kind === 'book' || kind === 'music' ? kind : 'screen';
      const subjectId = String(123450 + index);
      return { profileId: 'synthetic-profile', domain, subjectId, kind, title: '合成书影音 ' + kind + ' <img src=x>',
        url: 'https://' + (domain === 'screen' ? 'movie' : domain) + '.douban.com/subject/' + subjectId + '/',
        coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123450.jpg', rating: kind === 'music' ? null : 4,
        markedDate: '2026-11-10', comment: '合成私人短评', publishedAt: null, source: 'import', observedAt: timestamp,
        createdAt: timestamp, updatedAt: timestamp, metadataCheckedRunId: null,
        details: { year: 2024, doubanRating: 8.6, ratingCount: 12345, summary: '公开作品简介与私人短评分开',
          ...(domain === 'screen' ? { directors: ['合成导演'], duration: '120分钟' }
            : domain === 'book' ? { authors: ['合成作者'], publisher: '合成出版社', pages: 320 }
              : { artists: ['合成歌手'], albumType: '专辑', tracks: ['第一首合成曲目', '第二首合成曲目'] }) } };
    });
    const f = await fixture('id="douban-page"', '/life/douban', width, {}, { foods: [], douban: {
      connection: { profileId: 'synthetic-profile', revision: 1, updatedAt: timestamp }, items,
    } });
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 5);
    assert.match(f.document.getElementById('douban-total')?.textContent ?? '', /共 5 条/);
    const covers = [...f.document.querySelectorAll('#douban-list img')];
    assert.equal(covers.length, 5, 'every media kind, including private imports, has an image');
    for (const cover of covers) {
      const url = new URL(cover.getAttribute('src')!, 'https://synthetic-production.example');
      assert.equal(url.origin, 'https://synthetic-production.example', 'private imported covers use the authenticated same-origin proxy');
      assert.equal(url.pathname, '/api/life/douban/cover');
      assert.equal(url.searchParams.get('profileId'), 'synthetic-profile');
    }
    covers[0].dispatchEvent(new f.window.Event('error'));
    assert.match(covers[0].getAttribute('src') ?? '', /^data:image\/svg\+xml/);
    assert.equal(covers[0].getAttribute('alt'), '封面加载失败');
    assert.equal(covers[0].getAttribute('data-douban-cover'), 'failed');
    const failedCard = covers[0].closest('.db-card')!;
    assert.match(failedCard.querySelector('[data-douban-cover-status]')?.textContent ?? '', /封面加载失败/);
    assert.equal(f.requests.filter(request => request.path.startsWith('/api/life/douban/cover')).length, 0, 'an image error does not automatically reread the upstream cover');
    failedCard.querySelector('[data-douban-cover-retry]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await settle(() => covers[0].getAttribute('src')?.startsWith('blob:') === true);
    assert.equal(covers[0].getAttribute('data-douban-cover'), 'available');
    covers[0].dispatchEvent(new f.window.Event('load'));
    assert.equal(failedCard.querySelector('[data-douban-cover-retry]'), null);
    assert.equal(f.requests.filter(request => request.path.startsWith('/api/life/douban/cover')).length, 1);
    assert.equal(f.document.getElementById('douban-detail-dialog')?.hasAttribute('open'), false, 'retrying a cover does not open the work or an external link');
    assert.equal(f.document.querySelectorAll('#douban-list img').length, 5, 'an unavailable cover remains an honest local fallback image');
    assert.match(f.document.querySelector('#douban-list h3')?.textContent ?? '', /<img src=x>/);
    assert.ok(f.requests.every(request => request.method === 'GET' && !request.path.includes('/sync')));
    f.document.querySelector('#douban-list [data-douban-open]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    assert.equal(f.document.getElementById('douban-detail-dialog')?.hasAttribute('open'), true);
    assert.match(f.document.getElementById('douban-detail-body')?.textContent ?? '', /合成私人短评/);
    assert.match(f.document.querySelector('[data-douban-details="work"]')?.textContent ?? '', /8\.6/);
    assert.match(f.document.querySelector('[data-douban-details="personal"]')?.textContent ?? '', /4 \/ 5/);
    assert.match(f.document.querySelector('[data-douban-details="screen"]')?.textContent ?? '', /合成导演/);
    assert.match(f.document.querySelector('[data-douban-details="summary"]')?.textContent ?? '', /公开作品简介与私人短评分开/);
    f.document.getElementById('douban-detail-close')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    for (const [index, section, content] of [[2, 'book', '320 页'], [3, 'music', '合成歌手']] as const) {
      f.document.querySelector('#douban-list [data-douban-open="' + index + '"]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
      assert.ok(f.document.querySelector('[data-douban-details="' + section + '"]')?.textContent?.includes(content));
      if (section === 'music') assert.equal(f.document.querySelectorAll('[data-douban-details="tracks"] li').length, 2);
      f.document.getElementById('douban-detail-close')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    }
    const kind = f.document.getElementById('douban-kind') as unknown as HTMLSelectElement;
    kind.value = 'book'; kind.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    await settle(() => f.document.querySelectorAll('#douban-list .db-card').length === 1);
    assert.match(f.document.querySelector('#douban-list h3')?.textContent ?? '', /book/);
    assert.ok(f.requests.every(request => request.method === 'GET'), 'opening, reading and filtering must not import or contact Douban');
    assert.ok(f.document.getElementById('douban-import-files'), 'private-file import remains available without a public-source fetch');
  });
}

test('minified browser-extension sync connects explicitly and saves normalized pages without transferring browser login credentials', { skip: !hasBuild }, async () => {
  const item: DoubanRecordInput = { domain: 'book', subjectId: '1234567', kind: 'book', title: '扩展合成私密书籍',
    url: 'https://book.douban.com/subject/1234567/', coverUrl: null, rating: 4, markedDate: '2026-11-12',
    comment: '扩展合成个人短评', publishedAt: null, source: 'import' };
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: 'synthetic-profile', revision: 1, updatedAt: '2026-11-14T00:00:00.000Z' }, items: [], browserExtensionItems: [item], browserExtensionVersion: '1.0.3',
  } });
  const get = (id: string) => f.document.getElementById('douban-browser-' + id)!;
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  openMediaTools(f, 'browser');
  assert.equal(f.doubanExtensionMessages.length, 0);
  assert.equal(f.doubanImportBodies.length, 0);
  get('sync').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => get('status').textContent?.includes('浏览器同步完成') === true);
  assert.deepEqual(f.doubanExtensionMessages.map(body => body.action), ['CONNECT', 'START', 'STEP']);
  assert.match(get('status').textContent ?? '', /分类尚未补全.*1\.0\.4/);
  assert.deepEqual(f.doubanImportBodies.map(body => body.action), ['preview', 'commit']);
  assert.deepEqual(f.doubanImportBodies.map(body => body.expectedDataEpoch), [0, 0]);
  assert.deepEqual(f.doubanImportBodies[1].items, [item]);
  assert.equal(f.doubanImportBodies[1].profile, 'synthetic-profile');
  assert.equal(f.doubanImportBodies[1].confirmed, true);
  assert.match(f.document.querySelector('#douban-list h3')?.textContent ?? '', /扩展合成私密书籍/);
  assert.ok(f.doubanExtensionMessages.every(body => body.profileId === 'synthetic-profile' && typeof body.ownerKey === 'string'));
  assert.doesNotMatch(JSON.stringify([...f.doubanExtensionMessages, ...f.doubanImportBodies]), /cookie|password|rawHTML/i);
  assert.doesNotMatch(JSON.stringify(f.localStorage.snapshot()) + JSON.stringify(f.sessionStorage.snapshot()), /扩展合成个人短评/);
  get('sync').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => f.doubanExtensionMessages.filter(body => body.action === 'START').length === 2
    && f.doubanImportBodies.filter(body => body.action === 'commit').length === 2 && get('status').textContent?.includes('浏览器同步完成') === true);
  assert.equal(f.document.querySelectorAll('#douban-list .db-card').length, 1, 'a new explicit refresh reconciles the saved subject rather than duplicating it');
});

for (const [width, expectedKind] of [[390, 'movie'], [1280, 'series']] as const) void test('minified browser resync automatically enriches a saved screen using its newly persisted version at ' + width + 'px', { skip: !hasBuild }, async () => {
  const existing = { ...mediaWorkspaceRecord('screen', '1234890', '原待分类影视'),
    coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p-old.jpg', details: { summary: '原有简介必须保留' } };
  const input: DoubanRecordInput = { domain: existing.domain, subjectId: existing.subjectId, kind: 'screen', title: '重新同步的影视作品', url: existing.url,
    coverUrl: null, rating: existing.rating, markedDate: existing.markedDate, comment: existing.comment, publishedAt: null, source: 'browser' };
  const metadata: DoubanSubjectMetadata = { kind: expectedKind, coverUrl: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p-new.jpg',
    details: { directors: ['合成导演'], ...(expectedKind === 'movie' ? { duration: '118分钟' } : { episodes: 12 }) } };
  const items = [existing];
  const f = await fixture('id="douban-page"', '/life/douban', width, {}, { foods: [], douban: {
    connection: { profileId: existing.profileId, revision: 1, updatedAt: existing.updatedAt }, items, allowMetadata: true,
    browserExtensionItems: [input], browserExtensionVersion: '1.0.5', browserSubjectMetadata: { ['screen:' + existing.subjectId]: metadata },
  } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.doubanExtensionMessages.length, 0);
  assert.equal(f.doubanImportBodies.length, 0);
  openMediaTools(f, 'browser');
  const button = f.document.getElementById('douban-browser-sync')!;
  const status = f.document.getElementById('douban-browser-status')!;
  button.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settleWork(() => status.textContent?.includes('浏览器同步完成') === true, () => 'automatic sync must complete: ' + status.textContent);
  assert.deepEqual(f.doubanExtensionMessages.map(body => body.action), ['CONNECT', 'START', 'STEP', 'CONNECT', 'SUBJECT']);
  assert.deepEqual(f.doubanExtensionMessages.find(body => body.action === 'START')?.domains, ['screen', 'book', 'music']);
  assert.ok(f.doubanImportBodies.every(body => (body.items as DoubanRecordInput[]).every(item => item.source === 'browser')));
  const subject = f.doubanExtensionMessages.find(body => body.action === 'SUBJECT')!;
  assert.equal(subject.runId, '11111111-1111-4111-8111-111111111111');
  assert.equal(f.doubanImportBodies[0].returnRecords, undefined, 'preview only verifies the collection page');
  assert.equal(f.doubanImportBodies[1].returnRecords, true, 'the queue must use persisted versions, not stale collection input');
  assert.equal(f.doubanMetadataBodies[0].expectedUpdatedAt, new Date(Date.parse(existing.updatedAt) + 1).toISOString());
  assert.equal(f.doubanMetadataBodies[0].expectedDataEpoch, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, expectedKind);
  assert.equal(items[0].coverUrl, metadata.coverUrl);
  assert.equal(items[0].details?.summary, '原有简介必须保留');
  assert.equal(items[0].rating, existing.rating);
  assert.equal(items[0].comment, existing.comment);
  assert.doesNotMatch(JSON.stringify(subject) + JSON.stringify(f.doubanMetadataBodies), /独立的个人短评|markedDate|cookie|password|rawHTML/i);
  assert.match(status.textContent ?? '', /识别影视 1 条/);
  button.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  // START is recorded before its promise resolves; the previous completion
  // text can still be present there. Wait for this refresh's persisted page
  // and idle controls so it cannot leak unfinished work into the next VM.
  await settleWork(() => f.doubanExtensionMessages.filter(body => body.action === 'START').length === 2
    && f.doubanExtensionMessages.filter(body => body.action === 'STEP').length === 2
    && f.doubanImportBodies.filter(body => body.action === 'commit').length === 2
    && !(button as HTMLButtonElement).disabled && status.textContent?.includes('浏览器同步完成') === true,
    () => 'repeat sync must finish without downgrading known works: ' + status.textContent);
  assert.equal(f.doubanExtensionMessages.filter(body => body.action === 'SUBJECT').length, 1);
  assert.equal(f.doubanMetadataBodies.length, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, expectedKind);
});

for (const width of [390, 1280]) void test('minified work enrichment explicitly reads the local browser and saves public details without changing personal data at ' + width + 'px', { skip: !hasBuild }, async () => {
  const stamp = '2026-11-14T00:00:00.000Z';
  const item: DoubanRecord = { profileId: 'synthetic-profile', domain: 'book', subjectId: '1234567', kind: 'book', title: '合成待补全图书',
    url: 'https://book.douban.com/subject/1234567/', coverUrl: null, rating: 4, markedDate: '2026-11-12', comment: '不能发送的私人短评',
    publishedAt: null, source: 'import', observedAt: stamp, createdAt: stamp, updatedAt: stamp, metadataCheckedRunId: null, details: { summary: '已知作品简介' } };
  const metadata: DoubanSubjectMetadata = { kind: 'book', coverUrl: null, details: { authors: ['合成作者'], publisher: '合成出版社', doubanRating: 8.8, pages: 320 } };
  const f = await fixture('id="douban-page"', '/life/douban', width, {}, { foods: [], douban: {
    connection: { profileId: item.profileId, revision: 1, updatedAt: stamp }, items: [item], dataEpoch: 2, allowMetadata: true,
    browserSubjectMetadata: { 'book:1234567': metadata },
  } });
  const get = (id: string) => f.document.getElementById('douban-' + id)!;
  await settle(() => get('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.doubanExtensionMessages.length, 0); assert.equal(f.doubanMetadataBodies.length, 0);
  get('metadata').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => /本次补全完成|补全已停止/.test(get('metadata-status').textContent ?? ''));
  assert.match(get('metadata-status').textContent ?? '', /本次补全完成/, 'local enrichment must complete: ' + get('metadata-status').textContent);
  assert.deepEqual(f.doubanExtensionMessages.map(body => body.action), ['CONNECT', 'SUBJECT']);
  assert.deepEqual(f.doubanMetadataBodies, [{ profileId: item.profileId, domain: item.domain, subjectId: item.subjectId, expectedUpdatedAt: stamp, expectedDataEpoch: 2, confirmed: true, metadata }]);
  assert.deepEqual(f.requests.filter(request => request.path === '/api/life/douban/metadata'), [{ path: '/api/life/douban/metadata', method: 'PUT' }]);
  assert.doesNotMatch(JSON.stringify([...f.doubanExtensionMessages, ...f.doubanMetadataBodies]), /不能发送的私人短评|"rating":|"comment":|cookie|rawHTML/i);
  f.document.querySelector('#douban-list [data-douban-open]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.match(f.document.querySelector('[data-douban-details="work"]')?.textContent ?? '', /8\.8/);
  assert.match(f.document.querySelector('[data-douban-details="book"]')?.textContent ?? '', /合成作者/);
  assert.match(f.document.querySelector('[data-douban-details="summary"]')?.textContent ?? '', /已知作品简介/);
  assert.match(f.document.querySelector('[data-douban-details="personal"]')?.textContent ?? '', /4 \/ 5/);
});

void test('minified media reset previews before confirmation, retains its binding and pins the new epoch without automatically syncing', { skip: !hasBuild }, async () => {
  const stamp = '2026-11-14T00:00:00.000Z';
  const items: DoubanRecord[] = (['movie', 'book'] as const).map((kind, index) => ({
    profileId: index ? 'older-profile' : 'synthetic-profile', domain: kind === 'movie' ? 'screen' : 'book', subjectId: String(1234567 + index), kind,
    title: '待清空的合成记录 ' + kind, url: 'https://' + (kind === 'movie' ? 'movie' : 'book') + '.douban.com/subject/' + (1234567 + index) + '/',
    coverUrl: null, rating: 4, markedDate: '2026-11-12', comment: '合成私密短评', publishedAt: null, source: 'import', observedAt: stamp, createdAt: stamp, updatedAt: stamp, metadataCheckedRunId: null,
  }));
  const library = { connection: { profileId: 'synthetic-profile', revision: 3, updatedAt: stamp }, items, dataEpoch: 0, allowReset: true, allowImportPreview: true, browserExtensionItems: [] as DoubanRecordInput[] };
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: library });
  const get = (id: string) => f.document.getElementById('douban-' + id)!;
  await settle(() => get('page').getAttribute('aria-busy') === 'false' && f.document.querySelectorAll('#douban-list .db-card').length === 2);
  assert.equal(f.doubanResetBodies.length, 0); assert.equal(f.doubanExtensionMessages.length, 0);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  openMediaTools(f, 'manage');
  get('reset-panel').setAttribute('open', '');
  get('reset-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => !(get('reset-confirm') as HTMLButtonElement).disabled);
  assert.deepEqual([...f.doubanResetBodies], [{ action: 'preview' }]); assert.equal(library.dataEpoch, 0); assert.equal(library.items.length, 2);
  assert.match(get('reset-counts').textContent ?? '', /2 条记录/); assert.equal(f.document.querySelectorAll('#douban-list .db-card').length, 2, 'preview keeps all saved cards');
  get('reset-confirm').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => get('reset-status').textContent?.includes('绑定主页保留') === true && get('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.doubanResetBodies.length, 2); const commit = f.doubanResetBodies[1];
  assert.equal(commit.action, 'commit'); assert.equal(commit.confirmed, true); assert.equal(commit.expectedEpoch, 0); assert.equal(commit.expectedPreviewHash, 'b'.repeat(64)); assert.match(String(commit.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(library.dataEpoch, 1); assert.equal(library.items.length, 0); assert.equal(library.connection.profileId, 'synthetic-profile'); assert.equal(library.connection.revision, 4);
  assert.equal(f.document.querySelectorAll('#douban-list .db-card').length, 0); assert.match(get('total').textContent ?? '', /共 0 条/);
  assert.equal((get('profile') as HTMLInputElement).value, 'https://www.douban.com/people/synthetic-profile/');
  assert.equal(get('profile-link').getAttribute('href'), 'https://www.douban.com/people/synthetic-profile/');
  assert.equal(f.doubanExtensionMessages.length, 0, 'reset cannot connect or start the installed extension');
  assert.ok(f.requests.every(request => request.method === 'GET' || request.path === '/api/life/douban/reset'), 'reset only writes its two explicit reviewed requests');
  assert.equal(f.requests.some(request => request.path === '/api/life/douban/sync'), false, 'a public-source sync also needs a new click');
  const raw = JSON.stringify([{ title: '明确重新预览的书籍', url: 'https://book.douban.com/subject/9999999/', state: '读过' }]);
  openMediaTools(f, 'import');
  const file = new File([raw], 'new-generation.json', { type: 'application/json' });
  Object.defineProperty(get('import-files'), 'files', { configurable: true, value: [file] });
  get('import-files').dispatchEvent(new f.window.Event('change', { bubbles: true }));
  (get('import-completed') as HTMLInputElement).checked = true; get('import-completed').dispatchEvent(new f.window.Event('change', { bubbles: true }));
  get('import-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => get('import-result').hidden === false);
  assert.deepEqual(f.doubanImportBodies.map(body => [body.action, body.expectedDataEpoch]), [['preview', 1]], 'an explicit new file preview uses the epoch received after reset');
  assert.equal(library.items.length, 0, 'a fresh preview cannot restore cleared records'); assert.equal(f.doubanExtensionMessages.length, 0);
});

test('minified media enrichment and manual classification only write after their explicit actions', { skip: !hasBuild }, async () => {
  const stamp = '2026-11-14T00:00:00.000Z';
  const item: DoubanRecord = { profileId: 'synthetic-profile', domain: 'screen', subjectId: '1234567', kind: 'screen',
    title: '合成待分类影视', url: 'https://movie.douban.com/subject/1234567/', coverUrl: null, rating: 4,
    markedDate: '2026-11-10', comment: '合成私密短评', publishedAt: null, source: 'import', observedAt: stamp,
    createdAt: stamp, updatedAt: stamp, metadataCheckedRunId: null };
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: 'synthetic-profile', revision: 1, updatedAt: stamp }, items: [item], allowMetadata: true, allowClassification: true,
  } });
  const get = (id: string) => f.document.getElementById('douban-' + id)!;
  await settle(() => get('page').getAttribute('aria-busy') === 'false');
  assert.equal(f.doubanMetadataBodies.length, 0);
  assert.match(f.document.querySelector('#douban-list img')?.getAttribute('src') ?? '', /^data:image\/svg\+xml/);
  get('metadata').dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => /本次补全完成|补全已停止/.test(get('metadata-status').textContent ?? ''));
  assert.match(get('metadata-status').textContent ?? '', /本次补全完成/, 'fallback enrichment must complete: ' + get('metadata-status').textContent);
  assert.deepEqual(f.doubanMetadataBodies, [{ profileId: item.profileId, domain: 'screen', subjectId: item.subjectId, expectedUpdatedAt: stamp, expectedDataEpoch: 0, confirmed: true }]);
  assert.match(f.document.querySelector('#douban-list img')?.getAttribute('src') ?? '', /^\/api\/life\/douban\/cover\?/);
  assert.match(f.document.querySelector('#douban-list .db-meta')?.textContent ?? '', /电视剧/);
  f.document.querySelector('#douban-list [data-douban-open]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  const kind = get('classification-kind') as unknown as HTMLSelectElement;
  kind.value = 'movie'; kind.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(f.doubanClassificationBodies.length, 0, 'changing a classification is still an unsaved draft');
  get('classification-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => get('classification-status').textContent?.includes('分类已保存为电影') === true);
  assert.equal(f.doubanClassificationBodies.length, 1);
  assert.deepEqual(f.doubanClassificationBodies[0], { profileId: item.profileId, domain: 'screen', subjectId: item.subjectId, kind: 'movie', expectedUpdatedAt: '2026-11-14T00:00:00.001Z' });
  assert.match(get('detail-body').textContent ?? '', /合成私密短评/);
  assert.doesNotMatch(JSON.stringify([...f.doubanMetadataBodies, ...f.doubanClassificationBodies]), /合成私密短评|rating|comment|userId|cookie/i);
});

test('minified media recovery distinguishes upstream failures and prepares an import without replacing a private draft', { skip: !hasBuild }, async () => {
  const stamp = '2026-11-14T10:09:27.728Z';
  const progress = (status: string, errorCode: string | null, received = 0) => ({ status, errorCode, pages: received ? 1 : 0, received, total: received || null });
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: 'synthetic-profile', revision: 1, updatedAt: stamp }, items: [],
    lastRun: { profileId: 'synthetic-profile', connectionRevision: 1, status: 'partial', updatedAt: stamp,
      sources: { screen: progress('failed', 'DOUBAN_SOURCE_TIMEOUT'), book: progress('blocked', 'DOUBAN_SOURCE_BLOCKED'), music: progress('complete', null, 2) },
      rss: { status: 'failed', received: 0, errorCode: 'DOUBAN_SOURCE_BLOCKED' }, added: 2, updated: 0, unchanged: 0 },
  } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  openMediaTools(f, 'public');
  const source = (key: string) => f.document.querySelector('[data-douban-source="' + key + '"]')!;
  assert.match(source('screen').textContent ?? '', /超时/);
  assert.match(source('book').textContent ?? '', /拒绝|访问受限/);
  assert.match(source('rss').textContent ?? '', /拒绝|访问受限/);
  assert.equal(source('screen').querySelector('[data-douban-collection]')?.getAttribute('href'), 'https://movie.douban.com/people/synthetic-profile/collect');
  assert.equal(source('book').querySelector('[data-douban-collection]')?.getAttribute('href'), 'https://book.douban.com/people/synthetic-profile/collect');
  const bookmarklet = source('book').querySelector('[data-douban-book-export]')?.getAttribute('href') ?? '';
  assert.match(bookmarklet, /^javascript:/);
  const notices: string[] = [];
  runInNewContext(decodeURIComponent(bookmarklet.slice('javascript:'.length)), {
    URL, location: { href: 'https://synthetic-production.example/life/douban' },
    alert(message: string) { notices.push(message); },
    fetch() { throw new Error('The export helper cannot read another origin'); },
  }, { timeout: 1000 });
  assert.equal(notices.length, 1, 'the minified bookmarklet runs independently and safely rejects the site origin');
  source('book').querySelector('[data-douban-import-source]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  const get = (id: string) => f.document.getElementById('douban-' + id)!;
  assert.equal(get('import-panel').hasAttribute('open'), true);
  assert.equal(get('tools-panel-import').hidden, false);
  assert.match((get('import-profile') as HTMLInputElement).value, /synthetic-profile/);
  assert.equal((get('import-domain') as unknown as HTMLSelectElement).value, 'book');
  (get('import-profile') as HTMLInputElement).value = 'another-private-profile';
  get('import-profile').dispatchEvent(new f.window.Event('input', { bubbles: true }));
  source('screen').querySelector('[data-douban-import-source]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal((get('import-profile') as HTMLInputElement).value, 'another-private-profile');
  assert.equal((get('import-domain') as unknown as HTMLSelectElement).value, 'book');
  assert.ok(f.requests.every(request => request.method === 'GET'), 'recovery only prepares local options; no upstream sync or import is submitted');
});

test('minified private media file parser previews normalized personal fields without uploading the raw file or saving records', { skip: !hasBuild }, async () => {
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: null, revision: 0, updatedAt: null }, items: [], allowImportPreview: true,
  } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  openMediaTools(f, 'import');
  const get = (id: string) => f.document.getElementById('douban-' + id)!;
  (get('import-profile') as HTMLInputElement).value = 'synthetic-private-profile';
  get('import-profile').dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const raw = [{ title: '私密合成书籍', url: 'https://book.douban.com/subject/1234567/', state: '读过', myRating: 4,
    myComment: '合成私人短评', collectionDate: '2026-11-12', score: 9.8, unrelatedPrivateData: 'RAW-DO-NOT-UPLOAD' }];
  const file = new File([JSON.stringify(raw)], 'synthetic-private-notes.json', { type: 'application/json' });
  Object.defineProperty(get('import-files'), 'files', { configurable: true, value: [file] });
  get('import-files').dispatchEvent(new f.window.Event('change', { bubbles: true }));
  (get('import-completed') as HTMLInputElement).checked = true;
  get('import-completed').dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal(f.doubanImportBodies.length, 0);
  get('import-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => get('import-result').hidden === false);
  assert.equal(f.doubanImportBodies.length, 1);
  const body = f.doubanImportBodies[0];
  assert.equal(body.action, 'preview');
  assert.equal(body.expectedDataEpoch, 0);
  const items = body.items as Array<Record<string, unknown>>;
  assert.equal(items[0].rating, 4);
  assert.deepEqual(items[0].details, { doubanRating: 9.8 }, 'site score is public work data and never replaces the personal four-star rating');
  assert.equal(items[0].comment, '合成私人短评');
  assert.equal(items[0].source, 'import');
  assert.equal(items[0].markedDate, '2026-11-12');
  assert.doesNotMatch(JSON.stringify(body), /RAW-DO-NOT-UPLOAD|unrelatedPrivateData|synthetic-private-notes|myRating|"score"/);
  assert.doesNotMatch(JSON.stringify(f.localStorage.snapshot()) + JSON.stringify(f.sessionStorage.snapshot()), /合成私人短评|RAW-DO-NOT-UPLOAD/);
  assert.equal((get('import-confirm') as HTMLButtonElement).disabled, false);
  (get('import-completed') as HTMLInputElement).checked = false;
  get('import-completed').dispatchEvent(new f.window.Event('change', { bubbles: true }));
  assert.equal((get('import-confirm') as HTMLButtonElement).disabled, true);
  assert.ok(f.requests.filter(request => request.method === 'POST').every(request => request.path === '/api/life/douban/import'));
});

for (const width of [390, 1280]) {
  test('minified weekly review leads with a verified priority and explicitly fills an unsaved action at ' + width + 'px', { skip: !hasBuild }, async () => {
    const now = new Date('2026-11-14T04:00:00Z');
    const selection = parseHealthWeekQuery(new URLSearchParams({ week: '2026-11-02' }), now);
    const measurements: HealthMeasurement[] = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-10-26', '2026-10-27', '2026-10-28'].map((day, index) => ({
      id: 'synthetic-weekly-' + day, metric: 'sleep', value: index < 3 ? 5.5 : 7.5, unit: 'hours', aggregation: 'daily', source: 'synthetic',
      startDate: day + 'T00:00:00+08:00', endDate: day + 'T08:00:00+08:00',
    }));
    const review = buildHealthWeeklyReview(measurements, { ...emptyGoalSettings(), targets: { steps: null, sleep: 7, active_energy: null }, effectiveFrom: '2026-10-01' }, selection, now);
    const focus = buildHealthWeeklyFocus(review);
    const f = await fixture('id="weekly-page"', '/health/review?week=2026-11-02', width, {}, { foods: [], weeklyReview: review });
    await settle(() => f.document.getElementById('weekly-page')?.getAttribute('aria-busy') === 'false');
    assert.equal(f.document.getElementById('weekly-content')?.hidden, false);
    assert.equal(f.document.getElementById('weekly-focus-headline')?.textContent, focus.headline);
    assert.match(f.document.getElementById('weekly-focus-primary')?.textContent ?? '', /5\.5/);
    assert.equal(f.document.getElementById('weekly-details')?.hasAttribute('open'), false);
    assert.equal((f.document.getElementById('weekly-action-text') as HTMLTextAreaElement).value, '');
    assert.ok(f.requests.every(request => request.method === 'GET'));
    f.document.getElementById('weekly-focus-use-action')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    await settle(() => (f.document.getElementById('weekly-action-text') as HTMLTextAreaElement).value === focus.suggestedAction?.text);
    assert.match(f.document.getElementById('weekly-focus-action-message')?.textContent ?? '', /保存|草稿/);
    assert.ok(f.requests.every(request => request.method === 'GET'), 'adopting a suggestion must not save it automatically');
    assert.ok(f.document.getElementById('weekly-metrics')?.children.length, 'all detailed metrics remain available');
  });
}

test('minified official McDonald serving selection keeps its published SKU, half/two serving calories and separate source metadata', { skip: !hasBuild }, async()=>{
  const burger=getFood('mcd-cn:49:28');assert.ok(burger);assert.equal(burger.basis,'perServing');
  const f=await fixture('id="nutrition-page"','/health/nutrition',390,{}, {foods:[burger],sources:FOOD_CATALOG_SOURCES});
  await settle(()=>f.document.getElementById('nutrition-page')?.getAttribute('aria-busy')==='false');
  f.document.getElementById('nutrition-add')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  const search=f.document.getElementById('nutrition-food-search') as HTMLInputElement;search.value='麦当劳';
  f.document.getElementById('nutrition-food-search-button')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  await settle(()=>Boolean(f.document.querySelector('#nutrition-food-results [data-food-id]')));
  const results=f.document.getElementById('nutrition-food-results')!,choice=results.querySelector('[data-food-id]')!;
  assert.match(choice.textContent??'',/巨无霸.*每份 513 kcal/);
  assert.equal(results.querySelectorAll('details').length,FOOD_CATALOG_SOURCES.length);
  for(const source of FOOD_CATALOG_SOURCES)assert.ok([...results.querySelectorAll('a')].some((link)=>link.getAttribute('href')===source.url),'each source retains its own official citation');
  const brandSource=[...results.querySelectorAll('details')].find((node)=>node.textContent?.includes('麦当劳中国官网'))!;assert.ok(brandSource);assert.match(brandSource.textContent??'',/未提供开放数据许可/);assert.equal(brandSource.querySelectorAll('a').length,1);
  choice.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  const quantity=f.document.getElementById('nutrition-food-quantity') as HTMLInputElement;
  const unit=f.document.getElementById('nutrition-food-unit') as unknown as HTMLSelectElement;
  const calories=f.document.getElementById('nutrition-calories') as HTMLInputElement;
  assert.equal(quantity.value,'1');assert.deepEqual([...unit.querySelectorAll('option')].map((option)=>option.getAttribute('value')),['份']);
  assert.equal(calories.value,'513.0');
  quantity.value='0.5';quantity.dispatchEvent(new f.window.Event('input',{bubbles:true}));assert.equal(calories.value,'256.5');
  quantity.value='2';quantity.dispatchEvent(new f.window.Event('input',{bubbles:true}));assert.equal(calories.value,'1026.0');
  const preview=f.document.getElementById('nutrition-food-preview')!.textContent??'';
  assert.match(preview,/2 份/);assert.match(preview,/未提供可靠克重/);assert.ok(!/NaN|100g|nullg|0g/.test(preview));
  assert.ok(f.requests.every((request)=>request.method==='GET'&&!request.path.includes('/parse')&&!request.path.includes('/photo')));
});

test('minified food library browses the current catalog, paginates and opens read-only official nutrition details', { skip: !hasBuild }, async () => {
  const f = await fixture('id="food-library-page"', '/health/foods', 390);
  const list = f.document.getElementById('food-library-list')!;
  await settle(() => list.getAttribute('aria-busy') === 'false');
  assert.equal(list.children.length, 24);
  assert.equal(list.querySelectorAll('.fl-product-photo').length, 24);
  assert.equal(list.querySelectorAll('.fl-ring').length, 0);
  const photo = list.querySelector('.fl-product-photo')!;
  assert.equal(photo.getAttribute('src'), '/food-images/mcd-cn/49.png');
  assert.equal(photo.getAttribute('loading'), 'lazy');
  assert.equal(photo.getAttribute('width'), '88');
  assert.equal(photo.getAttribute('height'), '80');
  assert.ok(photo.getAttribute('alt'));
  photo.dispatchEvent(new f.window.Event('error'));
  assert.equal((photo as unknown as HTMLImageElement).hidden, true);
  assert.equal((photo.parentElement!.querySelector('.fl-image-fallback') as unknown as HTMLElement).hidden, false);
  assert.match(f.document.getElementById('food-library-count')?.textContent ?? '', /共 165 个条目/);
  assert.equal(f.document.querySelector('[data-context-path="/health/foods"]')?.getAttribute('aria-current'), 'page');
  const firstName = list.querySelector('.fl-card-name')?.textContent;
  list.querySelector('[data-food-open]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.document.getElementById('food-library-dialog')?.hasAttribute('open'), true);
  assert.equal(f.document.getElementById('food-library-detail-title')?.textContent, firstName);
  assert.equal(f.document.querySelectorAll('#food-library-detail .fl-ring').length, 1);
  assert.match(f.document.getElementById('food-library-detail')?.textContent ?? '', /钠.*钙.*2026-11-12/);
  const record = new URL(f.document.getElementById('food-library-record')!.getAttribute('href')!, 'https://synthetic.example');
  assert.equal(record.pathname, '/health/nutrition');
  assert.ok(record.searchParams.get('food')?.startsWith('mcd-cn:'));
  f.document.getElementById('food-library-close')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  f.document.getElementById('food-library-next')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle(() => list.getAttribute('aria-busy') === 'false' && f.document.getElementById('food-library-page-number')?.textContent === '第 2 / 7 页');
  assert.equal(list.children.length, 24);
  assert.notEqual(list.querySelector('.fl-card-name')?.textContent, firstName);
  assert.ok(f.requests.some((item) => new URL(item.path, 'https://synthetic.example').searchParams.get('offset') === '24'));
  const query = f.document.getElementById('food-library-query') as HTMLInputElement;
  query.value = '巨无霸';
  f.document.getElementById('food-library-filter')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => list.getAttribute('aria-busy') === 'false' && list.textContent?.includes('巨无霸') === true);
  assert.ok(list.children.length > 0 && list.children.length < 24);
  assert.equal(f.document.getElementById('food-library-pagination')?.hidden, true);
  assert.ok(!f.document.body.textContent?.includes('台湾'));
  assert.ok(f.requests.every((item) => item.method === 'GET' && item.path.startsWith('/api/health/foods?')));
});

test('minified food-library handoff prepares a one-serving confirmation without saving', { skip: !hasBuild }, async () => {
  const f = await fixture('id="nutrition-page"', '/health/nutrition?food=mcd-cn%3A49%3A28', 390);
  await settle(() => f.document.getElementById('nutrition-dialog')?.hasAttribute('open') === true);
  assert.match((f.document.getElementById('nutrition-name') as HTMLInputElement).value, /巨无霸/);
  assert.equal((f.document.getElementById('nutrition-food-quantity') as HTMLInputElement).value, '1');
  assert.equal((f.document.getElementById('nutrition-food-unit') as unknown as HTMLSelectElement).value, '份');
  assert.equal((f.document.getElementById('nutrition-calories') as HTMLInputElement).value, '513.0');
  assert.ok(f.requests.some((item) => item.path.includes('/foods?id=')));
  assert.ok(f.requests.every((item) => item.method === 'GET'));
});

test('minified Luckin library restores its brand, shows unknown energy and opens product details without inventing a serving', { skip: !hasBuild }, async () => {
  const f=await fixture('id="food-library-page"','/health/foods?brand=luckin-cn&q='+encodeURIComponent('小黄油拿铁'),390);
  const list=f.document.getElementById('food-library-list')!;
  await settle(()=>list.getAttribute('aria-busy')==='false');
  assert.equal((f.document.getElementById('food-library-brand') as unknown as HTMLSelectElement).value,'luckin-cn');
  const category=f.document.getElementById('food-library-category') as unknown as HTMLSelectElement;
  assert.equal(category.querySelectorAll('option').length,8);
  assert.ok(!category.textContent?.includes('汉堡和卷'));
  assert.equal(list.children.length,1);
  assert.match(list.textContent??'',/热量未公布/);
  assert.ok(list.querySelector('img')?.getAttribute('src')?.startsWith('/food-images/luckin-cn/'));
  list.querySelector('[data-food-open]')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.match(f.document.getElementById('food-library-detail')?.textContent??'',/官网未公布此产品的热量/);
  assert.equal(f.document.getElementById('food-library-record')?.textContent,'带入手工核对');
  const brand=f.document.getElementById('food-library-brand') as unknown as HTMLSelectElement;
  brand.value='mcd-cn';brand.dispatchEvent(new f.window.Event('change',{bubbles:true}));
  assert.equal(category.disabled,true);
  assert.equal(category.querySelectorAll('option').length,1);
  await settle(()=>list.getAttribute('aria-busy')==='false');
  assert.equal(category.disabled,false);
  assert.equal(category.querySelectorAll('option').length,9);
  assert.ok(category.textContent?.includes('汉堡和卷'));
  assert.ok(!category.textContent?.includes('拿铁类'));
  assert.equal(list.children.length,0,'the retained search can be empty while the brand category list stays complete');
  assert.ok(f.requests.every((item)=>item.method==='GET'&&item.path.startsWith('/api/health/foods?')));
});

test('minified food library normalizes a restored category from a different brand to its first page', { skip: !hasBuild }, async () => {
  const f=await fixture('id="food-library-page"','/health/foods?brand=luckin-cn&category='+encodeURIComponent('汉堡和卷')+'&offset=24',390);
  const list=f.document.getElementById('food-library-list')!;
  await settle(()=>list.getAttribute('aria-busy')==='false');
  const category=f.document.getElementById('food-library-category') as unknown as HTMLSelectElement;
  assert.equal(category.value,'');
  assert.equal(category.querySelectorAll('option').length,8);
  assert.equal(list.children.length,24);
  assert.equal(f.document.getElementById('food-library-page-number')?.textContent,'第 1 / 2 页');
  const query=new URLSearchParams(f.location.search);
  assert.equal(query.get('brand'),'luckin-cn');assert.equal(query.has('category'),false);assert.equal(query.has('offset'),false);
  assert.equal(f.requests.length,1);assert.ok(f.requests.every((item)=>item.method==='GET'));
});

test('minified Luckin handoffs preserve official kcal or unknown energy behind explicit manual confirmation', { skip: !hasBuild }, async () => {
  const known=await fixture('id="nutrition-page"','/health/nutrition?food=luckin-cn%3A1',390);
  await settle(()=>known.document.getElementById('nutrition-dialog')?.hasAttribute('open')===true);
  const quantity=known.document.getElementById('nutrition-food-quantity') as HTMLInputElement;
  assert.equal((known.document.getElementById('nutrition-calories') as HTMLInputElement).value,'179.0');
  quantity.value='0.5';quantity.dispatchEvent(new known.window.Event('input',{bubbles:true}));
  assert.equal((known.document.getElementById('nutrition-calories') as HTMLInputElement).value,'89.5');
  const unknown=await fixture('id="nutrition-page"','/health/nutrition?food=luckin-cn%3A49',390);
  await settle(()=>unknown.document.getElementById('nutrition-dialog')?.hasAttribute('open')===true);
  assert.equal((unknown.document.getElementById('nutrition-calories') as HTMLInputElement).value,'');
  assert.equal((unknown.document.getElementById('nutrition-portion') as HTMLInputElement).value,'');
  assert.match((unknown.document.getElementById('nutrition-name') as HTMLInputElement).value,/咸法酪泰奶/);
  assert.match((unknown.document.getElementById('nutrition-note') as HTMLTextAreaElement).value,/lkcoffee.com/);
  assert.ok([...known.requests,...unknown.requests].every((item)=>item.method==='GET'));
});

function libraryPersonalTemplate(): NutritionTemplate {
  return {...parseNutritionTemplate({kind:'meal',name:'我的测试整餐',note:'个人模板',baseServings:'1',totalWeight:null,components:[{name:'牛奶',portion:'1杯',grams:null,calories:'120',carbs:null,protein:'0',fat:null},{name:'其他食品',portion:'1份',grams:null,calories:null,carbs:null,protein:null,fat:null}]}),id:'22222222-2222-4222-8222-222222222222',revision:1,createdAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-14T00:00:00Z',archivedAt:null};
}

test('minified unified library keeps personal templates private and enters their existing explicit preview flow', {skip:!hasBuild}, async()=>{
  const template=libraryPersonalTemplate();
  const library=await fixture('id="food-library-page"','/health/foods?scope=mine',390,{}, {foods:[],personalTemplates:[template]});
  await settle(()=>library.document.getElementById('food-library-list')?.getAttribute('aria-busy')==='false');
  assert.equal(library.document.querySelectorAll('#food-library-list .fl-card').length,1);
  assert.ok(library.document.querySelector('.fl-private-tag'));
  assert.match(library.document.getElementById('food-library-list')?.textContent??'',/热量未填/);
  library.document.querySelector('[data-food-open]')!.dispatchEvent(new library.window.Event('click',{bubbles:true}));
  assert.match(library.document.getElementById('food-library-record')?.getAttribute('href')??'',/template=22222222-2222-4222-8222-222222222222/);
  const nutrition=await fixture('id="nutrition-page"','/health/nutrition?template='+template.id+'&templateRevision=1',390,{}, {foods:[],personalTemplates:[template]});
  await settle(()=>nutrition.document.getElementById('nutrition-template-use-dialog')?.hasAttribute('open')===true);
  assert.equal((nutrition.document.getElementById('nutrition-template-confirm') as HTMLButtonElement).disabled,true);
  assert.equal(nutrition.document.getElementById('nutrition-batch-dialog')?.hasAttribute('open'),false);
  assert.ok([...library.requests,...nutrition.requests].every(request=>request.method==='GET'));
});

test('minified drink controls drop nutrition when changing the published cold configuration to hot', {skip:!hasBuild}, async()=>{
  const library=await fixture('id="food-library-page"','/health/foods?q='+encodeURIComponent('瑞幸生椰拿铁'),390);
  await settle(()=>library.document.getElementById('food-library-list')?.getAttribute('aria-busy')==='false');
  library.document.querySelector('[data-food-open]')!.dispatchEvent(new library.window.Event('click',{bubbles:true}));
  const temperature=library.document.querySelector('[data-drink-field="temperature"]') as unknown as HTMLSelectElement;
  assert.ok(temperature);temperature.value='热';temperature.dispatchEvent(new library.window.Event('change',{bubbles:true}));
  assert.match(library.document.getElementById('food-library-drink-status')?.textContent??'',/暂无此配置官方营养/);
  const target=library.document.getElementById('food-library-record')!.getAttribute('href')!;
  const nutrition=await fixture('id="nutrition-page"',target,390);
  await settle(()=>nutrition.document.getElementById('nutrition-dialog')?.hasAttribute('open')===true);
  assert.equal((nutrition.document.getElementById('nutrition-calories') as HTMLInputElement).value,'');
  assert.match((nutrition.document.getElementById('nutrition-portion') as HTMLInputElement).value,/热/);
  assert.ok([...library.requests,...nutrition.requests].every(request=>request.method==='GET'));
});

test('minified public food manager opens a draft without publishing or saving automatically', {skip:!hasBuild}, async()=>{
  const f=await fixture('id="managed-food-page"','/health/foods/manage',390);
  await settle(()=>f.document.getElementById('mf-content')?.hidden===false);
  f.document.getElementById('mf-new')!.dispatchEvent(new f.window.Event('click',{bubbles:true}));
  assert.equal(f.document.getElementById('mf-editor')?.hasAttribute('open'),true);
  assert.equal(f.document.getElementById('mf-review')?.hasAttribute('open'),false);
  assert.equal((f.document.getElementById('mf-name') as HTMLInputElement).value,'');
  assert.ok(f.requests.every(request=>request.method==='GET'&&request.path==='/api/health/foods/manage'));
});

test('minified viewer can read a family book and its activity without exposing mutation actions', {skip:!hasBuild}, async()=>{
  const book='11111111-1111-4111-8111-111111111111';
  const choices=[{id:'own',name:'我的家庭账本',ownerName:'Synthetic account',role:'owner',accessRevision:0,canWrite:true,canManageMembers:true,canExport:true},{id:book,name:'共享家庭账本',ownerName:'另一位拥有人',role:'viewer',accessRevision:2,canWrite:false,canManageMembers:false,canExport:false}];
  const f=await fixture('id="account-list"','/finance?ledger=family&book='+book+'&bookRevision=2',390,{}, {foods:[],financeBooks:choices});
  await settle(()=>Boolean(f.document.documentElement.hasAttribute('data-finance-readonly')));
  assert.equal(f.document.getElementById('finance-books-manage')?.hidden,true);
  assert.ok(f.requests.every(request=>request.method==='GET'));
  const activity=await fixture('id="finance-activity-page"','/finance/activity?ledger=family&book='+book+'&bookRevision=2',390,{}, {foods:[],financeBooks:choices});
  await settle(()=>activity.document.getElementById('finance-activity-list')?.getAttribute('aria-busy')==='false');
  assert.match(activity.document.getElementById('finance-activity-status')?.textContent??'',/还没有/);
  assert.ok(activity.requests.some(request=>request.path.includes('/'+book+'/activity?')));
  assert.ok(activity.requests.every(request=>request.method==='GET'));
});

test('minified notifications initialize category switches without marking messages read or changing preferences', {skip:!hasBuild}, async()=>{
  const f=await fixture('id="notifications-page"','/notifications',390);
  await settle(()=>f.document.getElementById('notifications-page')?.getAttribute('aria-busy')==='false');
  assert.equal(f.document.getElementById('notifications-empty')?.hidden,false);
  assert.equal((f.document.getElementById('notifications-read-all') as HTMLButtonElement).disabled,true);
  assert.equal((f.document.getElementById('notifications-setting-invitations') as HTMLInputElement).disabled,false);
  assert.equal(f.document.querySelector('[data-context-path="/notifications"]')?.getAttribute('aria-current'),'page');
  assert.ok(f.requests.every(request=>request.method==='GET'&&request.path.startsWith('/api/notifications?')));
});

test('minified custom fallback previews explicitly and remains saved while official covers take priority', { skip: !hasBuild }, async () => {
  const item=mediaWorkspaceRecord('movie','8123456','生产自选封面作品'),chosen='https://images.example.org/production-cover.jpg';
  item.coverUrl='https://img1.doubanio.com/view/photo/public/p123456.jpg';
  const library={connection:{profileId:'synthetic-profile',revision:1,updatedAt:'2026-11-14T00:00:00.000Z'},items:[item],allowCoverSelection:true,allowMetadata:true};
  const f=await fixture('id="douban-page"','/life/douban',390,{}, {foods:[],douban:library});
  const query=<T=HTMLElement>(selector:string)=>{const element=f.document.querySelector(selector);assert.ok(element,selector);return element as unknown as T;};
  await settle(()=>query('#douban-page').getAttribute('aria-busy')==='false');query('[data-douban-open="0"]').dispatchEvent(new f.window.Event('click',{bubbles:true}));
  const mode=query<HTMLSelectElement>('[data-douban-cover-mode]');mode.value='url';mode.dispatchEvent(new f.window.Event('change',{bubbles:true}));const input=query<HTMLInputElement>('[data-douban-cover-url]');input.value=chosen;input.dispatchEvent(new f.window.Event('input',{bubbles:true}));
  assert.equal(f.doubanCoverSelectionBodies.length,0);const before=f.requests.length;query('[data-douban-cover-preview]').dispatchEvent(new f.window.Event('click',{bubbles:true}));const preview=query<HTMLImageElement>('[data-douban-cover-preview-image]');assert.equal(preview.getAttribute('src'),chosen);assert.equal(preview.getAttribute('referrerpolicy'),'no-referrer');preview.dispatchEvent(new f.window.Event('load'));assert.equal(f.requests.length,before,'preview reads through img, never the API transport');
  query('#douban-cover-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settleWork(()=>f.doubanCoverSelectionBodies.length===1&&!query<HTMLSelectElement>('[data-douban-cover-mode]').disabled,()=>query('[data-douban-cover-status]').textContent??'cover save');assert.match(query('#douban-list img').getAttribute('src')??'',/^\/api\/life\/douban\/cover\?/);assert.match(query('[data-douban-detail-cover]').getAttribute('src')??'',/^\/api\/life\/douban\/cover\?/);
  assert.deepEqual(f.doubanCoverSelectionBodies,[{profileId:item.profileId,domain:'screen',subjectId:item.subjectId,expectedDataEpoch:0,expectedLocalRevision:0,mode:'url',url:chosen}]);
  query('[data-douban-metadata-item]').dispatchEvent(new f.window.Event('click',{bubbles:true}));await settleWork(()=>query('#douban-metadata-status').textContent?.startsWith('本次补全完成')===true,()=>query('#douban-metadata-status').textContent??'metadata');assert.match(query('#douban-list img').getAttribute('src')??'',/^\/api\/life\/douban\/cover\?/);assert.match(query('[data-douban-detail-cover]').getAttribute('src')??'',/^\/api\/life\/douban\/cover\?/);
  query('[data-douban-cover-original]').dispatchEvent(new f.window.Event('click',{bubbles:true}));assert.equal(f.doubanCoverSelectionBodies.length,1);query('#douban-cover-form').dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settleWork(()=>f.doubanCoverSelectionBodies.length===2&&!query<HTMLSelectElement>('[data-douban-cover-mode]').disabled,()=>query('[data-douban-cover-status]').textContent??'original');
  assert.equal(f.doubanCoverSelectionBodies.length,2);assert.equal(f.doubanCoverSelectionBodies[1].mode,'original');assert.equal(Object.hasOwn(f.doubanCoverSelectionBodies[1],'url'),false);assert.equal(f.requests.some(request=>request.path===chosen),false);assert.ok(f.requests.filter(request=>request.method!=='GET').every(request=>['/api/life/douban/cover-selection','/api/life/douban/metadata'].includes(request.path)));
});

function productionTMDBPoster(imdbId: string): SyntheticTMDBCover {
  return { imdbId, mediaType: 'movie', tmdbId: 24680, posterPath: '/synthetic-production-poster.jpg', language: 'zh', matchedAt: '2026-11-14T00:00:00.000Z' };
}
const PRODUCTION_TMDB_POSTER = 'https://image.tmdb.org/t/p/w500/synthetic-production-poster.jpg';

test('minified saved covers fall through official, TMDB and custom images without writes or authenticated third-party fetches', { skip: !hasBuild }, async () => {
  const official = { ...mediaWorkspaceRecord('movie', '8160000', '生产豆瓣原图回退'), coverUrl: 'https://img1.doubanio.com/view/photo/public/p16000.jpg', details: { imdbId: 'tt0016000' }, tmdb: productionTMDBPoster('tt0016000') };
  const manual = { ...mediaWorkspaceRecord('movie', '8160001', '生产自定义最终回退'), coverUrl: 'https://img1.doubanio.com/view/photo/public/p16001.jpg', details: { imdbId: 'tt0016001' }, tmdb: productionTMDBPoster('tt0016001'), cover: { mode: 'url' as const, url: 'https://images.example.org/production-selected.jpg', revision: 2 }, local: { note: '', tags: [], hidden: false, revision: 2 } };
  const stale = { ...mediaWorkspaceRecord('movie', '8160002', '生产陈旧匹配'), details: { imdbId: 'tt0016002' }, tmdb: productionTMDBPoster('tt0016999') };
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: { connection: { profileId: official.profileId, revision: 1, updatedAt: official.updatedAt }, items: [official, manual, stale] } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  const cards = [...f.document.querySelectorAll('#douban-list .db-card')];
  const originalImage = cards[0].querySelector('img')!;
  assert.match(originalImage.getAttribute('src') ?? '', /^\/api\/life\/douban\/cover\?/);
  const beforeFailure = f.requests.length;
  originalImage.dispatchEvent(new f.window.Event('load'));
  assert.match(originalImage.getAttribute('src') ?? '', /^\/api\/life\/douban\/cover\?/);
  const manualImage = cards[1].querySelector('img')!;
  manualImage.dispatchEvent(new f.window.Event('error'));
  assert.equal(manualImage.getAttribute('src'), PRODUCTION_TMDB_POSTER);
  assert.equal(manualImage.getAttribute('referrerpolicy'), 'no-referrer');
  manualImage.dispatchEvent(new f.window.Event('error'));
  assert.equal(manualImage.getAttribute('src'), manual.cover.url);
  assert.equal(cards[2].querySelector('img')?.getAttribute('data-douban-cover'), 'missing', 'a stored TMDB match for another IMDb ID must not appear');
  assert.equal(f.requests.length, beforeFailure, 'TMDB posters use img.src and never the authenticated request transport');
  f.document.querySelector('[data-douban-open="0"]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.match(f.document.getElementById('douban-detail-body')?.textContent ?? '', /tt0016000/);
  const detailImage = f.document.querySelector('.db-detail-cover img')!;
  detailImage.dispatchEvent(new f.window.Event('error'));
  assert.equal(detailImage.getAttribute('src'), PRODUCTION_TMDB_POSTER);
  assert.match(f.document.querySelector('#douban-detail-body [data-douban-tmdb-source]')?.textContent ?? '', /TMDB/);
  assert.equal(official.coverUrl, 'https://img1.doubanio.com/view/photo/public/p16000.jpg');
  assert.equal(f.doubanTMDBBodies.length, 0);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('minified extension 1.0.6 persists Douban IMDb before TMDB lookup and keeps the selected cover and personal revision', { skip: !hasBuild }, async () => {
  const existing = { ...mediaWorkspaceRecord('movie', '8161000', '生产自动 IMDb 封面'), coverUrl: 'https://img1.doubanio.com/view/photo/public/p16100.jpg', cover: { mode: 'url' as const, url: 'https://images.example.org/production-manual.jpg', revision: 4 }, local: { note: '应保留的本地备注', tags: ['保留'], hidden: false, revision: 4 } };
  const { profileId: _profileId, observedAt: _observedAt, createdAt: _createdAt, updatedAt: _updatedAt, cover: _cover, local: _local, ...input } = existing;
  const metadata: DoubanSubjectMetadata = { kind: 'movie', coverUrl: null, details: { imdbId: 'tt0016100', duration: '120分钟' } };
  const items = [existing];
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: existing.profileId, revision: 1, updatedAt: existing.updatedAt }, items, allowMetadata: true, allowTMDB: true,
    tmdbResults: { [existing.subjectId]: { status: 'matched', cover: productionTMDBPoster('tt0016100') } },
    browserExtensionItems: [{ ...input, source: 'browser' }], browserExtensionVersion: '1.0.6', browserSubjectMetadata: { ['screen:' + existing.subjectId]: metadata },
  } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.doubanTMDBBodies.length, 0);
  openMediaTools(f, 'browser');
  f.document.getElementById('douban-browser-sync')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settleWork(() => f.document.getElementById('douban-browser-status')?.textContent?.includes('浏览器同步完成') === true, () => f.document.getElementById('douban-browser-status')?.textContent ?? 'automatic IMDb/TMDB flow');
  assert.equal(f.doubanMetadataBodies.length, 1); assert.equal(f.doubanTMDBBodies.length, 1);
  assert.equal(items[0].details?.imdbId, 'tt0016100');
  assert.deepEqual((items[0] as DoubanRecord & { tmdb?: SyntheticTMDBCover }).tmdb, productionTMDBPoster('tt0016100'));
  assert.deepEqual(f.doubanTMDBBodies[0], { profileId: existing.profileId, domain: 'screen', subjectId: existing.subjectId,
    expectedUpdatedAt: new Date(Date.parse(String(f.doubanMetadataBodies[0].expectedUpdatedAt)) + 1).toISOString(), expectedDataEpoch: 0, confirmed: true });
  assert.ok(f.requests.findIndex(request => request.path === '/api/life/douban/tmdb') > f.requests.findIndex(request => request.path === '/api/life/douban/metadata'));
  assert.deepEqual(items[0].cover, existing.cover); assert.deepEqual(items[0].local, existing.local); assert.equal(items[0].coverUrl, existing.coverUrl);
  assert.match(f.document.querySelector('#douban-list img')?.getAttribute('src') ?? '', /^\/api\/life\/douban\/cover\?/);
  assert.equal(f.doubanExtensionMessages.filter(body => body.action === 'SUBJECT').length, 1);
  assert.doesNotMatch(JSON.stringify(f.doubanTMDBBodies), /独立的个人短评|应保留的本地备注|rating|comment|markedDate|cookie|password|rawHTML/i);
});

for (const [status, message] of [
  ['not_configured', 'TMDB 尚未配置，未保存封面。'],
  ['no_match', 'TMDB 未找到匹配的作品，未保存封面。'],
  ['ambiguous', 'TMDB 存在多个匹配，未保存封面。'],
  ['rate_limited', 'TMDB 请求频率受限，请稍后重试，未保存封面。'],
] as const) test('minified explicit TMDB lookup reports ' + status + ' without inventing a saved poster', { skip: !hasBuild }, async () => {
  const item = { ...mediaWorkspaceRecord('movie', '8164000', '生产查询状态'), details: { imdbId: 'tt0016400' } };
  const f = await fixture('id="douban-page"', '/life/douban', 390, {}, { foods: [], douban: {
    connection: { profileId: item.profileId, revision: 1, updatedAt: item.updatedAt }, items: [item], allowTMDB: true,
    tmdbResults: { [item.subjectId]: { status, message, ...(status === 'rate_limited' ? { retryAfter: 30 } : {}) } },
  } });
  await settle(() => f.document.getElementById('douban-page')?.getAttribute('aria-busy') === 'false');
  f.document.querySelector('[data-douban-open="0"]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(f.doubanTMDBBodies.length, 0);
  f.document.querySelector('[data-douban-tmdb-item]')!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settleWork(() => {
    const text = f.document.querySelector('[data-douban-tmdb-status]')?.textContent ?? '';
    return status === 'rate_limited' ? /限流/.test(text) && /30 秒/.test(text) : text.includes(message);
  }, () => f.document.querySelector('[data-douban-tmdb-status]')?.textContent ?? 'explicit poster lookup');
  assert.equal(f.doubanTMDBBodies.length, 1);
  assert.equal(f.document.querySelector('.db-detail-cover img')?.getAttribute('data-douban-cover'), 'missing');
  assert.equal((item as DoubanRecord & { tmdb?: SyntheticTMDBCover }).tmdb, undefined);
  assert.deepEqual(f.requests.filter(request => request.method !== 'GET').map(request => request.path), ['/api/life/douban/tmdb']);
});


for (const width of [390, 1280]) test(width + 'px minified TMDB settings load safe shared metadata without credentials or automatic writes', { skip: !hasBuild }, async () => {
  const f = await fixture('id="tmdb-page"', '/settings/media', width, {}, { foods: [], tmdbCanManage: true, tmdbConfigured: true });
  await settle(() => f.document.getElementById('tmdb-page')?.getAttribute('aria-busy') === 'false');
  const input = f.document.getElementById('tmdb-token') as HTMLInputElement;
  assert.equal(input.value, ''); assert.equal(input.getAttribute('type'), 'password');
  assert.match(f.document.getElementById('tmdb-configured')?.textContent ?? '', /Token 不回显/);
  assert.equal(f.document.getElementById('tmdb-manage')?.hidden, false);
  assert.ok(f.requests.some(request => request.path === '/api/media/tmdb/settings'));
  assert.ok(f.requests.every(request => request.method === 'GET'));
  input.value = 'synthetic-production-token-DO-NOT-ECHO'; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  assert.equal(input.value, '', 'leaving the page clears the secret draft');
  assert.doesNotMatch(JSON.stringify(f.localStorage.snapshot()) + JSON.stringify(f.sessionStorage.snapshot()), /synthetic-production-token/);
});

test('minified members see shared TMDB status and cannot trigger secret mutations through synthetic events', { skip: !hasBuild }, async () => {
  const f = await fixture('id="tmdb-page"', '/settings/media', 390, {}, { foods: [], tmdbCanManage: false, tmdbConfigured: true });
  await settle(() => f.document.getElementById('tmdb-page')?.getAttribute('aria-busy') === 'false');
  assert.equal(f.document.getElementById('tmdb-manage')?.hidden, true);
  const input = f.document.getElementById('tmdb-token') as HTMLInputElement;
  assert.equal(input.disabled, true); assert.equal(input.value, '');
  assert.match(f.document.getElementById('tmdb-shared-note')?.textContent ?? '', /无需填写/);
  input.value = 'synthetic-production-unauthorized-secret';
  f.document.getElementById('tmdb-form')!.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  for (const id of ['test', 'delete-open', 'delete-submit']) f.document.getElementById('tmdb-' + id)!.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.ok(f.requests.every(request => request.method === 'GET'));
});
