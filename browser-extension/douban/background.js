/** MV3 worker. Credentials remain in the browser's native Douban cookie jar. */
import { parseDoubanDetails } from './details-parser.js';
export const WEBSITE_ORIGIN = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site';
export const EXTENSION_VERSION = '1.0.6';
const DOMAINS = ['screen', 'book', 'music'];
const HOSTS = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PAGES = 1000;
const MESSAGES = {
  INVALID_REQUEST: '同步请求格式不正确，请刷新本站后重试。',
  FORBIDDEN: '仅允许在 Jiashu OS 的豆瓣页面使用此扩展。',
  RUN_NOT_FOUND: '扩展中的临时同步已结束或被浏览器释放，请重新开始。',
  RUN_BUSY: '已有一项同步正在进行，请先停止该同步。',
  STEP_CONFLICT: '同步进度已变化，请停止后重新开始。',
  PACING: '正在等待正常的逐页读取间隔，请稍后继续。',
  DOUBAN_BROWSER_LOGIN_REQUIRED: '请在正常豆瓣页面完成登录，再重新开始同步。',
  DOUBAN_BROWSER_CHALLENGE: '豆瓣要求安全验证，已停止该来源，请在正常页面自行处理。',
  DOUBAN_BROWSER_BLOCKED: '豆瓣限制了该来源的访问，已停止该来源。',
  DOUBAN_BROWSER_RATE_LIMITED: '豆瓣正在限制访问频率，本次同步已停止，请稍后重试。',
  DOUBAN_BROWSER_PROFILE_MISMATCH: '豆瓣当前账户或页面与填写的主页不一致，已停止读取。',
  DOUBAN_BROWSER_INVALID: '豆瓣页面未能确认，已停止本次读取，避免保存错误资料。',
  DOUBAN_BROWSER_TOO_LARGE: '豆瓣收藏页面超过读取上限，已停止该来源。',
  DOUBAN_BROWSER_TIMEOUT: '豆瓣页面读取超时，已停止该来源。',
  DOUBAN_BROWSER_NETWORK: '豆瓣页面暂时无法读取，已停止该来源。',
};
const SAFE_CODES = new Set(Object.keys(MESSAGES));
// Diagnostics are fixed labels, never text, URLs, HTML, or browser exceptions.
const ERROR_REASONS = new Set(['input', 'document', 'structure_limit', 'account_navigation', 'heading', 'total', 'rows', 'item_url', 'item_title', 'item_comment',
  'item_rating', 'item_date', 'duplicate_items', 'item_range', 'pagination_query', 'pagination_offset', 'pagination_incomplete', 'subject_identity',
  'subject_structure', 'account_mismatch', 'collection_identity', 'script_unavailable', 'document_unavailable', 'document_position', 'result_shape', 'total_changed', 'duplicate_page']);
