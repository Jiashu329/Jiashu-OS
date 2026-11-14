import type { FoodSource } from './food-catalog.ts';

export interface ManagedFoodDefinition {
  name: string; aliases: string[]; brandId: string; brandName: string; category: string; description: string;
  sourceName: string; sourceUrl: string; portionLabel: string;
  calories: string | null; carbs: string | null; protein: string | null; fat: string | null; imageUrl: string;
}
export interface ManagedLibraryFood {
  basis: 'managed'; id: string; itemId: string; revision: number; name: string; aliases: string[];
  category: string; state: string; description: string; brand: { id: string; name: string }; source: FoodSource;
  reference: { label: string; calories: number | null; carbs?: number; protein?: number; fat?: number };
  image?: { src: string; alt: string };
}
export interface ManagedFoodAdminItem {
  id: string; revision: number; status: 'draft' | 'published' | 'archived'; replacesId: string | null;
  draft: ManagedFoodDefinition; published: ManagedFoodDefinition | null; publishedRevision: number | null;
  hasDraftChanges: boolean; createdAt: string; updatedAt: string;
}
export class ManagedFoodError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.name = 'ManagedFoodError'; this.code = code; this.status = status; }
}
function invalid(message: string): never { throw new ManagedFoodError('MANAGED_FOOD_INVALID', message); }
export function managedFoodId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return invalid('请使用有效的食物或提交标识。');
  return value.toLowerCase();
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('请提交完整的食品资料。');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return invalid('食品资料包含不支持的字段。');
  return raw;
}
function text(value: unknown, label: string, maximum: number, optional = false, multiline = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)
    || value.trim().length > maximum || !optional && !value.trim()) return invalid(`请填写${optional ? '不超过' : '1–'}${maximum}字的${label}。`);
  return value.trim();
}
function nutrient(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d)?$/.test(value.trim()) || Number(value) > 20000) return invalid(`${label}需为0–20,000之间的数值，最多一位小数；未知请留空。`);
  return Number(value).toFixed(1);
}
export function managedFoodImage(value: unknown): string {
  const input = text(value, '图片地址', 1200, true); if (!input) return '';
  if (/^\/food-images\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp)$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.')
      || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(url.hostname)) return invalid('图片请使用公开 HTTPS 地址或站内食物图片路径。');
    return url.href;
  } catch { return invalid('图片请使用公开 HTTPS 地址或站内食物图片路径。'); }
}
export function parseManagedFoodDefinition(value: unknown): ManagedFoodDefinition {
  const keys = ['name','aliases','brandId','brandName','category','description','sourceName','sourceUrl','portionLabel','calories','carbs','protein','fat','imageUrl'];
  const raw = object(value, keys);
  const brandId = text(raw.brandId, '品牌标识', 60);
  if (!/^(?:mcd-cn|luckin-cn|custom-[0-9a-f-]{36})$/.test(brandId)) return invalid('请选择已有品牌，或为新品牌生成独立标识。');
  if (brandId.startsWith('custom-')) managedFoodId(brandId.slice(7));
  const brandName = text(raw.brandName, '品牌名称', 40);
  if (brandId === 'mcd-cn' && !['麦当劳','麦当劳中国'].includes(brandName) || brandId === 'luckin-cn' && !['瑞幸','瑞幸咖啡'].includes(brandName)) return invalid('已有品牌名称与品牌标识不一致。');
  if (!Array.isArray(raw.aliases) || raw.aliases.length > 15) return invalid('别名最多15个。');
  const aliases = [...new Set(raw.aliases.map((alias) => text(alias, '别名', 100)))];
  const sourceUrl = text(raw.sourceUrl, '来源链接', 1200);
  try { const url = new URL(sourceUrl); if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return invalid('来源链接需为公开 HTTPS 地址。'); } catch { return invalid('来源链接需为公开 HTTPS 地址。'); }
  return { name: text(raw.name, '食品名称', 100), aliases, brandId, brandName, category: text(raw.category, '食品分类', 60),
    description: text(raw.description, '食品说明', 1000, true, true), sourceName: text(raw.sourceName, '来源名称', 100), sourceUrl,
    portionLabel: text(raw.portionLabel, '每份对应规格', 100), calories: nutrient(raw.calories, '热量'), carbs: nutrient(raw.carbs, '碳水'),
    protein: nutrient(raw.protein, '蛋白质'), fat: nutrient(raw.fat, '脂肪'), imageUrl: managedFoodImage(raw.imageUrl) };
}
export type ManagedFoodCommand = { action: 'save'; id?: string; expectedRevision: number; replacesId: string | null; definition: ManagedFoodDefinition }
  | { action: 'publish' | 'archive' | 'restore'; id: string; expectedRevision: number };
export function parseManagedFoodCommand(value: unknown): ManagedFoodCommand {
  const raw = object(value, ['action','id','expectedRevision','replacesId','definition']);
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0 || Number(raw.expectedRevision) >= Number.MAX_SAFE_INTEGER) return invalid('请先读取食品的最新版本。');
  const expectedRevision = Number(raw.expectedRevision);
  if (raw.action === 'save') {
    const id = raw.id === undefined ? undefined : managedFoodId(raw.id);
    if ((!id && expectedRevision !== 0) || id && expectedRevision < 1) return invalid('请使用食品的最新版本保存草稿。');
    let replacesId: string | null = null;
    if (raw.replacesId !== undefined && raw.replacesId !== null) {
      if (typeof raw.replacesId !== 'string' || !/^(?:mcd-cn:\d+:\d+|luckin-cn:\d+)$/.test(raw.replacesId)) return invalid('只能建立当前内置食物的维护副本。');
      replacesId = raw.replacesId;
    }
    return { action: 'save', ...(id ? { id } : {}), expectedRevision, replacesId, definition: parseManagedFoodDefinition(raw.definition) };
  }
  if (!['publish','archive','restore'].includes(String(raw.action)) || raw.definition !== undefined || raw.replacesId !== undefined || expectedRevision < 1) return invalid('请选择保存草稿、审核发布、下架或恢复。');
  return { action: raw.action as 'publish' | 'archive' | 'restore', id: managedFoodId(raw.id), expectedRevision };
}
export function managedLibraryFood(id: string, revision: number, definition: ManagedFoodDefinition): ManagedLibraryFood {
  const reference: ManagedLibraryFood['reference'] = { label: definition.portionLabel, calories: definition.calories === null ? null : Number(definition.calories) };
  for (const key of ['carbs','protein','fat'] as const) if (definition[key] !== null) reference[key] = Number(definition[key]);
  return { basis: 'managed', id: `managed:${id}:${revision}`, itemId: id, revision, name: definition.name, aliases: [...definition.aliases],
    category: definition.category, state: '管理员维护资料', description: definition.description, brand: { id: definition.brandId, name: definition.brandName },
    source: { name: definition.sourceName, url: definition.sourceUrl, recordId: id, version: `网站维护版本${revision}` }, reference,
    ...(definition.imageUrl ? { image: { src: definition.imageUrl, alt: definition.name } } : {}) };
}
