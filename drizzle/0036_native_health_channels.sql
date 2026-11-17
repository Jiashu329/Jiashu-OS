CREATE TABLE `native_health_channels` (
	`user_id` text PRIMARY KEY NOT NULL,
	`device_id` text,
	`last_device_id` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "native_health_channels_revision" CHECK(typeof("native_health_channels"."revision")='integer' AND "native_health_channels"."revision" BETWEEN 1 AND 9007199254740991)
);
