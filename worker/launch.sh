#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${CR3DX_WORKER_STATE_DIR:-}" || "${CR3DX_WORKER_STATE_DIR}" != /* ]]; then
  echo "CR3DX_WORKER_STATE_DIR must be an absolute path" >&2
  exit 2
fi

state_dir="$(realpath -m -- "${CR3DX_WORKER_STATE_DIR}")"
command_name="${1:-help}"

if [[ ! -d "${state_dir}" ]]; then
  if [[ "${command_name}" != "bootstrap" ]]; then
    echo "Worker state directory is missing; explicit bootstrap is required" >&2
    exit 2
  fi
  mkdir -m 700 -- "${state_dir}"
fi

state_mode="$(stat -c '%a' -- "${state_dir}")"
if [[ "${state_mode}" != "700" ]]; then
  echo "Worker state directory must have mode 0700, got ${state_mode}" >&2
  exit 2
fi

lock_path="${state_dir}/worker.lock"
if [[ "${CR3DX_WORKER_LOCK_HELD:-0}" != "1" ]]; then
  touch -- "${lock_path}"
  chmod 600 -- "${lock_path}"
  exec env CR3DX_WORKER_LOCK_HELD=1 flock --exclusive --nonblock --no-fork "${lock_path}" "$0" "$@"
fi

needs_secret=0
case "${command_name}" in
  bootstrap|run|step|advance|resume|resume-broadcast) needs_secret=1 ;;
esac

if (( needs_secret )); then
  secret_mode="${CR3DX_WORKER_SECRET_MODE:-}"
  if [[ "${secret_mode}" == "file" ]]; then
    env_file="${CR3DX_WORKER_ENV_FILE:-}"
    if [[ -z "${env_file}" || "${env_file}" != /* ]]; then
      echo "file mode requires absolute CR3DX_WORKER_ENV_FILE" >&2
      exit 2
    fi
    env_file="$(realpath -- "${env_file}")"
    checkout="$(realpath -- "$(dirname -- "$0")/..")"
    if [[ "${env_file}" == "${checkout}" || "${env_file}" == "${checkout}/"* ]]; then
      echo "S6 secret file must be outside the checkout" >&2
      exit 2
    fi
    if [[ ! -f "${env_file}" || -L "${env_file}" ]]; then
      echo "S6 secret target must be a regular non-symlink file" >&2
      exit 2
    fi
    if [[ "$(stat -c '%u' -- "${env_file}")" != "$(id -u)" || "$(stat -c '%a' -- "${env_file}")" != "600" ]]; then
      echo "S6 secret file must be owned by the worker user with mode 0600" >&2
      exit 2
    fi
    parent="$(dirname -- "${env_file}")"
    mode="$(stat -c '%a' -- "${parent}")"
    if [[ "$(stat -c '%u' -- "${parent}")" != "$(id -u)" ]] || (( (8#${mode} & 8#022) != 0 )); then
      echo "S6 secret containing directory must be worker-owned and not group/world writable: ${parent}" >&2
      exit 2
    fi
    mapfile -t key_lines < <(grep -E '^CR3DX_WORKER_PRIVATE_KEY=(0x)?[0-9a-fA-F]{64}$' -- "${env_file}" || true)
    if [[ "${#key_lines[@]}" != "1" ]]; then
      echo "S6 secret file must contain exactly one plain CR3DX_WORKER_PRIVATE_KEY assignment" >&2
      exit 2
    fi
    export CR3DX_WORKER_PRIVATE_KEY="${key_lines[0]#*=}"
    export CR3DX_WORKER_STATE_DIR="${state_dir}"
    export CR3DX_WORKER_SECRET_MODE=file
    export CR3DX_WORKER_SECRET_PROVENANCE="checked external file ${env_file}"
  elif [[ "${secret_mode}" == "manager" ]]; then
    : "${CR3DX_WORKER_PRIVATE_KEY:?manager mode must inject CR3DX_WORKER_PRIVATE_KEY}"
    export CR3DX_WORKER_SECRET_PROVENANCE="secret manager inherited environment"
  else
    echo "Signing commands require CR3DX_WORKER_SECRET_MODE=file|manager" >&2
    exit 2
  fi
fi

if [[ "${CR3DX_WORKER_VALIDATE_SECRET_ONLY:-0}" == "1" ]]; then
  exit 0
fi

exec node --import tsx "$(dirname -- "$0")/cli.ts" "$@"
