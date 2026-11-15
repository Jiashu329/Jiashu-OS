ALTER TABLE douban_items ADD COLUMN local_note TEXT NOT NULL DEFAULT '';
ALTER TABLE douban_items ADD COLUMN local_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE douban_items ADD COLUMN local_hidden INTEGER NOT NULL DEFAULT 0 CHECK (local_hidden IN (0,1));
ALTER TABLE douban_items ADD COLUMN local_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(local_revision)='integer' AND local_revision BETWEEN 0 AND 9007199254740991);
CREATE INDEX douban_items_owner_hidden_idx ON douban_items(user_id,local_hidden,marked_date);
