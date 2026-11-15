-- Keep historical `import` provenance intact: it includes private files and
-- older browser versions. Only new explicit browser snapshots use `browser`.
CREATE TABLE douban_items_browser_source (
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
  source TEXT NOT NULL CHECK (source IN ('collection','rss','import','browser')),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_checked_run_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id,profile_id,domain,subject_id),
  CHECK ((domain='screen' AND kind IN ('screen','movie','series')) OR domain=kind)
);
--> statement-breakpoint
INSERT INTO douban_items_browser_source
  (user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,
   observed_at,created_at,updated_at,metadata_checked_run_id,details_json)
SELECT user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,marked_date,comment,published_at,source,
  observed_at,created_at,updated_at,metadata_checked_run_id,details_json FROM douban_items;
--> statement-breakpoint
DROP TABLE douban_items;
--> statement-breakpoint
ALTER TABLE douban_items_browser_source RENAME TO douban_items;
--> statement-breakpoint
CREATE INDEX douban_items_owner_date_idx ON douban_items (user_id,marked_date,observed_at);
--> statement-breakpoint
CREATE INDEX douban_items_owner_profile_kind_idx ON douban_items (user_id,profile_id,kind);
