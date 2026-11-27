# Aster × Cloudflare Email Routing Worker（`qiyen.me`）

此 Email Worker 負責接收轉寄到 `in-<token>@qiyen.me` 的銀行／行動支付通知信（與 Gmail 轉寄驗證信），解析純文字後透過 HTTPS Webhook 送到 `https://aster.qiyen.me/api/hook/email`。

## 部署步驟

### 1. 產生並設定共用的 Webhook 密鑰
在 Aster 主機（PVE VM 106）產生一組隨機密鑰：
```bash
openssl rand -hex 32
```
將產出的密鑰填入 Aster 的 `~/aster/.env`：
```env
CLURE_EMAIL_WEBHOOK_SECRET=<剛產生的密鑰>
CLURE_EMAIL_FORWARD_DOMAIN=qiyen.me
CLURE_EMAIL_FORWARD_PREFIX=in-
```
並重啟 Aster API 容器（`cd ~/aster && docker compose up -d api`）。

### 2. 安裝與部署 Cloudflare Email Worker
```bash
cd scripts/cloudflare-email-worker
cp wrangler.toml.example wrangler.toml
npm install
npx wrangler login
npx wrangler secret put ASTER_WEBHOOK_SECRET
# 貼上與 CLURE_EMAIL_WEBHOOK_SECRET 相同的密鑰
npm run deploy
```

### 3. 設定 Cloudflare Email Routing（`qiyen.me`）
1. 登入 Cloudflare Dashboard → 選擇網域 **`qiyen.me`** → **Email** → **Email Routing**。
2. 若尚未啟用 Email Routing，依指示自動加入 Cloudflare MX / SPF DNS 紀錄。
3. 前往 **Routing rules**：
   - 在 **Catch-all address**（或自訂規則）選擇 **Send to a Worker** → 選取 **`aster-email-forward`**，並將狀態設為 **Active**。
   - Worker 內建會檢查收件人是否符合 `^in-[a-f0-9]{20}@`，非專屬轉寄位址會直接 `setReject('Unknown recipient')`。

### 4. 在 Aster App 內啟用
打開 Aster → **設定 → 自動記帳 → Email 自動轉寄（Gmail）**，依照 4 步驟精靈輸入 Gmail、完成轉寄地址驗證與篩選器設定即可。
