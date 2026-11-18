#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_TARGET="${1:-${VPS_TARGET:-}}"
if [[ -z "$VPS_TARGET" ]]; then
  echo "Usage: $0 <user@vps-host> (or set VPS_TARGET env var)" >&2
  exit 1
fi
VPS_PORT="${VPS_PORT:-80}"
APP_DIR="/home/ubuntu/neon-coin-arena"

echo "=== 1. Syncing frontend, vps-server & releases to ${VPS_TARGET}:${APP_DIR} ==="
ssh -o BatchMode=yes "$VPS_TARGET" "mkdir -p '${APP_DIR}'"
DIRS_TO_SYNC=(frontend vps-server)
if [[ -d "${SCRIPT_DIR}/releases" ]]; then
  DIRS_TO_SYNC+=(releases)
fi
tar -czf - -C "$SCRIPT_DIR" "${DIRS_TO_SYNC[@]}" | ssh -o BatchMode=yes "$VPS_TARGET" "tar -xzf - -C '${APP_DIR}'"

echo "=== 2. Installing systemd service (PORT=${VPS_PORT}) ==="
ssh -o BatchMode=yes "$VPS_TARGET" bash -s -- "$APP_DIR" "$VPS_PORT" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
VPS_PORT="$2"

sudo tee /etc/systemd/system/neon-coin-arena.service >/dev/null <<EOF
[Unit]
Description=Neon Coin Arena Multiplayer WebSocket Game
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${APP_DIR}/vps-server
Environment=PORT=${VPS_PORT}
Environment=HOST=0.0.0.0
ExecStart=/usr/bin/node ${APP_DIR}/vps-server/server.mjs
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now neon-coin-arena
sudo systemctl restart neon-coin-arena
sleep 1
sudo systemctl is-active neon-coin-arena
curl -s -f "http://127.0.0.1:${VPS_PORT}/health" && echo ""
REMOTE

echo "=== VPS DEPLOY COMPLETE ==="
