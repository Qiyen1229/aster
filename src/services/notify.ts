/**
 * Services 層用的輕量 UI 通知橋接：避免 services/ 直接依賴 stores/ui。
 * stores/ui 在模組載入時註冊實作；純單元測試未載入 UI 時安全降級為 no-op。
 */
export interface SnackNotice {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  secret?: boolean;
  required?: boolean;
  maxLength?: number;
  inputMode?: 'text' | 'numeric' | 'decimal';
  confirmText?: string;
  danger?: boolean;
}

export interface UiBridge {
  showSnack: (opts: SnackNotice) => void;
  askInput: (opts: PromptOptions) => Promise<string | null>;
}

let bridge: UiBridge | null = null;

export function registerUiBridge(next: UiBridge) {
  bridge = next;
}

export function notifyUser(opts: string | SnackNotice) {
  bridge?.showSnack(typeof opts === 'string' ? { text: opts } : opts);
}

export function promptUser(opts: PromptOptions): Promise<string | null> {
  return bridge ? bridge.askInput(opts) : Promise.resolve(null);
}
