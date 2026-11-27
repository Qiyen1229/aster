/**
 * iPhone 自動記帳捷徑頁（Clean Auto-Record Hub）：
 * 主畫面僅呈現 2 個核心渠道：
 *   ① 銀行與支付通知（自動擷取通知）
 *   ② Apple Pay 感應付款（刷卡即記）
 * 技術細節（連結碼、備用捷徑檔、裝置權杖列表與撤銷、手動設定指南）收斂至「進階設定與裝置管理」抽屜。
 */
import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createToken, emailForwardStatusLabel, ensureLink, forgetLink, getEmailForwardBinding, hookUrl, listTokens, revokeToken, savedLink,
  deviceLabel, openShortcutImport, shortcutFileUrl, SHORTCUTS,
  type EmailForwardBinding,
  type InboxToken,
} from '@/services/inbox';
import { AUTH_ENABLED } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { useUI, ask, askInput } from '@/stores/ui';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { EmailForwardSheet } from '../inbox/EmailForwardSheet';
import { countTokenUses, ShortcutWizard, type ShortcutDef } from '../inbox/ShortcutWizard';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });

async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); snack(`已複製${label}`); } catch { snack('無法複製，請長按文字自行選取'); }
}

type ConnectionState = {
  kind: 'unconfigured' | 'pending' | 'connected';
  label: string;
};

function getConnectionState(tokens: InboxToken[] | null, hasLink: boolean): ConnectionState {
  const count = countTokenUses(tokens);
  if (count > 0) {
    return { kind: 'connected', label: `已連線 · 已接收 ${count} 筆` };
  }
  if (hasLink || (tokens && tokens.length > 0)) {
    return { kind: 'pending', label: '待啟用' };
  }
  return { kind: 'unconfigured', label: '未設定' };
}

