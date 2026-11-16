-- Authentication metadata only. Business records and existing sessions are unchanged.
CREATE TABLE `local_session_revocations` (
  `family_hash` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL,
  CONSTRAINT `local_session_revocations_hash_check` CHECK (typeof(`family_hash`)='text' AND length(CAST(`family_hash` AS BLOB))=64 AND `family_hash` NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT `local_session_revocations_expiry_check` CHECK (typeof(`expires_at`)='integer' AND `expires_at` >= 0 AND `expires_at` <= 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `local_session_revocations_expiry_idx` ON `local_session_revocations` (`expires_at`);
