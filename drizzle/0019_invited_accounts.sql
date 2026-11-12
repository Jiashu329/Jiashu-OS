CREATE TABLE `app_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`bound_user_id` text,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_access_grants_email_unique` ON `app_access_grants` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_access_grants_bound_user_id_unique` ON `app_access_grants` (`bound_user_id`);--> statement-breakpoint
CREATE TABLE `app_access_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_owner_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "app_owner_identity_singleton" CHECK("app_owner_identity"."id" = 'owner')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_owner_identity_user_id_unique` ON `app_owner_identity` (`user_id`);