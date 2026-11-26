# Aster Workspace Rules

## Git 提交與推送規範
- 每次完成程式或設定更新並通過驗證後，必須執行以下流程將變更推送至 Git 遠端：
  1. `git add .`
  2. `git commit -m "<簡潔明確的繁體中文更新說明>"`
  3. `git push origin HEAD:main`（若目前在功能分支上，亦同步 `git push` 目前分支）
- **禁止納入版控的敏感與執行期檔案**：`.env`（含 `.env.*`，僅保留 `.env.example`）與 `data/`（僅保留 `data/api/.gitkeep`）必須維持在 `.gitignore` 中，絕不可加入追蹤或強制提交，以免外洩金鑰或導致伺服器 `git pull` 衝突。執行 `git add .` 前須確認這兩項未進入暫存區。

## 正式部署與 AI 基礎設施規範（取代舊 NAS nas918）
- **禁止再指引使用舊 NAS（`nas918`）**：所有部署、改設定、查 log、重啟指令一律以 **PVE VM 106** 為準，絕不寫 NAS 路徑或指令。
- **Aster 主機（PVE VM 106）**：
  - 名稱 `Q.aster`（Ubuntu 24.04，8GB RAM / 64GB Disk），IP `10.0.30.180`，帳號 `qiyen`。
  - 程式碼路徑 `~/aster`、環境設定 `~/aster/.env`、Compose 檔 `~/aster/docker-compose.yml`、資料存放於 PVE 本地磁碟（不放 NAS 資料夾）。
  - 部署指令：`bash ~/deploy-aster.sh`。
  - 公開網址：`https://aster.qiyen.me`（經 Cloudflare Tunnel）。
- **AI 運算節點（DGX Spark）**：
  - 主機名 `spark-881b`，IP `10.0.30.100`，帳號 `yicheng`（連線走 WireGuard，與 VM 106 同在 `10.0.30.x` 內網）。
  - 預設 AI：Gemma 4 26B（vLLM `0.28.0`，port `8000`，模型名 `gemma-4-26b`），Aster 連 AI 一律走內網 `http://10.0.30.100:8000/v1`；對外端點為 `https://nemotron.qiyen.me`（Cloudflare Tunnel 轉發至 port `8000`）。
  - 語音轉錄：Breeze-ASR-25（port `8094`）。
- **安全規範**：對外連線一律透過 Cloudflare Tunnel，絕不可直接暴露主機 IP。

## 打包與發布規範
- 仍須持續產出覆蓋用部署壓縮檔（`npm run pack:nas` / `aster-nas.zip`），但**絕不可包含 `data/`（含 `server/data/`）與 `.env`**，避免解壓覆蓋 VM 106 現有資料庫、設定與金鑰。打包後須確認排除規則生效，不可手動把 `data/` 加進壓縮檔。

## 版本更新與發佈重點規範
- 每次執行版本升級（修改 `package.json`、`server/app/main.py`、`src/release.json` 與 `src/features/whatsnew/releaseNotes.ts`）前，**必須先提出預計寫入的「版本更新重點」範例**（含每個項目的 `title`（不超過 10 字）、`intro`、`howto` 以及 `release.json` 的 `headline`），讓使用者審閱與修改。
- **未經使用者明確確認文案前，不得擅自寫入更新重點並提交發佈**。
