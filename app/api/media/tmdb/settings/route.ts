import { env } from 'cloudflare:workers';
import { clearTMDBSettings, readTMDBSettings, readTMDBSettingsOwner, saveTMDBSettings } from '../../../../../db/tmdb-settings-store';
import { parseTMDBSettingsRevision, parseTMDBSettingsSave, readTMDBSettingsBody } from '../../../../../lib/tmdb-settings';
import { apiUser, unauthenticated } from '../../../_shared';
import { tmdbSettingsDatabase, tmdbSettingsFailure, tmdbSettingsMutationGuard, tmdbSettingsOwnerRequired, tmdbSettingsResponse, tmdbSettingsStorageGuard } from './_shared';
export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await apiUser(); if (!user) return unauthenticated();
  try {
    const db = tmdbSettingsDatabase(), ownerId = await readTMDBSettingsOwner(db, env);
    return tmdbSettingsResponse(await readTMDBSettings(db, ownerId), user.isOwner === true && user.userId === ownerId);
  } catch (error) { return tmdbSettingsFailure(error); }
}
export async function PUT(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated(); if (user.isOwner !== true) return tmdbSettingsOwnerRequired();
  const guard = tmdbSettingsMutationGuard(request, user.userId) ?? tmdbSettingsStorageGuard(); if (guard) return guard;
  try {
    const input = parseTMDBSettingsSave(await readTMDBSettingsBody(request));
    const db = tmdbSettingsDatabase(), ownerId = await readTMDBSettingsOwner(db, env);
    if (user.userId !== ownerId) return tmdbSettingsOwnerRequired();
    return tmdbSettingsResponse(await saveTMDBSettings(db, ownerId, input, env.AI_SETTINGS_ENCRYPTION_KEY!), true, 'TMDB Token 已加密保存。');
  } catch (error) { return tmdbSettingsFailure(error); }
}
export async function DELETE(request: Request) {
  const user = await apiUser(); if (!user) return unauthenticated(); if (user.isOwner !== true) return tmdbSettingsOwnerRequired();
  const guard = tmdbSettingsMutationGuard(request, user.userId); if (guard) return guard;
  try {
    const { expectedRevision } = parseTMDBSettingsRevision(await readTMDBSettingsBody(request));
    const db = tmdbSettingsDatabase(), ownerId = await readTMDBSettingsOwner(db, env);
    if (user.userId !== ownerId) return tmdbSettingsOwnerRequired();
    return tmdbSettingsResponse(await clearTMDBSettings(db, ownerId, expectedRevision), true, 'TMDB Token 已删除，后续不再自动查找封面。');
  } catch (error) { return tmdbSettingsFailure(error); }
}
