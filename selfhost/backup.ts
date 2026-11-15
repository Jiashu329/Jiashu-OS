import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { databasePath } from './database.ts';

/** SQLite's backup API includes committed WAL pages and produces a consistent image. */
export async function backupDatabase(source: string, destination: string): Promise<{ path: string; bytes: number }> {
  databasePath(source);
  databasePath(destination);
  if (!existsSync(source)) throw new Error('Backup source database does not exist');
  if (resolve(source) === resolve(destination) || existsSync(destination)) throw new Error('Backup output must be a new file');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(destination), `.sqlite-backup-${randomUUID()}.tmp`);
  const connection = new DatabaseSync(realpathSync(source), { readOnly: true, allowExtension: false });
  try {
    connection.exec('PRAGMA busy_timeout=5000');
    closeSync(openSync(temporary, 'wx', 0o600));
    await backup(connection, temporary);
    chmodSync(temporary, 0o600);
    // The source uses WAL. Make the completed snapshot a single portable file;
    // opening a read-only backup must not need/create adjacent WAL/SHM files.
    const snapshot = new DatabaseSync(temporary, { allowExtension: false });
    try { snapshot.exec('PRAGMA journal_mode=DELETE'); }
    finally { snapshot.close(); }
    // Hard-link creation is atomic and fails if another backup claimed the path.
    // Unlike rename(), it cannot overwrite a previous recovery point.
    linkSync(temporary, destination);
    return { path: destination, bytes: statSync(destination).size };
  } finally {
    connection.close();
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
  }
}

export function backupPathForMigration(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(dirname(path), 'backups', `pre-migrate-${stamp}-${randomUUID()}.sqlite3`);
}

function isCLI(): boolean {
  return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isCLI()) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--database' || args[2] !== '--output') throw new Error('Usage: node selfhost/backup.ts --database /absolute/source --output /absolute/new-backup');
    console.log(JSON.stringify(await backupDatabase(args[1], args[3])));
  } catch {
    console.error('SQLite backup failed; verify database path, permissions and unused output path.');
    process.exitCode = 1;
  }
}
