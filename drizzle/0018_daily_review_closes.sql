CREATE TABLE `finance_month_closes` (
	`user_id` text NOT NULL,
	`ledger` text NOT NULL,
	`currency` text NOT NULL,
	`month` text NOT NULL,
	`version` integer NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`reason` text NOT NULL,
	`closed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `ledger`, `currency`, `month`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_month_closes_owner_operation_idx` ON `finance_month_closes` (`user_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `health_sync_diagnostics` (
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`received_at` text NOT NULL,
	`exported_at` text NOT NULL,
	`submitted_count` integer NOT NULL,
	`imported_count` integer,
	`skipped_count` integer,
	`first_day` text,
	`last_day` text,
	PRIMARY KEY(`user_id`, `scope`)
);
--> statement-breakpoint
CREATE TABLE `health_weekly_actions` (
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`feedback` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `week_start`)
);
