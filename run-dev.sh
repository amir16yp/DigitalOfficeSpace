#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not on PATH."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not on PATH."
  exit 1
fi

if [[ ! -d client/node_modules ]]; then
  echo "Installing client dependencies..."
  npm install --prefix client
fi

echo "Starting the office server at http://127.0.0.1:8080"
cargo run --manifest-path server/Cargo.toml &
server_pid=$!

cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
  wait "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Waiting for http://127.0.0.1:8080 ..."
ready=0
for _ in $(seq 1 180); do
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo "The office server exited before it could listen."
    wait "$server_pid" || true
    exit 1
  fi
  if node -e "const n=require('net');const s=n.connect(8080,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  echo "The office server never accepted connections."
  exit 1
fi

echo "Server is up. Starting Vite."
npm run dev --prefix client
