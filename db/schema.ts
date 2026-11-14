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

export const healthSyncDiagnostics = sqliteTable('health_sync_diagnostics', {
  userId: text('user_id').notNull(),
  scope: text('scope').notNull(),
  receivedAt: text('received_at').notNull(),
  exportedAt: text('exported_at').notNull(),
  submittedCount: integer('submitted_count').notNull(),
  importedCount: integer('imported_count'),
  skippedCount: integer('skipped_count'),
  firstDay: text('first_day'),
  lastDay: text('last_day'),
}, (table) => [primaryKey({ columns: [table.userId, table.scope] })]);

export const healthWeeklyActions = sqliteTable('health_weekly_actions', {
  userId: text('user_id').notNull(),
  weekStart: text('week_start').notNull(),
  text: text('text').notNull(),
  status: text('status').notNull(),
  feedback: text('feedback').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.weekStart] })]);

export const financeMonthCloses = sqliteTable('finance_month_closes', {
  userId: text('user_id').notNull(),
  ledger: text('ledger').notNull(),
  currency: text('currency').notNull(),
  month: text('month').notNull(),
  version: integer('version').notNull(),
  operationId: text('operation_id').notNull(),
  requestHash: text('request_hash').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  reason: text('reason').notNull(),
  closedAt: text('closed_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.ledger, table.currency, table.month, table.version] }),
  uniqueIndex('finance_month_closes_owner_operation_idx').on(table.userId, table.operationId),
]);

// Authorization records are intentionally excluded from portable business backups.
export const appOwnerIdentity = sqliteTable('app_owner_identity', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [check('app_owner_identity_singleton', sql`${table.id} = 'owner'`)]);

export const appAccessGrants = sqliteTable('app_access_grants', {
  id: text('id').primaryKey().notNull(),
  email: text('email').notNull().unique(),
  boundUserId: text('bound_user_id').unique(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

export const appAccessOperations = sqliteTable('app_access_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  actorUserId: text('actor_user_id').notNull(),
  requestHash: text('request_hash').notNull(),
  grantId: text('grant_id').notNull(),
  createdAt: text('created_at').notNull(),
});

// Household authorization and attribution stay local to this application and
// never enter portable finance/health backups. Legacy business user_id is owner.
export const familyBooks = sqliteTable('family_books', {
  id: text('id').primaryKey().notNull(), ownerUserId: text('owner_user_id').notNull().unique(),
  ownerEmail: text('owner_email').notNull(), ownerName: text('owner_name').notNull(), name: text('name').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const familyBookMembers = sqliteTable('family_book_members', {
  id: text('id').primaryKey().notNull(), bookId: text('book_id').notNull().references(() => familyBooks.id),
  email: text('email').notNull(), userId: text('user_id'), status: text('status').notNull(), revision: integer('revision').notNull(),
  role: text('role').notNull().default('editor'),
  expiresAt: text('expires_at').notNull(), acceptedAt: text('accepted_at'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('family_members_book_email_idx').on(table.bookId, table.email),
  uniqueIndex('family_members_book_user_idx').on(table.bookId, table.userId),
  index('family_members_user_status_idx').on(table.userId, table.status),
  index('family_members_email_status_idx').on(table.email, table.status),
  check('family_members_status', sql`${table.status} IN ('pending','active','revoked','declined')`),
  check('family_members_revision', sql`${table.revision} >= 1`),
  check('family_members_role', sql`${table.role} IN ('editor','viewer')`),
]);
export const familyBookMemberOperations = sqliteTable('family_book_member_operations', {
  operationId: text('operation_id').primaryKey().notNull(), actorUserId: text('actor_user_id').notNull(),
  bookId: text('book_id').notNull().references(() => familyBooks.id), memberId: text('member_id').notNull().references(() => familyBookMembers.id),
  requestHash: text('request_hash').notNull(), createdAt: text('created_at').notNull(),
});
export const familyFinanceCommands = sqliteTable('family_finance_commands', {
  bookId: text('book_id').notNull().references(() => familyBooks.id), operationId: text('operation_id').notNull(),
  actorUserId: text('actor_user_id').notNull(), actorName: text('actor_name').notNull(), actorEmail: text('actor_email').notNull(),
  membershipId: text('membership_id'), accessRevision: integer('access_revision').notNull(), requestHash: text('request_hash').notNull(),
  action: text('action').notNull(), targetId: text('target_id'), createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.bookId, table.operationId] }), index('family_finance_commands_actor_idx').on(table.actorUserId, table.createdAt)]);

// Public catalog maintenance is shared site configuration, separate from personal records.
export const managedFoods = sqliteTable('managed_foods', {
  id: text('id').primaryKey().notNull(), replacesId: text('replaces_id'), draftJson: text('draft_json').notNull(),
  revision: integer('revision').notNull().default(1), publishedRevision: integer('published_revision'),
  status: text('status').notNull().default('draft'), createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [uniqueIndex('managed_foods_replaces_idx').on(table.replacesId),
  index('managed_foods_status_idx').on(table.status, table.updatedAt), check('managed_foods_status', sql`${table.status} IN ('draft','published','archived')`)]);
export const managedFoodVersions = sqliteTable('managed_food_versions', {
  itemId: text('item_id').notNull().references(() => managedFoods.id), revision: integer('revision').notNull(),
  definitionJson: text('definition_json').notNull(), createdBy: text('created_by').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.itemId, table.revision] })]);
export const managedFoodOperations = sqliteTable('managed_food_operations', {
  operationId: text('operation_id').primaryKey().notNull(), actorUserId: text('actor_user_id').notNull(),
  itemId: text('item_id').notNull(), action: text('action').notNull(), requestHash: text('request_hash').notNull(),
  resultJson: text('result_json').notNull(), createdAt: text('created_at').notNull(),
});
export const familyBookActivity = sqliteTable('family_book_activity', {
  id: text('id').primaryKey().notNull(), bookId: text('book_id').notNull().references(() => familyBooks.id),
  actorUserId: text('actor_user_id').notNull(), actorName: text('actor_name').notNull(), action: text('action').notNull(),
  targetId: text('target_id'), targetName: text('target_name'), createdAt: text('created_at').notNull(),
}, (table) => [index('family_book_activity_book_created_idx').on(table.bookId, table.createdAt, table.id)]);
export const notificationReadStates = sqliteTable('notification_read_states', {
  userId: text('user_id').notNull(), notificationId: text('notification_id').notNull(), readAt: text('read_at').notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.notificationId] }),
  index('notification_read_states_owner_time_idx').on(table.userId, table.readAt)]);
