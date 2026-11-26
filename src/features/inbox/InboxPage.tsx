/**
 * 自動記帳收件匣：
 * ① 預計扣款：週期帳目的待確認 + 看起來是固定扣款、預計日到了的項目
 * ② 待確認：捷徑送來的交易、通知、Siri 一句話 → 一鍵記帳、編輯後記帳、略過
 * （iPhone 捷徑設定已獨立至「設定」→「加入 iPhone 捷徑」）
 */
import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { db } from '@/db/schema';
import { formatMoney, fromMinor, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { deleteTransactions, deleteTransfers } from '@/db/repo/ledger';
import {
  ackInbox, bookInboxEntries, inboxPrefix4, mergeDuplicate, loadInbox, markDuplicates, SOURCE_LABEL, useInboxCount,
  type InboxEntry,
} from '@/services/inbox';
import { saveSetting } from '@/db/repo/settings';
import { aiEnabledLocally, aiParseText } from '@/services/ai';
import { fallbackAccount, resolveDraft } from '@/services/quickentry';
import { snackUndo, useUI, askInput } from '@/stores/ui';
import { useSettings } from '@/stores/settings';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { CustomSelect } from '@/ui/form';
import { SwipeRow } from '@/ui/SwipeRow';
import { AiMark, CatIcon, Icon } from '@/ui/Icon';
import { bookForecast, confirmRulePending, loadForecast, registerForecast, skipForecast, skipRulePending, type ForecastData } from '@/services/forecast';
import type { ForecastItem } from '@/domain/forecast';
import { blankRule, RuleEditorSheet, type RuleDraft } from '@/features/settings/RuleEditorSheet';

const snack = (text: string, duration?: number) => useUI.getState().showSnack({ text, duration });

export default function InboxPage() {
  const navigate = useNavigate();
  const { list: accounts, map: accMap } = useAccounts();
  const { all: categories, map: catMap } = useCategories();
  const count = useInboxCount((s) => s.n);
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const today = todayKey();

  const recentAuto = useLiveQuery(async () => {
    const rows = await db.transactions.where('id').startsWith('inbox-').toArray();
    return rows.filter((t) => !t.deletedAt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }, [], []);

  const updateDraft = (itemId: number, idx: number, patch: { categoryId?: string; accountId?: string }) => {
    setEntries((prev) => prev?.map((entry) => (
      entry.item.id !== itemId ? entry : {
        ...entry,
        drafts: entry.drafts.map((d, di) => (di === idx ? { ...d, ...patch } : d)),
      }
    )) ?? null);
  };

  // 預計扣款：週期帳目的待確認 + 看起來是固定扣款、預計日到了的項目（本機推算）
  const [fc, setFc] = useState<ForecastData | null>(null);
  const loadFc = useCallback(() => loadForecast().then(setFc, () => setFc({ rules: [], predicted: [] })), []);
  useEffect(() => { void loadFc(); }, [loadFc]);
  const fcRun = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await loadFc(); } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };
  const bookFc = (p: ForecastItem) => fcRun(async () => {
    const id = await bookForecast(p);
    snackUndo(`已記下 ${p.name} ${formatMoney(p.amountMinor, p.currency)}`, async () => { await deleteTransactions([id]); await loadFc(); });
  });
  const editFc = (p: ForecastItem) => useUI.getState().openAdd({
    mode: 'expense', amount: fromMinor(p.amountMinor, p.currency).toString(), date: p.dueDate, accountId: p.accountId, categoryId: p.categoryId, note: p.name,
  });
  const fcCount = (fc?.rules.length ?? 0) + (fc?.predicted.length ?? 0);

  const reload = useCallback(async () => {
    try { setEntries(await loadInbox()); setError(''); } catch (e) { setError((e as Error).message); setEntries([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload, count]);

  // 「全部記帳」不含很可能重複的：那些請一則一則確認
  const ready = entries?.filter((e) => e.drafts.length && e.dup?.level !== 'strong' && !e.review) ?? [];

  const book = async (list: InboxEntry[]) => {
    setBusy(true);
    try {
      const r = await bookInboxEntries(list);
      snackUndo(`已記下 ${r.count} 筆${r.alreadyBooked ? `，${r.alreadyBooked} 則先前已入帳` : ''}${r.skipped ? `，${r.skipped} 則入帳失敗，保留待確認` : ''}${r.ackPending ? `，${r.ackPending} 則已儲存但尚待清除通知` : ''}`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      await reload();
    } catch (e) { snack((e as Error).message); } finally { setBusy(false); }
  };

  const merge = async (e: InboxEntry) => {
    try {
      if (await mergeDuplicate(e)) snack('已合併，沒有重複記帳');
      await reload();
    } catch (err) { snack((err as Error).message); }
  };

  const blockItem = async (e: InboxEntry) => {
    const def = (e.item.merchant || e.item.card || e.item.text.slice(0, 20)).trim();
    const word = await askInput({
      title: '加入自動記帳黑名單',
      message: '之後通知或發送者包含這個字詞時，會直接略過不進收件匣：',
      defaultValue: def,
      required: true,
      maxLength: 40,
      confirmText: '封鎖並清除',
    });
    if (!word) return;
    const st = useSettings.getState();
    const prev = st.inbox.blacklist ?? [];
    if (!prev.some((x) => x.toLowerCase() === word.toLowerCase())) {
      st.set('inbox', { ...st.inbox, blacklist: [...prev, word] });
    }
    try {
      await ackInbox([e.item.id]);
      snack(`已封鎖「${word}」並清除通知`);
      await reload();
    } catch (err) { snack(`已封鎖「${word}」，但通知尚未清除：${(err as Error).message}`); }
  };

  /** 左滑：自動取前 4 字加入白名單 */
  const whitelistBySwipe = async (e: InboxEntry) => {
    const word = inboxPrefix4(e.item, e.drafts[0]?.note);
    if (!word) { snack('這則通知沒有可辨識的來源名稱'); return; }
    const st = useSettings.getState();
    const prev = st.inbox.whitelist ?? [];
    const exists = prev.some((x) => x.normalize('NFKC').toLowerCase() === word.normalize('NFKC').toLowerCase());
    if (!exists) {
      const next = { ...st.inbox, whitelist: [...prev, word] };
      st.set('inbox', next);
      await saveSetting('inbox', next);
    }
    snackUndo(`已將「${word}」加入白名單（前 4 字自動相符）`, async () => {
      const cur = useSettings.getState();
      const restored = { ...cur.inbox, whitelist: (cur.inbox.whitelist ?? []).filter((x) => x !== word) };
      cur.set('inbox', restored);
      await saveSetting('inbox', restored);
    });
  };

  /** 右滑：自動取前 4 字加入黑名單並清除通知 */
  const blacklistBySwipe = async (e: InboxEntry) => {
    const word = inboxPrefix4(e.item, e.drafts[0]?.note);
    if (!word) { await blockItem(e); return; }
    const st = useSettings.getState();
    const prev = st.inbox.blacklist ?? [];
    if (!prev.some((x) => x.normalize('NFKC').toLowerCase() === word.normalize('NFKC').toLowerCase())) {
      const next = { ...st.inbox, blacklist: [...prev, word] };
      st.set('inbox', next);
      await saveSetting('inbox', next);
    }
    try {
      await ackInbox([e.item.id]);
      setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
      snack(`已將「${word}」加入黑名單（前 4 字自動封鎖）並清除通知`);
    } catch (err) { snack(`已將「${word}」加入黑名單，但通知尚未清除：${(err as Error).message}`); }
  };

  /** 規則看不懂的簡訊／通知：請 AI 解析成草稿（扣 1 點額度）。解析結果只改在畫面上，確認記帳才會寫入帳本 */
  const [aiBusyId, setAiBusyId] = useState<number | null>(null);
  const aiParse = async (e: InboxEntry) => {
    setAiBusyId(e.item.id);
    try {
      const { drafts } = await aiParseText((e.item.text || e.item.merchant).trim());
      if (!drafts.length) { snack('Cilo 也看不出金額，請手動記'); return; }
      const fb = await fallbackAccount();
      const list = await Promise.all(drafts.map((d) => resolveDraft(d, fb)));
      const next = (entries ?? []).map((x) => ({ ...x, ...(x.item.id === e.item.id ? { drafts: list } : {}) }));
      await markDuplicates(next);
      setEntries(next);
      snack('AI 已解析，確認後按「記帳」');
    } catch (err) { snack((err as Error).message); } finally { setAiBusyId(null); }
  };
  const skip = async (e: InboxEntry) => {
    try {
      await ackInbox([e.item.id]);
      setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
    } catch (err) { snack(`略過失敗，通知仍保留：${(err as Error).message}`); }
  };

  const edit = (e: InboxEntry) => {
    const d = e.drafts[0];
    const base = { inboxId: String(e.item.id), inboxCard: e.item.card || undefined };
    if (e.drafts.length > 1) useUI.getState().openAdd({ ...base, quickText: e.item.text });
    else if (d) {
      useUI.getState().openAdd({
        ...base, mode: d.kind, amount: String(d.amount), currency: d.currency, date: d.date, time: d.time, accountId: d.accountId, toAccountId: d.toAccountId,
        categoryId: d.categoryId, note: d.note, tagIds: d.tagIds.length ? d.tagIds : undefined, merchant: e.item.merchant || undefined,
      });
    } else useUI.getState().openAdd({ ...base, note: (e.item.merchant || e.item.text).slice(0, 200) });
  };

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>收件匣</h1>
        <button className="icon-btn" aria-label="自動入帳偏好" title="自動入帳偏好" onClick={() => navigate('/settings/inbox-whitelist')}><Icon name="shieldCheck" /></button>
        <button className="icon-btn" aria-label="重新整理" onClick={() => void reload()}><Icon name="repeat" /></button>
      </header>

      {fcCount > 0 && (
        <>
          <div className="section-title">預計扣款（{fcCount}）</div>
          <div className="list">
            {fc?.rules.map((it) => {
              const t = it.rule.template;
              const cur = t.currency ?? 'TWD';
              const c = t.categoryId ? catMap.get(t.categoryId) : undefined;
              return (
                <div key={it.id} className="row inbox-row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={it.rule.kind === 'subscription' ? 'repeat' : c?.icon ?? 'repeat'} size={16} /></span>
                  <span className="row-main">
                    <span className="row-title">{it.rule.name}</span>
                    <span className="row-sub">🔁 {shortDate(it.date, today)} · 週期帳目 · {accMap.get(t.accountId ?? '')?.name ?? '?'}</span>
                  </span>
                  <span className="num neg">{formatMoney(t.amountMinor ?? 0, cur)}</span>
                  <span className="inbox-actions">
                    <button className="pill accent-pill" disabled={busy} onClick={() => void fcRun(() => confirmRulePending(it))}>確認入帳</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => skipRulePending(it))}>略過</button>
                  </span>
                </div>
              );
            })}
            {fc?.predicted.map((p) => {
              const c = catMap.get(p.categoryId);
              return (
                <div key={p.id} className="row inbox-row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={c?.icon ?? 'sparkles'} size={16} /></span>
                  <span className="row-main">
                    <span className="row-title">{p.name}</span>
                    <span className="row-sub" style={{ whiteSpace: 'normal' }}>
                      🔮 預計 {shortDate(p.dueDate, today)}{p.lateDays > 0 ? `（已過 ${p.lateDays} 天）` : ''} · {p.period === 'week' ? '每週' : p.period === 'month' ? '每月' : '每年'}固定 · {accMap.get(p.accountId)?.name ?? '?'}
                    </span>
                  </span>
                  <span className="num neg">{formatMoney(p.amountMinor, p.currency)}</span>
                  <span className="inbox-actions">
                    <button className="pill accent-pill" disabled={busy} onClick={() => void bookFc(p)}>記帳</button>
                    <button className="pill" disabled={busy} onClick={() => editFc(p)}>編輯</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => registerForecast(p))} title="之後每期到了固定提醒你確認">登記成週期</button>
                    <button className="pill" disabled={busy} onClick={() => void fcRun(() => skipForecast(p.id))}>略過</button>
                  </span>
                </div>
              );
            })}
          </div>
          {fc && fc.predicted.length > 0 && <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 4px 0' }}>🔮 是從你的記帳紀錄推算的（連續幾期金額差不多），不一定真的扣了；已經手動記過的會自動消失。</p>}
        </>
      )}

      <div className="section-title">待確認{entries?.length ? `（${entries.length}）` : ''}</div>
      {error && <div className="card"><p style={{ margin: 0 }}>收件匣暫時讀不到：{error}</p></div>}
      {entries === null ? <SkeletonRows n={2} /> : entries.length === 0 ? (
        <EmptyState emoji="📭" title="收件匣是空的" text="捷徑送來的消費通知與預計扣款會出現在這裡核對記帳。" />
      ) : (
        <>
          <p className="muted" style={{ fontSize: '0.76rem', margin: '0 4px 6px' }}>
            左滑加入白名單、右滑加入黑名單（自動擷取前 4 字作為相符標準）
          </p>
          <div className="list">
            {entries.map((e) => {
              const src = SOURCE_LABEL[e.item.source] ?? SOURCE_LABEL.other;
              if (!e.drafts.length) {
                return (
                  <SwipeRow
                    key={e.item.id}
                    flat
                    action={{ label: '白名單', icon: 'shieldCheck', tone: 'accent' }}
                    leftAction={{ label: '黑名單', icon: 'close', tone: 'danger' }}
                    onDelete={() => void whitelistBySwipe(e)}
                    onEdit={() => void blacklistBySwipe(e)}
                  >
                    <div className="row inbox-row">
                      <span className="cat-icon sm" aria-hidden="true"><CatIcon icon={src.icon} size={16} /></span>
                      <span className="row-main">
                        <span className="row-title">{e.item.merchant || e.item.text.slice(0, 40) || '（沒有內容）'}</span>
                        <span className="row-sub" style={{ whiteSpace: 'normal' }}>{src.label} · {e.review || '看不懂金額，請手動記'}</span>
                      </span>
                      <span className="inbox-actions">
                        {aiEnabledLocally() && (e.item.text || e.item.merchant) && <button className="pill accent-pill" disabled={aiBusyId === e.item.id} onClick={() => void aiParse(e)}>{aiBusyId === e.item.id ? '解析中…' : <><AiMark /> Cilo 解析</>}</button>}
                        <button className="pill" onClick={() => setRuleDraft(blankRule('expense', '', e.item.merchant || e.item.text.slice(0, 60)))}>存為規則</button>
                        <button className="pill" onClick={() => void blockItem(e)}>封鎖</button>
                        <button className="pill" onClick={() => edit(e)}>手動記</button>
                        <button className="pill" onClick={() => void skip(e)} aria-label="略過">略過</button>
                      </span>
                    </div>
                  </SwipeRow>
                );
              }
              return (
                <SwipeRow
                  key={e.item.id}
                  flat
                  action={{ label: '白名單', icon: 'shieldCheck', tone: 'accent' }}
                  leftAction={{ label: '黑名單', icon: 'close', tone: 'danger' }}
                  onDelete={() => void whitelistBySwipe(e)}
                  onEdit={() => void blacklistBySwipe(e)}
                >
                  {e.drafts.map((d, i) => {
                    const c = d.categoryId ? catMap.get(d.categoryId) : undefined;
                    const acc = accMap.get(d.accountId);
                    const cur = d.currency ?? acc?.currency ?? 'TWD';
                    return (
                      <div key={`${e.item.id}-${i}`} className="row inbox-row">
                        <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={d.kind === 'transfer' ? 'repeat' : c?.icon ?? src.icon} size={16} /></span>
                        <span className="row-main">
                          <span className="row-title">{d.note || c?.name || src.label}</span>
                          <span className="row-sub">{src.icon} {shortDate(d.date, today)}{e.item.card ? ` · ${e.item.card}` : ''}</span>
                          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                            {d.kind !== 'transfer' && (
                              <CustomSelect<string>
                                className="mini-select"
                                title="快速切換分類"
                                aria-label="快速切換分類"
                                value={d.categoryId ?? ''}
                                onChange={(val) => updateDraft(e.item.id, i, { categoryId: val })}
                                options={categories
                                  .filter((cat) => !cat.archived && !cat.deletedAt && cat.kind === (d.kind === 'income' ? 'income' : 'expense'))
                                  .map((cat) => ({ value: cat.id, label: categoryLabel(catMap, cat.id) }))}
                              />
                            )}
                            <CustomSelect<string>
                              className="mini-select"
                              title="快速切換帳戶"
                              aria-label="快速切換帳戶"
                              value={d.accountId}
                              onChange={(val) => updateDraft(e.item.id, i, { accountId: val })}
                              options={accounts
                                .filter((a) => !a.archived && !a.deletedAt && a.type !== 'loan' && a.type !== 'brokerage')
                                .map((a) => ({ value: a.id, label: a.name }))}
                            />
                          </span>
                        </span>
                        <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>
                        {i === e.drafts.length - 1 && e.review && (
                          <p className="inbox-dup strong" role="note">⚠️ {e.review}</p>
                        )}
                        {i === e.drafts.length - 1 && e.dup && (
                          <p className={`inbox-dup ${e.dup.level}`} role="note">
                            {e.dup.level === 'strong' ? '⚠️ 很可能重複：' : 'ℹ️ 金額相同：'}
                            {e.dup.from === 'ledger' ? `帳本裡已有 ${e.dup.label}` : `和 ${e.dup.label}是同一次消費？`}
                          </p>
                        )}
                        {i === e.drafts.length - 1 && (
                          <span className="inbox-actions">
                            {e.dup?.level === 'strong' ? (
                              <>
                                <button className="pill accent-pill" onClick={() => void merge(e)}>合併（不重複記）</button>
                                <button className="pill" disabled={busy} onClick={() => void book([e])}>仍要記帳</button>
                                <button className="pill" onClick={() => setRuleDraft(blankRule(d.kind === 'income' ? 'income' : 'expense', d.categoryId || '', e.item.merchant || d.note || e.item.text.slice(0, 60)))}>存為規則</button>
                                <button className="pill" onClick={() => void blockItem(e)}>封鎖</button>
                                <button className="pill" onClick={() => edit(e)}>編輯</button>
                                <button className="pill" onClick={() => void skip(e)}>略過</button>
                              </>
                            ) : (
                              <>
                                <button className="pill accent-pill" disabled={busy} onClick={() => void book([e])}>記帳</button>
                                {e.dup && <button className="pill" onClick={() => void merge(e)}>合併</button>}
                                <button className="pill" onClick={() => setRuleDraft(blankRule(d.kind === 'income' ? 'income' : 'expense', d.categoryId || '', e.item.merchant || d.note || e.item.text.slice(0, 60)))}>存為規則</button>
                                <button className="pill" onClick={() => void blockItem(e)}>封鎖</button>
                                <button className="pill" onClick={() => edit(e)}>編輯</button>
                                <button className="pill" onClick={() => void skip(e)}>略過</button>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </SwipeRow>
              );
            })}
          </div>
          {ready.length > 1 && <button className="btn" disabled={busy} onClick={() => void book(ready)}>全部記帳（{ready.reduce((n, e) => n + e.drafts.length, 0)} 筆）</button>}
        </>
      )}

      {recentAuto.length > 0 && (
        <>
          <div className="section-title">近期已自動入帳（{recentAuto.length}）</div>
          <div className="list">
            {recentAuto.map((t) => {
              const c = t.categoryId ? catMap.get(t.categoryId) : undefined;
              const acc = accMap.get(t.accountId);
              return (
                <div key={t.id} className="row inbox-row">
                  <span className="cat-icon sm" style={{ ['--c' as string]: c?.color }} aria-hidden="true"><CatIcon icon={c?.icon ?? 'sparkles'} size={16} /></span>
                  <span className="row-main">
                    <span className="row-title">{t.note || t.merchant || c?.name || '自動記帳'}</span>
                    <span className="row-sub">{shortDate(t.date, today)} · {c?.name ?? '未分類'} · {acc?.name ?? '?'}</span>
                  </span>
                  <span className={`num ${t.type === 'income' ? 'pos' : 'neg'}`}>{formatMoney(t.amountMinor, t.currency)}</span>
                  <span className="inbox-actions">
                    <button className="pill" onClick={() => useUI.getState().editTx(t.id)}>編輯</button>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <RuleEditorSheet
        draft={ruleDraft}
        onChange={setRuleDraft}
        onClose={() => setRuleDraft(null)}
        onSaved={() => void reload()}
      />
    </main>
  );
}
