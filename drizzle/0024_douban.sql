CREATE TABLE douban_connections (
  user_id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE douban_items (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('screen','book','music')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screen','movie','series','book','music')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  cover_url TEXT,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  marked_date TEXT,
  comment TEXT,
  published_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('collection','rss','import')),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_checked_run_id TEXT,
  PRIMARY KEY (user_id,profile_id,domain,subject_id),
  CHECK ((domain='screen' AND kind IN ('screen','movie','series')) OR domain=kind)
);
--> statement-breakpoint
CREATE INDEX douban_items_owner_date_idx ON douban_items (user_id,marked_date,observed_at);
--> statement-breakpoint
CREATE INDEX douban_items_owner_profile_kind_idx ON douban_items (user_id,profile_id,kind);
--> statement-breakpoint
CREATE TABLE douban_sync_runs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  state_json TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
  updated INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
  unchanged INTEGER NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (user_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX douban_runs_one_active_idx ON douban_sync_runs (user_id,connection_revision) WHERE status='running';
--> statement-breakpoint
CREATE INDEX douban_runs_owner_created_idx ON douban_sync_runs (user_id,created_at,id);
--> statement-breakpoint
CREATE TABLE douban_import_receipts (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id,request_id)
);
