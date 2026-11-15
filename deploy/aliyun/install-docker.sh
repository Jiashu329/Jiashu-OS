#!/usr/bin/env bash
# Alibaba Cloud Linux 4 native Moby + Compose prerequisites only.
# Official installation and service commands:
# https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker
# Native Compose package is also documented in the ALinux 4 image release notes:
# https://help.aliyun.com/zh/alinux/product-overview/alibaba-cloud-linux-4-image-release-notes
# This script never removes packages/data, adds repositories, rewrites daemon
# settings, opens network ports, or changes the existing nginx installation.
set -euo pipefail
export LC_ALL=C
die() { printf 'Docker prerequisite check: %s\n' "$*" >&2; exit 1; }
mode=${1:---check}
[[ $# -le 1 && ( "$mode" == --check || "$mode" == --install ) ]] || die 'Usage: install-docker.sh [--check|--install]'
[[ $(id -u) == 0 ]] || die 'Run on the target ECS as root.'
[[ -f /etc/os-release ]] || die 'Missing OS identification.'
os_field() { sed -n "s/^$1=//p" /etc/os-release | head -1 | tr -d '"'; }
os_version=$(os_field VERSION_ID)
[[ $(os_field ID) == alinux && ( "$os_version" == 4 || "$os_version" == 4.* ) ]] || die 'Only Alibaba Cloud Linux 4 RPM edition is supported.'
[[ $(uname -m) == x86_64 ]] || die 'This deployment currently supports x86_64 only.'
for command in dnf rpm systemctl flock pgrep; do
  command -v "$command" >/dev/null 2>&1 || die "Required command is missing: $command"
done
exec 9>/run/jiashu-docker-install.lock
flock -x 9

# An already usable runtime is left completely untouched, including its daemon
# configuration, installed package versions and systemd enablement choices.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  printf 'docker_prerequisites=already_ready\n'
  docker --version
  docker compose version
  exit 0
fi

moby_installed=false
rpm -q moby >/dev/null 2>&1 && moby_installed=true
for package in podman podman-docker docker docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras; do
  if rpm -q "$package" >/dev/null 2>&1; then
    die "Existing $package package requires separate review; no packages were removed."
  fi
done
if [[ "$moby_installed" == false ]]; then
  for package in containerd runc; do
    if rpm -q "$package" >/dev/null 2>&1; then
      die "Existing $package runtime requires separate review; it was not replaced."
    fi
  done
  if command -v docker >/dev/null 2>&1 || pgrep -x dockerd >/dev/null 2>&1 || pgrep -x containerd >/dev/null 2>&1 || pgrep -x conmon >/dev/null 2>&1; then
    die 'An unmanaged container runtime exists; it was not changed.'
  fi
  for directory in /var/lib/docker /var/lib/containerd /var/lib/containers; do
    if [[ -d "$directory" && -n $(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
      die "Existing container data in $directory requires separate review; it was not changed."
    fi
  done
fi

# Use only native ALinux 4 repositories already configured by the image. Never
# guess a CentOS releasever, import third-party keys, or enable a Docker CE repo.
# gpgcheck is mandatory even if the host's global dnf configuration disabled it.
dnf_options=(--disablerepo='*' --enablerepo='alinux4-*' --setopt=gpgcheck=1 --setopt=install_weak_deps=False --setopt=obsoletes=False)
packages=()
for package in moby docker-compose-plugin; do
  if rpm -q "$package" >/dev/null 2>&1; then
    release=$(rpm -q --queryformat '%{RELEASE}' "$package")
    [[ "$release" == *'.alnx4'* ]] || die "Installed $package is not a native ALinux 4 package."
    continue
  fi
  # Check availability before any installation. Native releases must carry the
  # distribution marker; a missing plugin/repository stops instead of falling
  # back to a remote shell installer or an unsigned static binary.
  candidates=$(dnf -q "${dnf_options[@]}" list --available "$package") || die "Native $package package unavailable; inspect dnf repository metadata."
  if ! awk -v name="$package" '$1 ~ ("^" name "\\.") && $2 ~ /\.alnx4/ {found=1} END {exit !found}' <<< "$candidates"; then
    die "No native ALinux 4 candidate found for $package."
  fi
  packages+=("$package")
done
printf 'docker_prerequisites=native_packages_available\n'
if [[ "$mode" == --check ]]; then
  printf 'installation_performed=false\n'
  exit 0
fi
if ((${#packages[@]})); then
  # No --allowerasing, upgrade, remove, repository edits or daemon rewrites.
  dnf -y "${dnf_options[@]}" install "${packages[@]}"
fi
systemctl enable --now docker.service
docker info >/dev/null 2>&1 || die 'Moby installed but Docker daemon is unavailable; inspect systemd status separately.'
docker compose version >/dev/null 2>&1 || die 'Native Compose plugin is unavailable after installation.'
printf 'docker_prerequisites=ready\n'
docker --version
docker compose version
