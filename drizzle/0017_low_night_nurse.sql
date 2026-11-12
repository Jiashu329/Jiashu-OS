CREATE TABLE `finance_account_classifications` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`revision` integer NOT NULL,
	`effective_from` text NOT NULL,
	`type` text NOT NULL,
	`archived` integer NOT NULL,
	`origin` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `account_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `finance_classifications_owner_date_idx` ON `finance_account_classifications` (`user_id`,`account_id`,`effective_from`,`revision`);--> statement-breakpoint
CREATE TABLE `nutrition_template_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`template_id` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "nutrition_template_operations_action" CHECK("nutrition_template_operations"."action" IN ('create','edit','archive'))
);
--> statement-breakpoint
CREATE INDEX `nutrition_template_operations_owner_created_idx` ON `nutrition_template_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`template_json` text NOT NULL,
	`creation_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "nutrition_templates_kind" CHECK("nutrition_templates"."kind" IN ('food','recipe','meal'))
);
--> statement-breakpoint
CREATE INDEX `nutrition_templates_owner_archive_updated_idx` ON `nutrition_templates` (`user_id`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `health_weight_plan_cycles` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`settings_json` text NOT NULL,
	`summary_json` text NOT NULL,
	`started_at` text NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `weight_plan_cycles_owner_archived_idx` ON `health_weight_plan_cycles` (`user_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `health_weight_plan_operations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`cycle_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `liquidity_kind` text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `usable_bps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `health_weight_plan_settings` ADD `cycle_id` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `health_weight_plan_settings` ADD `archived_at` text;
--> statement-breakpoint
UPDATE finance_accounts SET
 liquidity_kind = CASE WHEN type IN ('cash','bank') THEN 'liquid' WHEN type IN ('property','credit_card','loan','other_liability') THEN 'illiquid' ELSE 'unreviewed' END,
 usable_bps = CASE WHEN type IN ('cash','bank') THEN 10000 ELSE 0 END;
--> statement-breakpoint
INSERT INTO finance_account_classifications(user_id,account_id,revision,effective_from,type,archived,origin,recorded_at)
 SELECT user_id,id,metadata_revision,'1970-01-01',type,(archived_at IS NOT NULL),'baseline',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM finance_accounts;
