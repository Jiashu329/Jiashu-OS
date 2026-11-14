import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, BACKUP_TABLE_NAMES, BACKUP_PRE_DOUBAN_V2_TABLE_NAMES, BACKUP_PREVIOUS_V2_TABLE_NAMES, VOLUME_BACKUP_LIMITS, SINGLE_BACKUP_LIMITS, backupDigest, backupFail, parseDataBackup } from './data-backup.ts';
import type { BackupLimits, BackupRow, BackupTable, DataBackup } from './data-backup.ts';

export interface BackupVolume {
  kind: 'jiashu-os-backup-volume'; version: 1; setId: string; exportedAt: string;
  partIndex: number; totalParts: number; tables: Record<BackupTable, BackupRow[]>;
}
export interface BackupManifest {
  kind: 'jiashu-os-backup-manifest'; version: 1; backupVersion: 2; setId: string; exportedAt: string;
  totalRows: number; volumes: Array<{ partIndex: number; rowCount: number; byteLength: number; sha256: string }>;
}
export interface BackupSet { kind: 'jiashu-os-backup-set'; version: 1; manifest: BackupManifest; volumes: BackupVolume[] }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const emptyTables = () => Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table, []])) as unknown as Record<BackupTable, BackupRow[]>;
function record(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) return backupFail('分卷文件含缺失或不支持的字段。');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return backupFail('分卷编号、数量或容量无效。');
  return Number(value);
}

/** Each download fits the original ceiling; the complete set is validated and restored atomically. */
export async function splitBackupVolumes(input: DataBackup): Promise<BackupSet> {
  const backup = parseDataBackup(input, Date.now(), VOLUME_BACKUP_LIMITS), setId = await backupDigest(backup);
  const volumes: BackupVolume[] = [];
  const make = (): BackupVolume => ({ kind: 'jiashu-os-backup-volume', version: 1, setId, exportedAt: backup.exportedAt, partIndex: volumes.length + 1, totalParts: 8, tables: emptyTables() });
  let volume = make(), size = bytes(volume), rowCount = 0;
  for (const table of BACKUP_TABLE_NAMES) for (const row of backup.tables[table]) {
    const rowBytes = bytes(row) + (volume.tables[table].length ? 1 : 0);
    if (rowCount && (rowCount >= BACKUP_MAX_ROWS || size + rowBytes > BACKUP_MAX_BYTES - 1024)) {
      volumes.push(volume); volume = make(); size = bytes(volume); rowCount = 0;
    }
    if (size + bytes(row) > BACKUP_MAX_BYTES - 1024) backupFail('单条记录超过分卷容量，无法安全导出。');
    size += bytes(row) + (volume.tables[table].length ? 1 : 0); volume.tables[table].push(row); rowCount++;
  }
  volumes.push(volume);
  if (volumes.length > 8) backupFail('分卷数量超过上限，未截断任何记录。');
  for (const part of volumes) part.totalParts = volumes.length;
  const descriptors = await Promise.all(volumes.map(async (part) => ({ partIndex: part.partIndex, rowCount: Object.values(part.tables).reduce((sum, rows) => sum + rows.length, 0), byteLength: bytes(part), sha256: await backupDigest(part) })));
  return { kind: 'jiashu-os-backup-set', version: 1, manifest: { kind: 'jiashu-os-backup-manifest', version: 1, backupVersion: 2, setId, exportedAt: backup.exportedAt, totalRows: descriptors.reduce((sum, part) => sum + part.rowCount, 0), volumes: descriptors }, volumes };
}

