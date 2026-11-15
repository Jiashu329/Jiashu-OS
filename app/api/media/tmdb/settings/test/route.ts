import { env } from 'cloudflare:workers';
import { readTMDBSettingsOwner, recordTMDBSettingsTest, resolveTMDBConfiguration } from '../../../../../../db/tmdb-settings-store';
import { parseTMDBSettingsRevision, readTMDBSettingsBody } from '../../../../../../lib/tmdb-settings';
import { checkTMDBToken } from '../../../../../../lib/tmdb-provider';
import { apiUser, json, unauthenticated } from '../../../../_shared';
import { tmdbSettingsDatabase, tmdbSettingsFailure, tmdbSettingsMutationGuard, tmdbSettingsOwnerRequired, tmdbSettingsResponse, tmdbSettingsStorageGuard } from '../_shared';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated(); if (user.isOwner !== true) return tmdbSettingsOwnerRequired();
  const guard = tmdbSettingsMutationGuard(request, user.userId) ?? tmdbSettingsStorageGuard(); if (guard) return guard;
  try {
    const { expectedRevision } = parseTMDBSettingsRevision(await readTMDBSettingsBody(request));
    const db = tmdbSettingsDatabase(), ownerId = await readTMDBSettingsOwner(db, env);
    if (user.userId !== ownerId) return tmdbSettingsOwnerRequired();
    const config = await resolveTMDBConfiguration(db, env, expectedRevision);
    if (!config.configured) return json({ error: '请先保存 API Read Access Token，再测试连接。', code: 'TMDB_NOT_CONFIGURED' }, 400);
    if (await readTMDBSettingsOwner(db, env) !== ownerId) return tmdbSettingsOwnerRequired();
    try { await checkTMDBToken(config.token); }
    catch (error) { await recordTMDBSettingsTest(db, ownerId, expectedRevision, false); throw error; }
    return tmdbSettingsResponse(await recordTMDBSettingsTest(db, ownerId, expectedRevision, true), true, 'TMDB 连接测试成功。');
  } catch (error) { return tmdbSettingsFailure(error); }
}
