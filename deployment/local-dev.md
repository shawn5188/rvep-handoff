# Local Development Deployment (切片 1 + 2 + 3)

本文件描述目前已驗證的本地開發拓撲：**backend + web 跑在本機 / DB + Livekit + coturn + MQTT 跑在 ai-bot-server01（192.168.68.68）**。

切片 3 驗證已通：Web UI → backend → Livekit → 看到 demo-bot publish 的 video tile（截圖：`/home/shawn/Documents/shawn_agent/slice3-03-control-view.png`）。

---

## 拓撲

```text
┌──────────────────────────────────┐
│  本機 (Shawn 桌機)               │
│  ─────────────────────────────  │
│  apps/backend  (pnpm dev:3000)   │
└──────────────┬───────────────────┘
               │ JDBC / WS / MQTT
               ▼
┌──────────────────────────────────┐
│  ai-bot-server01 (192.168.68.68) │
│  ─────────────────────────────  │
│  rvep-postgres-dev  :5432        │
│  rvep-deploy-livekit-1  :7880    │
│  rvep-deploy-coturn-1   :3478    │
│  rvep-deploy-mqtt-1     :1883    │
└──────────────────────────────────┘
```

---

## 第一次啟動步驟

### 1. server (ai-bot-server01) 端準備

```bash
# 從本機 SCP 過去
cd ~/Documents/shawn_codex/remote-vehicle-platform
scp docker-compose.dev.yml livekit.yaml mosquitto.conf .env.example \
    shawn@192.168.68.68:~/rvep-deploy/

ssh shawn@192.168.68.68 'cd ~/rvep-deploy && cp .env.example .env'

# 啟動 postgres (standalone, 因為已存在 rvep-postgres-dev)
ssh shawn@192.168.68.68 'docker run -d --name rvep-postgres-dev \
    -p 5432:5432 \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=rvep \
    postgres:16-alpine'

# 啟動 livekit + coturn + mqtt
ssh shawn@192.168.68.68 'cd ~/rvep-deploy && \
    docker compose -f docker-compose.dev.yml up -d livekit coturn mqtt'
```

### 2. 本機 backend 設定

```bash
cd apps/backend

# 第一次安裝
pnpm install

# 產生 .env.local
JWT_SIGN=$(openssl rand -base64 32)
JWT_REFRESH=$(openssl rand -base64 32)
cat > .env.local <<EOF
DATABASE_URL="postgresql://postgres:postgres@192.168.68.68:5432/rvep?schema=public"
JWT_SIGNING_KEY="${JWT_SIGN}"
JWT_REFRESH_KEY="${JWT_REFRESH}"
LIVEKIT_URL="ws://192.168.68.68:7880"
LIVEKIT_API_KEY="devkey"
LIVEKIT_API_SECRET="devsecret"
MQTT_URL="mqtt://192.168.68.68:1883"
STORAGE_ROOT="/var/lib/rvep/datasets"
BCRYPT_ROUNDS=12
NODE_ENV=development
EOF

# DB migration + seed
pnpm prisma generate
pnpm prisma migrate dev --name init
pnpm prisma db seed

# 啟動 dev server
pnpm dev
```

---

## 健康檢查

```bash
# Livekit
curl -s -o /dev/null -w "Livekit %{http_code}\n" http://192.168.68.68:7880/

# Backend
curl -s -o /dev/null -w "Backend %{http_code}\n" http://localhost:3000/api/v1/permissions/me
# 預期 401（沒帶 token），表示 middleware 正常工作

# 4 個容器全跑
ssh shawn@192.168.68.68 "docker ps --format '{{.Names}} | {{.Status}}'"
```

---

## curl 操作範例

### 登入

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin1234!"}'

# 回應
# {
#   "data": {
#     "accessToken": "eyJhbGc...",
#     "expiresAt": "2026-05-16T07:09:00.000Z",
#     "role": "ADMIN"
#   }
# }
```

### 看自己權限

```bash
TOKEN=<上面拿到的 accessToken>
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/permissions/me
```

### 申請 Livekit token

```bash
curl -X POST http://localhost:3000/api/v1/livekit/token \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vehicleId":"vehicle-001","role":"operator"}'

# 回應
# {
#   "data": {
#     "token": "eyJhbGc...",
#     "url": "ws://192.168.68.68:7880",
#     "roomName": "ugv-vehicle-001",
#     "identity": "operator-{userId}",
#     "expiresAt": "2026-05-16T07:09:00.000Z"
#   }
# }
```

### 驗證 Livekit token（server-side 同流程）

```bash
LK_TOKEN=<上面拿到的 livekit token>
LK_TOKEN="$LK_TOKEN" node apps/backend/tests/manual/verify-lk-token.mjs
```

---

## Seed 帳號

| email | password | role |
|-------|----------|------|
| `admin@example.com` | `Admin1234!` | ADMIN |
| `operator@example.com` | `Operator1234!` | OPERATOR |
| `viewer@example.com` | `Viewer1234!` | VIEWER |

預設車輛：`vehicle-001` (AMR-01)，三個 user 都有對應 permission。

---

## 已知限制（待後續切片解決）

- `vehiclePermissions` API 回的是 internal UUID `id`，不是 business key `vehicleId`。Web UI 需要 transform。
- Livekit 用 dev 預設 key/secret (`devkey`/`devsecret`)，**production 必須換**。
- coturn 用 dev credentials，prod 必須換 TURN secret。
- TURN 走 host network，多服務同機可能衝突，prod 需獨立網段。
- Token 真實 WS 加入房間驗證留待 Web UI 切片（需要 livekit-client browser SDK）。

---

## Web UI 啟動（切片 3）

```bash
cd apps/web
pnpm install   # 第一次
node node_modules/next/dist/bin/next dev -p 3001
# 或: NEXT_PUBLIC_API_BASE=http://localhost:3000 pnpm dev
```

訪問 `http://localhost:3001/login`，用 seed 帳號登入：

- admin@example.com / Admin1234!
- operator@example.com / Operator1234!
- viewer@example.com / Viewer1234!

點 vehicle-001 進 Control View，即可看到 demo-bot publish 的視訊。

## Demo publisher 啟動（在 ai-bot-server01）

```bash
ssh shawn@192.168.68.68 "docker run -d --name rvep-demo-publisher \
  --network host \
  -e LIVEKIT_URL=ws://localhost:7880 \
  -e LIVEKIT_API_KEY=devkey \
  -e LIVEKIT_API_SECRET=devsecret \
  livekit/livekit-cli:latest join-room \
  --room ugv-vehicle-001 --identity demo-bot --publish-demo"
```

## Livekit docker 注意事項

- `docker-compose.dev.yml` 內 livekit 使用 bridge networking + 顯式 expose UDP 50000-50100。
- `livekit.yaml` 內設 `node_ip: 192.168.68.68` 以便 LAN 內瀏覽器拿到 reachable ICE candidate。
- 若部署到客戶內網，需將 `node_ip` 改成該機在客戶網段的 IP。

## 切片 4 候選

- A. Edge Agent skeleton（Python / Node on AGX Orin + mock_camera publish）→ 把 demo-bot 換成真實 ZED-X 相機
- B. DataChannel 控制鏈（emergency_stop 按鈕真正送 command）+ Safety Gate
- C. Telemetry 流（MQTT 從 Edge → Backend → Web UI 即時顯示）

建議下一個切片：**B（DataChannel 控制鏈）**，因為「能看 + 能控」才算完整 remote control 體驗。
