#!/bin/sh
set -eu
node selfhost/migrations.ts migrate --database "$SELFHOST_DB_PATH" --directory /app/drizzle
exec node selfhost/server.mjs
