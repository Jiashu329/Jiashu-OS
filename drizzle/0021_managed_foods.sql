CREATE TABLE managed_foods (
 id text PRIMARY KEY NOT NULL,
 replaces_id text,
 draft_json text NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 published_revision integer,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
 created_by text NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL
);
CREATE UNIQUE INDEX managed_foods_replaces_idx ON managed_foods(replaces_id);
CREATE INDEX managed_foods_status_idx ON managed_foods(status,updated_at);
CREATE TABLE managed_food_versions (
 item_id text NOT NULL REFERENCES managed_foods(id),
 revision integer NOT NULL,
 definition_json text NOT NULL,
 created_by text NOT NULL,
 created_at text NOT NULL,
 PRIMARY KEY(item_id,revision)
);
CREATE TABLE managed_food_operations (
 operation_id text PRIMARY KEY NOT NULL,
 actor_user_id text NOT NULL,
 item_id text NOT NULL,
 action text NOT NULL,
 request_hash text NOT NULL,
 result_json text NOT NULL,
 created_at text NOT NULL
);
CREATE TRIGGER managed_food_versions_no_update BEFORE UPDATE ON managed_food_versions BEGIN
 SELECT RAISE(ABORT,'Published food versions are immutable');
END;
CREATE TRIGGER managed_food_versions_no_delete BEFORE DELETE ON managed_food_versions BEGIN
 SELECT RAISE(ABORT,'Published food versions are immutable');
END;
