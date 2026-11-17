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
import { previewAutoBook } from '@/services/inbox';
import { useSettings } from '@/stores/settings';
import { askInput, useUI } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { AccountField, SwitchField } from '@/ui/form';
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
  const [name, setName] = useState('');
  const [blockWord, setBlockWord] = useState('');
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const addBlacklist = () => {
    const n = blockWord.trim().slice(0, 40);
    if (!n) return;
    if (blacklist.some((x) => x.toLowerCase() === n.toLowerCase())) { snack('這個項目已經在黑名單裡了'); return; }
    update({ blacklist: [...blacklist, n] });
    setBlockWord('');
    snack(`已封鎖「${n}」：之後符合的通知將直接忽略`);
  };

  const runPreview = async () => {
    const q = testText.trim();
    if (!q) return;
    const r = await previewAutoBook(q);
    if (r.verdict.trust === 'drop') {
      setTestResult('🚫 會被黑名單或聊天過濾直接忽略（不進收件匣）');
      return;
    }
    if (!r.drafts.length) {
      setTestResult('📥 看不懂金額，會留在收件匣等你手動記帳');
      return;
    }
    const d = r.drafts[0];
    const catName = d.categoryId ? (catMap.get(d.categoryId)?.name ?? '未分類') : '轉帳';
    const accName = accMap.get(d.accountId)?.name ?? '預設帳戶';
    const modeLabel = (cfg.autoBook || r.whitelisted) && r.verdict.trust === 'ok' ? '⚡ 直接自動入帳' : '📥 留在收件匣待確認';
    setTestResult(`${modeLabel} →「${d.note}」· $${d.amount} · ${catName} · ${accName}`);
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

      <div className="section-title">黑名單（{blacklist.length}）</div>
      <div className="list">
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

      <div className="section-title">規則試跑測試</div>
      <div className="card">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="貼上一段銀行／LINE 通知試跑看看…"
            aria-label="測試通知文字"
            style={{ flex: 1 }}
          />
          <button type="button" className="pill accent-pill" disabled={!testText.trim()} onClick={() => void runPreview()}>試跑</button>
        </div>
        {testResult && <p style={{ margin: '8px 0 0', fontSize: '0.88rem' }}>{testResult}</p>}
      </div>

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

      <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>自動改名與分類規則（{rules.length}）</span>
        <button type="button" className="pill accent-pill" onClick={() => setRuleDraft(blankRule())}>＋ 新增</button>
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
                <button type="button" className="pill" style={{ color: 'var(--danger)' }} onClick={() => void deleteRule(r.id).then(() => snack('已刪除規則'))}>移除</button>
              </div>
            </div>
          ))}
        </div>
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
