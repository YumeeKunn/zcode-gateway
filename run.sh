#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${ZCODE_GATEWAY_PORT:-8790}"
HOST="${ZCODE_GATEWAY_HOST:-127.0.0.1}"
COMMAND="${1:-serve}"

usage() {
  cat <<'EOF'
usage: ./run.sh [command] [options]

commands:
  serve        start the gateway (default)
  login        sign in to ZCode and store the plan token
  status       print gateway health and credential state
  models       list the model catalog
  quit         nothing — Ctrl+C the running server instead

options:
  --port N     listen port (default 8790, env ZCODE_GATEWAY_PORT)
  --host H     bind address (default 127.0.0.1, env ZCODE_GATEWAY_HOST)
EOF
}

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

case "$COMMAND" in
  serve)
    export ZCODE_GATEWAY_PORT="$PORT"
    export ZCODE_GATEWAY_HOST="$HOST"
    # start-plan rejects parallel requests ("user concurrency limit exceeded"), serialise by default
    export ZCODE_MAX_CONCURRENCY="${ZCODE_MAX_CONCURRENCY:-1}"
    exec node src/server.js
    ;;
  login)
    exec node src/login.js
    ;;
  status)
    curl -sS "http://${HOST}:${PORT}/health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch{console.log(d)}})'
    ;;
  models)
    curl -sS "http://${HOST}:${PORT}/v1/models" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);for(const m of j.data)console.log(m.id)}catch{console.log(d)}})'
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "unknown command: $COMMAND" >&2
    usage
    exit 1
    ;;
esac
