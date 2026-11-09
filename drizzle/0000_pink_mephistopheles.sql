CREATE TABLE `health_measurements` (
	`user_id` text NOT NULL,
	`record_key` text NOT NULL,
	`metric` text NOT NULL,
	`day` text NOT NULL,
	`measurement_json` text NOT NULL,
	`exported_at` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `record_key`)
);
--> statement-breakpoint
CREATE INDEX `health_measurements_user_day_idx` ON `health_measurements` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `health_syncs` (
	`user_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`exported_at` text NOT NULL,
	`received_at` text NOT NULL,
	`measurement_count` integer NOT NULL,
	PRIMARY KEY(`user_id`, `payload_hash`)
);
--> statement-breakpoint
CREATE INDEX `health_syncs_user_received_idx` ON `health_syncs` (`user_id`,`received_at`);