import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export const healthGoalSettings = sqliteTable('health_goal_settings', {
  userId: text('user_id').primaryKey(),
  stepsTarget: integer('steps_target'),
  sleepTarget: real('sleep_target'),
  activeEnergyTarget: real('active_energy_target'),
  updatedAt: text('updated_at').notNull(),
});

export const financeAccounts = sqliteTable('finance_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ledger: text('ledger').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  currency: text('currency').notNull(),
  creationHash: text('creation_hash'),
  note: text('note').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
}, (table) => [index('finance_accounts_owner_ledger_idx').on(table.userId, table.ledger)]);

export const financeBalanceEntries = sqliteTable('finance_balance_entries', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  amountMinor: text('amount_minor').notNull(),
  asOfDate: text('as_of_date').notNull(),
  note: text('note').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [index('finance_balances_owner_account_date_idx').on(table.userId, table.accountId, table.asOfDate, table.sequence)]);
