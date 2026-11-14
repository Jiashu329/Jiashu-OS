/**
 * This function is serialized into a bookmarklet. Keep every runtime dependency
 * inside it so release minification cannot leave references to a module closure.
 */
export function runDoubanBookBrowserHelper(profileId: string): void {
  const marker = 'jiashu-douban-book-export';
  const validProfile = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  const path = '/people/' + profileId + '/collect';
  const here = new URL(location.href);
  if (!validProfile(profileId) || here.protocol !== 'https:' || here.hostname !== 'book.douban.com' || here.port || here.username || here.password
    || ![path, path + '/'].includes(here.pathname) || here.hash || here.searchParams.getAll('start').length > 1) {
    alert('请在书签所对应主页的豆瓣“读过的书”收藏页运行。此工具不会读取其他网站或其他主页。'); return;
  }
  if (document.getElementById(marker)) { document.getElementById(marker)?.scrollIntoView(); return; }
  const startValue = here.searchParams.get('start') ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(startValue) || Number(startValue) > 100000) { alert('当前收藏页的分页位置不正确，请从“读过的书”列表重新打开。'); return; }
  const initialStart = Number(startValue), maximum = 500, maximumPages = 40, byteLimit = 2 * 1024 * 1024;
  type Row = { profileId: string; title: string; url: string; type: 'book'; state: '读过'; myRating: number | null; collectionDate: string | null; myComment: string | null; coverUrl: string | null };
  const records: Row[] = [], seen = new Set<string>();
  let nextStart: number | null = initialStart, initialized = false, running = false, stopped = false, pages = 0, controller: AbortController | null = null;
  const box = document.createElement('section'); box.id = marker; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', '导出读过的书');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;max-width:440px;width:calc(100vw - 32px);max-height:85vh;overflow:auto;padding:20px;border:1px solid #cad2de;border-radius:12px;background:white;color:#263248;box-shadow:0 8px 32px #0003;font:14px/1.8 system-ui,sans-serif;text-align:left;box-sizing:border-box';
  const heading = document.createElement('strong'); heading.textContent = '导出读过的书 · ' + profileId; box.appendChild(heading);
  const note = document.createElement('p'); note.textContent = '由你在当前豆瓣页面主动运行。只读取已完成的书籍收藏；连续读取会使用当前浏览器的正常登录状态，至少间隔 1.5 秒。遇到登录、验证或访问限制立即停止。文件只下载到本机，不会上传。'; box.appendChild(note);
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); box.appendChild(message);
  const current = button('读取当前页', 'current'), all = button('开始逐页读取', 'all'), cancel = button('停止读取', 'cancel'), download = button('下载 JSON', 'download'), close = button('关闭', 'close');
  const resume = document.createElement('a'); resume.dataset.doubanBookExport = 'next'; resume.textContent = '在豆瓣打开下一段收藏 ↗'; resume.target = '_blank'; resume.rel = 'noopener noreferrer'; resume.referrerPolicy = 'no-referrer'; resume.style.cssText = 'display:block;margin-top:12px;color:#285a9e'; box.appendChild(resume);
  document.body.appendChild(box);
  function button(label: string, action: string) {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.dataset.doubanBookExport = action;
    element.style.cssText = 'font:inherit;margin:5px 8px 5px 0;padding:6px 10px;border:1px solid #cad2de;border-radius:6px;background:#f5f7fa;color:#263248;cursor:pointer'; box.appendChild(element); return element;
  }
  function collection(offset: number) { return 'https://book.douban.com' + path + '?' + new URLSearchParams({ start: String(offset), sort: 'time', rating: 'all', filter: 'all', mode: 'grid' }); }
  function update(text: string) {
    message.textContent = text + ' 已收集 ' + records.length + ' 条，已读取 ' + pages + ' 页。' + (initialStart ? ' 本次从第 ' + (initialStart + 1) + ' 条开始，不包含更早页面。' : '');
    current.disabled = running || initialized; all.disabled = running || initialized && nextStart === null || records.length >= maximum || pages >= maximumPages;
    all.textContent = initialized ? '继续逐页读取' : '开始逐页读取'; cancel.disabled = !running; download.disabled = running || records.length === 0; close.disabled = running;
    resume.hidden = nextStart === null; if (nextStart !== null) resume.href = collection(nextStart);
  }
  function compact(value: string | null | undefined) { return (value ?? '').replace(/\s+/g, ' ').trim(); }
  function fail(text: string): never { throw new Error(text); }
  function cleanText(value: string, limit: number, label: string) {
    if (!value || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail(label + '无法确认，已停止读取。'); return value;
  }
  function cover(raw: string | null): string | null {
    if (!raw || raw.length > 2048) return null;
    try {
      const url = new URL(raw);
      if (!['https:', 'http:'].includes(url.protocol) || !/^img\d{1,2}\.doubanio\.com$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash
        || !/^\/(?:view\/[A-Za-z0-9_./-]+|[sl]pic\/[A-Za-z0-9_.-]+)\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)) return null;
      url.protocol = 'https:'; return url.href;
    } catch { return null; }
  }
  function parse(doc: Document | DocumentFragment, offset: number) {
    const title = compact(doc.querySelector('title')?.textContent);
    if (/禁止访问|访问受限/.test(title)) fail('豆瓣限制了访问，未继续读取；已有记录可下载。');
    if (/登录|安全验证|人机验证/.test(title) || doc.querySelector('form[action*="accounts.douban.com"], form[action*="sec.douban.com"]')) fail('页面要求登录或安全验证，未继续读取；请在豆瓣正常完成后再自行运行。');
    const headingText = compact(doc.querySelector('h1')?.textContent) || title;
    if (!/读过的书/.test(headingText) || /想读|在读/.test(headingText)) fail('未确认当前页面是“读过的书”，未读取其他收藏状态。');
    const totalRaw = /\/\s*(\d+)/.exec(compact(doc.querySelector('.subject-num')?.textContent))?.[1] ?? /[（(]\s*(\d+)\s*[)）]/.exec(headingText)?.[1];
    const total = totalRaw === undefined ? -1 : Number(totalRaw);
    if (!Number.isSafeInteger(total) || total < 0 || total > 100000) fail('未能确认收藏总数，已有记录可下载。');
    const nodes = Array.from(doc.querySelectorAll('.item-show, .grid-view > .item, .interest-list > .subject-item'));
    if (nodes.length > 30 || !nodes.length && (total !== 0 || offset !== 0) || offset + nodes.length > total) fail('收藏页条目或分页无法确认，已有记录可下载。');
    const rows: Row[] = nodes.map(node => {
      const anchor = node.querySelector('.title > a, li.title > a, .info .title a, .info h2 > a');
      const raw = anchor?.getAttribute('href') ?? ''; let url: URL;
      try { url = new URL(raw); } catch { return fail('书籍条目链接无法确认，已停止读取。'); }
      const id = /^\/subject\/([1-9]\d{0,15})\/?$/.exec(url.pathname)?.[1];
      if (!id || !['https:', 'http:'].includes(url.protocol) || url.hostname !== 'book.douban.com' || url.username || url.password || url.port || url.search || url.hash) fail('书籍条目链接无法确认，已停止读取。');
      const name = cleanText(compact(anchor?.querySelector('em')?.textContent || anchor?.textContent), 500, '书名');
      const marked = /\b\d{4}-\d{2}-\d{2}\b/.exec(compact(node.querySelector('.date')?.textContent))?.[0] ?? null;
      if (marked && (marked < '1970-01-01' || marked > '2100-12-31' || !Number.isFinite(Date.parse(marked + 'T12:00:00Z')) || new Date(marked + 'T12:00:00Z').toISOString().slice(0, 10) !== marked)) fail('书籍标记日期无法确认，已停止读取。');
      const star = Array.from(node.querySelectorAll('[class]')).map(element => /^\s*rating([1-5])-t\s*$/.exec(element.getAttribute('class') ?? '')?.[1]).find(Boolean);
      const comment = compact(node.querySelector('.comment')?.textContent);
      return { profileId, title: name, url: 'https://book.douban.com/subject/' + id + '/', type: 'book', state: '读过', myRating: star ? Number(star) : null,
        collectionDate: marked, myComment: comment ? cleanText(comment, 2000, '个人短评') : null, coverUrl: cover(node.querySelector('img')?.getAttribute('src') ?? null) };
    });
    if (new Set(rows.map(row => row.url)).size !== rows.length || rows.some(row => seen.has(row.url))) fail('收藏分页出现重复条目，已停止，避免重复或错页。');
    let next: number | null = null;
    const link = doc.querySelector('.paginator .next a, .paginator a[rel="next"], a[rel="next"]');
    if (link) {
      let target: URL; try { target = new URL(link.getAttribute('href') ?? '', collection(offset)); } catch { return fail('下一页链接无法确认，已停止读取。'); }
      const start = target.searchParams.get('start');
      if (target.protocol !== 'https:' || target.hostname !== 'book.douban.com' || target.username || target.password || target.port || target.hash || ![path, path + '/'].includes(target.pathname)
        || target.searchParams.getAll('start').length !== 1 || !start || !/^(0|[1-9]\d*)$/.test(start)) fail('下一页不是同一主页的正常收藏分页，已停止读取。');
      next = Number(start);
      if (!Number.isSafeInteger(next) || next <= offset || next !== offset + rows.length || next >= total) fail('下一页位置无法确认，已停止读取。');
    }
    if ((offset + rows.length < total) !== (next !== null)) fail('收藏页尚不完整，未把它当作全部收藏。');
    return { rows, next };
  }
  async function read(offset: number): Promise<DocumentFragment> {
    controller = new AbortController(); const active = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { active.abort(); reject(new Error('豆瓣页面读取超时，已有记录可下载。')); }, 15000); });
    const request = async () => {
      let response: Response;
      try { response = await fetch(collection(offset), { method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: active.signal, headers: { Accept: 'text/html, application/xhtml+xml' } }); }
      catch { return fail(stopped ? '已停止读取，已有记录可下载。' : '豆瓣连接暂时失败，已有记录可下载。'); }
      if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.redirected) { void response.body?.cancel().catch(() => {}); fail('豆瓣要求跳转，已停止读取；请在豆瓣自行核对登录或验证页面。'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail([401, 403, 418, 429, 451].includes(response.status) ? '豆瓣要求登录、限制访问或限流，已停止；已有记录可下载。' : '豆瓣页面暂时无法读取，已有记录可下载。'); }
      if (!['text/html', 'application/xhtml+xml'].includes((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()) || !response.body) { void response.body?.cancel().catch(() => {}); fail('豆瓣返回的不是可确认的收藏页面，已停止读取。'); }
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > byteLimit) { void response.body.cancel().catch(() => {}); fail('豆瓣页面超过 2 MiB，已停止读取。'); }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, text = '';
      const abort = () => { void reader.cancel().catch(() => {}); }; active.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
          if (bytes > byteLimit) { void reader.cancel().catch(() => {}); fail('豆瓣页面超过 2 MiB，已停止读取。'); }
          text += decoder.decode(chunk.value, { stream: true }); }
        text += decoder.decode();
      } catch (error) { if (stopped) fail('已停止读取，已有记录可下载。'); if (error instanceof Error && error.message.startsWith('豆瓣页面超过')) throw error; fail('豆瓣页面内容未完整读取，已有记录可下载。'); }
      finally { active.signal.removeEventListener('abort', abort); reader.releaseLock(); }
      if (stopped) fail('已停止读取，已有记录可下载。');
      if (!text.trim() || /<!ENTITY\b/i.test(text) || /<!DOCTYPE(?!\s+html\s*>)/i.test(text) || (text.match(/</g)?.length ?? 0) > 30000) fail('豆瓣页面结构无法确认，已停止读取。');
      const template = document.createElement('template'); template.innerHTML = text; return template.content;
    };
    try { return await Promise.race([request(), deadline]); } finally { if (timer) clearTimeout(timer); active.abort(); if (controller === active) controller = null; }
  }
  function accept(doc: Document | DocumentFragment, offset: number) {
    const page = parse(doc, offset), remaining = maximum - records.length, accepted = page.rows.slice(0, remaining);
    for (const row of accepted) { records.push(row); seen.add(row.url); }
    pages++; initialized = true; nextStart = accepted.length < page.rows.length ? offset + accepted.length : page.next;
  }
  async function begin(continuous: boolean) {
    if (running || records.length >= maximum || pages >= maximumPages || initialized && nextStart === null) return;
    running = true; stopped = false; update('正在读取已完成的书籍收藏。');
    try {
      if (!initialized) accept(document, initialStart);
      while (continuous && nextStart !== null && !stopped && records.length < maximum && pages < maximumPages) {
        update('正在逐页读取；你可以随时停止。'); await new Promise<void>(resolve => setTimeout(resolve, 1500));
        if (stopped) break; const offset = nextStart; accept(await read(offset), offset);
      }
      update(stopped ? '已停止读取，已收集的记录可下载。' : records.length >= maximum || pages >= maximumPages ? '本批达到读取上限，结果仅包含本批。下载后可打开下一段收藏继续。' : nextStart === null ? '已读取至当前收藏列表末页。' : '已读取当前页；可继续逐页读取，或只下载当前结果。');
    } catch (error) { update(error instanceof Error ? error.message : '收藏页未能确认，已有记录可下载。'); }
    finally { running = false; update(message.textContent?.split(' 已收集 ')[0] ?? '本次读取已停止。'); }
  }
  current.addEventListener('click', () => { if (!initialized) void begin(false); }); all.addEventListener('click', () => { void begin(true); });
  cancel.addEventListener('click', () => { stopped = true; controller?.abort(); update('正在停止；已收集的记录会保留。'); });
  close.addEventListener('click', () => { if (!running) box.remove(); });
  download.addEventListener('click', () => {
    if (running || !records.length) return;
    const blob = new Blob([JSON.stringify({ profileId, items: records }, null, 2)], { type: 'application/json;charset=utf-8' });
    const objectURL = URL.createObjectURL(blob), link = document.createElement('a'); link.href = objectURL; link.download = 'douban-books-' + profileId + '-' + initialStart + '-' + (initialStart + records.length) + '.json'; link.hidden = true; box.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    update('JSON 已交给浏览器下载。返回本站选择此文件预览并确认导入；尚未上传或保存到本站。');
  });
  update('请明确选择读取当前页或开始逐页读取；打开本面板不会发起请求。');
}

export function renderDoubanBrowserHelperBookmarklet(profileId: string): string {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)) throw new Error('豆瓣主页 ID 不正确。');
  return 'javascript:' + encodeURIComponent('void (' + runDoubanBookBrowserHelper.toString() + ')(' + JSON.stringify(profileId) + ');');
}

/** Register the builder locally; this script never runs the export helper. */
export function renderDoubanBrowserHelperScript(): string {
  const source = JSON.stringify(runDoubanBookBrowserHelper.toString()).replace(/</g, '\\u003c');
  return '<script>(()=>{const source=' + source + ';window.JiashuDoubanBrowserHelper={bookmarklet(profileId){if(typeof profileId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId))throw new Error("豆瓣主页 ID 不正确。");return "javascript:"+encodeURIComponent("void ("+source+")("+JSON.stringify(profileId)+");");}};})();</script>';
}
