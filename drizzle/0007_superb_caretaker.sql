CREATE TABLE `health_record_changes` (
	`user_id` text NOT NULL,
	`change_id` text NOT NULL,
	`record_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`action` text NOT NULL,
	`target_revision` integer NOT NULL,
	`before_state_json` text,
	`after_state_json` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `change_id`)
);
--> statement-breakpoint
CREATE INDEX `health_record_changes_owner_record_idx` ON `health_record_changes` (`user_id`,`record_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `health_record_overrides` (
	`user_id` text NOT NULL,
	`record_key` text NOT NULL,
	`metric` text NOT NULL,
	`day` text NOT NULL,
	`override_json` text,
	`deleted` integer NOT NULL,
	`revision` integer NOT NULL,
	`last_change_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `record_key`)
);
--> statement-breakpoint
CREATE INDEX `health_record_overrides_owner_day_idx` ON `health_record_overrides` (`user_id`,`day`);