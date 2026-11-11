CREATE TABLE `ai_user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`key_ciphertext` text,
	`key_iv` text,
	`model` text NOT NULL,
	`region` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_test_status` text,
	`last_test_at` text
);
