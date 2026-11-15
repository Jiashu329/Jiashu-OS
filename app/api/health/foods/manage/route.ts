import { env } from 'cloudflare:workers';
import { createManagedFoodHandlers } from '../../../../../lib/managed-food-api';
import { readSiteAISettingsOwner } from '../../../../../db/site-ai-settings-store';
import { browseFoodLibrary } from '../../../../../lib/food-library-catalog';
import { apiUser, unauthenticated, json } from '../../../_shared';
import { configuredAccessOwner } from '../../../../../lib/access-control';

export const dynamic = 'force-dynamic';
const handlers = createManagedFoodHandlers({
  user:apiUser,unauthenticated,
  database() { if (!env.DB) throw new Error('Food library storage unavailable'); return env.DB; },
  ownerId(db) { return readSiteAISettingsOwner(db,env); },
  configuredOwnerId() { return configuredAccessOwner(env.APP_OWNER_USER_ID) ?? undefined; },
  builtin() {
    const foods: Array<{ id: string }> = [];
    for (let offset = 0; ; offset += 50) { const page = browseFoodLibrary({offset,limit:50}); foods.push(...page.foods); if (offset+50 >= page.total) break; }
    return foods;
  },
  json,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
