import { existsSync } from 'node:fs';
import { databasePath, SQLiteD1Database } from './database.ts';
import { checkDatabase, loadMigrations } from './migrations.ts';
import type { SchemaReadiness } from './migrations.ts';

type RuntimeState = { database?: SQLiteD1Database; path?: string };
const stateKey = Symbol.for('jiashu.selfhost.database.v1');
const shared = globalThis as typeof globalThis & { [key: symbol]: RuntimeState };
const state = shared[stateKey] ??= {};

function openedDatabase(): SQLiteD1Database {
  const path = databasePath();
  if (state.database && state.path !== path) throw new Error('SELFHOST_DB_PATH changed while the database is open');
  if (!state.database) {
    state.database = new SQLiteD1Database(path);
    state.path = path;
  }
  return state.database;
}

/** Shared by the native authentication gateway and the bundled application. */
export function getSelfhostDatabase(): SQLiteD1Database { return openedDatabase(); }

// Importing the Cloudflare compatibility module during the build is inert.
// Every setting is resolved at request time, never embedded into the bundle.
export const env = {
  get DB(): D1Database { return openedDatabase(); },
  get APP_OWNER_USER_ID(): string | undefined { return process.env.APP_OWNER_USER_ID; },
  get APP_OWNER_EMAIL(): string | undefined { return process.env.APP_OWNER_EMAIL; },
  get AI_SETTINGS_ENCRYPTION_KEY(): string | undefined { return process.env.AI_SETTINGS_ENCRYPTION_KEY; },
  get SELFHOST_AUTH_PROVIDER(): 'local' { return 'local'; },
};

/** Never creates a missing database or writes/repairs schema from a health GET. */
export function readSelfhostReadiness(): SchemaReadiness {
  const migrations = loadMigrations();
  const path = databasePath();
  if (state.database) {
    if (state.path !== path) throw new Error('SELFHOST_DB_PATH changed while the database is open');
    return checkDatabase(state.database, migrations);
  }
  if (!existsSync(path)) return { schemaReady: false, applied: 0, total: migrations.length, pending: migrations.length };
  // Keep the shared runtime connection lazy. The independent read-only probe
  // cannot create the file, enable WAL or mutate schema before startup succeeds.
  const database = new SQLiteD1Database(path, { readOnly: true });
  try { return checkDatabase(database, migrations); }
  finally { database.close(); }
}

export function closeSelfhostDatabase(): void {
  state.database?.close();
  delete state.database;
  delete state.path;
}
