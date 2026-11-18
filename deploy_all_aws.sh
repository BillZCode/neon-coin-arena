#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_TMP="$(mktemp)"
cleanup() {
  rm -f "$ENV_TMP"
}
trap cleanup EXIT

echo "=== STEP 1/4: Deploy All AWS Backend Services ==="
ENV_OUT_FILE="$ENV_TMP" "${SCRIPT_DIR}/deploy_game.sh"

# shellcheck disable=SC1090
source "$ENV_TMP"

echo "=== STEP 2/4: Generate Runtime frontend/config.js Automatically ==="
python3 - "$SCRIPT_DIR" "$AWS_WS_URL" "$AWS_HTTP_API_URL" <<'PY'
import json, os, re, sys

root, aws_ws, aws_http = sys.argv[1], sys.argv[2], sys.argv[3]
cfg_path = os.path.join(root, "frontend", "config.js")

existing = {}
if os.path.exists(cfg_path):
    text = open(cfg_path, encoding="utf-8").read()
    m_vps = re.search(r'"?VPS_WS_URL"?\s*:\s*"([^"]*)"', text)
    m_host = re.search(r'"?VPS_HOST"?\s*:\s*"([^"]*)"', text)
    if m_vps:
        existing["VPS_WS_URL"] = m_vps.group(1)
    if m_host:
        existing["VPS_HOST"] = m_host.group(1)

cfg = {
    "AWS_WS_URL": aws_ws,
    "AWS_HTTP_API_URL": aws_http,
    "VPS_WS_URL": os.environ.get("VPS_WS_URL", existing.get("VPS_WS_URL", "")),
    "VPS_HOST": os.environ.get("VPS_HOST", existing.get("VPS_HOST", "")),
}

content = f"window.NEON_ARENA_CONFIG = {json.dumps(cfg, indent=2)};\n"
for rel in [
    os.path.join("frontend", "config.js"),
    os.path.join("desktop-app", "web", "config.js"),
    os.path.join("android-app", "app", "src", "main", "assets", "www", "config.js"),
]:
    target = os.path.join(root, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(content)
    print("Updated", target)
PY

if [[ "${BUILD_APPS:-false}" == "true" ]]; then
  echo "=== OPTIONAL: Rebuild Desktop & Android Releases ==="
  "${SCRIPT_DIR}/build_all.sh"
fi

echo "=== STEP 3/4: Deploy Public Web Frontend to Amazon S3 ==="
"${SCRIPT_DIR}/deploy_aws_s3.sh"

if [[ -n "${VPS_TARGET:-}" ]]; then
  echo "=== OPTIONAL: Sync Updated Config & Builds to VPS (${VPS_TARGET}) ==="
  "${SCRIPT_DIR}/deploy_vps.sh" "$VPS_TARGET"
fi

if [[ "${SKIP_TESTS:-false}" != "true" ]]; then
  echo "=== STEP 4/4: Verify Live AWS HTTP API & WebSocket Endpoints ==="
  curl -sf "${AWS_HTTP_API_URL}/health" && echo ""
  curl -sf "${AWS_HTTP_API_URL}/leaderboard" && echo ""
  python3 "${SCRIPT_DIR}/test_game_ws.py" "$AWS_WS_URL"
fi

echo ""
echo "================================================================"
echo "  ALL-IN-ONE DEPLOY COMPLETE!"
echo "  WebSocket Endpoint : ${AWS_WS_URL}"
echo "  HTTP REST API      : ${AWS_HTTP_API_URL}"
echo "  Config Written     : frontend/config.js"
echo "================================================================"
