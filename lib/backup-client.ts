import type { BackupPreview } from '../db/data-backup-store.ts';
import type { BackupSet } from './backup-volumes.ts';

interface BackupClientConfig { ownerId: string; singleMaxBytes: number; setMaxBytes: number }
type RequestJSON = (url: string, options?: RequestInit & { timeoutMs?: number }) => Promise<unknown>;
interface RecentBackup { generatedAt: string; format: 'single' | 'volumes'; fileCount: number; rows: number; confirmedAt: string | null }

/** Self-contained browser controller; all runtime dependencies are arguments or browser APIs. */
export function installBackupClient(config: BackupClientConfig, requestJSON: RequestJSON): void {
  const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById('backup-' + id)! as T;
  let backup: unknown = null, preview: BackupPreview | null = null, busy = false, fileReading = false, fileVersion = 0;
  let urls: string[] = [], recent: RecentBackup | null = null;
  const recentKey = config.ownerId ? 'jiashu-backup-recent:v1:' + encodeURIComponent(config.ownerId) : '';
  const ownerHeaders:Record<string,string>=config.ownerId?{'X-Page-Owner':config.ownerId}:{};
  function status(message: string, error = false) { node('status').textContent = message; node('status').classList.toggle('error', error); }
  function reset() { preview = null; node('summary').hidden = true; node<HTMLInputElement>('confirm').checked = false; node<HTMLButtonElement>('restore').disabled = true; }
  function controls(value: boolean) {
    busy = value;
    const locked=busy||fileReading;
    for (const id of ['export', 'export-volumes']) node<HTMLInputElement>(id).disabled = locked;
    node<HTMLInputElement>('file').disabled=busy;
    node<HTMLButtonElement>('preview').disabled = locked || !backup;
    node<HTMLInputElement>('confirm').disabled = locked;
    node<HTMLButtonElement>('restore').disabled = locked || !preview?.canRestore || !node<HTMLInputElement>('confirm').checked;
    node<HTMLButtonElement>('saved').disabled = locked || !recent || !recentKey;
  }
  function renderRecent() {
    node('recent').textContent = recent
      ? '本机最近生成：' + new Date(recent.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' · ' + (recent.format === 'volumes' ? '分卷 ' + recent.fileCount + ' 个文件（含清单）' : '单文件') + ' · ' + recent.rows + ' 行。' + (recent.confirmedAt ? ' 你已确认妥善保存。' : ' 网站无法判断文件是否已保存，请下载并核对后确认。')
      : '本机尚无备份生成记录。此状态按本人和浏览器保存，不代表其他设备的备份情况。';
    node<HTMLButtonElement>('saved').disabled = busy || fileReading || !recent || !recentKey;
  }
  function persistRecent() {
    if (!recentKey) return;
    try { window.localStorage.setItem(recentKey, JSON.stringify(recent)); }
    catch { status('备份已生成，但本机状态无法保存；请妥善保存下载文件。', true); }
  }
  try {
    const value: unknown = recentKey ? JSON.parse(window.localStorage.getItem(recentKey) || 'null') : null;
    if (value && typeof value === 'object') {
      const row = value as RecentBackup;
      if (Number.isFinite(Date.parse(row.generatedAt)) && ['single', 'volumes'].includes(row.format) && Number.isSafeInteger(row.fileCount) && row.fileCount >= 1 && row.fileCount <= 9 && Number.isSafeInteger(row.rows) && row.rows >= 0 && (row.confirmedAt === null || Number.isFinite(Date.parse(row.confirmedAt)))) recent = row;
    }
  } catch { /* Local metadata failure must not disable backup and recovery. */ }
  renderRecent();
  function clearDownloads() { for (const url of urls) URL.revokeObjectURL(url); urls = []; node('downloads').replaceChildren(); node('download-panel').hidden = true; }
  function downloadLink(value: unknown, filename: string): HTMLAnchorElement {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })); urls.push(url);
    const link = document.createElement('a'); link.href = url; link.download = filename; link.className = 'backup-btn'; link.textContent = filename; return link;
  }
  async function exportBackup(volumes: boolean) {
    if (busy||fileReading) return; controls(true); status('正在读取并检查全部业务记录…');
    try {
      const data = await requestJSON('/api/data/backup' + (volumes ? '?format=volumes' : ''), { timeoutMs: 60000,headers:ownerHeaders });
      if (!data || typeof data !== 'object') throw new Error('服务没有返回有效完整备份。');
      if (volumes) {
        const set = data as BackupSet;
        if (set.kind !== 'jiashu-os-backup-set' || set.version !== 1 || !set.manifest || !Array.isArray(set.volumes) || !set.volumes.length) throw new Error('服务没有返回有效分卷清单。');
        clearDownloads();
        const prefix = 'jiashu-os-' + set.manifest.exportedAt.slice(0, 10) + '-' + set.manifest.setId.slice(0, 8);
        node('downloads').appendChild(downloadLink(set.manifest, prefix + '-manifest.json'));
        for (const part of set.volumes) node('downloads').appendChild(downloadLink(part, prefix + '-part-' + part.partIndex + '-of-' + part.totalParts + '.json'));
        node('download-panel').hidden = false;
        recent = { generatedAt: set.manifest.exportedAt, format: 'volumes', fileCount: set.volumes.length + 1, rows: set.manifest.totalRows, confirmedAt: null };
        status('分卷已生成。请逐个下载清单和全部分卷，恢复时一起选择；缺卷或混用会被拒绝。');
      } else {
        const single = data as { kind: string; exportedAt: string; tables: Record<string, unknown[]> };
        if (single.kind !== 'jiashu-os-backup' || typeof single.exportedAt !== 'string' || !single.tables) throw new Error('服务没有返回有效完整备份。');
        clearDownloads();
        const link = downloadLink(single, 'jiashu-os-backup-' + single.exportedAt.slice(0, 10) + '.json');
        node('downloads').appendChild(link); node('download-panel').hidden = false; link.click();
        recent = { generatedAt: single.exportedAt, format: 'single', fileCount: 1, rows: Object.values(single.tables).reduce((sum, rows) => sum + rows.length, 0), confirmedAt: null };
        status('完整备份已生成。若下载未开始，可点击下方文件；保存后请核对文件并确认。');
      }
      persistRecent(); renderRecent();
    } catch (error) { status(error instanceof Error ? error.message : '无法生成完整备份，请重试。', true); }
    finally { controls(false); }
  }
  node('export').addEventListener('click', () => exportBackup(false));
  node('export-volumes').addEventListener('click', () => exportBackup(true));
  node('saved').addEventListener('click', () => { if (busy || fileReading || !recent) return; recent = { ...recent, confirmedAt: new Date().toISOString() }; persistRecent(); renderRecent(); });
  node<HTMLInputElement>('file').addEventListener('change', async (event) => {
    if(busy)return;
    const version = ++fileVersion; reset(); backup = null;
    const files = Array.from((event.target as HTMLInputElement).files || []);
    fileReading=files.length>0;controls(false);
    if (!files.length) return;
    try {
      if (files.length > 9 || files.some((file) => file.size > config.singleMaxBytes) || files.reduce((sum, file) => sum + file.size, 0) > config.setMaxBytes + 128 * 1024) throw new Error('每个文件最多 8 MiB，整组最多 16 MiB。请选择一个完整备份，或清单与其全部分卷。');
      const parsed: unknown[] = await Promise.all(files.map(async (file) => JSON.parse(await file.text()) as unknown));
      if (version !== fileVersion) return;
      const manifests = parsed.filter((value) => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'jiashu-os-backup-manifest');
      if (parsed.length === 1 && !manifests.length) backup = parsed[0];
      else {
        const parts = parsed.filter((value) => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'jiashu-os-backup-volume');
        if (manifests.length !== 1 || parts.length !== parsed.length - 1 || !parts.length) throw new Error('请一起选择同一次备份的一个清单和全部分卷，不能混入其他文件。');
        backup = { kind: 'jiashu-os-backup-set', version: 1, manifest: manifests[0], volumes: parts };
      }
      status('文件已读取。请先预览，核对覆盖范围、完整性与冲突。');
    } catch (error) { if (version === fileVersion) status(error instanceof Error ? error.message : '无法读取备份文件。', true); }
    if (version === fileVersion) {fileReading=false;controls(busy);}
  });
  function renderPreview(value: BackupPreview) {
    const total = value.total;
    node('counts').textContent = '共 ' + total.incoming + ' 行：补入 ' + total.added + ' 行，相同跳过 ' + total.skipped + ' 行，冲突 ' + total.conflicts + ' 行。' + (value.generatedGoalHistoryRows ? ' 另生成 ' + value.generatedGoalHistoryRows + ' 条恢复历史基线。' : '');
    const rows = node('rows'), conflicts = node('conflicts'); rows.replaceChildren(); conflicts.replaceChildren();
    const labels: Record<string, string> = { name: '名称', type: '分类', note: '备注', date: '日期', portion: '份量', calories_tenth: '热量（0.1 kcal）', carbs_tenth: '碳水（0.1 g）', protein_tenth: '蛋白质（0.1 g）', fat_tenth: '脂肪（0.1 g）', archived_at: '归档时间', amount_minor: '金额（最小货币单位）', usable_bps: '可动用比例（万分比）' };
    for (const table of value.tables) {
      const tr = document.createElement('tr');
      for (const value of [table.label, table.incoming, table.added, table.skipped, table.conflicts]) { const td = document.createElement('td'); td.textContent = String(value); tr.appendChild(td); } rows.appendChild(tr);
      for (const example of table.conflictExamples || []) {
        const item = document.createElement('li'), details = document.createElement('details'), summary = document.createElement('summary');
        summary.textContent = table.label + ' · ' + example.record + '：' + example.reason; details.appendChild(summary);
        for (const difference of example.differences || []) {
          const line = document.createElement('p'); line.className = 'backup-difference';
          const field = document.createElement('strong'), current = document.createElement('span'), incoming = document.createElement('span');
          field.textContent = labels[difference.field] || difference.field; current.textContent = '当前：' + difference.current; incoming.textContent = '备份：' + difference.incoming; line.appendChild(field);line.appendChild(current);line.appendChild(incoming); details.appendChild(line);
        }
        item.appendChild(details); conflicts.appendChild(item);
      }
    }
    node('summary').hidden = false;
  }
  node('preview').addEventListener('click', async () => {
    if (busy || fileReading || !backup) return; reset(); controls(true); status('正在检查备份结构、分卷摘要、关联与当前数据…');
    try {
      preview = await requestJSON('/api/data/backup', { method: 'POST', timeoutMs: 60000, headers: { 'Content-Type': 'application/json',...ownerHeaders }, body: JSON.stringify({ action: 'preview', backup }) }) as BackupPreview;
      renderPreview(preview); status(preview.canRestore ? '预览完成。确认后将一次补入缺少的记录，相同记录跳过。' : '发现冲突，无法恢复。请展开下方记录对照字段；当前数据不会被覆盖。', !preview.canRestore);
    } catch (error) { status(error instanceof Error ? error.message : '无法预览备份。', true); }
    finally { controls(false); }
  });
  node('confirm').addEventListener('change', () => controls(busy));
  node('restore').addEventListener('click', async () => {
    if (busy || fileReading || !backup || !preview?.canRestore || !node<HTMLInputElement>('confirm').checked) return;
    controls(true); status('正在恢复完整备份，请保持本页打开…');
    try {
      const result = await requestJSON('/api/data/backup', { method: 'POST', timeoutMs: 60000, headers: { 'Content-Type': 'application/json',...ownerHeaders }, body: JSON.stringify({ action: 'restore', backup, previewHash: preview.previewHash }) }) as { added: number; skipped: number; generatedGoalHistoryRows?: number };
      reset(); status('恢复完成：补入 ' + result.added + ' 行，相同跳过 ' + result.skipped + ' 行。可前往健康、饮食或财务查看。');
    } catch (error) { reset(); status((error instanceof Error ? error.message : '恢复请求未完成。') + ' 请重新预览确认结果；已成功恢复的相同记录会跳过。', true); }
    finally { controls(false); }
  });
  window.addEventListener('pagehide', clearDownloads);
}
