#!/usr/bin/env bash
set -euo pipefail
[[ ${ALIYUN_HOST:-} =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { printf 'Invalid ALIYUN_HOST.\n' >&2; exit 1; }
[[ ${ALIYUN_USER:-} =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { printf 'Invalid ALIYUN_USER.\n' >&2; exit 1; }
port=${ALIYUN_SSH_PORT:-22}
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port>=1 && 10#$port<=65535)) || { printf 'Invalid SSH port.\n' >&2; exit 1; }
[[ -n ${ALIYUN_SSH_KEY:-} && -n ${ALIYUN_KNOWN_HOSTS:-} && -n ${RUNNER_TEMP:-} ]] || { printf 'Required SSH secrets are missing.\n' >&2; exit 1; }
umask 077
key="$RUNNER_TEMP/jiashu-deploy-key"
known="$RUNNER_TEMP/jiashu-known-hosts"
config="$RUNNER_TEMP/jiashu-ssh-config"
printf '%s\n' "$ALIYUN_SSH_KEY" > "$key"
printf '%s\n' "$ALIYUN_KNOWN_HOSTS" > "$known"
ssh-keygen -y -P '' -f "$key" >/dev/null
known_name=$ALIYUN_HOST
if [[ "$port" != 22 ]]; then known_name="[$ALIYUN_HOST]:$port"; fi
ssh-keygen -F "$known_name" -f "$known" >/dev/null || { printf 'Known-hosts entry does not match the configured host and port.\n' >&2; exit 1; }
cat > "$config" <<EOF
Host jiashu-aliyun
    HostName $ALIYUN_HOST
    User $ALIYUN_USER
    Port $port
    IdentityFile $key
    IdentitiesOnly yes
    UserKnownHostsFile $known
    StrictHostKeyChecking yes
    BatchMode yes
    ConnectTimeout 15
    ServerAliveInterval 15
    ServerAliveCountMax 3
EOF
printf '%s\n' "$config"
