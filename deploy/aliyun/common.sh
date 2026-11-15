#!/usr/bin/env bash
# Shared validation. These scripts manage only their marked application directory.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"; }
validate_app_dir() {
  [[ "$1" =~ ^/(opt|srv)/[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die 'Application directory must be beneath /opt or /srv.'
  [[ "$1" != *'/..'* && "$1" != *'//'* && "$1" != */ ]] || die 'Unsafe application directory.'
  [[ ! -L "$1" ]] || die 'Application directory cannot be a symlink.'
}
validate_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]] || die 'Expected a full Git commit SHA.'; }
validate_image_id() { [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Expected an immutable Docker image ID.'; }
validate_port() { [[ "$1" =~ ^[0-9]{2,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 )) || die 'Application port must be 1024..65535.'; }
validate_origin() { [[ "$1" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]] || die 'Public origin must be an HTTPS origin without a path.'; }
require_managed_dir() {
  validate_app_dir "$1"
  [[ -f "$1/.jiashu-selfhost" ]] && [[ "$(cat "$1/.jiashu-selfhost")" == 'jiashu-selfhost-v1' ]] || die 'Unrecognized directory; refusing to adopt or replace existing services.'
  [[ -f "$1/app.env" && ! -L "$1/app.env" ]] || die 'Server app.env is missing or unsafe. Run bootstrap first.'
}
compose() { docker compose --project-directory "$app_dir" --project-name jiashu-test --env-file "$1" -f "$app_dir/compose.yml" "${@:2}"; }
write_release_env() {
  local output=$1 image=$2 commit=$3 port=$4
  validate_image_id "$image"; validate_sha "$commit"; validate_port "$port"
  (umask 077; printf 'APP_IMAGE=%s\nAPP_COMMIT_SHA=%s\nAPP_BIND_PORT=%s\n' "$image" "$commit" "$port" > "$output")
}
env_value() {
  # Read a single non-secret release field; never source server app.env.
  local file=$1 name=$2
  [[ "$name" =~ ^(APP_IMAGE|APP_COMMIT_SHA|APP_BIND_PORT)$ ]] || die 'Unsupported release field.'
  sed -n "s/^${name}=//p" "$file" | head -1
}
verify_loaded_image() {
  local image=$1 commit=$2 actual
  validate_image_id "$image"; validate_sha "$commit"
  actual=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  [[ "$actual" == "$commit" ]] || die 'Image revision label does not match its verified commit.'
}
wait_ready() {
  local port=$1 commit=$2 attempt
  for attempt in {1..30}; do
    if curl --silent --show-error --fail --max-time 3 "http://127.0.0.1:${port}/_selfhost/healthz" 2>/dev/null |
      docker run --rm -i --network none --entrypoint node "$image_id" --input-type=module -e '
        let text="";for await(const part of process.stdin)text+=part;
        try{const data=JSON.parse(text);process.exit(data.ok===true&&data.commitSha===process.argv[1]?0:1);}catch{process.exit(1);}
      ' "$commit"; then return 0; fi
    sleep 2
  done
  return 1
}
load_bundle() {
  local directory=$1 manifest_values actual_hash
  require_command python3; require_command sha256sum
  [[ -f "$directory/manifest.json" && -f "$directory/image.tar.gz" ]] || die 'Release bundle is incomplete.'
  manifest_values=$(python3 - "$directory/manifest.json" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as handle: value=json.load(handle)
if set(value)!={'version','commitSha','imageId','archiveSha256'} or value['version']!=1: raise ValueError('Invalid release manifest')
for key in ('commitSha','imageId','archiveSha256'):
    text=value[key]
    if not isinstance(text,str) or '\n' in text or '\r' in text: raise ValueError('Invalid release field')
    print(text)
PY
  ) || die 'Release manifest could not be read.'
  mapfile -t release_fields <<< "$manifest_values"
  [[ ${#release_fields[@]} == 3 ]] || die 'Invalid release fields.'
  commit_sha=${release_fields[0]}; image_id=${release_fields[1]}
  validate_sha "$commit_sha"; validate_image_id "$image_id"
  [[ ${release_fields[2]} =~ ^[a-f0-9]{64}$ ]] || die 'Invalid archive checksum.'
  actual_hash=$(sha256sum "$directory/image.tar.gz" | awk '{print $1}')
  [[ "$actual_hash" == "${release_fields[2]}" ]] || die 'Release archive checksum mismatch.'
  docker image load --input "$directory/image.tar.gz" >/dev/null
  verify_loaded_image "$image_id" "$commit_sha"
}