function safeReason(value) { return typeof value === 'string' && ERROR_REASONS.has(value) ? value : undefined; }
function failure(code, retryAfter) { return { ok: false, error: { code, message: MESSAGES[code] ?? MESSAGES.DOUBAN_BROWSER_INVALID, ...(retryAfter === undefined ? {} : { retryAfter }) } }; }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sourceProgress() { return { status: 'pending', start: 0, pages: 0, segmentPages: 0, received: 0, total: null, lastPageIds: null, errorCode: null }; }
function collectionUrl(profileId, domain, start) {
  const all = domain === 'screen' ? { type: 'all' } : { rating: 'all' };
  return 'https://' + HOSTS[domain] + '/people/' + profileId + '/collect?' + new URLSearchParams({ start: String(start), sort: 'time', ...all, filter: 'all', mode: 'grid' });
}
function permittedSender(sender) {
  if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 || sender.frameId !== undefined && sender.frameId !== 0 || typeof sender.url !== 'string') return false;
  try { const url = new URL(sender.url); return url.origin === WEBSITE_ORIGIN && url.pathname === '/life/douban' && !url.username && !url.password; } catch { return false; }
}
function validRequest(message) {
  if (!plain(message) || message.type !== 'JIASHU_DOUBAN' || message.version !== 1
    || !['CONNECT', 'STATUS', 'LOGIN', 'START', 'STEP', 'POLL', 'CANCEL', 'SUBJECT', 'SUBJECT_CANCEL'].includes(message.action)
    || typeof message.ownerKey !== 'string' || !UUID.test(message.ownerKey)
    || typeof message.profileId !== 'string' || !PROFILE.test(message.profileId)) return false;
  const keys = ['type', 'version', 'action', 'ownerKey', 'profileId'];
  if (message.action === 'START') keys.push('domains');
  if (['STEP', 'POLL', 'CANCEL'].includes(message.action)) keys.push('runId');
  if (message.action === 'STEP') keys.push('step', 'requestId');
  if (message.action === 'SUBJECT') keys.push('requestId', 'domain', 'subjectId', 'runId');
  if (message.action === 'SUBJECT_CANCEL') keys.push('requestId');
  if (Object.keys(message).some(key => !keys.includes(key))) return false;
  if (message.action === 'START' && Object.hasOwn(message, 'domains') && (!Array.isArray(message.domains)
    || !message.domains.length || message.domains.length > DOMAINS.length
    || new Set(message.domains).size !== message.domains.length || message.domains.some(domain => !DOMAINS.includes(domain)))) return false;
  if (['SUBJECT', 'SUBJECT_CANCEL'].includes(message.action)
    && (typeof message.requestId !== 'string' || !UUID.test(message.requestId))) return false;
  if (message.action === 'SUBJECT' && (!DOMAINS.includes(message.domain) || typeof message.subjectId !== 'string'
    || !/^[1-9]\d{0,15}$/.test(message.subjectId)
    || Object.hasOwn(message, 'runId') && (typeof message.runId !== 'string' || !UUID.test(message.runId)))) return false;
  if (['STEP', 'POLL', 'CANCEL'].includes(message.action) && (typeof message.runId !== 'string' || !UUID.test(message.runId))) return false;
  return message.action !== 'STEP' || Number.isSafeInteger(message.step) && message.step >= 0 && typeof message.requestId === 'string' && UUID.test(message.requestId);
}

// Only the public subject fields leave the isolated reader. Personal collection
// values and arbitrary content-script properties never enter this response.
function normalizeSubjectMetadata(value, domain) {
  if (!plain(value) || Object.keys(value).some(key => !['kind', 'coverUrl', 'details'].includes(key))
    || value.kind !== null && !(domain === 'screen' ? ['movie', 'series'].includes(value.kind) : value.kind === domain)
    || value.coverUrl !== null && (typeof value.coverUrl !== 'string' || value.coverUrl.length > 2048)
    || !plain(value.details ?? {})) throw { code: 'DOUBAN_BROWSER_INVALID' };
  let details;
  try { details = parseDoubanDetails(value.details); } catch { throw { code: 'DOUBAN_BROWSER_INVALID' }; }
  return { kind: value.kind, coverUrl: value.coverUrl, details };
}

