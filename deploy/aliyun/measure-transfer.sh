#!/usr/bin/env bash
# Bounded diagnostic: transfer two 256 KiB random files, never execute a payload.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
require_command timeout; require_command python3
config=$(bash "$script_dir/ssh-config.sh")
local_dir=$(mktemp -d "$RUNNER_TEMP/jiashu-transport.XXXXXXXX")
remote_dir=''
cleanup() {
  [[ -z "$remote_dir" ]] || ssh -T -F "$config" jiashu-aliyun "rm -rf -- '$remote_dir'" >/dev/null 2>&1 || true
  rm -rf -- "$local_dir"
}
trap cleanup EXIT
candidate_dir=$(ssh -T -F "$config" jiashu-aliyun 'umask 077; mktemp -d /tmp/jiashu-transport.XXXXXXXX')
[[ "$candidate_dir" =~ ^/tmp/jiashu-transport\.[A-Za-z0-9]+$ ]] || die 'Unexpected transfer diagnostic directory.'
remote_dir=$candidate_dir
dd if=/dev/urandom of="$local_dir/payload.bin" bs=262144 count=1 status=none
expected_hash=$(sha256sum "$local_dir/payload.bin" | awk '{print $1}')
for qos in none cs1; do
  start=$(date +%s%N)
  status=0
  timeout 45s scp -q -o "IPQoS=$qos" -F "$config" "$local_dir/payload.bin" "jiashu-aliyun:$remote_dir/payload-$qos.bin" 2>"$local_dir/scp-error" || status=$?
  end=$(date +%s%N)
  if [[ "$status" == 0 ]]; then
    actual_hash=$(ssh -T -F "$config" jiashu-aliyun "sha256sum '$remote_dir/payload-$qos.bin'" | awk '{print $1}')
    [[ "$actual_hash" == "$expected_hash" ]] || die 'Transfer diagnostic checksum mismatch.'
  fi
  python3 - "$qos" "$start" "$end" "$status" <<'PY'
import json,sys
qos,start,end,status=sys.argv[1:]
seconds=(int(end)-int(start))/1e9
code=int(status)
print(json.dumps({'transport':'scp','ipQos':qos,'bytes':262144,'elapsedSeconds':round(seconds,3),
                  'kibPerSecond':round(256/seconds,2) if code == 0 else None,
                  'ok':code == 0,'exitCode':code},separators=(',',':')))
PY
done
