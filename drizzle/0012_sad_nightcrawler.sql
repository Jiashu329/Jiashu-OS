CREATE TABLE `finance_balance_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`amount_minor` text,
	`as_of_date` text,
	`note` text,
	`reason` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_balance_changes_id_unique` ON `finance_balance_changes` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_balance_changes_owner_entry_revision_idx` ON `finance_balance_changes` (`user_id`,`entry_id`,`revision`);--> statement-breakpoint
CREATE INDEX `finance_balance_changes_owner_account_idx` ON `finance_balance_changes` (`user_id`,`account_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `health_import_batches` (
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`operation_id` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` text NOT NULL,
	`reverted_at` text,
	`revert_reason` text,
	`revert_id` text,
	PRIMARY KEY(`user_id`, `batch_id`)
);
--> statement-breakpoint
CREATE INDEX `health_import_batches_owner_created_idx` ON `health_import_batches` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `balance_revision` integer DEFAULT 0 NOT NULL;