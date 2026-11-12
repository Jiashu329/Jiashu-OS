import { exportFullBackup } from '../../../db/backup-store';
import { apiUser, json, unauthenticated } from '../_shared';
import { backupDatabase, backupError } from './_shared';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await apiUser();
  if (!user) return unauthenticated();
  try {
    const backup = await exportFullBackup(backupDatabase(), user.userId);
    return json(backup, 200, { 'Content-Disposition': `attachment; filename="jiashu-os-backup-${backup.exportedAt.slice(0, 10)}.json"` });
  } catch (error) { return backupError(error); }
}
