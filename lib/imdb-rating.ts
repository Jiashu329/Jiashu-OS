import { validIMDbId } from './tmdb-cover.ts';

export const IMDB_RATING_SOURCE = 'imdb-datasets' as const;
export const IMDB_DATASET_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
export const IMDB_ATTRIBUTION = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';

/** A successful snapshot from the official IMDb ratings dataset, never a personal or TMDB score. */
export interface IMDbRating {
  imdbId: string;
  rating: number;
  ratingCount: number;
  source: typeof IMDB_RATING_SOURCE;
  checkedAt: string;
  datasetDate: string | null;
}

const fields = ['imdbId', 'rating', 'ratingCount', 'source', 'checkedAt', 'datasetDate'] as const;
function invalid(): never { throw new TypeError('IMDb 评分格式不正确。'); }

export function validIMDbRatingDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validCheckedAt(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Empty objects represent an absent score; all populated snapshots have exactly these data fields. */
export function parseIMDbRating(raw: unknown): IMDbRating | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
    descriptors = Object.getOwnPropertyDescriptors(raw);
  } catch { return invalid(); }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length === 0) return null;
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key as typeof fields[number]))) return invalid();
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    value[field] = descriptor.value;
  }
  if (!validIMDbId(value.imdbId) || typeof value.rating !== 'number' || !Number.isFinite(value.rating) || value.rating <= 0 || value.rating > 10
    || !Number.isSafeInteger(value.ratingCount) || Number(value.ratingCount) <= 0 || value.source !== IMDB_RATING_SOURCE
    || !validCheckedAt(value.checkedAt) || value.datasetDate !== null && !validIMDbRatingDate(value.datasetDate)) return invalid();
  const datasetDate = value.datasetDate as string | null;
  if (datasetDate !== null && datasetDate > value.checkedAt.slice(0, 10)) return invalid();
  return { imdbId: value.imdbId, rating: value.rating, ratingCount: value.ratingCount as number, source: IMDB_RATING_SOURCE,
    checkedAt: value.checkedAt, datasetDate };
}

export function serializeIMDbRating(raw: unknown): string { return JSON.stringify(parseIMDbRating(raw) ?? {}); }
