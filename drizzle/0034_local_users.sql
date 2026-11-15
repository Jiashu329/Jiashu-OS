-- Local credentials are independent of business data and portable JSON backups.
CREATE TABLE `local_users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text COLLATE NOCASE NOT NULL,
  `password_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `revision` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_login_at` text,
  CONSTRAINT `local_users_status_check` CHECK (`status` IN ('active','disabled')),
  CONSTRAINT `local_users_revision_check` CHECK (typeof(`revision`)='integer' AND `revision` >= 1 AND `revision` <= 9007199254740991),
  CONSTRAINT `local_users_email_check` CHECK (length(`email`) BETWEEN 3 AND 254 AND `email`=lower(trim(`email`)) COLLATE BINARY),
  CONSTRAINT `local_users_hash_check` CHECK (length(`password_hash`) BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_users_email_unique` ON `local_users` (`email` COLLATE NOCASE);
