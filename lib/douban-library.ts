import { DoubanValidationError, type DoubanDomain, type DoubanSubjectDetails } from './douban.ts';

export interface DoubanLocalRecord { note: string; tags: string[]; hidden: boolean; revision: number }
export type DoubanLibrarySort = 'date-desc' | 'date-asc' | 'rating-desc' | 'rating-asc';
export const DOUBAN_LIBRARY_SORTS: DoubanLibrarySort[] = ['date-desc', 'date-asc', 'rating-desc', 'rating-asc'];

/** Core fields that can usefully be completed for every supported kind of work. */
export function doubanMissingFields(item: { domain: DoubanDomain; kind?: string; coverUrl?: string | null; cover?: { mode: string; url?: string }; details?: DoubanSubjectDetails }): string[] {
  const missing: string[] = [], details = item.details ?? {};
  if (item.kind === 'screen') missing.push('影视分类');
  if (!item.coverUrl?.trim() && !(item.cover?.mode === 'url' && item.cover.url?.trim())) missing.push('封面');
  if (!details.summary?.trim()) missing.push('简介');
  const field = item.domain === 'screen' ? 'directors' : item.domain === 'book' ? 'authors' : 'artists';
  if (!details[field]?.length) missing.push(item.domain === 'screen' ? '导演' : item.domain === 'book' ? '作者' : '表演者');
  return missing;
}
export const missingDoubanDetails = doubanMissingFields;

export function parseDoubanLocalRecord(value: unknown): Omit<DoubanLocalRecord, 'revision'> {
  const invalid = (): never => { throw new DoubanValidationError('备注最多 4000 字，标签最多 12 个、每个最多 30 字，请核对填写。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.note !== 'string' || raw.note.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(raw.note)
    || !Array.isArray(raw.tags) || raw.tags.length > 12 || typeof raw.hidden !== 'boolean') return invalid();
  const tags: string[] = [];
  for (const entry of raw.tags) {
    if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > 30 || /[\u0000-\u001f\u007f-\u009f]/.test(entry)) return invalid();
    const tag = entry.trim();
    if (tags.includes(tag)) return invalid();
    tags.push(tag);
  }
  return { note: raw.note.replace(/\r\n?/g, '\n'), tags, hidden: raw.hidden };
}
