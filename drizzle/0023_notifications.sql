-- Message read states and delivery preferences contain no business record payloads.
CREATE TABLE notification_read_states (
  user_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(user_id, notification_id)
);
CREATE INDEX notification_read_states_owner_time_idx ON notification_read_states(user_id, read_at);
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  settings_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL
);
