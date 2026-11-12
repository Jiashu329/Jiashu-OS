import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';
import { BACKUP_MAX_BYTES, VOLUME_BACKUP_LIMITS } from './data-backup.ts';
import { installBackupClient } from './backup-client.ts';

export function renderDataBackupScript(ownerId = ''): string {
  const config = JSON.stringify({ ownerId, singleMaxBytes: BACKUP_MAX_BYTES, setMaxBytes: VOLUME_BACKUP_LIMITS.maxBytes }).replaceAll('<', '\\u003c');
  return `<script>(()=>{${CLIENT_REQUEST_SCRIPT}\n(${installBackupClient.toString()})(${config},requestJSON);})();</script>`;
}
