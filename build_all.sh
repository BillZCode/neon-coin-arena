#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASES_DIR="${SCRIPT_DIR}/releases"
mkdir -p "$RELEASES_DIR"

echo "=== 1. Sync shared frontend assets to desktop & Android apps ==="
for file in index.html style.css game.js config.example.js; do
  cp "${SCRIPT_DIR}/frontend/${file}" "${SCRIPT_DIR}/desktop-app/web/${file}"
  cp "${SCRIPT_DIR}/frontend/${file}" "${SCRIPT_DIR}/android-app/app/src/main/assets/www/${file}"
done
if [[ -f "${SCRIPT_DIR}/frontend/config.js" ]]; then
  cp "${SCRIPT_DIR}/frontend/config.js" "${SCRIPT_DIR}/desktop-app/web/config.js"
  cp "${SCRIPT_DIR}/frontend/config.js" "${SCRIPT_DIR}/android-app/app/src/main/assets/www/config.js"
fi

echo "=== 2. Build Desktop Apps (Windows EXE, Linux, macOS) ==="
(
  cd "${SCRIPT_DIR}/desktop-app"
  export GOPATH="${GOPATH:-$(go env GOPATH)}"
  export GOCACHE="${GOCACHE:-$(go env GOCACHE)}"
  go test ./...
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-H windowsgui -s -w" -o "${RELEASES_DIR}/NeonCoinArena-Windows-x64.exe" .
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "${RELEASES_DIR}/NeonCoinArena-Linux-amd64" .
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o "${RELEASES_DIR}/NeonCoinArena-macOS-arm64" .
  CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o "${RELEASES_DIR}/NeonCoinArena-macOS-amd64" .
)

echo "=== 3. Build Android APK ==="
(
  cd "${SCRIPT_DIR}/android-app"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
  export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
  if [[ -n "${KEYSTORE_FILE:-}" && -f "${KEYSTORE_FILE}" ]]; then
    ./gradlew assembleRelease --no-daemon
    cp app/build/outputs/apk/release/app-release.apk "${RELEASES_DIR}/NeonCoinArena-Android.apk"
  else
    ./gradlew assembleDebug --no-daemon
    cp app/build/outputs/apk/debug/app-debug.apk "${RELEASES_DIR}/NeonCoinArena-Android.apk"
  fi
)

echo "=== 4. Build Artifacts Summary ==="
ls -lh "${RELEASES_DIR}"
