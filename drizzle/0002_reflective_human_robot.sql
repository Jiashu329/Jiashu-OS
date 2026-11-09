CREATE TABLE `finance_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ledger` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `finance_accounts_owner_ledger_idx` ON `finance_accounts` (`user_id`,`ledger`);--> statement-breakpoint
CREATE TABLE `finance_balance_entries` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount_minor` text NOT NULL,
	`as_of_date` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_balance_entries_id_unique` ON `finance_balance_entries` (`id`);--> statement-breakpoint
CREATE INDEX `finance_balances_owner_account_date_idx` ON `finance_balance_entries` (`user_id`,`account_id`,`as_of_date`,`sequence`);