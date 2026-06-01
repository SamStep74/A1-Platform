#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIMA_INSTANCE="${A1_LIMA_INSTANCE:-}"
VM_HOST="${A1_VM_HOST:-}"
VM_DIR="${A1_VM_DIR:-/opt/a1/A1-Platform}"
VM_SSH="${A1_VM_SSH:-ssh}"
VM_SCP="${A1_VM_SCP:-scp}"
VM_RSYNC="${A1_VM_RSYNC:-rsync}"
VM_SSH_CONFIG="${A1_VM_SSH_CONFIG:-}"
VM_GATEWAY_PORT="${A1_VM_GATEWAY_PORT:-8088}"
VM_MINIO_PORT="${A1_VM_MINIO_PORT:-9001}"
COMPOSE_FILE="${A1_VM_COMPOSE_FILE:-infra/compose/compose.vm.yml}"
ENV_FILE="${A1_VM_ENV_FILE:-infra/compose/.env}"

if [[ -n "$LIMA_INSTANCE" && -z "$VM_HOST" ]]; then
  VM_HOST="lima-${LIMA_INSTANCE}"
  VM_SSH_CONFIG="${VM_SSH_CONFIG:-$HOME/.lima/${LIMA_INSTANCE}/ssh.config}"
fi

usage() {
  cat <<'USAGE'
A1 VM runtime helper.

Required:
  A1_VM_HOST=ubuntu@<vm-host-or-ip>
  or A1_LIMA_INSTANCE=a1-platform

Optional:
  A1_VM_DIR=/opt/a1/A1-Platform
  A1_VM_SSH_CONFIG=/path/to/ssh.config
  A1_VM_GATEWAY_PORT=8088
  A1_VM_MINIO_PORT=9001

Commands:
  check               Verify SSH, Docker Engine, and Compose in the VM
  install-engine      Install Docker Engine inside the Ubuntu VM
  sync                Rsync this repo to the VM
  init-env            Create infra/compose/.env on the VM from .env.example if absent
  up                  Start the VM Compose stack
  down                Stop the VM Compose stack
  ps                  Show VM Compose services
  logs [service...]   Tail VM Compose logs
  migrate             Run registry migrations in the API container
  health              Run platform health from the API container
  a1 <args...>        Run node cli/a1.js inside the API container
  put <local> <dest>  Copy a local file/directory into the VM
  tunnel              Open SSH tunnels for gateway and MinIO console
  shell               Open a shell in the synced VM repo
  bootstrap           install-engine, sync, init-env, up, migrate, health

Example:
  A1_VM_HOST=ubuntu@192.168.64.10 infra/vm/a1-vm.sh bootstrap
  A1_LIMA_INSTANCE=a1-platform infra/vm/a1-vm.sh bootstrap
  A1_VM_HOST=ubuntu@192.168.64.10 infra/vm/a1-vm.sh tunnel
USAGE
}

require_host() {
  if [[ -z "$VM_HOST" ]]; then
    echo "A1_VM_HOST or A1_LIMA_INSTANCE is required, for example: A1_VM_HOST=ubuntu@192.168.64.10 or A1_LIMA_INSTANCE=a1-platform" >&2
    exit 2
  fi
}

quote() {
  printf "%q" "$1"
}

quote_args() {
  local out="" q
  for arg in "$@"; do
    printf -v q "%q" "$arg"
    out+=" $q"
  done
  printf "%s" "$out"
}

remote() {
  require_host
  if [[ -n "$VM_SSH_CONFIG" ]]; then
    "$VM_SSH" -F "$VM_SSH_CONFIG" "$VM_HOST" "$@"
  else
    "$VM_SSH" "$VM_HOST" "$@"
  fi
}

remote_sh() {
  require_host
  local remote_command
  remote_command="bash -lc $(quote "$1")"
  if [[ -n "$VM_SSH_CONFIG" ]]; then
    "$VM_SSH" -F "$VM_SSH_CONFIG" "$VM_HOST" "$remote_command"
  else
    "$VM_SSH" "$VM_HOST" "$remote_command"
  fi
}

remote_compose() {
  local args
  args="$(quote_args "$@")"
  remote_sh "cd $(quote "$VM_DIR") && docker compose --env-file $(quote "$ENV_FILE") -f $(quote "$COMPOSE_FILE")${args}"
}

