CREATE TABLE `health_goal_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`steps_target` integer,
	`sleep_target` real,
	`active_energy_target` real,
	`updated_at` text NOT NULL
);