export async function parseBackupInput(input: unknown, now = Date.now()): Promise<{ backup: DataBackup; limits: BackupLimits }> {
  if (!input || typeof input !== 'object' || (input as { kind?: unknown }).kind !== 'jiashu-os-backup-set') return { backup: parseDataBackup(input, now), limits: SINGLE_BACKUP_LIMITS };
  if (bytes(input) > VOLUME_BACKUP_LIMITS.maxBytes + 128 * 1024) backupFail('整组分卷超过 16 MiB 上限。');
  const set = record(input, ['kind', 'version', 'manifest', 'volumes']);
  if (set.version !== 1 || !Array.isArray(set.volumes)) backupFail('分卷组版本或文件列表无效。');
  const manifest = record(set.manifest, ['kind', 'version', 'backupVersion', 'setId', 'exportedAt', 'totalRows', 'volumes']);
  if (manifest.kind !== 'jiashu-os-backup-manifest' || manifest.version !== 1 || manifest.backupVersion !== 2 || typeof manifest.setId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.setId) || !Array.isArray(manifest.volumes)) backupFail('分卷清单无效。');
  const count = integer(manifest.volumes.length, 1, 8);
  if (set.volumes.length !== count) backupFail('分卷缺失或多选了其他文件，请选择清单与全部分卷。');
  const totalRows = integer(manifest.totalRows, 0, VOLUME_BACKUP_LIMITS.maxRows), seen = new Set<number>();
  let sourceNames: BackupTable[] | null = null;
  let tables: Record<BackupTable,BackupRow[]> | null = null;
  const sorted = [...set.volumes].sort((a, b) => Number(a?.partIndex) - Number(b?.partIndex));
  let actualRows = 0;
  for (let index = 0; index < count; index++) {
    const descriptor = record(manifest.volumes[index], ['partIndex', 'rowCount', 'byteLength', 'sha256']);
    if (descriptor.partIndex !== index + 1) backupFail('分卷清单顺序或编号无效。');
    integer(descriptor.rowCount, 0, BACKUP_MAX_ROWS); integer(descriptor.byteLength, 1, BACKUP_MAX_BYTES);
    const part = record(sorted[index], ['kind', 'version', 'setId', 'exportedAt', 'partIndex', 'totalParts', 'tables']);
    const partIndex = integer(part.partIndex, 1, count);
    if (seen.has(partIndex) || partIndex !== index + 1 || part.kind !== 'jiashu-os-backup-volume' || part.version !== 1 || part.totalParts !== count || part.setId !== manifest.setId || part.exportedAt !== manifest.exportedAt) backupFail('分卷混用、重复或不属于同一次备份。');
    seen.add(partIndex);
    if (bytes(part) !== descriptor.byteLength || await backupDigest(part) !== descriptor.sha256) backupFail('分卷校验失败，文件可能不完整或已被修改。');
    if(!sourceNames){
      if(!part.tables||typeof part.tables!=='object'||Array.isArray(part.tables))backupFail('分卷数据表无效。');
      const names=Object.keys(part.tables);
      const supported: readonly (readonly BackupTable[])[] = [BACKUP_TABLE_NAMES,BACKUP_PRE_DOUBAN_V2_TABLE_NAMES,BACKUP_PREVIOUS_V2_TABLE_NAMES];
      const shape = supported.find(shape => names.length === shape.length && shape.every(table => Object.hasOwn(part.tables as object, table)));
      if (!shape) backupFail('分卷含缺失或不支持的数据表。');
      sourceNames=[...shape];
      tables=Object.fromEntries(sourceNames.map((table)=>[table,[]])) as unknown as Record<BackupTable,BackupRow[]>;
    }
    const rows = record(part.tables, sourceNames);
    let partRows = 0;
    for (const table of sourceNames) {
      if (!Array.isArray(rows[table])) backupFail('分卷数据表应为数组。');
      partRows += (rows[table] as unknown[]).length;
      tables![table].push(...rows[table] as BackupRow[]);
    }
    if (partRows !== descriptor.rowCount) backupFail('分卷行数与清单不一致。');
    actualRows += partRows;
  }
  if (actualRows !== totalRows) backupFail('分卷总行数与清单不一致。');
  // Verify the published signed shape before compatibility expansion adds empty new tables.
  const signedBackup={ kind: 'jiashu-os-backup', version: 2, exportedAt: manifest.exportedAt, tables };
  if (await backupDigest(signedBackup) !== manifest.setId) backupFail('整组分卷内容与清单摘要不一致。');
  const backup = parseDataBackup(signedBackup, now, VOLUME_BACKUP_LIMITS);
  return { backup, limits: VOLUME_BACKUP_LIMITS };
}
