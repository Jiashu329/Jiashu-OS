import { previewFullBackup } from '../../../../db/backup-store';
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
    if (Object.keys(body).join(',') !== 'backup') throw new BackupValidationError('请提交一份完整备份供预览。');
    return json(await previewFullBackup(backupDatabase(), user.userId, body.backup));
  } catch (error) { return backupError(error); }
}
