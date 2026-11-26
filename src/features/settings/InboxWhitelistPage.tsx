/**
 * 自動入帳偏好：
 * ① 看得懂的直接記帳＋判斷不出帳戶時的預設帳戶
 * ② 白名單發送者（支援新增、編輯、移除；比對發送者／LINE 官方帳號名稱或通知內容）
 * ③ 卡片對應的帳戶（已設定的對應不會被系統自動覆蓋）
 * 入口：收件匣右上角盾牌圖示、加入 iPhone 捷徑頁的「自動入帳偏好」。
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { useAccounts, useCategories } from '@/app/hooks';
import { db } from '@/db/schema';
import { deleteRule } from '@/services/autocat';
import { useSettings } from '@/stores/settings';
import { ask, askInput, useUI } from '@/stores/ui';
import { EmptyState, Segmented } from '@/ui/controls';
import { AccountField, CustomSelect, SwitchField } from '@/ui/form';
import { Icon, iconEmoji } from '@/ui/Icon';
import { blankRule, RULE_MATCH_LABEL, RuleEditorSheet, ruleTargetSummary, type RuleDraft } from './RuleEditorSheet';

const snack = (text: string) => useUI.getState().showSnack({ text });

export default function InboxWhitelistPage() {
  const navigate = useNavigate();
  const cfg = useSettings((s) => s.inbox);
  const set = useSettings((s) => s.set);
  const update = (patch: Partial<typeof cfg>) => set('inbox', { ...cfg, ...patch });
  const { list: accounts, map: accMap } = useAccounts();
  const { map: catMap } = useCategories();
  const rules = useLiveQuery(() => db.rules.orderBy('priority').toArray(), []) ?? [];
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const list = cfg.whitelist ?? [];
  const blacklist = cfg.blacklist ?? [];
  const [tab, setTab] = useState<'white' | 'black' | 'rules' | 'tools'>('white');
  const [name, setName] = useState('');
  const [blockWord, setBlockWord] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);

  const addBlacklist = () => {
    const n = blockWord.trim().slice(0, 40);
    if (!n) return;
    if (blacklist.some((x) => x.toLowerCase() === n.toLowerCase())) { snack('這個項目已經在黑名單裡了'); return; }
    update({ blacklist: [...blacklist, n] });
    setBlockWord('');
    snack(`已封鎖「${n}」：之後符合的通知將直接忽略`);
  };

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

      <div style={{ margin: '14px 0 12px' }}>
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="自動入帳管理分頁"
          options={[
            { value: 'white', label: `白名單 (${list.length})` },
            { value: 'black', label: `黑名單 (${blacklist.length})` },
            { value: 'rules', label: `規則 (${rules.length})` },
            { value: 'tools', label: '預設卡片' },
          ]}
        />
      </div>

      {tab === 'white' && (
        <section aria-label="白名單管理">
          <div className="list" style={{ marginBottom: 10 }}>
            <div className="field">
              <input
                value={name}
                maxLength={40}
                placeholder="新增發送者，例如：中國信託、LINE Pay"
                aria-label="發送者名稱"
                style={{ flex: 1 }}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    add();
                  }
                }}
              />
              <button className="pill accent-pill" disabled={!name.trim()} onClick={add}>加入</button>
            </div>
          </div>
          {list.length === 0 ? (
            <EmptyState emoji="" title="白名單是空的" text="加入信任的發送者後，即使沒開「看得懂的直接記帳」，它的消費通知也會直接入帳。" />
          ) : (
            <div className="list">
              {list.map((n, idx) => (
                <div key={`${n}-${idx}`} className="row">
                  <span className="row-main">
                    <span className="row-title">{n}</span>
                    <span className="row-sub">發送者或卡片名稱完全相符時套用</span>
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="pill" onClick={() => void edit(n, idx)}>編輯</button>
                    <button className="pill" style={{ color: 'var(--danger)' }} onClick={() => remove(n)}>移除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'black' && (
        <section aria-label="黑名單管理">
          <div className="list" style={{ marginBottom: 10 }}>
            <div className="field">
              <input
                value={blockWord}
                maxLength={40}
                placeholder="封鎖發送者或關鍵字，如：停車折抵、小明"
                aria-label="新增黑名單"
                style={{ flex: 1 }}
                onChange={(e) => setBlockWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    addBlacklist();
                  }
                }}
              />
              <button type="button" className="pill" disabled={!blockWord.trim()} onClick={addBlacklist}>封鎖</button>
            </div>
          </div>
          {blacklist.length === 0 ? (
            <EmptyState emoji="" title="黑名單是空的" text="如果某些對話或廣告通知常被誤判進收件匣，加入黑名單就會永久安靜。" />
          ) : (
            <div className="list">
              {blacklist.map((b, idx) => (
                <div key={`${b}-${idx}`} className="row">
                  <span className="row-main">
                    <span className="row-title">{b}</span>
                    <span className="row-sub">命中時自動忽略，不跳審核通知</span>
                  </span>
                  <button type="button" className="pill" style={{ color: 'var(--danger)' }} onClick={() => update({ blacklist: blacklist.filter((x) => x !== b) })}>移除</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'rules' && (
        <section aria-label="自動改名與分類規則">
          <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <span>自動改名與分類規則（{rules.length}）</span>
            <button type="button" className="pill accent-pill" onClick={() => setRuleDraft(blankRule())}>＋ 新增規則</button>
          </div>
          {rules.length === 0 ? (
            <EmptyState emoji="✨" title="還沒有自訂改名／分類規則" text="設定關鍵字（例如通知裡的「遠東百貨板橋分公司」），之後自動入帳就會自動改成你指定的名稱（如「牛肉麵」）與類別（如「晚餐」）。" />
          ) : (
            <div className="list">
              {rules.map((r) => (
                <div key={r.id} className="row" style={{ opacity: r.enabled ? 1 : 0.55 }}>
                  <span className="row-main">
                    <span className="row-title">「{r.keyword}」</span>
                    <span className="row-sub">
                      {RULE_MATCH_LABEL[r.match]} · {ruleTargetSummary(r, catMap)}{r.hits > 0 ? ` · 命中 ${r.hits} 次` : ''}
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="pill" onClick={() => setRuleDraft({ ...r })}>編輯</button>
                    <button type="button" className="pill" style={{ color: 'var(--danger)' }} onClick={async () => { if (await ask(`刪除「${r.keyword}」這條規則？`)) { await deleteRule(r.id); snack('已刪除規則'); } }}>移除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'tools' && (
        <section aria-label="預設卡片對應">
          <div className="section-title" style={{ marginTop: 4 }}>已學習的卡片對應帳戶</div>
          {Object.keys(cfg.cardMap).length === 0 ? (
            <EmptyState emoji="💳" title="還沒有卡片對應紀錄" text="之後在確認或自動記帳時，系統會記住每張卡對應的帳戶；你也可以在這裡手動調整。" />
          ) : (
            <>
              <div className="list">
                {Object.entries(cfg.cardMap).map(([card, id]) => (
                  <div key={card} className="field">
                    <span className="label" style={{ flex: 1 }}>{card}</span>
                    <CustomSelect
                      title={`${card} 對應的帳戶`}
                      aria-label={`${card} 對應的帳戶`}
                      value={accMap.has(id) ? id : ''}
                      onChange={(val) => {
                        const map = { ...cfg.cardMap };
                        if (val) map[card] = val; else delete map[card];
                        update({ cardMap: map });
                      }}
                      options={[
                        { value: '', label: '（不指定，自動判斷）' },
                        ...accounts.filter((a) => a.type !== 'loan').map((a) => ({ value: a.id, label: `${iconEmoji(a.icon)} ${a.name}` })),
                      ]}
                    />
                  </div>
                ))}
              </div>
              <p className="muted" style={{ fontSize: '0.78rem', margin: '6px 8px' }}>你在這裡手動指定的對應不會被系統自動覆蓋。</p>
            </>
          )}
        </section>
      )}

      <RuleEditorSheet draft={ruleDraft} onChange={setRuleDraft} onClose={() => setRuleDraft(null)} />

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
                  <b>比對方式（來源名稱完全相符）：</b><br />
                  比對捷徑提供的發送者、卡片或 App 名稱，不分大小寫與全半形；內文或商家提到銀行名稱不會命中。<br />
                  LINE 使用通知第一行的發送者標題，缺少標題時保留待確認。這是來源欄位比對，不是銀行身分驗證。
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
