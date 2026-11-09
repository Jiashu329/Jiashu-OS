import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const healthMeasurements = sqliteTable('health_measurements', {
  userId: text('user_id').notNull(),
  recordKey: text('record_key').notNull(),
  metric: text('metric').notNull(),
  day: text('day').notNull(),
  measurementJson: text('measurement_json').notNull(),
  exportedAt: text('exported_at').notNull(),
  receivedAt: text('received_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.recordKey] }),
  index('health_measurements_user_day_idx').on(table.userId, table.day),
]);

export const healthSyncs = sqliteTable('health_syncs', {
  userId: text('user_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  exportedAt: text('exported_at').notNull(),
  receivedAt: text('received_at').notNull(),
  measurementCount: integer('measurement_count').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.payloadHash] }),
  index('health_syncs_user_received_idx').on(table.userId, table.receivedAt),
]);

export const syncDevices = sqliteTable('sync_devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('sync_devices_user_revoked_idx').on(table.userId, table.revokedAt),
]);
