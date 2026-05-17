#!/bin/sh
set -eu

CONTAINER="${LLMHQ_CONTAINER:-llmhq}"
EXCLUDE="${LLMHQ_NETWORK_SYNC_EXCLUDE:-bridge host none llmhq_private}"
INTERVAL="${LLMHQ_NETWORK_SYNC_INTERVAL_SECONDS:-30}"

log() {
  timestamp="$(date -Iseconds 2>/dev/null || date)"
  printf '%s %s\n' "$timestamp" "$*"
}

is_excluded() {
  candidate="$1"
  for excluded in $EXCLUDE; do
    if [ "$candidate" = "$excluded" ]; then
      return 0
    fi
  done
  return 1
}

container_exists() {
  docker inspect "$CONTAINER" >/dev/null 2>&1
}

container_networks() {
  docker inspect \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    "$CONTAINER" 2>/dev/null || true
}

target_networks() {
  docker network ls --filter driver=bridge --format '{{.Name}}' | while IFS= read -r network; do
    [ -n "$network" ] || continue
    is_excluded "$network" && continue
    printf '%s\n' "$network"
  done
}

connect_network() {
  network="$1"

  if ! container_exists; then
    log "waiting for container ${CONTAINER}"
    return 0
  fi

  if container_networks | grep -Fx "$network" >/dev/null 2>&1; then
    return 0
  fi

  log "connecting ${CONTAINER} to ${network} as llmhq"
  error_file="/tmp/llmhq-network-sync.err"
  if docker network connect --alias llmhq "$network" "$CONTAINER" 2>"$error_file"; then
    rm -f "$error_file"
    return 0
  fi

  error="$(cat "$error_file" 2>/dev/null || true)"
  rm -f "$error_file"
  case "$error" in
    *"already exists"*|*"is already connected"*)
      return 0
      ;;
    *)
      log "failed to connect ${CONTAINER} to ${network}: ${error}"
      return 0
      ;;
  esac
}

sync_once() {
  target_networks | while IFS= read -r network; do
    connect_network "$network"
  done
}

log "starting server-local network sync for ${CONTAINER}"
sync_once

while true; do
  if docker events --filter type=container --filter type=network --format '{{.Type}} {{.Action}} {{.Actor.Attributes.name}}' | while IFS= read -r _event; do
    sync_once
  done; then
    log "docker event stream ended; restarting after ${INTERVAL}s"
  else
    log "docker event stream failed; restarting after ${INTERVAL}s"
  fi

  sleep "$INTERVAL"
  sync_once
done
