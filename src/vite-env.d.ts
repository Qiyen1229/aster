/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /** 'off' 關閉帳號系統（純本機模式）；預設需要登入 */
  readonly VITE_AUTH_MODE?: 'required' | 'off';
  /** 公開支援／隱私聯絡信箱（建置時注入，離線或未連到後端時也能在 /privacy 與 /terms 顯示） */
  readonly VITE_SUPPORT_EMAIL?: string;
  /** 獨立後端 API 網址（原生 App 或前後端分離部署時使用，留空＝同源 /api） */
  readonly VITE_API_URL?: string;
}
