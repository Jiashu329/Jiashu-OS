import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

// Raw import versions are retained so a mistaken source switch can be undone.
export const healthImportBatches = sqliteTable('health_import_batches', {
  userId: text('user_id').notNull(),
  batchId: text('batch_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  operationId: text('operation_id').notNull(),
  beforeJson: text('before_json').notNull(),
  afterJson: text('after_json').notNull(),
  receiptJson: text('receipt_json').notNull(),
  createdAt: text('created_at').notNull(),
  revertedAt: text('reverted_at'),
  revertReason: text('revert_reason'),
  revertId: text('revert_id'),
}, (table) => [
  primaryKey({ columns: [table.userId, table.batchId] }),
  index('health_import_batches_owner_created_idx').on(table.userId, table.createdAt),
]);

// Bounded diagnostic receipts only. No invalid payload, measurement values or credentials.
export const healthSyncAttempts = sqliteTable('health_sync_attempts', {
  userId: text('user_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  createdAt: text('created_at').notNull(),
  channel: text('channel').notNull(),
  deviceLabel: text('device_label'),
  status: text('status').notNull(),
  batchId: text('batch_id'),
  errorCode: text('error_code'),
  summaryJson: text('summary_json').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.attemptId] }),
  index('health_sync_attempts_owner_created_idx').on(table.userId, table.createdAt),
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
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const healthGoalVersions = sqliteTable('health_goal_versions', {
  userId: text('user_id').notNull(),
  revision: integer('revision').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  stepsTarget: integer('steps_target'),
  sleepTarget: real('sleep_target'),
  activeEnergyTarget: real('active_energy_target'),
  createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.revision] }), index('health_goal_versions_owner_date_idx').on(table.userId, table.effectiveFrom, table.revision)]);

export const financeAccounts = sqliteTable('finance_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ledger: text('ledger').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  currency: text('currency').notNull(),
  creationHash: text('creation_hash'),
  balanceRevision: integer('balance_revision').notNull().default(0),
  metadataRevision: integer('metadata_revision').notNull().default(1),
  liquidityKind: text('liquidity_kind').notNull().default('unreviewed'),
  usableBps: integer('usable_bps').notNull().default(0),
  note: text('note').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
}, (table) => [index('finance_accounts_owner_ledger_idx').on(table.userId, table.ledger)]);

export const financeAccountClassifications = sqliteTable('finance_account_classifications', {
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(), revision: integer('revision').notNull(),
  effectiveFrom: text('effective_from').notNull(), type: text('type').notNull(), archived: integer('archived').notNull(),
  origin: text('origin').notNull(), recordedAt: text('recorded_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.accountId, table.revision] }), index('finance_classifications_owner_date_idx').on(table.userId, table.accountId, table.effectiveFrom, table.revision)]);

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

// Originals remain immutable. Each correction/void is a new, user-owned revision.
export const financeBalanceChanges = sqliteTable('finance_balance_changes', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  entryId: text('entry_id').notNull(),
  revision: integer('revision').notNull(),
  action: text('action').notNull(),
  amountMinor: text('amount_minor'),
  asOfDate: text('as_of_date'),
  note: text('note'),
  reason: text('reason').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('finance_balance_changes_owner_entry_revision_idx').on(table.userId, table.entryId, table.revision),
  index('finance_balance_changes_owner_account_idx').on(table.userId, table.accountId, table.sequence),
]);

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
  revision: integer('revision').notNull().default(1),
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
  revision: integer('revision').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.userId, table.ledger, table.currency] })]);

export const weightPlanSettings = sqliteTable('health_weight_plan_settings', {
  userId: text('user_id').primaryKey(),
  baselineWeight: real('baseline_weight').notNull(),
  targetWeight: real('target_weight').notNull(),
  startDate: text('start_date').notNull(),
  deadline: text('deadline').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  cycleId: text('cycle_id').notNull().default('legacy'),
  archivedAt: text('archived_at'),
});

// A cycle is copied here only when the user archives it. Saved summaries never
// change when measurements are subsequently corrected or a new cycle begins.
export const weightPlanCycles = sqliteTable('health_weight_plan_cycles', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  settingsJson: text('settings_json').notNull(),
  summaryJson: text('summary_json').notNull(),
  startedAt: text('started_at').notNull(),
  archivedAt: text('archived_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] }), index('weight_plan_cycles_owner_archived_idx').on(table.userId, table.archivedAt)]);

export const weightPlanOperations = sqliteTable('health_weight_plan_operations', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  action: text('action').notNull(),
  requestHash: text('request_hash').notNull(),
  cycleId: text('cycle_id').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] })]);

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
  carbsTenth: integer('carbs_tenth'),
  proteinTenth: integer('protein_tenth'),
  fatTenth: integer('fat_tenth'),
  foodJson: text('food_json'),
  provenanceJson: text('provenance_json'),
  creationHash: text('creation_hash').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [index('nutrition_entries_owner_date_idx').on(table.userId, table.date),
  check('nutrition_entries_carbs_bounds', sql`${table.carbsTenth} IS NULL OR (typeof(${table.carbsTenth}) = 'integer' AND ${table.carbsTenth} BETWEEN 0 AND 200000)`),
  check('nutrition_entries_protein_bounds', sql`${table.proteinTenth} IS NULL OR (typeof(${table.proteinTenth}) = 'integer' AND ${table.proteinTenth} BETWEEN 0 AND 200000)`),
  check('nutrition_entries_fat_bounds', sql`${table.fatTenth} IS NULL OR (typeof(${table.fatTenth}) = 'integer' AND ${table.fatTenth} BETWEEN 0 AND 200000)`),
]);

