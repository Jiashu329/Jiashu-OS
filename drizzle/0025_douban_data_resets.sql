CREATE TABLE douban_data_resets (
  user_id TEXT PRIMARY KEY NOT NULL,
  data_epoch INTEGER NOT NULL,
  last_request_id TEXT NOT NULL,
  last_request_hash TEXT NOT NULL,
  last_receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT douban_data_resets_epoch CHECK (typeof(data_epoch)='integer' AND data_epoch BETWEEN 1 AND 9007199254740991)
);
