#!/usr/bin/env bash
# One-time owner data transfer. Source rows and credentials never reach stdout.
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
app_dir=/opt/jiashu-test
phase=${1:-}
expected_sha=${2:-}
expected_plan=${3:-}
case "$phase" in prepare|fetch-plan|apply|verify|cleanup) ;; *) die 'Unsupported owner migration phase.';; esac
validate_sha "$expected_sha"
if [[ "$phase" == apply ]]; then [[ "$expected_plan" =~ ^[a-f0-9]{64}$ ]] || die 'Apply requires the reviewed plan hash.'; fi
require_managed_dir "$app_dir"
require_command docker; require_command flock; require_command sha256sum
exec 9>"$app_dir/.deploy.lock"
flock -x 9
current_env="$app_dir/current.env"
[[ -f "$current_env" && ! -L "$current_env" ]] || die 'Current release is unavailable.'
image_id=$(env_value "$current_env" APP_IMAGE)
current_sha=$(env_value "$current_env" APP_COMMIT_SHA)
bind_port=$(env_value "$current_env" APP_BIND_PORT)
validate_image_id "$image_id"; validate_sha "$current_sha"; validate_port "$bind_port"
[[ "$current_sha" == "$expected_sha" ]] || die 'Running release changed; review the target again.'
verify_loaded_image "$image_id" "$current_sha"
identity=$(docker run --rm --network none --read-only --entrypoint node "$image_id" -p 'process.getuid() + ":" + process.getgid()')
[[ "$identity" == '10001:10001' ]] || die 'Unexpected application identity.'
[[ $(stat -c '%u:%g' "$app_dir/data/app.sqlite3") == "$identity" && ! -L "$app_dir/data/app.sqlite3" ]] || die 'Unexpected database ownership.'
migration_dir="$app_dir/data-migrations/jiashu-owner-20261116-v1"
work="$migration_dir/work"
[[ ! -L "$app_dir/data-migrations" && ! -L "$migration_dir" && ! -L "$work" ]] || die 'Unsafe migration directory.'
install -d -m 700 "$app_dir/data-migrations" "$migration_dir"
if [[ ! -d "$work" ]]; then install -d -o 10001 -g 10001 -m 700 "$work"; fi
[[ $(stat -c '%u:%g:%a' "$work") == '10001:10001:700' ]] || die 'Migration staging has unexpected permissions.'
# Only nonsecret source files are mounted here. The outer SSH temp directory is
# private on the host; the helper container needs its mounted directory readable.
chmod 755 "$script_dir"
chmod 644 "$script_dir/owner-migration-worker.mjs"
if [[ -f "$script_dir/owner-migration-import.ts" ]]; then chmod 644 "$script_dir/owner-migration-import.ts"; fi
worker() {
  compose "$current_env" run --rm --no-deps -T --entrypoint node \
    -v "$work:/migration" -v "$script_dir:/migration-code:ro" app \
    /migration-code/owner-migration-worker.mjs "$@"
}
wait_ready "$bind_port" "$current_sha" || die 'Target is not ready before migration.'
if [[ "$phase" != apply ]]; then worker "$phase"; exit 0; fi
if [[ -f "$migration_dir/applied-receipt.json" ]]; then
  python3 - "$migration_dir/applied-receipt.json" "$expected_plan" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: value=json.load(f)
if value.get('planHash') != sys.argv[2]: raise SystemExit('A different owner migration is already applied.')
print('{"ok":true,"alreadyApplied":true}')
PY
  worker verify
  exit 0
fi
stopped=false
committed=false
on_error() {
  local status=$?
  [[ "$status" == 0 ]] && return 0
  trap - EXIT ERR HUP INT TERM
  set +e
  if [[ "$stopped" == true && "$committed" == false ]]; then
    compose "$current_env" up -d --no-deps app >/dev/null
    wait_ready "$bind_port" "$current_sha" >/dev/null
    printf 'Migration stopped before cutover; the original database remains active.\n' >&2
  elif [[ "$committed" == true ]]; then
    compose "$current_env" stop app >/dev/null 2>&1
    printf 'Post-cutover verification failed. New data and the private pre-import backup were retained for forward repair.\n' >&2
  fi
  exit "$status"
}
trap on_error EXIT
trap 'exit 130' HUP INT TERM
compose "$current_env" stop app
stopped=true
backup_stage=$(mktemp -d "$work/.backup.XXXXXXXX")
chown "$identity" "$backup_stage"
chmod 700 "$backup_stage"
backup_name="pre-import-$(date -u +%Y%m%dT%H%M%SZ)-${backup_stage##*.}.sqlite3"
compose "$current_env" run --rm --no-deps -T --entrypoint node -v "$work:/migration" app \
  /app/selfhost/backup.ts --database /data/app.sqlite3 --output "/migration/${backup_stage##*/}/backup.sqlite3"
mv -- "$backup_stage/backup.sqlite3" "$migration_dir/$backup_name"
rmdir -- "$backup_stage"
chown 0:0 "$migration_dir/$backup_name"
chmod 600 "$migration_dir/$backup_name"
backup_sha=$(sha256sum "$migration_dir/$backup_name" | awk '{print $1}')
backup_bytes=$(stat -c '%s' "$migration_dir/$backup_name")
python3 - "$work/backup-receipt.json" "$backup_name" "$backup_sha" "$backup_bytes" <<'PY'
import json,os,sys
path=sys.argv[1]
descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
with os.fdopen(descriptor,'w') as target: json.dump({'file':sys.argv[2],'sha256':sys.argv[3],'bytes':int(sys.argv[4])},target)
os.chown(path,10001,10001)
os.chmod(path,0o600)
PY
worker apply-candidate "$expected_plan"
[[ -f "$work/candidate.sqlite3" && ! -L "$work/candidate.sqlite3" && $(stat -c '%u:%g' "$work/candidate.sqlite3") == "$identity" ]] || die 'Invalid migration candidate.'
[[ $(stat -c '%d' "$work/candidate.sqlite3") == $(stat -c '%d' "$app_dir/data") ]] || die 'Candidate and data must share a filesystem for atomic cutover.'
# No app connections remain. Ensure old WAL pages are checkpointed before the
# new single-file candidate takes this basename; never attach an old WAL to it.
compose "$current_env" run --rm --no-deps -T --entrypoint node app --input-type=module -e '
  import {DatabaseSync} from "node:sqlite";
  const db=new DatabaseSync("/data/app.sqlite3",{allowExtension:false});
  try{db.exec("PRAGMA busy_timeout=5000");const row=db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();if(row.busy!==0)throw new Error();db.exec("PRAGMA journal_mode=DELETE");}finally{db.close();}
 '
[[ ! -e "$app_dir/data/app.sqlite3-wal" && ! -e "$app_dir/data/app.sqlite3-shm" ]] || die 'Old SQLite sidecars are still in use.'
mv -f -- "$work/candidate.sqlite3" "$app_dir/data/app.sqlite3"
committed=true
compose "$current_env" up -d --no-deps app
wait_ready "$bind_port" "$current_sha"
worker verify
install -m 600 "$work/candidate-receipt.json" "$migration_dir/applied-receipt.json"
trap - EXIT ERR HUP INT TERM
printf 'Owner data migration committed and verified.\n'