/** Kept exportable so protocol and navigation boundaries can be tested without a real Chrome account. */
export function createDoubanExtensionController(chromeApi, options = {}) {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const readPage = options.readPage ?? ((run, domain) => readOwnedPage(chromeApi, run, domain));
  const readSubject = options.readSubject ?? (job => readOwnedSubject(chromeApi, job));
  let active = null, subject = null, lastExternalReadAt = null;
  function subjectOwner(job, message, sender) {
    return job && job.ownerKey === message.ownerKey && job.profileId === message.profileId && job.websiteTabId === sender.tab.id;
  }
  function owns(run, message, sender) {
    return run && run.id === message.runId && run.ownerKey === message.ownerKey && run.profileId === message.profileId && run.websiteTabId === sender.tab.id;
  }
  function parentAvailable(job) {
    return job.collectionRunId === null || active && active.id === job.collectionRunId && active.status !== 'cancelled'
      && active.ownerKey === job.ownerKey && active.profileId === job.profileId && active.websiteTabId === job.websiteTabId;
  }
  function cancelRunSubject(run) {
    const job = subject;
    if (!job || job.collectionRunId !== run.id || job.ownerKey !== run.ownerKey || job.profileId !== run.profileId || job.websiteTabId !== run.websiteTabId) return null;
    job.status = 'cancelled'; job.response = null; return job;
  }
  function progress(run) {
    return { status: run.status, sources: structuredClone(run.sources), received: DOMAINS.reduce((sum, domain) => sum + run.sources[domain].received, 0),
      pages: DOMAINS.reduce((sum, domain) => sum + run.sources[domain].pages, 0), accountProfileId: run.accountProfileId };
  }
  function view(run) { return { runId: run.id, step: run.step, progress: progress(run), done: run.status !== 'running' }; }
  function finalize(run) {
    if (run.status === 'cancelled' || DOMAINS.some(domain => run.sources[domain].status === 'pending')) return;
    run.status = run.domains.every(domain => run.sources[domain].status === 'complete') ? 'completed'
      : run.domains.some(domain => run.sources[domain].received > 0 || run.sources[domain].status === 'complete') ? 'partial' : 'failed';
  }
  async function stopRead(run) {
    for (const tabId of Object.values(run.tabs)) {
      try { await chromeApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: cancelOwnedRead, args: [run.id] }); } catch { /* A closed tab has no pending read to cancel. */ }
    }
  }
  async function handle(message, sender) {
    if (!permittedSender(sender)) return failure('FORBIDDEN');
    if (!validRequest(message)) return failure('INVALID_REQUEST');
    if (message.action === 'CONNECT' || message.action === 'STATUS') return { ok: true, data: { extensionVersion: EXTENSION_VERSION, protocolVersion: 1 } };
    if (message.action === 'SUBJECT_CANCEL') {
      if (!subjectOwner(subject, message, sender) || subject.requestId !== message.requestId) return failure('RUN_NOT_FOUND');
      const job = subject; job.status = 'cancelled'; job.response = null;
      await stopRead(job);
      return { ok: true, data: { cancelled: true } };
    }
    if (message.action === 'SUBJECT') {
      if (subject?.requestId === message.requestId) {
        if (!subjectOwner(subject, message, sender)) return failure('RUN_NOT_FOUND');
        if (subject.domain !== message.domain || subject.subjectId !== message.subjectId || subject.requestRunId !== (message.runId ?? null)) return failure('STEP_CONFLICT');
        if (subject.status === 'cancelled' || !parentAvailable(subject)) return failure('RUN_NOT_FOUND');
        return subject.response ? structuredClone(subject.response) : failure('RUN_BUSY');
      }
      if (subject?.status === 'running') return failure('RUN_BUSY');
      let collection = null;
      if (message.runId !== undefined) {
        if (!owns(active, message, sender) || active.status === 'cancelled') return failure('RUN_NOT_FOUND');
        collection = active;
      } else if (active?.status === 'running') {
        if (!subjectOwner(active, message, sender)) return failure('RUN_BUSY');
        collection = active;
      }
      if (collection?.busy) return failure('RUN_BUSY');
      const lastRead = lastExternalReadAt ?? -Infinity;
      if (now() - lastRead < 1500) return failure('PACING', Math.ceil((1500 - (now() - lastRead)) / 1000));
      const prior = subject;
      const job = { id: message.requestId, requestId: message.requestId, ownerKey: message.ownerKey, profileId: message.profileId,
        websiteTabId: sender.tab.id, domain: message.domain, subjectId: message.subjectId, status: 'running',
        collectionRunId: collection?.id ?? null, requestRunId: message.runId ?? null,
        tabs: subjectOwner(prior, message, sender) ? { ...prior.tabs } : {}, response: null, attentionTabId: null };
      subject = job; lastExternalReadAt = now();
      let response;
      try {
        const metadata = normalizeSubjectMetadata(await readSubject(job), job.domain);
        if (subject !== job || job.status !== 'running' || !parentAvailable(job)) return failure('RUN_NOT_FOUND');
        response = { ok: true, data: { requestId: job.requestId, domain: job.domain, subjectId: job.subjectId, metadata } };
      } catch (error) {
        if (subject !== job || job.status !== 'running' || !parentAvailable(job)) return failure('RUN_NOT_FOUND');
        const code = SAFE_CODES.has(error?.code) ? error.code : 'DOUBAN_BROWSER_INVALID';
        if (['DOUBAN_BROWSER_LOGIN_REQUIRED', 'DOUBAN_BROWSER_CHALLENGE', 'DOUBAN_BROWSER_BLOCKED', 'DOUBAN_BROWSER_RATE_LIMITED'].includes(code)) job.attentionTabId = job.tabs[job.domain] ?? null;
        response = failure(code);
      }
      job.status = 'completed'; job.response = structuredClone(response);
      return response;
    }
    if (message.action === 'LOGIN') {
      const owned = active && active.ownerKey === message.ownerKey && active.profileId === message.profileId && active.websiteTabId === sender.tab.id;
      const tabId = subjectOwner(subject, message, sender) && subject.attentionTabId !== null ? subject.attentionTabId : owned ? active.attentionTabId : null;
      if (tabId !== null && tabId !== undefined) {
        try { await chromeApi.tabs.update(tabId, { active: true }); return { ok: true, data: { opened: true } }; }
        catch { /* The user may have closed that normal tab; use the fixed login page below. */ }
      }
      try { await chromeApi.tabs.create({ url: 'https://www.douban.com/accounts/login', active: true }); }
      catch { return failure('DOUBAN_BROWSER_NETWORK'); }
      return { ok: true, data: { opened: true } };
    }
    if (message.action === 'START') {
      if (subject?.status === 'running') return failure('RUN_BUSY');
      let interrupted = null;
      if (active?.status === 'running') {
        // A page reload creates a new owner marker. An explicit new start may
        // discard that same tab's former run, but never reveal or take over it.
        if (active.websiteTabId !== sender.tab.id || active.ownerKey === message.ownerKey) return failure('RUN_BUSY');
        interrupted = active; interrupted.status = 'cancelled'; interrupted.lastResult = null;
      }
      const domains = DOMAINS.filter(domain => (message.domains ?? DOMAINS).includes(domain));
      const created = { id: randomUUID(), ownerKey: message.ownerKey, profileId: message.profileId, websiteTabId: sender.tab.id, step: 0, status: 'running', domains,
        sources: Object.fromEntries(DOMAINS.map(domain => [domain, { ...sourceProgress(), status: domains.includes(domain) ? 'pending' : 'skipped' }])), tabs: {}, seen: new Set(), lastReadAt: null,
        lastResult: null, busy: false, accountProfileId: null, attentionTabId: null };
      active = created;
      if (interrupted) { const child = cancelRunSubject(interrupted); await stopRead(interrupted); if (child) await stopRead(child); }
      return { ok: true, data: view(created) };
    }
    const run = active;
    if (!owns(run, message, sender)) return failure('RUN_NOT_FOUND');
    if (message.action === 'POLL') return { ok: true, data: view(run) };
    if (message.action === 'CANCEL') {
      run.status = 'cancelled'; run.lastResult = null;
      const child = cancelRunSubject(run);
      await stopRead(run);
      if (child) await stopRead(child);
      return { ok: true, data: view(run) };
    }
    if (run.lastResult?.requestId === message.requestId) {
      return run.lastResult.requestStep === message.step ? structuredClone(run.lastResult.response) : failure('STEP_CONFLICT');
    }
    if (run.busy || subject?.status === 'running') return failure('RUN_BUSY');
    if (run.step !== message.step || run.status !== 'running') return failure('STEP_CONFLICT');
    const lastRead = lastExternalReadAt ?? -Infinity;
    if (now() - lastRead < 1500) return failure('PACING', Math.ceil((1500 - (now() - lastRead)) / 1000));
    const domain = DOMAINS.find(key => run.sources[key].status === 'pending');
    if (!domain) { finalize(run); return { ok: true, data: { ...view(run), items: [] } }; }
    const source = run.sources[domain];
    run.busy = true; run.lastReadAt = now(); lastExternalReadAt = run.lastReadAt;
    let items = [];
    try {
      const page = await readPage(run, domain);
      if (active !== run || run.status === 'cancelled') return failure('RUN_NOT_FOUND');
      if (!plain(page) || !Array.isArray(page.items) || page.items.length > 30 || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 100000
        || page.nextStart !== null && (!Number.isSafeInteger(page.nextStart) || page.nextStart <= source.start || page.nextStart > 100000)
        || page.accountProfileId !== null && typeof page.accountProfileId !== 'string') throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'result_shape' };
      if (page.accountProfileId !== null && page.accountProfileId !== run.profileId) throw { code: 'DOUBAN_BROWSER_PROFILE_MISMATCH', reason: 'account_mismatch' };
      if (source.total !== null && source.total !== page.total) throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'total_changed' };
      if (page.accountProfileId !== null) run.accountProfileId = page.accountProfileId;
      const keys = page.items.map(item => domain + ':' + item.subjectId);
      if (new Set(keys).size !== keys.length || keys.some(key => run.seen.has(key)) || page.items.some(item => item.domain !== domain)) throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'duplicate_page' };
      items = page.items.map(item => ({ ...item, source: 'browser' }));
      for (const key of keys) run.seen.add(key);
      source.pages++; source.segmentPages++; source.received += items.length; source.total = page.total; source.lastPageIds = keys.join(',');
      if (page.nextStart === null) source.status = 'complete';
      else { source.start = page.nextStart; if (source.pages >= MAX_PAGES) { source.status = 'limited'; source.errorCode = 'DOUBAN_BROWSER_LIMIT'; } }
    } catch (error) {
      if (active !== run || run.status === 'cancelled') return failure('RUN_NOT_FOUND');
      const code = SAFE_CODES.has(error?.code) ? error.code : 'DOUBAN_BROWSER_INVALID';
      const reason = safeReason(error?.reason);
      source.status = ['DOUBAN_BROWSER_LOGIN_REQUIRED', 'DOUBAN_BROWSER_CHALLENGE', 'DOUBAN_BROWSER_BLOCKED', 'DOUBAN_BROWSER_RATE_LIMITED', 'DOUBAN_BROWSER_PROFILE_MISMATCH'].includes(code) ? 'blocked' : 'failed';
      source.errorCode = code;
      if (reason) source.errorReason = reason;
      if (source.status === 'blocked') run.attentionTabId = run.tabs[domain] ?? null;
      if (code === 'DOUBAN_BROWSER_RATE_LIMITED' || code === 'DOUBAN_BROWSER_PROFILE_MISMATCH') {
        for (const key of DOMAINS) if (run.sources[key].status === 'pending') {
          run.sources[key].status = 'blocked'; run.sources[key].errorCode = code;
          if (reason) run.sources[key].errorReason = reason;
        }
      }
    } finally { run.busy = false; }
    run.step++; finalize(run);
    const response = { ok: true, data: { ...view(run), items } };
    run.lastResult = { requestId: message.requestId, requestStep: message.step, response: structuredClone(response) };
    return response;
  }
  return { handle };
}

