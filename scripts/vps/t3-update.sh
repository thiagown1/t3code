#!/usr/bin/env bash
# Keeps a VPS on the newest fork CLI archive (.github/workflows/cli-archive-fork.yml).
#
# Finds the highest `cli-<version>-vps.<run>` release that carries a Linux archive for this
# machine, unpacks it next to the running version under $T3_UPDATE_ROOT, repoints the
# `current` symlink, restarts the systemd user unit and rolls back when the health check
# fails. A release that failed its health check is not retried; publish a newer one.
#
# While the server has child processes (provider sessions, terminals) the update waits, for at
# most T3_UPDATE_MAX_DEFER_HOURS, because a restart ends them. `--force` skips that wait.
set -euo pipefail

repo="${T3_UPDATE_REPO:-thiagown1/t3code}"
api_url="${T3_UPDATE_API_URL:-https://api.github.com/repos/${repo}/releases?per_page=30}"
download_url="${T3_UPDATE_DOWNLOAD_URL:-https://github.com/${repo}/releases/download}"
root="${T3_UPDATE_ROOT:-/opt/t3}"
unit="${T3_UPDATE_UNIT:-t3.service}"
health_url="${T3_UPDATE_HEALTH_URL:-http://127.0.0.1:3773/health}"
health_timeout="${T3_UPDATE_HEALTH_TIMEOUT:-60}"
max_defer_hours="${T3_UPDATE_MAX_DEFER_HOURS:-24}"
cgroup_root="${T3_UPDATE_CGROUP_ROOT:-/sys/fs/cgroup}"
state_dir="${T3_UPDATE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/t3-update}"

case "${T3_UPDATE_ARCH:-$(uname -m)}" in
  x86_64 | x64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "t3-update: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

force=0
[ "${1:-}" = "--force" ] && force=1

log() { echo "t3-update: $*"; }

run_number() {
  local n="${1##*-vps.}"
  if [[ "$n" =~ ^[0-9]+$ ]]; then echo "$n"; else echo 0; fi
}

# Child processes of the server other than its resource monitor.
busy_processes() {
  local cgroup main pid comm
  cgroup="$(systemctl --user show -p ControlGroup --value "$unit")"
  main="$(systemctl --user show -p MainPID --value "$unit")"
  [ -n "$cgroup" ] && [ -r "$cgroup_root$cgroup/cgroup.procs" ] || return 0
  while read -r pid; do
    [ "$pid" = "$main" ] && continue
    comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || continue
    case "$comm" in t3-resource-mon*) continue ;; esac
    printf '%s ' "$comm($pid)"
  done <"$cgroup_root$cgroup/cgroup.procs"
}

healthy() {
  local deadline=$((SECONDS + health_timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if systemctl --user is-active --quiet "$unit" && curl -fs --max-time 5 -o /dev/null "$health_url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

point_current_at() {
  ln -sfn "$1" "$root/.current.next"
  mv -T "$root/.current.next" "$root/current"
}

mkdir -p "$state_dir"
touch "$state_dir/failed"

current_dir="$(readlink -f "$root/current" || true)"
current="$(basename "${current_dir:-none}")"

tag="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$api_url" | jq -r --arg arch "$arch" '
  [ .[]
    | select(.draft | not)
    | select(.tag_name | test("^cli-.+-vps\\.[0-9]+$"))
    | select(any(.assets[]; .name | endswith("-linux-\($arch).tar.gz")))
  ]
  | max_by(.tag_name | capture("-vps\\.(?<n>[0-9]+)$").n | tonumber)
  | .tag_name // empty')"

if [ -z "$tag" ]; then
  log "no fork CLI release for linux-$arch"
  exit 0
fi
version="${tag#cli-}"
if [ "$(run_number "$version")" -le "$(run_number "$current")" ]; then
  log "up to date ($current)"
  rm -f "$state_dir/pending"
  exit 0
fi
if grep -qxF "$tag" "$state_dir/failed"; then
  log "$tag failed before; waiting for a newer release"
  exit 0
fi

if [ "$force" -eq 0 ]; then
  busy="$(busy_processes)"
  if [ -n "$busy" ]; then
    now="$(date +%s)"
    pending_tag="" since=""
    [ -f "$state_dir/pending" ] && read -r pending_tag since <"$state_dir/pending"
    if [ "$pending_tag" != "$tag" ]; then
      since="$now"
      echo "$tag $now" >"$state_dir/pending"
    fi
    if [ $((now - since)) -lt $((max_defer_hours * 3600)) ]; then
      log "deferring $tag, server is busy: $busy"
      exit 0
    fi
    log "installing $tag although the server is busy: deferred for ${max_defer_hours}h"
  fi
fi

asset="t3-${version}-linux-${arch}.tar.gz"
target="$root/$version"
if [ ! -x "$target/t3" ]; then
  incoming="$(mktemp -d "$root/.incoming.XXXXXX")"
  trap 'rm -rf "$incoming"' EXIT
  log "downloading $asset"
  curl -fsSL --max-time 600 -o "$incoming/$asset" "$download_url/$tag/$asset"
  curl -fsSL --max-time 30 -o "$incoming/SHA256SUMS" "$download_url/$tag/SHA256SUMS"
  (cd "$incoming" && awk -v a="$asset" '$2 == a || $2 == "*" a' SHA256SUMS | sha256sum -c --quiet -)
  tar -xzf "$incoming/$asset" -C "$incoming"
  reported="$("$incoming/${asset%.tar.gz}/t3" --version 2>/dev/null || true)"
  if [ "$reported" != "t3 v$version" ]; then
    echo "$tag" >>"$state_dir/failed"
    log "$asset reports '$reported', expected 't3 v$version'"
    exit 1
  fi
  rm -rf "$target"
  mv "$incoming/${asset%.tar.gz}" "$target"
fi

point_current_at "$target"
log "restarting $unit on $version (was $current)"
systemctl --user restart "$unit"
if ! healthy; then
  echo "$tag" >>"$state_dir/failed"
  if [ -n "$current_dir" ] && [ -d "$current_dir" ]; then
    log "$version failed its health check; rolling back to $current"
    point_current_at "$current_dir"
    systemctl --user restart "$unit"
  else
    log "$version failed its health check and there is no previous version to restore"
  fi
  exit 1
fi
rm -f "$state_dir/pending"
log "now running $version"

# Keep the running version and the one it replaced, for rollback.
shopt -s nullglob
for dir in "$root"/*-vps.*/; do
  dir="${dir%/}"
  if [ "$dir" != "$target" ] && [ "$dir" != "$current_dir" ]; then
    rm -rf "$dir"
  fi
done
