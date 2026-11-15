#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
app_dir=/opt/jiashu-test
bundle=$script_dir
public_origin=https://www.treefund.asia
bind_port=3100
confirmed=false
while (($#)); do
  case "$1" in
    --app-dir) app_dir=${2:?}; shift 2;;
    --bundle) bundle=${2:?}; shift 2;;
    --public-origin) public_origin=${2:?}; shift 2;;
    --port) bind_port=${2:?}; shift 2;;
    --confirm-empty-test-site) confirmed=true; shift;;
    *) die "Unknown bootstrap argument: $1";;
  esac
done
[[ "$confirmed" == true ]] || die 'Bootstrap requires --confirm-empty-test-site.'
[[ $(id -u) == 0 ]] || die 'Initial bootstrap requires root.'
validate_app_dir "$app_dir"; validate_origin "$public_origin"; validate_port "$bind_port"
require_command docker; require_command flock; require_command curl; require_command ss
docker info >/dev/null 2>&1 || die 'Docker is not available. Inspect the host and install a supported Docker/Compose before bootstrap.'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
bash "$script_dir/inspect.sh"
if [[ -e "$app_dir" && ! -f "$app_dir/.jiashu-selfhost" ]]; then
  [[ -d "$app_dir" && -z "$(find "$app_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die 'Existing nonempty directory is not managed by this application.'
fi
if [[ ! -f "$app_dir/.jiashu-selfhost" ]] && ss -H -lnt | awk '{print $4}' | grep -Eq ":${bind_port}$"; then
  die 'Requested loopback application port is already occupied. Existing services were not changed.'
fi
mkdir -p -- "$app_dir"
chmod 700 "$app_dir"
[[ ! -L "$app_dir/.deploy.lock" ]] || die 'Bootstrap lock cannot be a symlink.'
(
  flock -x 9
  if [[ -f "$app_dir/.jiashu-selfhost" ]]; then
    if [[ -e "$app_dir/app.env" ]]; then
      require_managed_dir "$app_dir"
    else
      # Resume only the marker/lock state left by failed image transport.
      # Partial credentials, data and unrelated contents require inspection.
      require_empty_bootstrap_state "$app_dir"
    fi
  else
    (umask 077; printf 'jiashu-selfhost-v1\n' > "$app_dir/.jiashu-selfhost")
  fi
  load_bundle "$bundle"
  mkdir -p "$app_dir/data" "$app_dir/backups" "$app_dir/releases"
  chmod 700 "$app_dir/data" "$app_dir/backups" "$app_dir/releases"
  runtime_uid=$(docker run --rm --network none --entrypoint node "$image_id" -p 'process.getuid()')
  runtime_gid=$(docker run --rm --network none --entrypoint node "$image_id" -p 'process.getgid()')
  [[ "$runtime_uid" =~ ^[0-9]+$ && "$runtime_gid" =~ ^[0-9]+$ ]] || die 'Cannot determine application image UID/GID.'
  chown "$runtime_uid:$runtime_gid" "$app_dir/data"
  docker run --rm --network none --read-only --user 0:0 \
    --mount "type=bind,src=$app_dir,dst=/bootstrap" \
    --mount "type=bind,src=$script_dir,dst=/bootstrap-tools,readonly" \
    -e "BOOTSTRAP_PUBLIC_ORIGIN=$public_origin" \
    --entrypoint node "$image_id" /bootstrap-tools/bootstrap-config.mjs
  install -m 700 "$script_dir/common.sh" "$app_dir/common.sh"
  install -m 700 "$script_dir/deploy.sh" "$app_dir/deploy.sh"
  install -m 600 "$script_dir/compose.yml" "$app_dir/compose.yml"
  printf 'Bootstrap configuration ready. Credentials remain in the private server initial-login file.\n'
) 9>"$app_dir/.deploy.lock"
# The deployment script takes its own lock; do not hold the bootstrap lock.
exec bash "$app_dir/deploy.sh" --app-dir "$app_dir" --bundle "$bundle" --port "$bind_port"