export const notificationPreferences = sqliteTable('notification_preferences', {
  userId: text('user_id').primaryKey().notNull(), settingsJson: text('settings_json').notNull(),
  revision: integer('revision').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [check('notification_preferences_revision', sql`${table.revision} >= 1`)]);

// Source-bound personal collections; configuration and diagnostic runs are not portable credentials.
export const doubanConnections = sqliteTable('douban_connections', {
  userId: text('user_id').primaryKey().notNull(), profileId: text('profile_id'),
  revision: integer('revision').notNull(), updatedAt: text('updated_at').notNull(),
}, table => [check('douban_connections_revision', sql`${table.revision} >= 1`)]);
export const doubanItems = sqliteTable('douban_items', {
  userId: text('user_id').notNull(), profileId: text('profile_id').notNull(), domain: text('domain').notNull(),
  subjectId: text('subject_id').notNull(), kind: text('kind').notNull(), title: text('title').notNull(), url: text('url').notNull(),
  coverUrl: text('cover_url'), rating: integer('rating'), markedDate: text('marked_date'), comment: text('comment'),
  publishedAt: text('published_at'), source: text('source').notNull(), observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), metadataCheckedRunId: text('metadata_checked_run_id'),
  detailsJson: text('details_json').notNull().default('{}'),
}, table => [primaryKey({ columns: [table.userId, table.profileId, table.domain, table.subjectId] }),
  index('douban_items_owner_date_idx').on(table.userId, table.markedDate, table.observedAt),
  index('douban_items_owner_profile_kind_idx').on(table.userId, table.profileId, table.kind),
  check('douban_items_domain', sql`${table.domain} IN ('screen','book','music')`),
  check('douban_items_kind', sql`${table.kind} IN ('screen','movie','series','book','music')`),
  check('douban_items_rating', sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`),
  check('douban_items_source', sql`${table.source} IN ('collection','rss','import')`),
  check('douban_items_domain_kind', sql`(${table.domain}='screen' AND ${table.kind} IN ('screen','movie','series')) OR ${table.domain}=${table.kind}`)]);
export const doubanSyncRuns = sqliteTable('douban_sync_runs', {
  userId: text('user_id').notNull(), id: text('id').notNull(), profileId: text('profile_id').notNull(),
  connectionRevision: integer('connection_revision').notNull(), revision: integer('revision').notNull().default(0),
  status: text('status').notNull(), stateJson: text('state_json').notNull(),
  added: integer('added').notNull().default(0), updated: integer('updated').notNull().default(0), unchanged: integer('unchanged').notNull().default(0),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), finishedAt: text('finished_at'),
}, table => [primaryKey({ columns: [table.userId, table.id] }),
  uniqueIndex('douban_runs_one_active_idx').on(table.userId, table.connectionRevision).where(sql`${table.status}='running'`),
  index('douban_runs_owner_created_idx').on(table.userId, table.createdAt, table.id),
  check('douban_sync_runs_revision', sql`${table.revision} >= 0`),
  check('douban_sync_runs_status', sql`${table.status} IN ('running','completed','partial','failed')`),
  check('douban_sync_runs_added', sql`${table.added} >= 0`), check('douban_sync_runs_updated', sql`${table.updated} >= 0`),
  check('douban_sync_runs_unchanged', sql`${table.unchanged} >= 0`)]);
// Import receipts contain counters only; neither uploaded documents nor private item content is duplicated here.
export const doubanImportReceipts = sqliteTable('douban_import_receipts', {
  userId: text('user_id').notNull(), requestId: text('request_id').notNull(), requestHash: text('request_hash').notNull(),
  receiptJson: text('receipt_json').notNull(), createdAt: text('created_at').notNull(),
}, table => [primaryKey({ columns: [table.userId, table.requestId] })]);
// A local deletion fence and counter-only receipt; never included in business backups.
export const doubanDataResets = sqliteTable('douban_data_resets', {
  userId: text('user_id').primaryKey().notNull(), dataEpoch: integer('data_epoch').notNull(),
  lastRequestId: text('last_request_id').notNull(), lastRequestHash: text('last_request_hash').notNull(),
  lastReceiptJson: text('last_receipt_json').notNull(), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, table => [check('douban_data_resets_epoch', sql`typeof(${table.dataEpoch})='integer' AND ${table.dataEpoch} BETWEEN 1 AND 9007199254740991`)]);
