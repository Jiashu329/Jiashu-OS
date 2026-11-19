CREATE TABLE `nutrition_recipe_cookings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`note` text NOT NULL,
	`photo_data_url` text,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "nutrition_recipe_cookings_archived_photo" CHECK("nutrition_recipe_cookings"."archived_at" IS NULL OR "nutrition_recipe_cookings"."photo_data_url" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `nutrition_recipe_cookings_owner_recipe_idx` ON `nutrition_recipe_cookings` (`user_id`,`recipe_id`,`archived_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_recipe_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`cooking_id` text,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "nutrition_recipe_operations_action" CHECK("nutrition_recipe_operations"."action" IN ('create','edit','archive','cook','edit-cooking','delete-cooking'))
);
--> statement-breakpoint
CREATE INDEX `nutrition_recipe_operations_owner_created_idx` ON `nutrition_recipe_operations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`source_key` text,
	`source_title` text,
	`source_author` text,
	`title` text NOT NULL,
	`note` text NOT NULL,
	`ingredients` text NOT NULL,
	`steps` text NOT NULL,
	`servings` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "nutrition_recipes_source" CHECK(("nutrition_recipes"."source" = 'own' AND "nutrition_recipes"."source_url" IS NULL AND "nutrition_recipes"."source_key" IS NULL AND "nutrition_recipes"."source_title" IS NULL AND "nutrition_recipes"."source_author" IS NULL) OR ("nutrition_recipes"."source" IN ('xiaohongshu','xiachufang') AND "nutrition_recipes"."source_url" IS NOT NULL AND "nutrition_recipes"."source_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `nutrition_recipes_owner_archive_updated_idx` ON `nutrition_recipes` (`user_id`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_recipes_owner_source_idx` ON `nutrition_recipes` (`user_id`,`source_key`) WHERE "nutrition_recipes"."archived_at" IS NULL AND "nutrition_recipes"."source_key" IS NOT NULL;