export const nutritionGoalSettings = sqliteTable('nutrition_goal_settings', {
  userId: text('user_id').primaryKey(),
  caloriesTenth: integer('calories_tenth'), carbsTenth: integer('carbs_tenth'), proteinTenth: integer('protein_tenth'), fatTenth: integer('fat_tenth'),
  revision: integer('revision').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('nutrition_goals_calories_bounds', sql`${table.caloriesTenth} IS NULL OR (typeof(${table.caloriesTenth}) = 'integer' AND ${table.caloriesTenth} BETWEEN 0 AND 200000)`),
  check('nutrition_goals_carbs_bounds', sql`${table.carbsTenth} IS NULL OR (typeof(${table.carbsTenth}) = 'integer' AND ${table.carbsTenth} BETWEEN 0 AND 200000)`),
  check('nutrition_goals_protein_bounds', sql`${table.proteinTenth} IS NULL OR (typeof(${table.proteinTenth}) = 'integer' AND ${table.proteinTenth} BETWEEN 0 AND 200000)`),
  check('nutrition_goals_fat_bounds', sql`${table.fatTenth} IS NULL OR (typeof(${table.fatTenth}) = 'integer' AND ${table.fatTenth} BETWEEN 0 AND 200000)`),
]);

export const nutritionEntryHistory = sqliteTable('nutrition_entry_history', {
  userId: text('user_id').notNull(), entryId: text('entry_id').notNull(), revision: integer('revision').notNull(),
  action: text('action').notNull(), beforeJson: text('before_json'), afterJson: text('after_json').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.entryId, table.revision] }), index('nutrition_history_owner_entry_idx').on(table.userId, table.entryId)]);

export const nutritionRestoreOperations = sqliteTable('nutrition_restore_operations', {
  userId: text('user_id').notNull(), id: text('id').notNull(), entryId: text('entry_id').notNull(),
  sourceRevision: integer('source_revision').notNull(), targetRevision: integer('target_revision').notNull(), requestHash: text('request_hash').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] })]);

export const nutritionCopyOperations = sqliteTable('nutrition_copy_operations', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), requestHash: text('request_hash').notNull(),
  entryIdsJson: text('entry_ids_json').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [index('nutrition_copy_operations_owner_created_idx').on(table.userId, table.createdAt)]);

// Request counters only; questions, answers and health data are never stored here.
export const aiUsageLimits = sqliteTable('ai_usage_limits', {
  userId: text('user_id').primaryKey(),
  day: text('day').notNull(),
  dayCount: integer('day_count').notNull(),
  minute: integer('minute').notNull(),
  minuteCount: integer('minute_count').notNull(),
});

// Each visitor owns one settings record. Only authenticated ciphertext is stored.
export const aiUserSettings = sqliteTable('ai_user_settings', {
  userId: text('user_id').primaryKey(),
  keyCiphertext: text('key_ciphertext'),
  keyIv: text('key_iv'),
  model: text('model').notNull(),
  region: text('region').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastTestStatus: text('last_test_status'),
  lastTestAt: text('last_test_at'),
});

export const nutritionBatches = sqliteTable('nutrition_batches', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  requestHash: text('request_hash').notNull(),
  entryIdsJson: text('entry_ids_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] })]);

export const nutritionFavorites = sqliteTable('nutrition_favorites', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  templateHash: text('template_hash').notNull(),
  templateJson: text('template_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('nutrition_favorites_owner_hash_idx').on(table.userId, table.templateHash)]);

// Named personal foods, composed recipes and whole-meal templates are independent
// of favorites so historical favorite hashes and operation receipts stay stable.
export const nutritionTemplates = sqliteTable('nutrition_templates', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), kind: text('kind').notNull(),
  name: text('name').notNull(), templateJson: text('template_json').notNull(), creationHash: text('creation_hash').notNull(),
  revision: integer('revision').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), archivedAt: text('archived_at'),
}, (table) => [
  index('nutrition_templates_owner_archive_updated_idx').on(table.userId, table.archivedAt, table.updatedAt),
  check('nutrition_templates_kind', sql`${table.kind} IN ('food','recipe','meal')`),
]);

export const nutritionTemplateOperations = sqliteTable('nutrition_template_operations', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), templateId: text('template_id').notNull(),
  action: text('action').notNull(), requestHash: text('request_hash').notNull(), resultJson: text('result_json').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [
  index('nutrition_template_operations_owner_created_idx').on(table.userId, table.createdAt),
  check('nutrition_template_operations_action', sql`${table.action} IN ('create','edit','archive')`),
]);

export const nutritionDayStatus = sqliteTable('nutrition_day_status', {
  userId: text('user_id').notNull(),
  date: text('date').notNull(),
  complete: integer('complete').notNull(),
  mealsJson: text('meals_json').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.date] })]);
