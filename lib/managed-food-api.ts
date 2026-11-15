import { ManagedFoodError, managedFoodId, parseManagedFoodCommand } from './managed-food-catalog.ts';
import type { ManagedFoodDatabase } from '../db/managed-food-store.ts';
import { listManagedFoodAdmin, mutateManagedFood } from '../db/managed-food-store.ts';
import { foodCatalogImages } from './food-catalog-images.ts';

interface Actor { userId: string; isOwner?: boolean }
interface Dependencies {
  unauthenticated?(message?: string): Response | Promise<Response>;
  user(): Promise<Actor | null>; database(): ManagedFoodDatabase;
  ownerId(db: ManagedFoodDatabase): Promise<string>;
  /** Optional deployment-configured stable owner, never accepted from JSON. */
  configuredOwnerId?(): string | undefined;
  builtin(): Array<{ id: string }>;
  json(value: unknown, status?: number): Response;
}
async function body(request: Request): Promise<unknown> {
  const maximum = 32768;
  if (Number(request.headers.get('content-length')) > maximum || !request.body) throw new ManagedFoodError('MANAGED_FOOD_REQUEST_TOO_LARGE','请提交不超过32 KB的食品资料。',413);
  const reader = request.body.getReader(), decoder = new TextDecoder(); let size = 0, input = '';
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new ManagedFoodError('MANAGED_FOOD_REQUEST_TOO_LARGE','食品资料不能超过32 KB。',413); }
    input += decoder.decode(part.value,{stream:true}); }
    return JSON.parse(input + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}
export function createManagedFoodHandlers(deps: Dependencies) {
  const failure = (error: unknown) => error instanceof ManagedFoodError && error.code === 'SIGN_IN_REQUIRED' && deps.unauthenticated ? deps.unauthenticated('请先登录网站。') : error instanceof ManagedFoodError ? deps.json({ error: error.message, code: error.code },error.status)
    : error instanceof SyntaxError ? deps.json({ error:'请提交有效的食品JSON资料。',code:'MANAGED_FOOD_INVALID' },400)
      : deps.json({ error:'公共食物库暂时无法读取或保存，请保留原内容后重试。',code:'MANAGED_FOOD_UNAVAILABLE' },503);
  async function actor(request: Request) {
    const user = await deps.user();
    if (!user) throw new ManagedFoodError('SIGN_IN_REQUIRED','请先登录网站。',401);
    if (request.headers.has('X-Page-Owner') && request.headers.get('X-Page-Owner') !== user.userId) throw new ManagedFoodError('ACCOUNT_CHANGED','登录账户已变化，请刷新后继续。',401);
    if (user.isOwner !== true) throw new ManagedFoodError('MANAGED_FOOD_OWNER_REQUIRED','只有网站管理员可以维护公共食物库。',403);
    return user;
  }
  async function authorized(request: Request) {
    const user = await actor(request), db = deps.database();
    if (await deps.ownerId(db) !== user.userId) throw new ManagedFoodError('MANAGED_FOOD_OWNER_REQUIRED','只有网站管理员可以维护公共食物库。',403);
    return { user, db };
  }
  return {
    async GET(request: Request) {
      try {
        if (new URL(request.url).searchParams.size) throw new ManagedFoodError('MANAGED_FOOD_INVALID','管理列表不支持额外查询字段。');
        const { db } = await authorized(request);
        const builtin = deps.builtin();
        return deps.json({ canManage:true,items:await listManagedFoodAdmin(db),builtin,images:foodCatalogImages(builtin) });
      } catch(error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        const user = await actor(request);
        if (request.headers.get('origin') !== new URL(request.url).origin) throw new ManagedFoodError('INVALID_ORIGIN','请从已登录的网站维护食物库。',403);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ManagedFoodError('INVALID_CONTENT_TYPE','请通过网站提交JSON食品资料。',415);
        if (request.headers.get('X-Page-Owner') !== user.userId) throw new ManagedFoodError('ACCOUNT_CHANGED','请刷新已登录页面后继续。',401);
        const operationId = managedFoodId(request.headers.get('Idempotency-Key'));
        const command = parseManagedFoodCommand(await body(request));
        if (command.action === 'save' && command.replacesId && !deps.builtin().some((food) => food.id === command.replacesId)) throw new ManagedFoodError('MANAGED_FOOD_INVALID','找不到关联的内置食品，请重新从当前食物库选择。');
        const db = deps.database();
        if (await deps.ownerId(db) !== user.userId) throw new ManagedFoodError('MANAGED_FOOD_OWNER_REQUIRED','只有网站管理员可以维护公共食物库。',403);
        return deps.json(await mutateManagedFood(db,user.userId,command,operationId,undefined,deps.configuredOwnerId?.()));
      } catch(error) { return failure(error); }
    },
  };
}