async function readyTab(chromeApi, tabId) {
  const current = await chromeApi.tabs.get(tabId);
  if (current.status === 'complete') return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null), 20000);
    function finish(tab) {
      clearTimeout(timer); chromeApi.tabs.onUpdated.removeListener(updated); chromeApi.tabs.onRemoved.removeListener(removed);
      if (tab) resolve(tab); else reject({ code: 'DOUBAN_BROWSER_TIMEOUT' });
    }
    function updated(id, info, tab) { if (id === tabId && info.status === 'complete') finish(tab); }
    function removed(id) { if (id === tabId) finish(null); }
    chromeApi.tabs.onUpdated.addListener(updated); chromeApi.tabs.onRemoved.addListener(removed);
    // Completion may have happened between tabs.get and installing the listeners.
    chromeApi.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(tab); }).catch(() => finish(null));
  });
}
async function readOwnedPage(chromeApi, run, domain) {
  if (run.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  const source = run.sources[domain]; let firstPage = false;
  if (run.tabs[domain] === undefined) {
    const tab = await chromeApi.tabs.create({ url: collectionUrl(run.profileId, domain, source.start), active: false });
    if (!Number.isInteger(tab.id)) throw { code: 'DOUBAN_BROWSER_NETWORK' };
    run.tabs[domain] = tab.id; firstPage = true;
  }
  if (run.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  const tabId = run.tabs[domain];
  const tab = await readyTab(chromeApi, tabId);
  if (run.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  const expected = new URL(collectionUrl(run.profileId, domain, source.start));
  let here;
  try { here = new URL(tab.url); } catch { throw { code: 'DOUBAN_BROWSER_LOGIN_REQUIRED' }; }
  if (here.protocol !== 'https:' || here.hostname !== HOSTS[domain] || here.port || here.username || here.password || ![expected.pathname, expected.pathname + '/'].includes(here.pathname)) throw { code: 'DOUBAN_BROWSER_LOGIN_REQUIRED', reason: 'document_position' };
  try { await chromeApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['collector-parser.js', 'collector.js'] }); }
  catch { throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'script_unavailable' }; }
  if (run.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  let results;
  try { results = await chromeApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: collectOwnedPage,
    args: [{ runId: run.id, profileId: run.profileId, domain, start: source.start, url: expected.href, firstPage }] }); }
  catch { throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'document_unavailable' }; }
  const result = results?.[0]?.result;
  if (!result?.ok) throw { code: SAFE_CODES.has(result?.errorCode) ? result.errorCode : 'DOUBAN_BROWSER_INVALID', reason: safeReason(result?.errorReason) ?? (plain(result) ? undefined : 'result_shape') };
  return result.page;
}
async function readOwnedSubject(chromeApi, job) {
  const domain = job.domain, url = 'https://' + HOSTS[domain] + '/subject/' + job.subjectId + '/';
  let firstPage = false;
  if (job.tabs[domain] !== undefined) {
    try { await chromeApi.tabs.get(job.tabs[domain]); }
    catch { delete job.tabs[domain]; }
  }
  if (job.tabs[domain] === undefined) {
    const tab = await chromeApi.tabs.create({ url, active: false });
    if (!Number.isInteger(tab.id)) throw { code: 'DOUBAN_BROWSER_NETWORK' };
    job.tabs[domain] = tab.id; firstPage = true;
  }
  if (job.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  const tabId = job.tabs[domain], tab = await readyTab(chromeApi, tabId);
  let here;
  try { here = new URL(tab.url); } catch { throw { code: 'DOUBAN_BROWSER_LOGIN_REQUIRED' }; }
  if (here.protocol !== 'https:' || here.hostname !== HOSTS[domain] || here.port || here.username || here.password
    || !/^\/subject\/[1-9]\d{0,15}\/?$/.test(here.pathname)) throw { code: 'DOUBAN_BROWSER_LOGIN_REQUIRED', reason: 'document_position' };
  if (job.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  try { await chromeApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['collector-parser.js', 'collector.js'] }); }
  catch { throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'script_unavailable' }; }
  if (job.status !== 'running') throw { code: 'DOUBAN_BROWSER_INVALID' };
  let results;
  try { results = await chromeApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: collectOwnedPage,
    args: [{ runId: job.id, profileId: job.profileId, domain, subjectId: job.subjectId, mode: 'subject', url, firstPage }] }); }
  catch { throw { code: 'DOUBAN_BROWSER_INVALID', reason: 'document_unavailable' }; }
  const result = results?.[0]?.result;
  if (!result?.ok) throw { code: SAFE_CODES.has(result?.errorCode) ? result.errorCode : 'DOUBAN_BROWSER_INVALID', reason: safeReason(result?.errorReason) };
  return result.page;
}
function cancelOwnedRead(runId) {
  if (globalThis.__jiashuDoubanRead?.runId === runId) globalThis.__jiashuDoubanRead.controller.abort();
}
/** Serialized by Chrome; every dependency intentionally stays inside this function. */
async function collectOwnedPage(request) {
  const allowed = { screen: 'movie.douban.com', book: 'book.douban.com', music: 'music.douban.com' };
  const expected = new URL(request.url), subject = request.mode === 'subject'; let controller; let timer;
  const invalid = (code, reason) => { throw { code, reason }; };
  try {
    const permittedPath = subject ? '/subject/' + request.subjectId + '/' : '/people/' + request.profileId + '/collect';
    const positioned = subject ? /^\/subject\/[1-9]\d{0,15}\/?$/.test(location.pathname)
      : [expected.pathname, expected.pathname + '/'].includes(location.pathname);
    if (location.protocol !== 'https:' || location.hostname !== allowed[request.domain] || location.port || location.username || location.password
      || expected.origin !== location.origin || expected.pathname !== permittedPath || !positioned
      || subject && !/^[1-9]\d{0,15}$/.test(request.subjectId)) invalid('DOUBAN_BROWSER_LOGIN_REQUIRED', 'document_position');
    if (typeof globalThis.JiashuDoubanCollector?.[subject ? 'parseSubject' : 'parseCollection'] !== 'function') invalid('DOUBAN_BROWSER_INVALID', 'script_unavailable');
    controller = new AbortController(); globalThis.__jiashuDoubanRead = { runId: request.runId, controller };
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject({ code: 'DOUBAN_BROWSER_TIMEOUT' }); }, 15000); });
    const read = async () => {
      let html;
      if (request.firstPage) {
        if (subject ? ![expected.pathname, expected.pathname.slice(0, -1)].includes(location.pathname)
          : Number(new URL(location.href).searchParams.get('start') ?? '0') !== request.start) invalid('DOUBAN_BROWSER_INVALID', 'document_position');
        if (typeof document.documentElement?.outerHTML !== 'string') invalid('DOUBAN_BROWSER_INVALID', 'document_unavailable');
        html = document.documentElement.outerHTML;
      } else {
        let response;
        try { response = await fetch(expected.href, { method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html, application/xhtml+xml' } }); }
        catch { invalid(controller.signal.aborted ? 'DOUBAN_BROWSER_TIMEOUT' : 'DOUBAN_BROWSER_NETWORK'); }
        if (response.status === 429) { void response.body?.cancel().catch(() => {}); invalid('DOUBAN_BROWSER_RATE_LIMITED'); }
        if (response.type === 'opaqueredirect' || response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); invalid('DOUBAN_BROWSER_LOGIN_REQUIRED'); }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); invalid([401, 403, 418, 451].includes(response.status) ? 'DOUBAN_BROWSER_BLOCKED' : 'DOUBAN_BROWSER_NETWORK'); }
        if (!['text/html', 'application/xhtml+xml'].includes((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()) || !response.body) { void response.body?.cancel().catch(() => {}); invalid('DOUBAN_BROWSER_INVALID'); }
        const length = response.headers.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length) > 2 * 1024 * 1024) { void response.body.cancel().catch(() => {}); invalid('DOUBAN_BROWSER_TOO_LARGE'); }
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; html = '';
        const stop = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', stop, { once: true });
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
            if (bytes > 2 * 1024 * 1024) { void reader.cancel().catch(() => {}); invalid('DOUBAN_BROWSER_TOO_LARGE'); } html += decoder.decode(chunk.value, { stream: true }); }
          html += decoder.decode();
        } finally { controller.signal.removeEventListener('abort', stop); reader.releaseLock(); }
      }
      if (controller.signal.aborted) invalid('DOUBAN_BROWSER_TIMEOUT');
      const page = subject ? globalThis.JiashuDoubanCollector.parseSubject(html, request.domain, request.subjectId)
        : globalThis.JiashuDoubanCollector.parseCollection(html, request.profileId, request.domain, request.start);
      return { ok: true, page };
    };
    return await Promise.race([read(), timeout]);
  } catch (error) {
    const safe = ['INVALID', 'TOO_LARGE', 'LOGIN_REQUIRED', 'CHALLENGE', 'BLOCKED', 'PROFILE_MISMATCH', 'RATE_LIMITED', 'NETWORK', 'TIMEOUT'].map(code => 'DOUBAN_BROWSER_' + code);
    const reasons = ['input', 'document', 'structure_limit', 'account_navigation', 'heading', 'total', 'rows', 'item_url', 'item_title', 'item_comment',
      'item_rating', 'item_date', 'duplicate_items', 'item_range', 'pagination_query', 'pagination_offset', 'pagination_incomplete', 'subject_identity',
      'subject_structure', 'account_mismatch', 'collection_identity', 'script_unavailable', 'document_unavailable', 'document_position', 'result_shape', 'total_changed', 'duplicate_page'];
    return { ok: false, errorCode: safe.includes(error?.code) ? error.code : 'DOUBAN_BROWSER_INVALID',
      ...(typeof error?.reason === 'string' && reasons.includes(error.reason) ? { errorReason: error.reason } : {}) };
  } finally {
    clearTimeout(timer); controller?.abort();
    if (globalThis.__jiashuDoubanRead?.runId === request.runId) delete globalThis.__jiashuDoubanRead;
  }
}

if (globalThis.chrome?.runtime?.onMessageExternal) {
  const controller = createDoubanExtensionController(globalThis.chrome);
  globalThis.chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    controller.handle(message, sender).then(sendResponse).catch(() => sendResponse(failure('DOUBAN_BROWSER_INVALID')));
    return true;
  });
}
