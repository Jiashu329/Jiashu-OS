CREATE TABLE `health_apple_vitals` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`value_json` text NOT NULL,
	`exported_at` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `metric`),
	CONSTRAINT "health_apple_vitals_metric" CHECK("health_apple_vitals"."metric" IN ('heartRate','restingHeartRate','oxygenSaturation'))
);
--> statement-breakpoint
CREATE TABLE `health_apple_workouts` (
	`user_id` text NOT NULL,
	`workout_id` text NOT NULL,
	`day` text NOT NULL,
	`start_date` text NOT NULL,
	`workout_json` text NOT NULL,
	`exported_at` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `workout_id`)
);
--> statement-breakpoint
CREATE INDEX `health_apple_workouts_owner_day_idx` ON `health_apple_workouts` (`user_id`,`day`,`start_date`);