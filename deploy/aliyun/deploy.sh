#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
app_dir=/opt/jiashu-test
bundle=$script_dir
bind_port=3100
while (($#)); do
  case "$1" in
    --app-dir) app_dir=${2:?}; shift 2;;
    --bundle) bundle=${2:?}; shift 2;;
    --port) bind_port=${2:?}; shift 2;;
    *) die "Unknown deployment argument: $1";;
  esac
done
require_managed_dir "$app_dir"; validate_port "$bind_port"
require_command docker; require_command flock; require_command curl
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
exec 9>"$app_dir/.deploy.lock"
flock -x 9
load_bundle "$bundle"
current_env="$app_dir/current.env"
previous_image=''; previous_sha=''; previous_port=''
if [[ -f "$current_env" ]]; then
  previous_image=$(env_value "$current_env" APP_IMAGE)
  previous_sha=$(env_value "$current_env" APP_COMMIT_SHA)
  previous_port=$(env_value "$current_env" APP_BIND_PORT)
  validate_image_id "$previous_image"; validate_sha "$previous_sha"; validate_port "$previous_port"
  if [[ "$previous_image" == "$image_id" && "$previous_sha" == "$commit_sha" ]] && wait_ready "$previous_port" "$previous_sha"; then
    printf 'Already deployed and ready: %s\n' "$commit_sha"
    exit 0
  fi
fi
release_dir="$app_dir/releases/$commit_sha"
mkdir -p "$release_dir"
chmod 700 "$release_dir"
candidate_env="$release_dir/release.env"
candidate_compose="$app_dir/.compose.candidate.yml"
write_release_env "$candidate_env" "$image_id" "$commit_sha" "$bind_port"
install -m 600 "$bundle/compose.yml" "$candidate_compose"
docker compose --project-directory "$app_dir" --project-name jiashu-test --env-file "$candidate_env" -f "$candidate_compose" config --quiet
if [[ -f "$current_env" ]]; then
  cp -p "$current_env" "$release_dir/previous.env"
  cp -p "$app_dir/compose.yml" "$release_dir/previous-compose.yml"
fi
phase=before-migrations
migrations_changed=true
backup_staging=''
finish_on_error() {
  local status=$?
  trap - ERR HUP INT TERM
  set +e
  if [[ -n ${backup_staging:-} && "$backup_staging" == "$app_dir/backups/.staging."* && -d "$backup_staging" && ! -L "$backup_staging" ]]; then
    rm -rf -- "$backup_staging"
  fi
  if [[ -n "$previous_image" ]] && { [[ "$phase" == before-migrations ]] || [[ "$migrations_changed" == false ]]; }; then
    cp -p "$release_dir/previous-compose.yml" "$app_dir/compose.yml"
    cp -p "$release_dir/previous.env" "$current_env"
    compose "$current_env" up -d --no-deps app
    image_id=$previous_image
    if wait_ready "$previous_port" "$previous_sha"; then
      printf 'Deployment failed; previous compatible application image restored: %s\n' "$previous_sha" >&2
    else printf 'Deployment and previous-image readiness failed. Inspect server logs privately.\n' >&2; fi
  else
    [[ -f "$candidate_env" ]] && compose "$candidate_env" stop app >/dev/null 2>&1
    printf 'Deployment failed after a possible schema change. Database was not restored or downgraded; forward repair is required.\n' >&2
  fi
  exit "$status"
}
trap finish_on_error ERR
trap 'false' HUP INT TERM
if [[ -f "$current_env" ]]; then compose "$current_env" stop app; fi
if [[ -f "$app_dir/data/app.sqlite3" ]]; then
  if [[ -L "$app_dir/data/app.sqlite3" ]]; then printf 'Database backup source must be a regular application file.\n' >&2; false; fi
  backup_identity=$(docker run --rm --network none --read-only --entrypoint node "$image_id" -p 'process.getuid() + ":" + process.getgid()')
  if [[ ! "$backup_identity" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then printf 'Backup requires a verified non-root application UID/GID.\n' >&2; false; fi
  if [[ $(stat -c '%u:%g' "$app_dir/data/app.sqlite3") != "$backup_identity" ]]; then printf 'Database ownership does not match the application image; it was not changed.\n' >&2; false; fi
  backup_staging=$(mktemp -d "$app_dir/backups/.staging.XXXXXXXX")
  chown "$backup_identity" "$backup_staging"
  chmod 700 "$backup_staging"
  backup_name="$(date -u +%Y%m%dT%H%M%SZ)-${previous_sha:-initial}-${backup_staging##*.}.sqlite3"
  # The SQLite source connection remains readOnly:true. Its directory must be
  # writable for WAL/SHM creation after a clean stop removed those sidecars.
  # Run as the application owner so rollback can reopen any surviving sidecars.
  docker run --rm --network none --read-only --user "$backup_identity" \
    --mount "type=bind,src=$app_dir/data,dst=/data" \
    --mount "type=bind,src=$backup_staging,dst=/backups" \
    --entrypoint node "$image_id" selfhost/backup.ts \
      --database /data/app.sqlite3 --output "/backups/$backup_name"
  if [[ ! -f "$backup_staging/$backup_name" || -L "$backup_staging/$backup_name" ]]; then printf 'Backup did not produce a regular recovery file.\n' >&2; false; fi
  ln -- "$backup_staging/$backup_name" "$app_dir/backups/$backup_name"
  chown 0:0 "$app_dir/backups/$backup_name"
  chmod 600 "$app_dir/backups/$backup_name"
  rm -- "$backup_staging/$backup_name"
  rmdir -- "$backup_staging"
  backup_staging=''
fi
install -m 600 "$candidate_compose" "$app_dir/compose.yml"
phase=migrating
compose "$candidate_env" run --rm --no-deps --entrypoint node app selfhost/migrations.ts migrate \
  --database /data/app.sqlite3 --directory /app/drizzle > "$release_dir/migrations.json"
migrations_changed=$(python3 - "$release_dir/migrations.json" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as handle: value=json.load(handle)
names=value.get('appliedMigrationNames'); changed=value.get('changed')
if value.get('schemaReady') is not True or value.get('pending') != 0: raise ValueError('Schema is not ready')
if not isinstance(names,list) or any(not isinstance(name,str) for name in names): raise ValueError('Missing appliedMigrationNames array')
if not isinstance(changed,int) or isinstance(changed,bool) or changed < 0 or len(names) != changed: raise ValueError('Invalid migration change count')
print('true' if changed else 'false')
PY
)
phase=migrated
compose "$candidate_env" up -d --no-deps app
wait_ready "$bind_port" "$commit_sha"
cp -p "$candidate_env" "$app_dir/.current.env.next"
mv -f "$app_dir/.current.env.next" "$current_env"
cp -p "$candidate_compose" "$release_dir/compose.yml"
install -m 700 "$bundle/common.sh" "$app_dir/common.sh"
install -m 700 "$bundle/deploy.sh" "$app_dir/deploy.sh"
trap - ERR
printf 'Deployed and ready: %s (loopback port %s)\n' "$commit_sha" "$bind_port"
printf 'Existing web server, ports 80/443, server environment and database were not replaced.\n'
