CREATE TABLE `finance_runway_settings` (
	`user_id` text NOT NULL,
	`ledger` text NOT NULL,
	`currency` text NOT NULL,
	`monthly_expense_minor` text NOT NULL,
	`target_months` integer NOT NULL,
	`account_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `ledger`, `currency`)
);
