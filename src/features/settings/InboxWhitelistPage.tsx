/**
 * 自動入帳偏好：
 * ① 看得懂的直接記帳＋判斷不出帳戶時的預設帳戶
 * ② 白名單發送者（支援新增、編輯、移除；比對發送者／LINE 官方帳號名稱或通知內容）
 * ③ 卡片對應的帳戶（已設定的對應不會被系統自動覆蓋）
 * 入口：收件匣右上角盾牌圖示、加入 iPhone 捷徑頁的「自動入帳偏好」。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { askInput, useUI } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { AccountField, SwitchField } from '@/ui/form';
import { Icon, iconEmoji } from '@/ui/Icon';

const snack = (text: string) => useUI.getState().showSnack({ text });

export default function InboxWhitelistPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const set = useSettings((s) => s.set);
  const update = (patch: Partial<typeof cfg>) => set('inbox', { ...cfg, ...patch });
  const { list: accounts, map: accMap } = useAccounts();
  const list = cfg.whitelist ?? [];
  const [name, setName] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);

  const add = () => {
    const n = name.trim().slice(0, 40);
    if (!n) return;
    if (list.some((x) => x.toLowerCase() === n.toLowerCase())) { snack('這個發送者已經在白名單裡了'); return; }
    update({ whitelist: [...list, n] });
    setName('');
    snack(`已加入「${n}」：之後它的通知會直接記帳`);
  };

  const edit = async (oldName: string, idx: number) => {
    const next = await askInput({
      title: '編輯白名單發送者',
      placeholder: '發送者名稱，例如 LINE 帳號或銀行名稱',
      defaultValue: oldName,
      required: true,
      maxLength: 40,
      confirmText: '儲存',
    });
    if (!next) return;
    const trimmed = next.trim().slice(0, 40);
    if (!trimmed || trimmed === oldName) return;
    if (list.some((x, i) => i !== idx && x.toLowerCase() === trimmed.toLowerCase())) {
      snack('白名單裡已經有相同的名稱了');
      return;
    }
    update({ whitelist: list.map((x, i) => (i === idx ? trimmed : x)) });
    snack(`已更新為「${trimmed}」`);
  };

  const remove = (n: string) => update({ whitelist: list.filter((x) => x !== n) });

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>自動入帳偏好</h1>
        <button className="icon-btn" aria-label="比對方式說明" title="比對方式說明" onClick={() => setInfoOpen(true)}><Icon name="info" /></button>
      </header>

      <div className="section-title">自動入帳設定</div>
      <div className="list">
        <SwitchField
          label="看得懂的直接記帳"
          sub="開啟 App 時自動記下有金額且明確的項目。Apple Pay 偶爾會送來空白或被拒絕的交易，建議先手動確認一陣子再開啟"
          checked={cfg.autoBook}
          onChange={(v) => update({ autoBook: v })}
        />
        <AccountField
          label="判斷不出帳戶時"
          value={cfg.defaultAccountId}
          onChange={(v) => update({ defaultAccountId: v })}
          accounts={accounts}
          allowEmpty
          emptyLabel="上次記帳的帳戶"
          filter={(a) => a.type !== 'loan' && a.type !== 'brokerage'}
        />
      </div>

      <div className="section-title">新增白名單發送者</div>
      <div className="list">
        <div className="field">
          <input
            value={name}
            maxLength={40}
            placeholder="發送者名稱，例如 中國信託 或 LINE 帳號"
            aria-label="發送者名稱"
            style={{ flex: 1 }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
          <button className="pill accent-pill" disabled={!name.trim()} onClick={add}>加入</button>
        </div>
      </div>

      <div className="section-title">白名單（{list.length}）</div>
      {list.length === 0 ? (
        <EmptyState emoji="🛡️" title="白名單是空的" text="加入信任的發送者後，即使沒開「看得懂的直接記帳」，它的消費通知也會直接入帳。" />
      ) : (
        <div className="list">
          {list.map((n, idx) => (
            <div key={`${n}-${idx}`} className="row">
              <span className="row-main">
                <span className="row-title">{n}</span>
                <span className="row-sub">名稱或內容符合時直接記帳</span>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="pill" onClick={() => void edit(n, idx)}>編輯</button>
                <button className="pill" style={{ color: 'var(--danger)' }} onClick={() => remove(n)}>移除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(cfg.cardMap).length > 0 && (
        <>
          <div className="section-title">卡片對應的帳戶</div>
          <div className="list">
            {Object.entries(cfg.cardMap).map(([card, id]) => (
              <div key={card} className="field">
                <span className="label" style={{ flex: 1 }}>{card}</span>
                <select
                  value={accMap.has(id) ? id : ''}
                  aria-label={`${card} 對應的帳戶`}
                  onChange={(e) => {
                    const map = { ...cfg.cardMap };
                    if (e.target.value) map[card] = e.target.value; else delete map[card];
                    update({ cardMap: map });
                  }}
                >
                  <option value="">（不指定，自動判斷）</option>
                  {accounts.filter((a) => a.type !== 'loan').map((a) => <option key={a.id} value={a.id}>{iconEmoji(a.icon)} {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 8px' }}>未設定過的卡片會在確認記帳時自動記住；你在這裡手動指定的對應不會被系統自動覆蓋。</p>
        </>
      )}

      {infoOpen && (
        <div className="whatsnew-wrap" role="dialog" aria-modal="true" aria-labelledby="whitelist-info-title">
          <div className="whatsnew-backdrop" aria-hidden="true" onClick={() => setInfoOpen(false)} />
          <div className="whatsnew-modal" style={{ maxWidth: 420 }}>
            <header className="whatsnew-header">
              <h2 id="whitelist-info-title" className="whatsnew-title">白名單比對說明</h2>
              <div className="whatsnew-header-end">
                <button type="button" className="whatsnew-close-btn" aria-label="關閉說明" onClick={() => setInfoOpen(false)}>
                  <Icon name="close" size={16} stroke={2.2} />
                </button>
              </div>
            </header>
            <div style={{ padding: '16px 20px 20px', display: 'grid', gap: 12 }}>
              <p style={{ margin: 0 }}>白名單裡的發送者，通知會<b>直接記帳、不用手動確認</b>——即使沒有開啟「看得懂的直接記帳」。</p>
              <div className="card" style={{ margin: 0, background: 'var(--surface-2)' }}>
                <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.55 }}>
                  <b>比對方式（名稱或內容皆可）：</b><br />
                  只要「發送者／LINE 官方帳號／卡片名稱」或「通知內容／商家」其中一項包含該名稱就算命中（不分大小寫與全半形）。<br />
                  例如 LINE 官方帳號名稱為「中國信託」，加入「中國信託」後，名字符合的通知就會直接入帳。
                </p>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>請只加入你信任的發送者；看不懂金額或疑似重複的項目仍會留在收件匣等你確認。</p>
              <button type="button" className="btn" onClick={() => setInfoOpen(false)}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
