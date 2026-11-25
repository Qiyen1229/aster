# Aster Workspace Rules

## Git 提交與推送規範
- 每次完成程式或設定更新並通過驗證後，必須執行以下流程將變更推送至 Git 遠端：
  1. `git add .`
  2. `git commit -m "<簡潔明確的繁體中文更新說明>"`
  3. `git push origin HEAD:main`（若目前在功能分支上，亦同步 `git push` 目前分支）
- **禁止納入版控的敏感與執行期檔案**：`.env`（含 `.env.*`，僅保留 `.env.example`）與 `data/`（僅保留 `data/api/.gitkeep`）必須維持在 `.gitignore` 中，絕不可加入追蹤或強制提交，以免外洩金鑰或導致 NAS `git pull` 衝突。執行 `git add .` 前須確認這兩項未進入暫存區。

## 打包與發布規範
- 產出 NAS 部署包（`npm run pack:nas` / `aster-nas.zip`）或任何發布壓縮檔時，**絕不可包含 `data/`（含 `server/data/`）與 `.env`**，避免解壓覆蓋 NAS 現有資料庫、設定與金鑰。打包後須確認排除規則生效，不可手動把 `data/` 加進壓縮檔。

## 版本更新與發佈重點規範
- 每次執行版本升級（修改 `package.json`、`server/app/main.py`、`src/release.json` 與 `src/features/whatsnew/releaseNotes.ts`）前，**必須先提出預計寫入的「版本更新重點」範例**（含每個項目的 `title`（不超過 10 字）、`intro`、`howto` 以及 `release.json` 的 `headline`），讓使用者審閱與修改。
- **未經使用者明確確認文案前，不得擅自寫入更新重點並提交發佈**。
