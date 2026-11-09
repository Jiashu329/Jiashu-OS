CREATE TABLE `health_weight_plan_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`baseline_weight` real NOT NULL,
	`target_weight` real NOT NULL,
	`start_date` text NOT NULL,
	`deadline` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