export default function ShortcutsPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const [tokens, setTokens] = useState<InboxToken[] | null>(null);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [link, setLink] = useState(savedLink);
  const [preparing, setPreparing] = useState(false);
  const [activeChannel, setActiveChannel] = useState<ShortcutDef | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [emailBinding, setEmailBinding] = useState<EmailForwardBinding | null>(null);
  const [emailChecked, setEmailChecked] = useState(false);
  const [emailSheetOpen, setEmailSheetOpen] = useState(false);

  const refreshTokens = useCallback(async (): Promise<InboxToken[]> => {
    try {
      const list = await listTokens();
      setTokens(list);
      const saved = savedLink();
      if (saved && !list.some((t) => t.id === saved.id)) {
        forgetLink();
        setLink(null);
      } else if (saved && Capacitor.isNativePlatform()) {
        void ensureLink();
      }
      return list;
    } catch {
      setTokens((prev) => prev ?? []);
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshTokens();
    if (AUTH_ENABLED) {
      void getEmailForwardBinding()
        .then(setEmailBinding)
        .catch(() => undefined)
        .finally(() => setEmailChecked(true));
    }
  }, [refreshTokens]);

  const addShortcut = async (sc: ShortcutDef) => {
    const isNative = Capacitor.isNativePlatform();
    let l = link;
    let pending: ReturnType<typeof ensureLink> | null = null;
    let copying: Promise<boolean> = Promise.resolve(false);
    if (l) {
      if (isNative) {
        void ensureLink();
      } else {
        copying = navigator.clipboard.writeText(l.code).then(() => true, () => false);
      }
    } else {
      setPreparing(true);
      pending = ensureLink();
      if (!isNative) {
        copying = typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
          ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((x) => new Blob([x.code], { type: 'text/plain' })) })]).then(() => true, () => false)
          : Promise.resolve(false);
      }
    }
    openShortcutImport(sc);
    let copied = await copying;
    if (pending) {
      try {
        const r = await pending;
        l = { id: r.id, code: r.code };
        setLink(l);
        if (r.created) setTokens((t) => [...(t ?? []), r.created!]);
        if (!isNative && !copied) copied = await navigator.clipboard.writeText(r.code).then(() => true, () => false);
      } catch (e) {
        snack((e as Error).message);
        throw e;
      } finally {
        setPreparing(false);
      }
    }
    if (!isNative) {
      snack(copied
        ? '已複製連結碼：在「捷徑」App 按「設定捷徑」，長按輸入框 →「貼上」，最後按「加入捷徑」'
        : '請先至「進階設定與裝置管理」複製連結碼，再到「捷徑」App 貼上', 8000);
    }
  };

  const resetLink = async () => {
    if (!link || !await ask('重新產生連結碼？已加入的捷徑會失效，需要重新加入。')) return;
    await revokeToken(link.id).catch(() => undefined);
    forgetLink();
    setTokens((l) => l?.filter((x) => x.id !== link.id) ?? null);
    setLink(null);
  };

  const sendTest = async (via: 'link' | 'header', channelKey: ShortcutDef['key'] = 'auto'): Promise<boolean> => {
    const auth = via === 'header' && fresh ? { Authorization: `Bearer ${fresh.token}` } : null;
    let url = auth ? hookUrl() : link?.code;
    if (!url && via === 'link') {
      try {
        const ensured = await ensureLink();
        setLink({ id: ensured.id, code: ensured.code });
        if (ensured.created) setTokens((t) => [...(t ?? []), ensured.created!]);
        url = ensured.code;
      } catch (e) {
        snack(`無法建立測試連線：${(e as Error).message}`, 6000);
        return false;
      }
    }
    if (!url) return false;
    const payload = { source: 'notify', card: '測試銀行', text: '測試消費 午餐 120 元' };
    void channelKey;
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `伺服器錯誤（${r.status}）`);
      snack('已送出測試項目，請至首頁「收件匣」查看待確認項目');
      return true;
    } catch (e) {
      snack(`測試失敗：${(e as Error).message}`, 6000);
      return false;
    }
  };

  const newToken = async () => {
    const name = await askInput({ title: '幫這組權杖取個名字', placeholder: '例如：我的 iPhone', defaultValue: '我的 iPhone', required: true, maxLength: 40, confirmText: '建立' });
    if (!name) return;
    try {
      const r = await createToken(name);
      setFresh({ token: r.token, name: r.item.name });
      setTokens((t) => [...(t ?? []), r.item]);
    } catch (e) { snack((e as Error).message); }
  };

  const conn = getConnectionState(tokens, !!link);
  const actionLabel = conn.kind === 'connected' ? '管理' : '設定';
  const emailConn = emailForwardStatusLabel(emailBinding);

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動記帳捷徑</h1>
        <button className="icon-btn" aria-label="進階設定與裝置管理" onClick={() => setAdvancedOpen(true)}>
          <Icon name="more" />
        </button>
      </header>

      <p className="muted" style={{ margin: '4px 4px 12px', fontSize: '0.88rem', lineHeight: 1.55 }}>
        選擇自動記帳管道並完成 3 步驟設定，消費通知與 Apple Pay 感應付款就會自動送進 Aster 收件匣。
      </p>

      <div className="shortcut-hub-list">
        {SHORTCUTS.map((sc) => {
          const isAuto = sc.key === 'auto';
          return (
            <section key={sc.key} className="card shortcut-channel-card">
              <div className="shortcut-channel-head">
                <span className="set-tile" style={{ ['--c' as string]: isAuto ? '#30D158' : '#0A84FF' }} aria-hidden="true">
                  <Icon name={isAuto ? 'zap' : 'wallet'} size={18} />
                </span>
                <div className="shortcut-channel-meta">
                  <div className="shortcut-channel-title">{sc.title}</div>
                  <div className="shortcut-channel-sub muted">{sc.hint}</div>
                </div>
                <button
                  type="button"
                  className={conn.kind === 'connected' ? 'pill' : 'pill accent-pill'}
                  onClick={() => setActiveChannel(sc)}
                >
                  {actionLabel}
                </button>
              </div>
              <div className="shortcut-channel-foot">
                <span className={`shortcut-status-badge is-${conn.kind}`}>
                  <i className="shortcut-status-dot" aria-hidden="true" />
                  {tokens === null ? '檢查連線中…' : conn.label}
                </span>
              </div>
            </section>
          );
        })}

        {AUTH_ENABLED && (
          <section className="card shortcut-channel-card">
            <div className="shortcut-channel-head">
              <span className="set-tile" style={{ ['--c' as string]: '#FF375F' }} aria-hidden="true">
                <Icon name="mail" size={18} />
              </span>
              <div className="shortcut-channel-meta">
                <div className="shortcut-channel-title">Email 自動轉寄（Gmail）</div>
                <div className="shortcut-channel-sub muted">
                  透過專屬轉寄地址自動接收 Gmail 銀行與行動支付通知信並匯入 Aster 收件匣
                </div>
              </div>
              <button
                type="button"
                className={emailConn.kind === 'connected' ? 'pill' : 'pill accent-pill'}
                onClick={() => setEmailSheetOpen(true)}
              >
                {emailBinding ? '管理' : '設定'}
              </button>
            </div>
            <div className="shortcut-channel-foot">
              <span className={`shortcut-status-badge is-${emailConn.kind}`}>
                <i className="shortcut-status-dot" aria-hidden="true" />
                {!emailChecked ? '檢查連線中…' : emailConn.label}
              </span>
            </div>
          </section>
        )}
      </div>

      <div className="section-title">偏好與管理</div>
      <div className="list">
        <button className="field" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate('/settings/inbox-whitelist')}>
          <span className="label" style={{ flex: 1 }}>自動入帳偏好</span>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {cfg.autoBook ? '自動記帳開啟' : `白名單 ${(cfg.whitelist ?? []).length} 項`}
            {Object.keys(cfg.cardMap).length ? ` · 卡片 ${Object.keys(cfg.cardMap).length}` : ''}
          </span>
          <Icon name="chevronR" />
        </button>
        <button className="field" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => setAdvancedOpen(true)}>
          <span className="label" style={{ flex: 1 }}>進階設定與裝置管理</span>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {tokens ? `${tokens.length} 台裝置` : '連結碼・權杖・備用下載'}
          </span>
          <Icon name="chevronR" />
        </button>
      </div>

      <ShortcutWizard
        open={activeChannel !== null}
        onClose={() => setActiveChannel(null)}
        shortcut={activeChannel}
        preparing={preparing}
        hasLink={!!link}
        tokens={tokens}
        onAdd={addShortcut}
        onSendTest={(k) => sendTest('link', k)}
        onRefreshTokens={refreshTokens}
      />

      <EmailForwardSheet
        open={emailSheetOpen}
        onClose={() => setEmailSheetOpen(false)}
        binding={emailBinding}
        onUpdated={setEmailBinding}
      />

      <Sheet open={advancedOpen} onClose={() => setAdvancedOpen(false)} title="進階設定與裝置管理">
        {link && (
          <div className="card inbox-oneclick">
            <div className="copy-row oneclick-code">
              <span className="label">連結碼</span>
              <code>{link.code.replace(/t=(clr_.{4}).*(.{4})$/, 't=$1••••$2')}</code>
              <button className="pill" onClick={() => void copy(link.code, '連結碼')}>複製</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn tinted small" onClick={() => void sendTest('link', 'auto')}>傳送測試項目</button>
              <button className="btn secondary small" onClick={() => void resetLink()}>重新產生連結碼</button>
            </div>
          </div>
        )}

        <div className="section-title">已連結的裝置</div>
        <div className="list">
          {tokens?.length === 0 && <div className="row"><span className="row-sub">還沒有已連結裝置，於主畫面設定捷徑後會自動建立。</span></div>}
          {tokens?.map((t) => (
            <div key={t.id} className="row">
              <span className="row-main">
                <span className="row-title">{link?.id === t.id && t.name === 'iPhone 捷徑' ? deviceLabel() : t.name} <span className="faint num">••••{t.hint}</span></span>
                <span className="row-sub">{t.last_used_at ? `已傳送 ${t.use_count || 1} 次資料，上次：${new Date(`${t.last_used_at}Z`).toLocaleString('zh-TW')}` : '還沒有送過資料'}</span>
              </span>
              <button className="pill" style={{ color: 'var(--danger)' }} onClick={async () => {
                if (!await ask(`撤銷「${t.name}」？使用這組權杖的捷徑將無法再送出。`)) return;
                try {
                  await revokeToken(t.id);
                  setTokens((l) => l?.filter((x) => x.id !== t.id) ?? null);
                  if (link?.id === t.id) { forgetLink(); setLink(null); }
                } catch (e) { snack((e as Error).message); }
              }}>撤銷</button>
            </div>
          ))}
        </div>

        <details className="card oneclick-fallback" style={{ marginTop: 12 }}>
          <summary className="muted">備用：直接下載 .shortcut 捷徑檔</summary>
          <p className="muted">沒有跳轉到「捷徑」App 時，可下載捷徑檔，再到「檔案」App 的「下載項目」點開：</p>
          <p>{SHORTCUTS.map((s) => <a key={s.key} className="pill" href={shortcutFileUrl(s)} download={`${s.name}.shortcut`}>{s.name}</a>)}</p>
          <p className="muted">「設定捷徑」畫面卡住時，先按「略過設定」加入，再把捷徑第一個「文字」動作換成連結碼。外層有登入保護（如 Cloudflare Access）時，要放行 <code>/shortcuts/</code> 與 <code>/api/hook/</code>。</p>
        </details>

        <details className="card inbox-advanced">
          <summary><b>進階：自己動手建立捷徑／權杖</b></summary>
          <p className="muted">想修改捷徑內容，或用在其他裝置（Android 的 Tasker 等）時，可以建立一組權杖，用標頭傳送。</p>
          <button className="btn secondary small" onClick={() => void newToken()}><Icon name="plus" /> 建立捷徑權杖</button>
          {fresh && (
            <div className="card inbox-token">
              <p style={{ marginTop: 0 }}><b>「{fresh.name}」的權杖已建立</b> — 只會顯示這一次，請現在複製到捷徑裡。</p>
              <div className="copy-row"><span className="label">網址</span><code>{hookUrl()}</code><button className="pill" onClick={() => void copy(hookUrl(), '網址')}>複製</button></div>
              <div className="copy-row"><span className="label">標頭值</span><code>Bearer {fresh.token}</code><button className="pill" onClick={() => void copy(`Bearer ${fresh.token}`, '標頭值')}>複製</button></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn tinted small" onClick={() => void sendTest('header', 'auto')}>傳送測試項目</button>
                <button className="btn secondary small" onClick={() => setFresh(null)}>我已複製好了</button>
              </div>
            </div>
          )}
          <ShortcutGuides />
        </details>
      </Sheet>
    </main>
  );
}

