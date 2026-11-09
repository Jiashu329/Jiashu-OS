CREATE TABLE `sync_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_devices_user_revoked_idx` ON `sync_devices` (`user_id`,`revoked_at`);