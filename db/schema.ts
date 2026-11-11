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

export const financeGoalPlans = sqliteTable('finance_goal_plans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ledger: text('ledger').notNull(),
  currency: text('currency').notNull(),
  name: text('name').notNull(),
  targetMinor: text('target_minor').notNull(),
  deadline: text('deadline').notNull(),
  accountIdsJson: text('account_ids_json').notNull(),
  creationHash: text('creation_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
}, (table) => [index('finance_goal_plans_owner_ledger_idx').on(table.userId, table.ledger)]);

export const financeRunwaySettings = sqliteTable('finance_runway_settings', {
  userId: text('user_id').notNull(),
  ledger: text('ledger').notNull(),
  currency: text('currency').notNull(),
  monthlyExpenseMinor: text('monthly_expense_minor').notNull(),
  targetMonths: integer('target_months').notNull(),
  accountIdsJson: text('account_ids_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.ledger, table.currency] })]);

export const weightPlanSettings = sqliteTable('health_weight_plan_settings', {
  userId: text('user_id').primaryKey(),
  baselineWeight: real('baseline_weight').notNull(),
  targetWeight: real('target_weight').notNull(),
  startDate: text('start_date').notNull(),
  deadline: text('deadline').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const healthRecordOverrides = sqliteTable('health_record_overrides', {
  userId: text('user_id').notNull(),
  recordKey: text('record_key').notNull(),
  metric: text('metric').notNull(),
  day: text('day').notNull(),
  overrideJson: text('override_json'),
  deleted: integer('deleted').notNull(),
  revision: integer('revision').notNull(),
  lastChangeId: text('last_change_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.recordKey] }),
  index('health_record_overrides_owner_day_idx').on(table.userId, table.day),
]);

export const healthRecordChanges = sqliteTable('health_record_changes', {
  userId: text('user_id').notNull(),
  changeId: text('change_id').notNull(),
  recordKey: text('record_key').notNull(),
  requestHash: text('request_hash').notNull(),
  action: text('action').notNull(),
  targetRevision: integer('target_revision').notNull(),
  beforeStateJson: text('before_state_json'),
  afterStateJson: text('after_state_json').notNull(),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.changeId] }),
  index('health_record_changes_owner_record_idx').on(table.userId, table.recordKey, table.createdAt),
]);

export const nutritionEntries = sqliteTable('nutrition_entries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  date: text('date').notNull(),
  meal: text('meal').notNull(),
  name: text('name').notNull(),
  portion: text('portion').notNull(),
  note: text('note').notNull(),
  caloriesTenth: integer('calories_tenth'),
  creationHash: text('creation_hash').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [index('nutrition_entries_owner_date_idx').on(table.userId, table.date)]);

// Request counters only; questions, answers and health data are never stored here.
export const aiUsageLimits = sqliteTable('ai_usage_limits', {
  userId: text('user_id').primaryKey(),
  day: text('day').notNull(),
  dayCount: integer('day_count').notNull(),
  minute: integer('minute').notNull(),
  minuteCount: integer('minute_count').notNull(),
});
