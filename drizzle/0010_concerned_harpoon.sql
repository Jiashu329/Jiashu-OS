CREATE TABLE `ai_usage_limits` (
	`user_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`day_count` integer NOT NULL,
	`minute` integer NOT NULL,
	`minute_count` integer NOT NULL
);
