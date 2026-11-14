import { commitDoubanStep, countUnclassifiedDoubanRecords, nextUnclassifiedRecord, readDoubanConnection, readDoubanRun, startDoubanRun } from '../../../../../db/douban-store';
import { advanceDoubanSyncStep, createDoubanSyncState, doubanRateLimited, DoubanSyncError, parseDoubanSyncState, presentDoubanRun } from '../../../../../lib/douban-sync';
import { apiUser, json, unauthenticated } from '../../../_shared';
import { doubanBody, doubanDatabase, doubanError, doubanGuard, presentDoubanConnection } from '../_shared';

export const dynamic = 'force-dynamic';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated();
  const guard = doubanGuard(request); if (guard) return guard;
  try {
    const body = await doubanBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DoubanSyncError('请通过网站开始或继续豆瓣同步。');
    const raw = body as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['expectedConnectionRevision', 'runId', 'expectedRunRevision'].includes(key))
      || !Number.isSafeInteger(raw.expectedConnectionRevision) || Number(raw.expectedConnectionRevision) < 0
      || raw.runId !== undefined && (typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId)
        || !Number.isSafeInteger(raw.expectedRunRevision) || Number(raw.expectedRunRevision) < 0)
      || raw.runId === undefined && raw.expectedRunRevision !== undefined) throw new DoubanSyncError('同步进度标识或版本不正确，请读取最新状态。');
    const db = doubanDatabase(), connection = await readDoubanConnection(db, user.userId);
    if (connection.profileId === null) throw new DoubanSyncError('请先保存你的豆瓣个人主页，再开始公开记录同步。', 'DOUBAN_NOT_CONNECTED', 409);
    if (connection.revision !== raw.expectedConnectionRevision) throw new DoubanSyncError('豆瓣主页配置已变化，请读取最新配置后再同步。', 'DOUBAN_CONNECTION_CONFLICT', 409);
    if (raw.runId === undefined) {
      const previous = await readDoubanRun(db, user.userId);
      if (previous && doubanRateLimited(parseDoubanSyncState(previous.state))) {
        const remaining = 60000 - (Date.now() - Date.parse(previous.updatedAt));
        if (remaining > 0) throw new DoubanSyncError('豆瓣刚返回请求频率限制，请稍后再开始同步。', 'DOUBAN_SYNC_RATE_LIMITED', 429, Math.min(60, Math.ceil(remaining / 1000)));
      }
      const state = createDoubanSyncState(previous?.status === 'partial' ? previous.state : undefined);
      const run = await startDoubanRun(db, user.userId, connection.revision, state);
      return json({ connection: presentDoubanConnection(connection), run: presentDoubanRun(run), more: run.status === 'running' });
    }
    const run = await readDoubanRun(db, user.userId, raw.runId.toString().toLowerCase());
    if (!run) return json({ error: '找不到这次豆瓣同步，请读取当前账号的同步状态。', code: 'DOUBAN_RUN_NOT_FOUND' }, 404);
    if (run.profileId !== connection.profileId || run.connectionRevision !== connection.revision) throw new DoubanSyncError('这次同步属于旧的豆瓣配置，请按当前主页重新开始。', 'DOUBAN_CONNECTION_CONFLICT', 409);
    if (run.status !== 'running') return json({ connection: presentDoubanConnection(connection), run: presentDoubanRun(run), more: false });
    if (run.revision !== raw.expectedRunRevision) throw new DoubanSyncError('同步进度已更新，请读取最新状态后继续。', 'DOUBAN_RUN_CONFLICT', 409);
    const now = Date.now(), elapsed = now - Date.parse(run.updatedAt), cursor = parseDoubanSyncState(run.state);
    if (cursor.leaseUntil !== null && Date.parse(cursor.leaseUntil) > now) {
      throw new DoubanSyncError('另一个请求正在处理这一步同步，请稍后继续。', 'DOUBAN_SYNC_RATE_LIMITED', 429,
        Math.min(20, Math.max(1, Math.ceil((Date.parse(cursor.leaseUntil) - now) / 1000))));
    }
    if (!Number.isFinite(elapsed) || elapsed < 1000) throw new DoubanSyncError('请稍候再继续同步，避免频繁请求豆瓣。', 'DOUBAN_SYNC_RATE_LIMITED', 429, 1);
    // Claim before network I/O. A duplicate tab must lose this atomic revision
    // check before it can read the same public page. If this worker stops, the
    // bounded claim expires and the unchanged cursor can be resumed safely.
    const claimed = await commitDoubanStep(db, user.userId, { runId: run.id, expectedRevision: run.revision,
      connectionRevision: connection.revision, items: [], state: { ...cursor, leaseUntil: new Date(now + 20000).toISOString() },
      status: 'running', now: new Date(now).toISOString() });
    const decision = await advanceDoubanSyncStep(claimed, {
      nextUnclassified: (profileId, runId) => nextUnclassifiedRecord(db, user.userId, profileId, runId),
      countUnclassified: profileId => countUnclassifiedDoubanRecords(db, user.userId, profileId),
    });
    decision.state.leaseUntil = null;
    const updated = await commitDoubanStep(db, user.userId, { runId: run.id, expectedRevision: claimed.revision,
      connectionRevision: connection.revision, ...decision, now: new Date(Date.now()).toISOString() });
    return json({ connection: presentDoubanConnection(connection), run: presentDoubanRun(updated), more: updated.status === 'running' });
  } catch (error) { return doubanError(error); }
}
