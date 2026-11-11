import { env } from 'cloudflare:workers';
import { createDataBackupHandlers } from '../../../../lib/data-backup-api';
import { apiUser, json, storageDiagnostic } from '../../_shared';

export const dynamic = 'force-dynamic';
const handlers = createDataBackupHandlers({ user:apiUser,json,unavailable() { const diagnosticId = storageDiagnostic('data-backup'); return json({error:'数据备份服务暂时不可用，请稍后重试。',code:'BACKUP_STORAGE_UNAVAILABLE',diagnosticId},503,{'X-Diagnostic-ID':diagnosticId}); },database() { if (!env.DB) throw new Error('Backup storage unavailable'); return env.DB; } });
export const GET = handlers.GET;
export const POST = handlers.POST;
