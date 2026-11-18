# Neon Coin Arena — AWS WebSocket Multiplayer Game & Cross-Platform Apps

Game multiplayer 2D real-time menggunakan **AWS API Gateway WebSocket + AWS Lambda (Node.js 22.x) + Amazon DynamoDB**, dengan dukungan server VPS Node.js 24/7 serta aplikasi klien untuk web, Android (`.apk`), Windows (`.exe`), Linux, dan macOS.

## Arsitektur Resource AWS (`us-east-1`)

- **DynamoDB Table:** `websocket-game-db` (Partition key: `pk` String)
  - Item pemain: `pk = "PLAYER#<connectionId>"` (`name`, `color`, `x`, `y`, `dir`, `boosting`, `score`, `coinsCollected`, `joined`)
  - Item koin arena: `pk = "COIN#<coinId>"` (`kind`: `gold` +10, `gem` +25, `boost` +15 & Turbo, `star` +50)
- **AWS Lambda Functions (`nodejs22.x`):**
  - `game-connect` (`$connect`)
  - `game-disconnect` (`$disconnect`)
  - `game-events` (`join`, `move`, `collect`, `chat`, `ping`, `$default`)
- **API Gateway WebSocket API:** `websocket-game-api` (Stage: `dev`, Route selection: `$request.body.action`)
- **Amazon S3 Static Website Hosting (Opsional Publik Web):** `deploy_aws_s3.sh`

## Konfigurasi Runtime Endpoint (`config.js`)

Repository ini tidak menyimpan IP server, ID API Gateway, atau keystore di Git. Salin template sebelum deploy atau build aplikasi:

```bash
cp frontend/config.example.js frontend/config.js
```

Lalu isi nilai `AWS_WS_URL`, dan secara opsional `VPS_WS_URL` / `VPS_HOST` di `frontend/config.js`. Bila `VPS_WS_URL` dikosongkan dan game dijalankan di atas `vps-server/server.mjs`, klien otomatis memakai WebSocket same-origin (`/ws`).

## Struktur Workspace

- `backend/shared/ws-utils.mjs` — Helper DynamoDB, ApiGatewayManagementApi, broadcast, spawn koin, dan pembersihan koneksi `410 GoneException`.
- `backend/game-connect/index.mjs`, `backend/game-disconnect/index.mjs`, `backend/game-events/index.mjs` — Handler Lambda WebSocket API.
- `frontend/` — Game client HTML5 Canvas 2D responsif (`index.html`, `style.css`, `game.js`), portal unduhan (`downloads.html`), dan `config.example.js`.
- `desktop-app/` — Wrapper desktop Go (`main.go`, `window_windows.go`, `window_unix.go`, `main_test.go`) dengan aset tersemat (`//go:embed`) dan native Edge WebView2 GUI untuk Windows.
- `android-app/` — Project Gradle Android (`MainActivity.kt`, `AndroidManifest.xml`, `assets/www/`) untuk membangun aplikasi WebView Android.
- `vps-server/server.mjs` — Server standalone Node.js tanpa dependensi eksternal (`/ws`, `/health`, `/downloads`, `/releases/*`).
- `deploy_game.sh` — Deploy / update backend WebSocket ke AWS (`AWS_REGION`, `AWS_ROLE_NAME`).
- `deploy_aws_s3.sh` — Deploy static web hosting ke Amazon S3.
- `deploy_vps.sh` — Deploy frontend, server Node.js, dan hasil build ke VPS (`./deploy_vps.sh <user>@<vps-host>`).
- `build_all.sh` — Build aplikasi desktop & Android APK ke folder `releases/` (gitignored).
- `test_game_ws.py` — Uji otomatis 2 pemain end-to-end.

## Cara Build & Deploy

```bash
# 1. Deploy backend serverless AWS (butuh AWS CLI terautentikasi)
./deploy_game.sh

# 2. (Opsional) Build binary desktop & Android APK ke releases/
#    Untuk signed release APK, set KEYSTORE_FILE, KEYSTORE_PASS, KEY_ALIAS, KEY_PASS
./build_all.sh

# 3. Deploy web static hosting ke Amazon S3 atau ke VPS
./deploy_aws_s3.sh
./deploy_vps.sh <user>@<vps-host>
```

## Uji Otomatis

```bash
# Uji unit server lokal desktop Go
(cd desktop-app && go test -v ./...)

# Uji multiplayer WebSocket (ganti URL dengan endpoint Anda)
python3 test_game_ws.py ws://127.0.0.1:8080/ws
python3 test_game_ws.py wss://<api-id>.execute-api.us-east-1.amazonaws.com/dev
```
