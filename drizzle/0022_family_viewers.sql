ALTER TABLE family_book_members ADD COLUMN role text NOT NULL DEFAULT 'editor' CHECK(role IN ('editor','viewer'));
--> statement-breakpoint
CREATE TABLE family_book_activity (
  id text PRIMARY KEY NOT NULL,
  book_id text NOT NULL REFERENCES family_books(id),
  actor_user_id text NOT NULL,
  actor_name text NOT NULL,
  action text NOT NULL,
  target_id text,
  target_name text,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX family_book_activity_book_created_idx ON family_book_activity(book_id,created_at,id);
