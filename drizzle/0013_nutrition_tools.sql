CREATE TABLE `nutrition_batches` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`request_hash` text NOT NULL,
	`entry_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `nutrition_day_status` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`complete` integer NOT NULL,
	`meals_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `nutrition_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`template_hash` text NOT NULL,
	`template_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_favorites_owner_hash_idx` ON `nutrition_favorites` (`user_id`,`template_hash`);--> statement-breakpoint
ALTER TABLE `nutrition_entries` ADD `food_json` text;
--> statement-breakpoint
CREATE TRIGGER nutrition_entry_insert_status AFTER INSERT ON nutrition_entries
BEGIN
  INSERT INTO nutrition_day_status (user_id,date,complete,meals_json,revision,updated_at)
    VALUES (NEW.user_id,NEW.date,0,'{}',1,NEW.updated_at)
    ON CONFLICT(user_id,date) DO UPDATE SET complete=0,revision=revision+1,updated_at=NEW.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER nutrition_entry_update_status AFTER UPDATE ON nutrition_entries
BEGIN
  INSERT INTO nutrition_day_status (user_id,date,complete,meals_json,revision,updated_at)
    VALUES (OLD.user_id,OLD.date,0,'{}',1,NEW.updated_at)
    ON CONFLICT(user_id,date) DO UPDATE SET complete=0,revision=revision+1,updated_at=NEW.updated_at;
  INSERT INTO nutrition_day_status (user_id,date,complete,meals_json,revision,updated_at)
    SELECT NEW.user_id,NEW.date,0,'{}',1,NEW.updated_at WHERE NEW.date<>OLD.date
    ON CONFLICT(user_id,date) DO UPDATE SET complete=0,revision=revision+1,updated_at=NEW.updated_at;
END;
