# Neon Coin Arena — AWS Serverless Multiplayer Game & Cross-Platform Apps

Game multiplayer 2D real-time menggunakan arsitektur **AWS Serverless Multi-Service** (`us-east-1`), dilengkapi server VPS Node.js 24/7 opsional serta aplikasi klien untuk web, Android (`.apk`), Windows (`.exe`), Linux, dan macOS.

## Arsitektur Service AWS yang Digunakan

1. **Amazon API Gateway (WebSocket API v2)** — `websocket-game-api` (`$connect`, `$disconnect`, `join`, `move`, `collect`, `chat`, `ping`).
2. **Amazon API Gateway (HTTP API v2)** — `neon-coin-arena-http-api` (`GET /leaderboard`, `GET /stats`, `GET /health`) untuk Hall of Fame & statistik publik.
3. **AWS Lambda (6 fungsi, `nodejs22.x`)**:
   - `game-connect` (`$connect`)
   - `game-disconnect` (`$disconnect`)
   - `game-events` (`join`, `move`, `collect`, `chat`, `ping`)
   - `game-analytics-worker` (worker event SQS untuk Hall of Fame, S3 archive, CloudWatch, & SNS alert)
   - `game-rest-api` (handler REST HTTP API `/leaderboard`, `/stats`, `/health`)
   - `game-cleanup` (pembersih sesi usang terjadwal & snapshot leaderboard ke S3)
4. **Amazon DynamoDB (+ TTL)** — Tabel `websocket-game-db` menyimpan pemain aktif (`PLAYER#`, TTL otomatis 1 jam), koin arena (`COIN#`), Hall of Fame permanen (`HALL_OF_FAME#`), dan counter global (`STATS#GLOBAL`).
5. **Amazon SQS** — Queue `neon-coin-arena-events` memisahkan pemrosesan analytics, Hall of Fame, & S3 archiving agar frame WebSocket real-time tetap cepat.
6. **Amazon SNS** — Topic `neon-coin-arena-alerts` untuk notifikasi rekor High Score baru & target CloudWatch Error Alarm.
7. **Amazon S3** — Bucket data `neon-coin-arena-data-*` untuk arsip event & snapshot leaderboard, serta S3 Static Website Hosting via `deploy_aws_s3.sh`.
8. **Amazon CloudWatch (Logs, Custom Metrics & Alarms)** — Namespace metrik kustom `NeonCoinArena`, log retention 14 hari per Lambda, dan error alarm `neon-coin-arena-lambda-errors`.
9. **Amazon EventBridge** — Aturan terjadwal (`rate(5 minutes)`) `neon-coin-arena-maintenance` memicu `game-cleanup`.
10. **AWS Systems Manager (SSM Parameter Store)** — Parameter `/neon-coin-arena/config` untuk konfigurasi dinamis arena (`targetCoins`, `scoreMultiplier`, `motd`) tanpa redeploy kode.
11. **AWS IAM** — Role eksekusi Lambda & izin invoke antar-service (API Gateway, SQS, EventBridge).
12. **Amazon CloudFront (Opsional via `ENABLE_CLOUDFRONT=true`)** — Distribusi CDN HTTPS global di depan bucket website S3.

## Konfigurasi Runtime Endpoint (`config.js`)

Repository ini tidak menyimpan IP server, ID API Gateway, atau keystore di Git. Salin template sebelum deploy atau build aplikasi:

```bash
cp frontend/config.example.js frontend/config.js
```

Lalu isi nilai `AWS_WS_URL`, `AWS_HTTP_API_URL`, serta opsional `VPS_WS_URL` / `VPS_HOST` di `frontend/config.js`. Bila `VPS_WS_URL` dikosongkan dan game dijalankan di atas `vps-server/server.mjs`, klien otomatis memakai WebSocket same-origin (`/ws`).

## Struktur Workspace

- `backend/shared/` — `aws-clients.mjs` (SSM, SQS, SNS, S3, CloudWatch, DynamoDB, API GW lazy clients + mock hook) & `ws-utils.mjs`.
- `backend/game-*` — Ke-6 AWS Lambda handlers (`connect`, `disconnect`, `events`, `analytics-worker`, `rest-api`, `cleanup`).
- `backend/test/lambdas.test.mjs` — Uji integrasi seluruh alur AWS Lambda secara lokal dengan `node --test`.
- `frontend/` — Game client HTML5 Canvas 2D responsif (`index.html`, `style.css`, `game.js`), portal unduhan (`downloads.html`), Hall of Fame tab, dan `config.example.js`.
- `desktop-app/` — Wrapper desktop Go (`main.go`, `window_windows.go`, `window_unix.go`, `main_test.go`) dengan aset tersemat (`//go:embed`) dan native Edge WebView2 GUI untuk Windows.
- `android-app/` — Project Gradle Android (`MainActivity.kt`, `AndroidManifest.xml`, `assets/www/`) untuk membangun aplikasi WebView Android.
- `vps-server/server.mjs` — Server standalone Node.js tanpa dependensi eksternal (`/ws`, `/api/leaderboard`, `/health`, `/downloads`, `/releases/*`).
- `deploy_game.sh` — Provisioning seluruh 11+ AWS service backend secara idempoten (`AWS_REGION`, `AWS_ROLE_NAME`).
- `deploy_aws_s3.sh` — Deploy static web hosting S3 (+ CloudFront opsional).
- `deploy_vps.sh` — Deploy frontend, server Node.js, dan hasil build ke VPS (`./deploy_vps.sh <user>@<vps-host>`).
- `build_all.sh` — Build aplikasi desktop & Android APK ke folder `releases/` (gitignored).
- `test_game_ws.py` — Uji otomatis 2 pemain end-to-end.

## Cara Build, Uji & Deploy

```bash
# 1. Uji unit seluruh 6 AWS Lambda secara lokal
node --test backend/test/lambdas.test.mjs

# 2. Deploy seluruh arsitektur backend AWS (butuh AWS CLI terautentikasi)
./deploy_game.sh

# 3. Deploy web static hosting ke Amazon S3 (+ CloudFront opsional: ENABLE_CLOUDFRONT=true)
./deploy_aws_s3.sh

# 4. (Opsional) Build binary desktop & Android APK ke releases/
./build_all.sh

# 5. (Opsional) Deploy fallback 24/7 ke VPS
./deploy_vps.sh <user>@<vps-host>
```
