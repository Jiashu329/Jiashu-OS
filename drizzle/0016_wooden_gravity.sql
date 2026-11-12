CREATE TABLE `nutrition_entry_history` (
	`user_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `entry_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `nutrition_history_owner_entry_idx` ON `nutrition_entry_history` (`user_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `nutrition_goal_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`calories_tenth` integer,
	`carbs_tenth` integer,
	`protein_tenth` integer,
	`fat_tenth` integer,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "nutrition_goals_calories_bounds" CHECK("nutrition_goal_settings"."calories_tenth" IS NULL OR (typeof("nutrition_goal_settings"."calories_tenth") = 'integer' AND "nutrition_goal_settings"."calories_tenth" BETWEEN 0 AND 200000)),
	CONSTRAINT "nutrition_goals_carbs_bounds" CHECK("nutrition_goal_settings"."carbs_tenth" IS NULL OR (typeof("nutrition_goal_settings"."carbs_tenth") = 'integer' AND "nutrition_goal_settings"."carbs_tenth" BETWEEN 0 AND 200000)),
	CONSTRAINT "nutrition_goals_protein_bounds" CHECK("nutrition_goal_settings"."protein_tenth" IS NULL OR (typeof("nutrition_goal_settings"."protein_tenth") = 'integer' AND "nutrition_goal_settings"."protein_tenth" BETWEEN 0 AND 200000)),
	CONSTRAINT "nutrition_goals_fat_bounds" CHECK("nutrition_goal_settings"."fat_tenth" IS NULL OR (typeof("nutrition_goal_settings"."fat_tenth") = 'integer' AND "nutrition_goal_settings"."fat_tenth" BETWEEN 0 AND 200000))
);
--> statement-breakpoint
CREATE TABLE `nutrition_restore_operations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`target_revision` integer NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
ALTER TABLE `finance_accounts` ADD `metadata_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_goal_plans` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `nutrition_entries` ADD `provenance_json` text;--> statement-breakpoint
-- Capture only new committed revisions. Idempotent replays do not mutate rows and produce no duplicate history.
INSERT INTO nutrition_entry_history(user_id,entry_id,revision,action,before_json,after_json,created_at)
SELECT n.user_id,n.id,n.revision,'baseline',NULL,json_object('id',n.id,'date',n.date,'meal',n.meal,'name',n.name,'portion',n.portion,'note',n.note,'caloriesTenth',n.calories_tenth,'carbsTenth',n.carbs_tenth,'proteinTenth',n.protein_tenth,'fatTenth',n.fat_tenth,'revision',n.revision,'createdAt',n.created_at,'updatedAt',n.updated_at,'deletedAt',n.deleted_at,'food',json(n.food_json),'provenance',json(n.provenance_json)),n.updated_at FROM nutrition_entries n;
--> statement-breakpoint
CREATE TRIGGER nutrition_history_insert AFTER INSERT ON nutrition_entries BEGIN
  INSERT OR IGNORE INTO nutrition_entry_history(user_id,entry_id,revision,action,before_json,after_json,created_at)
  VALUES(NEW.user_id,NEW.id,NEW.revision,'create',NULL,json_object('id',NEW.id,'date',NEW.date,'meal',NEW.meal,'name',NEW.name,'portion',NEW.portion,'note',NEW.note,'caloriesTenth',NEW.calories_tenth,'carbsTenth',NEW.carbs_tenth,'proteinTenth',NEW.protein_tenth,'fatTenth',NEW.fat_tenth,'revision',NEW.revision,'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at,'food',json(NEW.food_json),'provenance',json(NEW.provenance_json)),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER nutrition_history_update AFTER UPDATE ON nutrition_entries WHEN NEW.revision>OLD.revision BEGIN
  INSERT OR IGNORE INTO nutrition_entry_history(user_id,entry_id,revision,action,before_json,after_json,created_at)
  VALUES(NEW.user_id,NEW.id,NEW.revision,
    CASE WHEN EXISTS(SELECT 1 FROM nutrition_restore_operations r WHERE r.user_id=NEW.user_id AND r.entry_id=NEW.id AND r.target_revision=NEW.revision) THEN 'restore'
      WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'delete'
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'restore'
      ELSE 'edit' END,json_object('id',OLD.id,'date',OLD.date,'meal',OLD.meal,'name',OLD.name,'portion',OLD.portion,'note',OLD.note,'caloriesTenth',OLD.calories_tenth,'carbsTenth',OLD.carbs_tenth,'proteinTenth',OLD.protein_tenth,'fatTenth',OLD.fat_tenth,'revision',OLD.revision,'createdAt',OLD.created_at,'updatedAt',OLD.updated_at,'deletedAt',OLD.deleted_at,'food',json(OLD.food_json),'provenance',json(OLD.provenance_json)),json_object('id',NEW.id,'date',NEW.date,'meal',NEW.meal,'name',NEW.name,'portion',NEW.portion,'note',NEW.note,'caloriesTenth',NEW.calories_tenth,'carbsTenth',NEW.carbs_tenth,'proteinTenth',NEW.protein_tenth,'fatTenth',NEW.fat_tenth,'revision',NEW.revision,'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at,'food',json(NEW.food_json),'provenance',json(NEW.provenance_json)),NEW.updated_at);
END;
