import { restoreFullBackup } from '../../../../db/backup-store';
import { BackupValidationError } from '../../../../lib/backup';
import { apiUser, json, unauthenticated } from '../../_shared';
import { backupBody, backupDatabase, backupError, backupGuard } from '../_shared';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthenticated();
  const guard = backupGuard(request);
  if (guard) return guard;
  try {
    const body = await backupBody(request);
    if (Object.keys(body).sort().join(',') !== 'backup,backupHash,confirmed,targetHash'
      || typeof body.backupHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.backupHash)
      || typeof body.targetHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.targetHash) || body.confirmed !== true) throw new BackupValidationError('请先完成预览并明确确认恢复。');
    return json(await restoreFullBackup(backupDatabase(), user.userId, body.backup, { backupHash: body.backupHash, targetHash: body.targetHash, confirmed: true }));
  } catch (error) { return backupError(error); }
}
