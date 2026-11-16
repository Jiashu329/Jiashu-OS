#!/usr/bin/env bash
# Read-only metadata. Do not print environment files, nginx configuration or credentials.
set -euo pipefail
field() { printf '%s=%s\n' "$1" "$2"; }
os_field() { sed -n "s/^$1=//p" /etc/os-release 2>/dev/null | head -1 | tr -d '"'; }
field os_id "$(os_field ID)"
field os_version "$(os_field VERSION_ID)"
field architecture "$(uname -m)"
field ssh_user "$(id -un)"
if command -v docker >/dev/null 2>&1; then
  field docker_version "$(docker --version 2>/dev/null | head -1)"
  if docker info >/dev/null 2>&1; then
    field docker_access ready
    printf 'running_container_metadata:\n'
    docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
  else field docker_access unavailable; fi
  if docker compose version >/dev/null 2>&1; then field compose_version "$(docker compose version --short)"; else field compose_version unavailable; fi
else field docker_version unavailable; fi
if command -v ss >/dev/null 2>&1; then
  printf 'listening_requested_ports:\n'
  ss -H -lnt | awk '$4 ~ /:(22|80|443|3100)$/ { print $4 }' | sort -u
else field socket_inspection unavailable; fi
found=false
for nginx in /usr/sbin/nginx /usr/local/nginx/sbin/nginx /www/server/nginx/sbin/nginx; do
  if [[ -x "$nginx" ]]; then
    found=true
    field nginx_binary "$nginx"
    field nginx_version "$("$nginx" -v 2>&1 | head -1)"
    if "$nginx" -t >/dev/null 2>&1; then
      field nginx_configuration_test passed
      # Only directive names and public routing/certificate paths, never headers,
      # environment values, embedded credentials or private key contents.
      "$nginx" -T 2>/dev/null | awk '/^# configuration file / || /^[ \t]*(listen|server_name|root|include|ssl_certificate)[ \t]/ {print}'
    else field nginx_configuration_test failed; fi
  fi
done
if [[ "$found" == false ]]; then field nginx_binary not_found_in_standard_locations; fi
if [[ -f /opt/jiashu-test/.jiashu-selfhost ]]; then field jiashu_directory marked; else field jiashu_directory not_bootstrapped; fi

# Optional capacity metadata only. Expensive reads require a deadline; missing
# tools, permissions or a slow Docker daemon must not fail the original probe.
capacity_command() {
  local label=$1 seconds=$2
  shift 2
  printf '%s:\n' "$label"
  if ! command -v timeout >/dev/null 2>&1; then
    field "${label}_status" skipped_timeout_unavailable
  elif ! timeout --signal=TERM --kill-after=1s "${seconds}s" "$@" 2>/dev/null; then
    field "${label}_status" unavailable_or_timed_out
  fi
  return 0
}
inspect_capacity() {
  local cpu_count docker_root container_ids directory container
  local -a disk_paths=(/) usage_paths=() app_containers=()
  field capacity_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || cpu_count=unavailable
  field logical_cpus "$cpu_count"
  if [[ -r /proc/uptime ]]; then
    awk '{printf "uptime_seconds=%.0f\n",$1}' /proc/uptime
  fi
  if [[ -r /proc/loadavg ]]; then
    awk '{printf "load_average_1m_5m_15m=%s %s %s\n",$1,$2,$3}' /proc/loadavg
  fi
  if [[ -r /proc/meminfo ]]; then
    awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {printf "memory_%s_bytes=%.0f\n",substr($1,1,length($1)-1),$2*1024}' /proc/meminfo
  else field memory_status unavailable; fi
  if command -v vmstat >/dev/null 2>&1; then
    # The first line is the boot average; subsequent lines sample five seconds.
    capacity_command cpu_vmstat_5s 7 vmstat 1 6
  else
    capacity_command cpu_sample_5s 7 bash -c '
      read -r cpu user nice system idle wait irq softirq steal rest < /proc/stat || exit 1
      total=$((user+nice+system+idle+wait+irq+softirq+steal)); idle_before=$idle; wait_before=$wait; steal_before=$steal
      sleep 5
      read -r cpu user nice system idle wait irq softirq steal rest < /proc/stat || exit 1
      awk -v total="$((user+nice+system+idle+wait+irq+softirq+steal-total))" -v idle="$((idle-idle_before))" -v wait="$((wait-wait_before))" -v steal="$((steal-steal_before))" \
        '\''BEGIN {if(total<=0)exit 1;printf "cpu_busy_percent=%.2f\ncpu_iowait_percent=%.2f\ncpu_steal_percent=%.2f\n",100*(total-idle-wait)/total,100*wait/total,100*steal/total}'\''
    '
  fi
  [[ ! -d /opt/jiashu-test ]] || disk_paths+=(/opt/jiashu-test)
  if command -v docker >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    docker_root=$(timeout --signal=TERM --kill-after=1s 2s docker info --format '{{.DockerRootDir}}' 2>/dev/null) || docker_root=''
    if [[ "$docker_root" == /* && "$docker_root" != *$'\n'* && -d "$docker_root" ]]; then
      field docker_root "$docker_root"
      disk_paths+=("$docker_root")
    fi
  fi
  capacity_command filesystem_bytes 2 df -B1 --output=target,size,used,avail,pcent -- "${disk_paths[@]}"
  capacity_command filesystem_inodes 2 df -i --output=target,itotal,iused,iavail,ipcent -- "${disk_paths[@]}"
  for directory in /opt/jiashu-test/data /opt/jiashu-test/backups; do
    [[ ! -d "$directory" ]] || usage_paths+=("$directory")
  done
  if ((${#usage_paths[@]})); then
    capacity_command application_storage_bytes 4 du --summarize --bytes --total -- "${usage_paths[@]}"
  else field application_storage_status not_bootstrapped; fi
  if command -v docker >/dev/null 2>&1; then
    capacity_command docker_storage_summary 4 docker system df
    if command -v timeout >/dev/null 2>&1; then
      container_ids=$(timeout --signal=TERM --kill-after=1s 2s docker ps -aq --filter label=com.docker.compose.project=jiashu-test --filter label=com.docker.compose.service=app 2>/dev/null) || container_ids=''
      while IFS= read -r container; do
        [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || continue
        app_containers+=("$container")
        ((${#app_containers[@]} < 3)) || break
      done <<< "$container_ids"
    fi
    if ((${#app_containers[@]})); then
      capacity_command application_container_state 2 docker inspect --type container --format 'name={{.Name}} status={{.State.Status}} running={{.State.Running}} exit_code={{.State.ExitCode}} oom_killed={{.State.OOMKilled}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}not_configured{{end}} memory_limit_bytes={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} log_driver={{.HostConfig.LogConfig.Type}} log_max_size={{index .HostConfig.LogConfig.Config "max-size"}} log_max_file={{index .HostConfig.LogConfig.Config "max-file"}}' "${app_containers[@]}"
      capacity_command application_container_stats 3 docker stats --no-stream --format 'name={{.Name}} cpu={{.CPUPerc}} memory={{.MemUsage}} memory_percent={{.MemPerc}} network={{.NetIO}} block_io={{.BlockIO}} pids={{.PIDs}}' "${app_containers[@]}"
    else field application_container_status unavailable_or_not_found; fi
  else field docker_capacity_status unavailable; fi
}
if ! inspect_capacity; then field capacity_status unavailable; fi
printf 'inspection_only=true\n'