/** 兩種捷徑的手動設定步驟（可展開） */
function ShortcutGuides() {
  const common = (
    <>
      <li>加入動作「<b>取得 URL 的內容</b>」，網址貼上上面複製的<b>網址</b>。</li>
      <li>點「顯示更多」：<b>方法</b>選 POST；<b>標頭</b>新增一個，名稱填 <code>Authorization</code>，值貼上<b>標頭值</b>（Bearer 開頭那串）。</li>
      <li><b>要求本文</b>選「JSON」，再依下面的表格新增欄位（類型都選「文字」）。</li>
    </>
  );
  return (
    <div className="inbox-guides">
      <details className="card">
        <summary><b>💳 Apple Pay 付款後自動記帳</b><span className="faint">　iOS 17 以上</span></summary>
        <ol>
          <li>打開「捷徑」App →「自動化」→ 右上角「＋」→ 選「<b>交易</b>」。</li>
          <li>選要追蹤的卡片（可以全選），選「<b>立即執行</b>」，按「下一步」→「新增空白自動化」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>applepay</td></tr>
          <tr><td><code>amount</code></td><td>點「捷徑輸入」→ 選「<b>金額</b>」</td></tr>
          <tr><td><code>merchant</code></td><td>「捷徑輸入」→「<b>商家</b>」</td></tr>
          <tr><td><code>card</code></td><td>「捷徑輸入」→「<b>卡片或票證</b>」（用來判斷帳戶）</td></tr>
        </tbody></table>
        <p className="muted">完成後用 Apple Pay 付一筆，打開 Aster 就會在收件匣看到。</p>
      </details>
      <details className="card">
        <summary><b>🔔 銀行 App／LINE Pay／街口／訊息通知自動記帳</b></summary>
        <ol>
          <li>打開「捷徑」App →「自動化」→ 右上角「＋」→ 選「<b>收到通知</b>」。</li>
          <li>「App」勾選「<b>訊息</b>」、你的銀行 App、<b>LINE</b>、LINE Pay、街口支付等（勿勾選 Gmail／Outlook），選「<b>立即執行</b>」，按「下一步」→「新增空白自動化」。</li>
          {common}
        </ol>
        <table className="inbox-fields"><tbody>
          <tr><td><code>source</code></td><td>notify</td></tr>
          <tr><td><code>card</code></td><td>點「捷徑輸入」→ 選「<b>App</b>」（傳送發送通知的 App 名稱）</td></tr>
          <tr><td><code>text</code></td><td>點「捷徑輸入」→ 依序放入「<b>標題</b>」（Title，供 LINE 官方帳號／白名單比對）與「<b>內容</b>」</td></tr>
        </tbody></table>
        <p className="muted">Aster 會從通知文字中解析金額、商店名稱與卡片帳戶，非交易的驗證碼與廣告推播會自動過濾略過。</p>
      </details>
    </div>
  );
}
