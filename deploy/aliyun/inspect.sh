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
printf 'inspection_only=true\n'
