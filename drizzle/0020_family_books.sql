CREATE TABLE `family_book_member_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `family_books`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `family_book_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `family_book_members` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `family_books`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "family_members_status" CHECK("family_book_members"."status" IN ('pending','active','revoked','declined')),
	CONSTRAINT "family_members_revision" CHECK("family_book_members"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `family_members_book_email_idx` ON `family_book_members` (`book_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `family_members_book_user_idx` ON `family_book_members` (`book_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `family_members_user_status_idx` ON `family_book_members` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `family_members_email_status_idx` ON `family_book_members` (`email`,`status`);--> statement-breakpoint
CREATE TABLE `family_books` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`owner_name` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `family_books_owner_user_id_unique` ON `family_books` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `family_finance_commands` (
	`book_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`actor_email` text NOT NULL,
	`membership_id` text,
	`access_revision` integer NOT NULL,
	`request_hash` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`book_id`, `operation_id`),
	FOREIGN KEY (`book_id`) REFERENCES `family_books`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `family_finance_commands_actor_idx` ON `family_finance_commands` (`actor_user_id`,`created_at`);