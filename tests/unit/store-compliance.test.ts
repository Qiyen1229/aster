// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfiguredSupportEmail, PrivacyPage, TermsPage } from '@/features/legal/LegalPages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('商店合規與安全修補', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('CSP connect-src 包含備援匯率 cdn.jsdelivr.net 與台股休市日 openapi.twse.com.tw', () => {
    const conf = readFileSync(resolve(process.cwd(), 'docker/security-headers.conf'), 'utf8');
    const match = conf.match(/connect-src\s+'self'([^;]+);/);
    expect(match).not.toBeNull();
    const connectSrc = match![1];
    expect(connectSrc).toContain('https://open.er-api.com');
    expect(connectSrc).toContain('https://cdn.jsdelivr.net');
    expect(connectSrc).toContain('https://openapi.twse.com.tw');
  });

  describe('公開支援／隱私聯絡管道（/privacy 與 /terms）', () => {
    it('getConfiguredSupportEmail 正確讀取並修剪空白', () => {
      expect(getConfiguredSupportEmail(undefined)).toBe('');
      expect(getConfiguredSupportEmail('   ')).toBe('');
      expect(getConfiguredSupportEmail(' support@example.com ')).toBe('support@example.com');
    });

    it('設定 VITE_SUPPORT_EMAIL 時，離線／未連到後端也能於 /privacy 與 /terms 顯示聯絡信箱', async () => {
      vi.stubEnv('VITE_SUPPORT_EMAIL', 'privacy@aster.example.com');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      await act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(PrivacyPage)));
      });
      expect(host.textContent).toContain('privacy@aster.example.com');
      expect(host.querySelector('a[href="mailto:privacy@aster.example.com"]')).not.toBeNull();

      await act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(TermsPage)));
      });
      expect(host.textContent).toContain('privacy@aster.example.com');
      expect(host.querySelector('a[href="mailto:privacy@aster.example.com"]')).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    });

    it('未設定 VITE_SUPPORT_EMAIL 且後端不可達時維持相容安全文案（不捏造假 Email）', async () => {
      vi.stubEnv('VITE_SUPPORT_EMAIL', '');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      await act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(PrivacyPage)));
      });
      expect(host.textContent).toContain('（站台的聯絡方式請向管理員索取）');
      expect(host.querySelector('a[href^="mailto:"]')).toBeNull();

      await act(async () => {
        root.render(createElement(MemoryRouter, null, createElement(TermsPage)));
      });
      expect(host.textContent).toContain('有任何問題請洽管理員。');
      expect(host.querySelector('a[href^="mailto:"]')).toBeNull();

      await act(async () => root.unmount());
    });

    it('.env.example 預留 VITE_SUPPORT_EMAIL 與 VITE_API_URL 註解', () => {
      const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
      expect(envExample).toMatch(/^#\s*VITE_SUPPORT_EMAIL=/m);
      expect(envExample).toMatch(/^#\s*VITE_API_URL=/m);
    });
  });
});
