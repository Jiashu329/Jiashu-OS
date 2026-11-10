CREATE TABLE `nutrition_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`meal` text NOT NULL,
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
CREATE INDEX `nutrition_entries_owner_date_idx` ON `nutrition_entries` (`user_id`,`date`);