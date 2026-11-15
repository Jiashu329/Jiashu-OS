import { VOLUME_BACKUP_LIMITS, BackupValidationError, BackupCapacityError } from './data-backup.ts';
import { splitBackupVolumes } from './backup-volumes.ts';
import { BackupConflictError, exportDataBackup, previewDataRestore, restoreDataBackup } from '../db/data-backup-store.ts';
import type { BackupDatabase } from '../db/data-backup-store.ts';

interface Dependencies {
  unauthenticated?(message?: string): Response | Promise<Response>; user(): Promise<{ userId: string } | null>; database(): BackupDatabase; json(value: unknown, status?: number, headers?: Record<string,string>): Response; unavailable(): Response }
async function body(request: Request) {
  const limit = VOLUME_BACKUP_LIMITS.maxBytes + 128 * 1024;
  const size = Number(request.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader(); const decoder = new TextDecoder(); let bytes=0; let content='';
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes+=chunk.value.byteLength; if (bytes>limit) { await reader.cancel(); throw new RangeError(); } content+=decoder.decode(chunk.value,{stream:true}); } return JSON.parse(content+decoder.decode()) as unknown; }
  finally { reader.releaseLock(); }
}
export function createDataBackupHandlers(deps: Dependencies) {
  const ownerChanged=(request:Request|undefined,userId:string)=>{
    const owner=request?.headers.get('X-Page-Owner');
    return owner&&owner!==userId?deps.json({error:'登录账号已变化，请刷新数据备份页面后继续。',code:'BACKUP_OWNER_CHANGED'},409):null;
  };
  const errorResponse = (error: unknown) => {
    if (error instanceof BackupValidationError || error instanceof BackupConflictError) return deps.json({ error:error.message,code:error.code },error.status);
    if (error instanceof RangeError) return deps.json({ error:error instanceof BackupCapacityError ? error.message : '单文件上限 8 MiB、20,000 行；完整分卷组上限 16 MiB、40,000 行。未写入数据。',code:'BACKUP_TOO_LARGE' },413);
    if (error instanceof SyntaxError) return deps.json({ error:'备份 JSON 格式不正确。',code:'INVALID_DATA_BACKUP' },400);
    return deps.unavailable();
  };
  return {
    async GET(request?: Request) {
      const user = await deps.user(); if (!user) return deps.unauthenticated ? deps.unauthenticated('请先登录网站，再导出完整备份。') : deps.json({ error:'请先登录网站，再导出完整备份。',code:'SIGN_IN_REQUIRED' },401);
      const changed=ownerChanged(request,user.userId);if(changed)return changed;
      try {
        const format=request?new URL(request.url).searchParams.get('format'):null;
        if(format!==null&&format!=='volumes')return deps.json({error:'不支持的备份格式。',code:'INVALID_DATA_BACKUP'},400);
        const backup = await exportDataBackup(deps.database(),user.userId,new Date().toISOString(),format==='volumes'?VOLUME_BACKUP_LIMITS:undefined);
        if(format==='volumes')return deps.json(await splitBackupVolumes(backup));
        return deps.json(backup,200,{ 'Content-Disposition':`attachment; filename="jiashu-os-backup-${backup.exportedAt.slice(0,10)}.json"` });
      }
      catch (error) { return errorResponse(error); }
    },
    async POST(request: Request) {
      const user = await deps.user(); if (!user) return deps.unauthenticated ? deps.unauthenticated('请先登录网站，再恢复备份。') : deps.json({ error:'请先登录网站，再恢复备份。',code:'SIGN_IN_REQUIRED' },401);
      const changed=ownerChanged(request,user.userId);if(changed)return changed;
      if (request.headers.get('origin') !== new URL(request.url).origin) return deps.json({ error:'请从已登录的网站页面恢复备份。',code:'INVALID_ORIGIN' },403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return deps.json({ error:'请上传 JSON 完整备份。' },415);
      try {
        const raw = await body(request);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError();
        const input = raw as Record<string,unknown>;
        if ((input.action !== 'preview' && input.action !== 'restore') || Object.keys(input).some((k) => !['action','backup','previewHash'].includes(k))) throw new SyntaxError();
        if (input.action === 'preview') { if (Object.hasOwn(input,'previewHash')) throw new SyntaxError(); return deps.json(await previewDataRestore(deps.database(),user.userId,input.backup)); }
        if (typeof input.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.previewHash)) return deps.json({ error:'请先预览完整备份，再确认恢复。',code:'BACKUP_PREVIEW_REQUIRED' },400);
        return deps.json(await restoreDataBackup(deps.database(),user.userId,input.backup,input.previewHash));
      } catch (error) { return errorResponse(error); }
    },
  };
}
