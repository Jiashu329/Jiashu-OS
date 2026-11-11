CREATE TABLE `health_goal_versions` (
	`user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`effective_from` text NOT NULL,
	`steps_target` integer,
	`sleep_target` real,
	`active_energy_target` real,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `health_goal_versions_owner_date_idx` ON `health_goal_versions` (`user_id`,`effective_from`,`revision`);--> statement-breakpoint
CREATE TABLE `health_sync_attempts` (
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`created_at` text NOT NULL,
	`channel` text NOT NULL,
	`device_label` text,
	`status` text NOT NULL,
	`batch_id` text,
	`error_code` text,
	`summary_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `attempt_id`)
);
--> statement-breakpoint
CREATE INDEX `health_sync_attempts_owner_created_idx` ON `health_sync_attempts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_copy_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`entry_ids_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nutrition_copy_operations_owner_created_idx` ON `nutrition_copy_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`portion` text NOT NULL,
	`note` text NOT NULL,
	`calories_tenth` integer,
	`creation_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `nutrition_favorites_owner_deleted_idx` ON `nutrition_favorites` (`user_id`,`deleted_at`);--> statement-breakpoint
ALTER TABLE `finance_runway_settings` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `health_goal_settings` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `health_weight_plan_settings` ADD `revision` integer DEFAULT 0 NOT NULL;