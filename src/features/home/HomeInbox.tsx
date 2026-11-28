/**
 * 首頁收件匣：隨時核對自動記帳送來的待確認項目。
 * 一眼看到前幾筆（來源、金額、是否可疑），可直接「記帳」或「略過」；複雜的（看不懂金額、疑似重複）點進收件匣處理。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '@/app/hooks';
import { formatMoney, toMinor } from '@/domain/money';
import { shortDate } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { AUTH_ENABLED } from '@/stores/auth';
import { snackUndo, useUI } from '@/stores/ui';
import { useInboxCount } from '@/services/inboxCount';
import type { FeedbackField } from '@/db/types';
import type { InboxEntry } from '@/services/inbox';
import { InboxDecisionMeta, ScopeRuleSheet, SplitSkipControl } from '@/features/inbox/InboxDecisionUI';
import { Icon } from '@/ui/Icon';

const SHOW = 3;
const snack = (text: string) => useUI.getState().showSnack({ text });

export default function HomeInbox() {
  const navigate = useNavigate();
  const count = useInboxCount((s) => s.n);
  const { map: accMap } = useAccounts();
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scopeEntry, setScopeEntry] = useState<InboxEntry | null>(null);
  const [editedMap, setEditedMap] = useState<Record<number, Array<{ field: FeedbackField; beforeValue?: string; afterValue?: string }>>>({});
  const today = todayKey();

  const reload = useCallback(async () => {
    try {
      const m = await import('@/services/inbox');
      setEntries(await m.loadInbox());
      setLoadError(null);
    } catch (err) {
      const msg = (err as Error)?.message;
      if (msg) {
        setLoadError(msg);
        return;
      }
      const { getInboxSyncState } = await import('@/services/inbox');
      const state = await getInboxSyncState().catch(() => ({ lastSyncAt: null, lastError: null }));
      setLoadError(state.lastError || '收件匣載入失敗');
    }
  }, []);
  useEffect(() => {
    if (AUTH_ENABLED) void reload();
  }, [reload, count]);

  if (!AUTH_ENABLED) return null;

  const book = async (e: InboxEntry) => {
    setBusy(true);
    try {
      const [{ confirmInboxEntry }, { deleteTransactions, deleteTransfers }] = await Promise.all([
        import('@/services/inbox'),
        import('@/db/repo/ledger'),
      ]);
      const editedFields = editedMap[e.item.id];
      const r = await confirmInboxEntry(e, editedFields?.length ? { editedFields } : undefined);
      snackUndo(`已記下 ${r.count} 筆`, async () => {
        if (r.txIds.length) await deleteTransactions(r.txIds);
        if (r.transferIds.length) await deleteTransfers(r.transferIds);
      });
      await reload();
    } catch (err) {
      snack((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const skip = async (e: InboxEntry, reason: 'non_tx' | 'duplicate' | 'ignore') => {
    setBusy(true);
    try {
      const { skipInboxEntry } = await import('@/services/inbox');
      await skipInboxEntry(e, reason);
      setEntries((l) => l?.filter((x) => x.item.id !== e.item.id) ?? null);
    } catch (err) {
      snack((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const settleDebtEntry = async (e: InboxEntry, debtId: string, personName: string) => {
    setBusy(true);
    try {
      const { settleInboxEntryWithDebt } = await import('@/services/inbox');
      const accId = e.drafts[0]?.accountId;
      await settleInboxEntryWithDebt(e, debtId, accId ? { accountId: accId } : undefined);
      snack(`已沖銷 ${personName} 的應收帳款`);
      await reload();
    } catch (err) {
      snack((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applySecondCandidate = (e: InboxEntry, cand: NonNullable<InboxEntry['secondCandidate']>) => {
    const d = e.drafts[0];
    if (!d) return;
    const edits: Array<{ field: FeedbackField; beforeValue?: string; afterValue?: string }> = [];
    if (cand.categoryId && cand.categoryId !== d.categoryId) {
      edits.push({ field: 'category', beforeValue: d.categoryId, afterValue: cand.categoryId });
    }
    if (cand.accountId && cand.accountId !== d.accountId) {
      edits.push({ field: 'account', beforeValue: d.accountId, afterValue: cand.accountId });
    }
    if (edits.length) {
      setEditedMap((prev) => ({ ...prev, [e.item.id]: edits }));
    }
    setEntries((prev) => prev?.map((x) => (
      x.item.id !== e.item.id ? x : {
        ...x,
        drafts: x.drafts.map((dr, idx) => (idx === 0 ? {
          ...dr,
          ...(cand.categoryId ? { categoryId: cand.categoryId } : {}),
          ...(cand.accountId ? { accountId: cand.accountId } : {}),
        } : dr)),
      }
    )) ?? null);
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

  const list = entries ?? [];
  const shown = list.slice(0, SHOW);
  const statusLabel = loadError ? '讀取失敗' : entries === null ? '載入中…' : list.length ? '全部查看' : '沒有待確認';

  return (
    <section className="home-inbox" aria-label="收件匣">
      <button type="button" className="home-inbox-head" onClick={() => navigate('/inbox')}>
        <span>📥 收件匣{list.length ? `（${list.length} 筆待確認）` : ''}</span>
        <span className="muted home-inbox-more">{statusLabel}<Icon name="chevronR" size={14} /></span>
      </button>
      {loadError && (
        <div className="list">
          <div className="row inbox-row" role="alert">
            <span className="row-main">
              <span className="row-title">收件匣暫時讀不到</span>
              <span className="row-sub" style={{ whiteSpace: 'normal' }}>{loadError}</span>
            </span>
            <span className="inbox-actions">
              <button type="button" className="pill accent-pill" onClick={() => void reload()}>重試</button>
            </span>
          </div>
        </div>
      )}
      {shown.length > 0 && (
        <div className="list">
          {shown.map((e) => {
            const d = e.drafts[0];
            const acc = d ? accMap.get(d.accountId) : undefined;
            const cur = d ? d.currency ?? acc?.currency ?? 'TWD' : 'TWD';
            const title = d?.note || e.item.merchant || e.item.text.slice(0, 30) || '（沒有內容）';
            return (
              <div key={e.item.id} className="row inbox-row">
                <span className="row-main">
                  <span className="row-title">{title}</span>
                  <span className="row-sub" style={{ whiteSpace: 'normal' }}>
                    {d ? `${shortDate(d.date, today)} · ${acc?.name ?? '?'}` : '看不懂金額，請點「入帳」或「編輯」補填'}
                    {e.matchedDebts && e.matchedDebts.length > 0
                      ? ` · 🤝 疑為朋友還款：${e.matchedDebts.map((md) => `${md.personName} ${formatMoney(md.amountMinor, md.currency)}`).join('／')}`
                      : e.review ? ` · ⚠️ ${e.review}` : e.dup ? ' · ⚠️ 可能重複' : ''}
                  </span>
                  <InboxDecisionMeta
                    entry={e}
                    compact
                    onApplySecondCandidate={(cand) => applySecondCandidate(e, cand)}
                  />
                </span>
                {d && <span className={`num ${d.kind === 'income' ? 'pos' : 'neg'}`}>{formatMoney(toMinor(d.amount, cur), cur)}</span>}
                <span className="inbox-actions">
                  {e.matchedDebts && e.matchedDebts.length === 1 && (
                    <button
                      type="button"
                      className="pill accent-pill"
                      disabled={busy}
                      onClick={() => void settleDebtEntry(e, e.matchedDebts![0].debtId, e.matchedDebts![0].personName)}
                    >
                      沖銷 {e.matchedDebts[0].personName} 應收
                    </button>
                  )}
                  {e.matchedDebts && e.matchedDebts.length > 1 && e.matchedDebts.map((md) => (
                    <button
                      key={md.debtId}
                      type="button"
                      className="pill accent-pill"
                      disabled={busy}
                      onClick={() => void settleDebtEntry(e, md.debtId, md.personName)}
                    >
                      沖銷 {md.personName}
                    </button>
                  ))}
                  <button className={e.matchedDebts?.length ? 'pill' : 'pill accent-pill'} disabled={busy} onClick={() => (d ? void book(e) : edit(e))}>入帳</button>
                  {d && <button type="button" className="pill" disabled={busy} onClick={() => setScopeEntry(e)}>以後這類都這樣</button>}
                  <button className="pill" disabled={busy} onClick={() => edit(e)}>編輯</button>
                  <SplitSkipControl disabled={busy} onSkip={(reason) => skip(e, reason)} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      <ScopeRuleSheet entry={scopeEntry} onClose={() => setScopeEntry(null)} onCreated={() => void reload()} />
    </section>
  );
}
