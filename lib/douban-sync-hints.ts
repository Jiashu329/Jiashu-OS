import { parseDoubanRecord, type DoubanRecordInput } from './douban.ts';
import { parseDoubanDetails } from './douban-details.ts';
export interface DoubanSyncHints { collectionHash: string | null; detailsCheckedAt: string | null }
export function normalizeDoubanSyncHints(raw: { collectionHash?: unknown; detailsCheckedAt?: unknown }): DoubanSyncHints {
  const collectionHash = raw.collectionHash ?? null, detailsCheckedAt = raw.detailsCheckedAt ?? null;
  if (collectionHash !== null && (typeof collectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(collectionHash))
    || detailsCheckedAt !== null && (typeof detailsCheckedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(detailsCheckedAt)
      || !Number.isFinite(Date.parse(detailsCheckedAt)) || new Date(detailsCheckedAt).toISOString() !== detailsCheckedAt)) throw new TypeError('豆瓣同步检查状态暂时无法读取。');
  return { collectionHash: collectionHash as string | null, detailsCheckedAt: detailsCheckedAt as string | null };
}
/** Hash the normalized source payload, never the enriched or manually organized stored row. */
export async function doubanCollectionHash(raw: DoubanRecordInput): Promise<string> {
  const item = parseDoubanRecord(raw), fields = ['domain','subjectId','kind','title','url','coverUrl','rating','markedDate','comment','publishedAt','source'] as const;
  const payload = { ...Object.fromEntries(fields.map(field => [field, item[field]])), details: parseDoubanDetails(item.details) };
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(value => value.toString(16).padStart(2, '0')).join('');
}
