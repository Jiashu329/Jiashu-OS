/* oxlint-disable no-control-regex -- Recipe fields reject control bytes. */
import { validateNutritionPhotoDataUrl } from './nutrition-photo-image.ts';
import { normalizeRecipeLink } from './recipe-link.ts';

export const MAX_RECIPE_PHOTO_BYTES = 256 * 1024;
export const MAX_RECIPE_PHOTO_STORAGE_CHARS = 6 * 1024 * 1024;
export const MAX_RECIPE_REQUEST_BYTES = 400 * 1024;

export class RecipeValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'INVALID_RECIPE', status = 400) {
    super(message);
    this.name = 'RecipeValidationError';
    this.code = code;
    this.status = status;
  }
}

export interface RecipeDefinition {
  title: string;
  note: string;
  ingredients: string;
  steps: string;
  servings: string;
}

export type RecipeSource = 'own' | 'xiaohongshu' | 'xiachufang';
export type RecipeSourceFilter = RecipeSource | 'all' | 'linked';
export interface RecipeCreation extends RecipeDefinition {
  source: RecipeSource;
  sourceUrl: string | null;
  sourceKey: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  cookingNote: string;
  photoDataUrl: string | null;
}

export interface RecipeListSelection {
  source: RecipeSourceFilter;
  cooked: boolean;
  query: string;
  limit: number;
  offset: number;
}

const definitionKeys = ['title', 'note', 'ingredients', 'steps', 'servings'] as const;

function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new RecipeValidationError('菜谱填写格式不正确。');
  }
  return input as Record<string, unknown>;
}

function field(input: unknown, label: string, max: number, options: { required?: boolean; multiline?: boolean } = {}): string {
  if (!options.required && (input === undefined || input === null)) return '';
  const forbidden = options.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
  if (typeof input !== 'string' || forbidden.test(input) || input.trim().length > max || (options.required && !input.trim())) {
    throw new RecipeValidationError(`${label}需${options.required ? `填写 1–${max} 字` : `至多 ${max} 字`}。`);
  }
  return input.trim();
}

/** Canonical recipe fields are shared by mutations and portable backup validation. */
export function parseRecipeDefinition(input: unknown): RecipeDefinition {
  return recipeDefinition(object(input, definitionKeys));
}

function recipeDefinition(raw: Record<string, unknown>): RecipeDefinition {
  return {
    title: field(raw.title, '菜名', 100, { required: true }),
    note: field(raw.note, '备注', 1_000, { multiline: true }),
    ingredients: field(raw.ingredients, '食材', 3_000, { multiline: true }),
    steps: field(raw.steps, '做法', 6_000, { multiline: true }),
    servings: field(raw.servings, '份量', 120),
  };
}

export function parseRecipeCookingNote(value: unknown): string {
  return field(value, '制作笔记', 2_000, { multiline: true });
}

export function parseRecipeSourceTitle(value: unknown): string | null {
  return field(value, '来源标题', 200) || null;
}

export function parseRecipeSourceAuthor(value: unknown): string | null {
  return field(value, '来源作者', 120) || null;
}

export function parseRecipePhoto(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && value.length > 'data:image/jpeg;base64,'.length + Math.ceil(MAX_RECIPE_PHOTO_BYTES / 3) * 4) {
    throw new RecipeValidationError('菜谱照片压缩后不能超过 256 KiB。', 'RECIPE_PHOTO_TOO_LARGE', 413);
  }
  const photo = validateNutritionPhotoDataUrl(value);
  if (photo.byteLength > MAX_RECIPE_PHOTO_BYTES) {
    throw new RecipeValidationError('菜谱照片压缩后不能超过 256 KiB。', 'RECIPE_PHOTO_TOO_LARGE', 413);
  }
  return photo.dataUrl;
}

export function parseRecipeLink(value: unknown) {
  const link = normalizeRecipeLink(value);
  if (!link) throw new RecipeValidationError('请粘贴有效的小红书或下厨房菜谱分享链接。', 'INVALID_RECIPE_LINK');
  return link;
}

export function parseRecipePreview(input: unknown) {
  return parseRecipeLink(object(input, ['sourceUrl']).sourceUrl);
}

export function parseRecipeCreation(input: unknown): RecipeCreation {
  const raw = object(input, [...definitionKeys, 'sourceUrl', 'sourceTitle', 'sourceAuthor', 'cookingNote', 'photoDataUrl']);
  const link = raw.sourceUrl === undefined || raw.sourceUrl === null ? null : parseRecipeLink(raw.sourceUrl);
  return {
    ...recipeDefinition(raw),
    source: link?.source ?? 'own',
    sourceUrl: link?.url ?? null,
    sourceKey: link?.key ?? null,
    sourceTitle: link ? parseRecipeSourceTitle(raw.sourceTitle) : null,
    sourceAuthor: link ? parseRecipeSourceAuthor(raw.sourceAuthor) : null,
    cookingNote: parseRecipeCookingNote(raw.cookingNote),
    photoDataUrl: parseRecipePhoto(raw.photoDataUrl),
  };
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RecipeValidationError('请重新打开菜谱核对当前版本。');
  }
  return value;
}

export function parseRecipeEdit(input: unknown) {
  const raw = object(input, [...definitionKeys, 'expectedRevision']);
  return { ...recipeDefinition(raw), expectedRevision: revision(raw.expectedRevision) };
}

export function parseRecipeArchive(input: unknown) {
  return revision(object(input, ['expectedRevision']).expectedRevision);
}

export function parseRecipeCooking(input: unknown) {
  const raw = object(input, ['note', 'photoDataUrl']);
  const note = parseRecipeCookingNote(raw.note), photoDataUrl = parseRecipePhoto(raw.photoDataUrl);
  if (!note && !photoDataUrl) throw new RecipeValidationError('请添加一张照片或填写制作笔记。');
  return { note, photoDataUrl };
}

export function parseRecipeCookingEdit(input: unknown) {
  const raw = object(input, ['note', 'photoDataUrl', 'expectedRevision']);
  return {
    note: parseRecipeCookingNote(raw.note),
    photoDataUrl: Object.hasOwn(raw, 'photoDataUrl') ? parseRecipePhoto(raw.photoDataUrl) : undefined,
    expectedRevision: revision(raw.expectedRevision),
  };
}

export function parseRecipeList(query: URLSearchParams): RecipeListSelection {
  const source = query.get('source') ?? 'all';
  if (source !== 'all' && source !== 'linked' && source !== 'own' && source !== 'xiaohongshu' && source !== 'xiachufang') {
    throw new RecipeValidationError('菜谱来源筛选不正确。');
  }
  const limit = paginationNumber(query.get('limit'), 30, 1, 50);
  const offset = paginationNumber(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  return { source, query: field(query.get('q'), '搜索词', 100), cooked: query.get('cooked') === '1', limit, offset };
}

function paginationNumber(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RecipeValidationError('菜谱分页参数不正确。');
  }
  return value;
}