sync_repo() {
  require_host
  remote_sh "sudo mkdir -p $(quote "$VM_DIR") && sudo chown \$(whoami):\$(id -gn) $(quote "$VM_DIR")"
  local ssh_transport=("$VM_SSH")
  if [[ -n "$VM_SSH_CONFIG" ]]; then
    ssh_transport+=("-F" "$VM_SSH_CONFIG")
  fi
  "$VM_RSYNC" -az --delete -e "$(printf "%q " "${ssh_transport[@]}")" \
    --exclude ".git/" \
    --exclude ".DS_Store" \
    --exclude "node_modules/" \
    --exclude "coverage/" \
    --exclude "exports/" \
    --exclude "exports-after-import/" \
    --exclude "backups/" \
    --exclude "tmp/" \
    --exclude "*.dump" \
    --exclude "*.sqlite" \
    --exclude "*.db" \
    --exclude "infra/compose/.env" \
    "$ROOT/" "$VM_HOST:$VM_DIR/"
}

prepare_runtime_dirs() {
  require_host
  remote_sh "sudo mkdir -p /opt/a1/imports /opt/a1/exports /opt/a1/backups && sudo chown -R \$(whoami):\$(id -gn) /opt/a1/imports /opt/a1/exports /opt/a1/backups"
}

install_engine() {
  require_host
  remote "mkdir" "-p" "/tmp/a1-platform-vm"
  if [[ -n "$VM_SSH_CONFIG" ]]; then
    "$VM_SCP" -F "$VM_SSH_CONFIG" "$ROOT/infra/vm/install-docker-engine.sh" "$VM_HOST:/tmp/a1-platform-vm/install-docker-engine.sh"
  else
    "$VM_SCP" "$ROOT/infra/vm/install-docker-engine.sh" "$VM_HOST:/tmp/a1-platform-vm/install-docker-engine.sh"
  fi
  remote "bash" "/tmp/a1-platform-vm/install-docker-engine.sh"
}

init_env() {
  remote_sh "cd $(quote "$VM_DIR") && test -f infra/compose/.env || cp infra/compose/.env.example infra/compose/.env && chmod 600 infra/compose/.env"
}

case "${1:-}" in
  ""|help|-h|--help)
    usage
    ;;
  install-engine)
    install_engine
    ;;
  check)
    remote_sh "uname -a && docker --version && docker compose version"
    ;;
  sync)
    sync_repo
    ;;
  init-env)
    init_env
    ;;
  up)
    prepare_runtime_dirs
    remote_compose up -d --build
    ;;
  down)
    remote_compose down
    ;;
  ps)
    remote_compose ps
    ;;
  logs)
    shift
    remote_compose logs --no-color --tail=120 "$@"
    ;;
  migrate)
    remote_compose exec -T api node cli/a1.js migrate
    ;;
  health)
    remote_compose exec -T api node cli/a1.js health
    ;;
  a1)
    shift
    remote_compose exec -T api node cli/a1.js "$@"
    ;;
  put)
    shift
    if [[ $# -ne 2 ]]; then
      echo "Usage: infra/vm/a1-vm.sh put <local-path> <absolute-vm-path>" >&2
      exit 2
    fi
    require_host
    local_path="$1"
    remote_path="$2"
    remote_dir="$(dirname "$remote_path")"
    remote_sh "sudo mkdir -p $(quote "$remote_dir") && sudo chown \$(whoami):\$(id -gn) $(quote "$remote_dir")"
    if [[ -n "$VM_SSH_CONFIG" ]]; then
      "$VM_SCP" -F "$VM_SSH_CONFIG" -r "$local_path" "$VM_HOST:$remote_path"
    else
      "$VM_SCP" -r "$local_path" "$VM_HOST:$remote_path"
    fi
    ;;
  tunnel)
    require_host
    if [[ -n "$VM_SSH_CONFIG" ]]; then
      "$VM_SSH" -F "$VM_SSH_CONFIG" -N \
        -L "${VM_GATEWAY_PORT}:127.0.0.1:8088" \
        -L "${VM_MINIO_PORT}:127.0.0.1:9001" \
        "$VM_HOST"
    else
      "$VM_SSH" -N \
        -L "${VM_GATEWAY_PORT}:127.0.0.1:8088" \
        -L "${VM_MINIO_PORT}:127.0.0.1:9001" \
        "$VM_HOST"
    fi
    ;;
  shell)
    require_host
    remote_sh "cd $(quote "$VM_DIR") && exec bash"
    ;;
  bootstrap)
    install_engine
    sync_repo
    prepare_runtime_dirs
    init_env
    remote_compose up -d --build
    remote_compose exec -T api node cli/a1.js migrate
    remote_compose exec -T api node cli/a1.js health
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
