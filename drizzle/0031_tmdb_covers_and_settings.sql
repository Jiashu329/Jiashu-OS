CREATE TABLE `tmdb_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`token_ciphertext` text,
	`token_iv` text,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_test_status` text,
	`last_test_at` text,
	CONSTRAINT "tmdb_settings_revision" CHECK(typeof("tmdb_settings"."revision")='integer' AND "tmdb_settings"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "tmdb_settings_token_pair" CHECK(("tmdb_settings"."token_ciphertext" IS NULL AND "tmdb_settings"."token_iv" IS NULL) OR ("tmdb_settings"."token_ciphertext" IS NOT NULL AND "tmdb_settings"."token_iv" IS NOT NULL)),
	CONSTRAINT "tmdb_settings_test_status" CHECK("tmdb_settings"."last_test_status" IS NULL OR "tmdb_settings"."last_test_status" IN ('success','failed'))
);
--> statement-breakpoint
ALTER TABLE `douban_items` ADD `tmdb_cover_json` text DEFAULT '{}' NOT NULL;