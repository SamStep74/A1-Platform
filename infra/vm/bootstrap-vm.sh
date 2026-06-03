#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VM_HOST="${A1_VM_HOST:-}"
LIMA_INSTANCE="${A1_LIMA_INSTANCE:-}"

if [[ -z "$VM_HOST" && -z "$LIMA_INSTANCE" ]]; then
  cat <<'USAGE' >&2
A1 VM bootstrap requires one of:
  A1_LIMA_INSTANCE=<name>
  A1_VM_HOST=<user@host>

Examples:
  export A1_LIMA_INSTANCE=a1-platform
  # OR
  export A1_VM_HOST=ubuntu@192.168.64.10
USAGE
  exit 2
fi

if [[ -n "$VM_HOST" && ( "$VM_HOST" == *"<"* || "$VM_HOST" == *">"* || "$VM_HOST" == *" "* ) ]]; then
  echo "A1_VM_HOST must be a real host, not a shell placeholder." >&2
  echo "Use a value like: A1_VM_HOST=ubuntu@192.168.64.10" >&2
  exit 2
fi

cd "$ROOT"

echo "Starting A1 Platform VM bootstrap..."
npm run vm:bootstrap

if [[ "${A1_VM_NO_TUNNEL:-0}" != "1" ]]; then
  if [[ -n "$VM_HOST" ]]; then
    echo "Bootstrap complete. In a separate terminal run:"
    echo "  A1_VM_HOST=$VM_HOST npm run vm:tunnel"
  else
    echo "Bootstrap complete. In a separate terminal run:"
    echo "  A1_LIMA_INSTANCE=$LIMA_INSTANCE npm run vm:tunnel"
  fi
fi

