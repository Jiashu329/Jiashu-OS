CREATE TABLE `finance_goal_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ledger` text NOT NULL,
	`currency` text NOT NULL,
	`name` text NOT NULL,
	`target_minor` text NOT NULL,
	`deadline` text NOT NULL,
	`account_ids_json` text NOT NULL,
	`creation_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `finance_goal_plans_owner_ledger_idx` ON `finance_goal_plans` (`user_id`,`ledger`);