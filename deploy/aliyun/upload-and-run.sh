#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
operation=${1:?Expected bootstrap or deploy}; bundle=${2:?Expected release bundle}
[[ "$operation" == bootstrap || "$operation" == deploy ]] || die 'Unsupported remote operation.'
app_dir=${ALIYUN_DEPLOY_PATH:-/opt/jiashu-test}
public_origin=${ALIYUN_PUBLIC_ORIGIN:-https://www.treefund.asia}
bind_port=${ALIYUN_BIND_PORT:-3100}
validate_app_dir "$app_dir"; validate_origin "$public_origin"; validate_port "$bind_port"
config=$(bash "$script_dir/ssh-config.sh")
remote_dir=$(ssh -T -F "$config" jiashu-aliyun 'umask 077; mktemp -d /tmp/jiashu-release.XXXXXXXX')
[[ "$remote_dir" =~ ^/tmp/jiashu-release\.[A-Za-z0-9]+$ ]] || die 'Unexpected remote upload directory.'
cleanup() { ssh -T -F "$config" jiashu-aliyun "rm -rf -- '$remote_dir'" >/dev/null 2>&1 || true; }
trap cleanup EXIT
scp -F "$config" -r "$bundle/." "jiashu-aliyun:$remote_dir/"
# Uploading a large image can take minutes. Revalidate after it, before executing.
gate_output=$(mktemp "$RUNNER_TEMP/jiashu-final-gate.XXXXXXXX")
GITHUB_OUTPUT="$gate_output" node "$script_dir/check-ci.mjs"
if ! grep -qx 'ready=true' "$gate_output"; then
  rm -f "$gate_output"
  printf 'Uploaded bundle was not executed: source/checks/deployment setting changed during upload.\n'
  exit 0
fi
rm -f "$gate_output"
arguments=(bash "$remote_dir/$operation.sh" --app-dir "$app_dir" --bundle "$remote_dir" --port "$bind_port")
if [[ "$operation" == bootstrap ]]; then arguments+=(--public-origin "$public_origin" --confirm-empty-test-site); fi
printf -v remote_command '%q ' "${arguments[@]}"
ssh -T -F "$config" jiashu-aliyun "$remote_command"
