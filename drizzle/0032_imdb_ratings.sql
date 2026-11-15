CREATE TABLE `douban_imdb_ratings_receipts` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`write_token` text NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `request_id`)
);
--> statement-breakpoint
CREATE TABLE `imdb_ratings_cache` (
	`imdb_id` text PRIMARY KEY NOT NULL,
	`rating_json` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `imdb_ratings_refresh_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `douban_items` ADD `tmdb_cover_url` text;--> statement-breakpoint
ALTER TABLE `douban_items` ADD `imdb_rating_json` text DEFAULT '{}' NOT NULL;