/** Kept self-contained because the browser embeds this function with toString(). */
export function shouldRefreshDoubanDetails(item: unknown, full = false, now = Date.now()): boolean {
  if (full === true || !Number.isFinite(now) || !item || typeof item !== 'object' || Array.isArray(item)) return true;
  const sync = (item as { sync?: unknown }).sync;
  if (!sync || typeof sync !== 'object' || Array.isArray(sync)) return true;
  const hint = sync as { collectionHash?: unknown; detailsCheckedAt?: unknown };
  if (typeof hint.collectionHash !== 'string' || !/^[a-f0-9]{64}$/i.test(hint.collectionHash)
    || typeof hint.detailsCheckedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(hint.detailsCheckedAt)) return true;
  const checked = Date.parse(hint.detailsCheckedAt);
  if (!Number.isFinite(checked)) return true;
  const canonical = new Date(checked).toISOString();
  if (canonical !== hint.detailsCheckedAt && canonical.replace('.000Z', 'Z') !== hint.detailsCheckedAt) return true;
  return checked > now || now - checked >= 7 * 24 * 60 * 60 * 1000;
}

/** IMDb freshness is independent from collection timestamps and the Douban hint. */
export function shouldRefreshIMDbRating(item: unknown, full = false, now = Date.now()): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const record = item as { domain?: unknown; details?: unknown; imdb?: unknown };
  if (record.domain !== 'screen' || !record.details || typeof record.details !== 'object' || Array.isArray(record.details)) return false;
  const imdbId = (record.details as { imdbId?: unknown }).imdbId;
  if (typeof imdbId !== 'string' || !/^tt[0-9]{7,10}$/.test(imdbId)) return false;
  if (full === true || !Number.isFinite(now)) return true;
  if (!record.imdb || typeof record.imdb !== 'object' || Array.isArray(record.imdb)) return true;
  const rating = record.imdb as { imdbId?: unknown; source?: unknown; rating?: unknown; ratingCount?: unknown; checkedAt?: unknown };
  if (rating.imdbId !== imdbId || rating.source !== 'imdb-datasets' || typeof rating.rating !== 'number'
    || !Number.isFinite(rating.rating) || rating.rating <= 0 || rating.rating > 10
    || !Number.isSafeInteger(rating.ratingCount) || Number(rating.ratingCount) <= 0
    || typeof rating.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(rating.checkedAt)) return true;
  const checked = Date.parse(rating.checkedAt);
  if (!Number.isFinite(checked)) return true;
  const canonical = new Date(checked).toISOString();
  if (canonical !== rating.checkedAt && canonical.replace('.000Z', 'Z') !== rating.checkedAt) return true;
  return checked > now || now - checked >= 24 * 60 * 60 * 1000;
}
