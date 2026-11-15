#!/usr/bin/env bash
# CI fixture only: exercise a genuine second image, database backup and restart.
set -Eeuo pipefail
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && ${SITES_MANAGED_LINUX_CONTAINER:-} != 1 ]] || { printf 'Docker upgrade acceptance runs only on GitHub Actions.\n' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { printf 'CI Docker upgrade acceptance requires sudo.\n' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$repository/deploy/aliyun/common.sh"
app_dir=/opt/jiashu-ci
original_bundle=${RUNNER_TEMP:?}/jiashu-ci-bundle
original_sha=${GITHUB_SHA:?}
validate_sha "$original_sha"; require_managed_dir "$app_dir"
[[ $(env_value "$app_dir/current.env" APP_COMMIT_SHA) == "$original_sha" ]] || die 'CI initial version is unexpected.'
base_tag="jiashu-test:$original_sha"
verify_loaded_image "$(env_value "$app_dir/current.env" APP_IMAGE)" "$original_sha"
fixture_sha=$(printf 'selfhost-ci-upgrade-only:%s\n' "$original_sha" | sha1sum | awk '{print $1}')
validate_sha "$fixture_sha"
[[ "$fixture_sha" != "$original_sha" ]] || die 'CI fixture must be a different version.'
fixture_tag="jiashu-test:$fixture_sha"
fixture_dir=$(mktemp -d "$RUNNER_TEMP/jiashu-upgrade.XXXXXXXX")
trap 'rm -rf -- "$fixture_dir"' EXIT
marker=$(python3 -c 'import secrets;print(secrets.token_hex(24))')
container=$(compose "$app_dir/current.env" ps -q app)
[[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || die 'CI initial container is not running.'
# Write using the actual application UID, with a committed SQLite WAL transaction.
docker exec -i "$container" node --input-type=module - "$marker" <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { statSync, writeFileSync } from 'node:fs';
assert.notEqual(process.getuid(), 0);
assert.equal(statSync('/data/app.sqlite3').uid, process.getuid());
const database = new DatabaseSync('/data/app.sqlite3');
assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
database.exec('CREATE TABLE __selfhost_ci_upgrade_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
database.prepare('INSERT INTO __selfhost_ci_upgrade_fixture VALUES (?, ?)').run('before-upgrade', process.argv[2]);
database.close();
writeFileSync('/data/ci-upgrade-marker.txt', process.argv[2], { mode: 0o600 });
JS
# Force the real clean-stop WAL case: there must be no auxiliary files before
# backup. A read-only bind mount cannot recreate them and failed in production.
compose "$app_dir/current.env" stop app
docker run --rm -i --network none --mount "type=bind,src=$app_dir/data,dst=/data" --entrypoint node "$base_tag" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
const database = new DatabaseSync('/data/app.sqlite3');
assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
database.close();
assert.equal(existsSync('/data/app.sqlite3-wal'), false);
assert.equal(existsSync('/data/app.sqlite3-shm'), false);
JS
# Negative control reproduces the previous production mount exactly. Writable
# destination + root still cannot open a clean WAL database on a read-only bind.
mkdir "$fixture_dir/readonly-backup"
if docker run --rm --network none --read-only --user 0:0 \
  --mount "type=bind,src=$app_dir/data,dst=/data,readonly" \
  --mount "type=bind,src=$fixture_dir/readonly-backup,dst=/backups" \
  --entrypoint node "$base_tag" selfhost/backup.ts \
  --database /data/app.sqlite3 --output /backups/readonly.sqlite3 >"$fixture_dir/readonly-backup.log" 2>&1; then
  die 'CI regression fixture did not reproduce the previous read-only WAL failure.'
fi
grep -q 'SQLite backup failed' "$fixture_dir/readonly-backup.log" || die 'CI negative control failed for an unexpected reason.'
[[ ! -e "$fixture_dir/readonly-backup/readonly.sqlite3" ]] || die 'CI negative control published a failed backup.'
# This synthetic revision changes only CI image metadata. It is never uploaded
# to ECS and deliberately cannot qualify as a checked GitHub production commit.
docker build --provenance=false --pull=false --build-arg "BASE_IMAGE=$base_tag" --build-arg "FIXTURE_SHA=$fixture_sha" -t "$fixture_tag" - <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG FIXTURE_SHA
LABEL org.opencontainers.image.revision="$FIXTURE_SHA" io.jiashu.ci.fixture="deployment-upgrade-only"
ENV APP_COMMIT_SHA="$FIXTURE_SHA"
DOCKERFILE
mkdir "$fixture_dir/bundle"
for file in "$original_bundle/"*; do
  [[ ${file##*/} == image.tar.gz ]] || cp -p "$file" "$fixture_dir/bundle/"
done
docker image save "$fixture_tag" | gzip -1 > "$fixture_dir/bundle/image.tar.gz"
fixture_image=$(docker image inspect --format '{{.Id}}' "$fixture_tag")
fixture_archive_sha=$(sha256sum "$fixture_dir/bundle/image.tar.gz" | awk '{print $1}')
python3 - "$fixture_dir/bundle/manifest.json" "$fixture_sha" "$fixture_image" "$fixture_archive_sha" <<'PY'
import json,sys
path,commit,image,archive=sys.argv[1:]
with open(path,'w',encoding='utf-8') as output:
    json.dump({'version':1,'commitSha':commit,'imageId':image,'archiveSha256':archive},output)
    output.write('\n')
PY
bash "$repository/deploy/aliyun/deploy.sh" --app-dir "$app_dir" --bundle "$fixture_dir/bundle"
[[ $(env_value "$app_dir/current.env" APP_COMMIT_SHA) == "$fixture_sha" ]] || die 'CI upgrade did not activate the second version.'
curl --fail --silent --max-time 10 'http://127.0.0.1:3100/_selfhost/healthz' | python3 -c 'import json,sys;v=json.load(sys.stdin);assert v["ok"] is True and v["commitSha"]==sys.argv[1]' "$fixture_sha"
container=$(compose "$app_dir/current.env" ps -q app)
# Data and file ownership survive the image change; new WAL/SHM must remain
# owned by the non-root application and allow subsequent business writes.
docker exec -i "$container" node --input-type=module - "$marker" <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
assert.notEqual(process.getuid(), 0);
assert.equal(statSync('/data/app.sqlite3').uid, process.getuid());
assert.equal(readFileSync('/data/ci-upgrade-marker.txt', 'utf8'), process.argv[2]);
const database = new DatabaseSync('/data/app.sqlite3');
assert.equal(database.prepare('SELECT value FROM __selfhost_ci_upgrade_fixture WHERE id=?').get('before-upgrade').value, process.argv[2]);
database.prepare('INSERT INTO __selfhost_ci_upgrade_fixture VALUES (?, ?)').run('after-upgrade', process.argv[2]);
for (const suffix of ['-wal', '-shm']) {
  const metadata = statSync('/data/app.sqlite3' + suffix);
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.gid, process.getgid());
}
database.close();
JS
mapfile -t backups < <(find "$app_dir/backups" -mindepth 1 -maxdepth 1 -type f -name '*.sqlite3' -print)
[[ ${#backups[@]} == 1 ]] || die 'CI upgrade must create exactly one consistent backup.'
[[ $(stat -c '%u:%a' "$app_dir/backups") == 0:700 && $(stat -c '%u:%a' "${backups[0]}") == 0:600 ]] || die 'CI backup is not private and owned by root.'
[[ -z $(find "$app_dir/backups" -mindepth 1 -maxdepth 1 -type d -print -quit) ]] || die 'CI backup staging was not removed.'
mkdir "$fixture_dir/restored"
cp "${backups[0]}" "$fixture_dir/restored/app.sqlite3"
# Read a restored copy on a read-only mount: it must be a standalone snapshot,
# include committed pre-upgrade data, and exclude later writes to the live DB.
docker run --rm -i --network none --read-only --user 0:0 --mount "type=bind,src=$fixture_dir/restored,dst=/restored,readonly" --entrypoint node "$fixture_tag" --input-type=module - "$marker" <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync('/restored/app.sqlite3', { readOnly: true });
assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
assert.equal(database.prepare('SELECT value FROM __selfhost_ci_upgrade_fixture WHERE id=?').get('before-upgrade').value, process.argv[2]);
assert.equal(database.prepare('SELECT value FROM __selfhost_ci_upgrade_fixture WHERE id=?').get('after-upgrade'), undefined);
database.close();
JS
printf 'CI second-version deployment, clean-WAL backup, restored data, permissions and readiness passed.\n'
