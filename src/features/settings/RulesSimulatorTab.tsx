import { useState } from 'react';
import { categoryLabel, useAccounts, useCategories } from '@/app/hooks';
import { db } from '@/db/schema';
import type { Transaction } from '@/db/types';
import { fromMinor } from '@/domain/money';
import { addDays, todayKey } from '@/domain/period';
import { evaluateDraftContext, type DraftContextEvaluation } from '@/services/autocat';
import { previewAutoBook, type InboxRaw } from '@/services/inbox';
import { CONFIDENCE_LABEL, formatDecisionReason } from '@/features/inbox/InboxDecisionUI';
import { Segmented } from '@/ui/controls';
import { SelectField, TextField } from '@/ui/form';

type SimSource = 'notify' | 'email' | 'applepay' | 'line';

interface SimPreviewResult {
  preview: Awaited<ReturnType<typeof previewAutoBook>>;
  evalCtx: DraftContextEvaluation;
}

interface DryRunDiff {
  tx: Transaction;
  oldCategoryId: string;
  newCategoryId?: string;
  oldAccountId: string;
  newAccountId?: string;
  ruleLabel: string;
  isShadow: boolean;
}

export function RulesSimulatorTab() {
  const { map: catMap } = useCategories();
  const { map: accMap } = useAccounts();

  const [source, setSource] = useState<SimSource>('notify');
  const [card, setCard] = useState('');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TWD');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [simBusy, setSimBusy] = useState(false);
  const [simResult, setSimResult] = useState<SimPreviewResult | null>(null);

  const [dryBusy, setDryBusy] = useState(false);
  const [drySummary, setDrySummary] = useState<{ scanned: number; diffs: DryRunDiff[] } | null>(null);

  const runSimulation = async () => {
    setSimBusy(true);
    try {
      const mappedSource: InboxRaw['source'] = source === 'line' ? 'notify' : source;
      const effectiveCard = source === 'line' ? (card.trim() || 'LINE') : card.trim();
      const parsedAmt = amount.trim() && Number.isFinite(Number(amount)) ? Number(amount) : undefined;
      const rawText = [text.trim(), parsedAmt !== undefined && !/\d/.test(text) ? `${currency} ${parsedAmt}` : '']
        .filter(Boolean)
        .join(' ');

      const [preview, evalCtx] = await Promise.all([
        previewAutoBook(rawText || text, effectiveCard, '', {
          source: mappedSource,
          amount: amount.trim() || undefined,
        }),
        evaluateDraftContext({
          rawText: text.trim(),
          kind,
          amount: parsedAmt,
          source: source === 'line' ? 'line' : source,
          card: effectiveCard || undefined,
          currency,
        }),
      ]);
      setSimResult({ preview, evalCtx });
    } finally {
      setSimBusy(false);
    }
  };

  const runDryRun = async () => {
    setDryBusy(true);
    try {
      const since = addDays(todayKey(), -90);
      const txs = await db.transactions.where('date').aboveOrEqual(since).toArray();
      const live = txs.filter(
        (t) => !t.deletedAt && (t.type === 'expense' || t.type === 'income') && !t.stockTradeId && !t.dividendId,
      );
      const diffs: DryRunDiff[] = [];
      for (const tx of live) {
        const rawText = [tx.merchant, tx.note].filter(Boolean).join(' ');
        const evalRes = await evaluateDraftContext({
          rawText,
          merchant: tx.merchant,
          kind: tx.type as 'expense' | 'income',
          amount: fromMinor(tx.amountMinor, tx.currency).toNumber(),
          currency: tx.currency,
          projectId: tx.projectId,
        });
        const cand = evalRes.primary ?? evalRes.shadowPredictions[0];
        if (!cand) continue;
        const nextCat = cand.rule.categoryId || undefined;
        const nextAcc = cand.rule.accountId || undefined;
        const catChanged = Boolean(nextCat && nextCat !== tx.categoryId);
        const accChanged = Boolean(nextAcc && nextAcc !== tx.accountId);
        if (catChanged || accChanged) {
          diffs.push({
            tx,
            oldCategoryId: tx.categoryId,
            newCategoryId: catChanged ? nextCat : undefined,
            oldAccountId: tx.accountId,
            newAccountId: accChanged ? nextAcc : undefined,
            ruleLabel: cand.rule.name || cand.rule.rawKeyword || cand.rule.merchantAlias || cand.rule.id,
            isShadow: !evalRes.primary,
          });
        }
      }
      setDrySummary({ scanned: live.length, diffs });
    } finally {
      setDryBusy(false);
    }
  };

  const firstDraft = simResult?.preview.drafts[0];
  const confidence = simResult?.preview.confidence ?? simResult?.evalCtx.confidence;
  const reasons = simResult?.preview.decisionReasons?.length
    ? simResult.preview.decisionReasons
    : simResult?.evalCtx.reasons ?? [];

  return (
    <div data-testid="rules-simulator-tab">
      <div className="section-title">模擬輸入</div>
      <div className="list">
        <SelectField
          label="來源"
          value={source}
          onChange={setSource}
          options={[
            { value: 'notify', label: '手機通知 (notify)' },
            { value: 'email', label: 'Email (email)' },
            { value: 'applepay', label: 'Apple Pay (applepay)' },
            { value: 'line', label: 'LINE (line)' },
          ]}
        />
        <TextField label="卡片 / 末四碼" value={card} onChange={setCard} placeholder="例如：玉山 Unicard 或 8899" />
        <TextField label="通知 / 交易文字" value={text} onChange={setText} placeholder="例如：於 全聯福利中心 消費 NT$320" />
        <TextField label="金額" value={amount} onChange={setAmount} placeholder="選填，例如 320" />
        <SelectField
          label="幣別"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: 'TWD', label: 'TWD 新台幣' },
            { value: 'USD', label: 'USD 美元' },
            { value: 'JPY', label: 'JPY 日圓' },
            { value: 'EUR', label: 'EUR 歐元' },
            { value: 'HKD', label: 'HKD 港幣' },
            { value: 'CNY', label: 'CNY 人民幣' },
          ]}
        />
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Segmented
            value={kind}
            ariaLabel="交易類型"
            onChange={setKind}
            options={[
              { value: 'expense', label: '支出' },
              { value: 'income', label: '收入' },
            ]}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '8px 0 12px', flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={simBusy} onClick={() => void runSimulation()}>
          {simBusy ? '模擬中…' : '執行模擬預覽'}
        </button>
        <button type="button" className="btn secondary" disabled={dryBusy} onClick={() => void runDryRun()}>
          {dryBusy ? '試跑中…' : '近 90 天歷史資料 Dry-run'}
        </button>
      </div>

      {simResult && (
        <div className="card" data-testid="simulator-preview-result" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>模擬結果</div>
          <div style={{ display: 'grid', gap: 4, fontSize: '0.86rem' }}>
            <div>
              草稿金額：{firstDraft ? `${firstDraft.amount} ${firstDraft.currency ?? currency}` : (amount || '未解析')}
            </div>
            <div>
              商家別名：{simResult.evalCtx.merchantAlias.alias || '（無）'}
            </div>
            <div>
              建議分類：{firstDraft?.categoryId ? categoryLabel(catMap, firstDraft.categoryId) : (simResult.evalCtx.primary?.rule.categoryId ? categoryLabel(catMap, simResult.evalCtx.primary.rule.categoryId) : '未指定')}
            </div>
            <div>
              建議帳戶：{firstDraft?.accountId ? (accMap.get(firstDraft.accountId)?.name ?? firstDraft.accountId) : (simResult.evalCtx.primary?.rule.accountId ? (accMap.get(simResult.evalCtx.primary.rule.accountId)?.name ?? simResult.evalCtx.primary.rule.accountId) : '未指定')}
            </div>
            {confidence && (
              <div>信心等級：{CONFIDENCE_LABEL[confidence]}</div>
            )}
            {reasons.length > 0 && (
              <div>決策理由：{reasons.map(formatDecisionReason).join('、')}</div>
            )}
            {simResult.preview.secondCandidate && (
              <div>第二候選：{simResult.preview.secondCandidate.label}</div>
            )}
            {simResult.preview.shadowMatch && (
              <div style={{ color: 'var(--accent-text)' }}>觀察期預測：{simResult.preview.shadowMatch.label}</div>
            )}
            {simResult.preview.driftWarning && (
              <div style={{ color: 'var(--warning, #b45309)' }}>格式漂移警示：{simResult.preview.driftWarning}</div>
            )}
          </div>
        </div>
      )}

      {drySummary && (
        <div className="card" data-testid="dryrun-result">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>近 90 天歷史資料 Dry-run（唯讀）</div>
          <p className="muted" style={{ fontSize: '0.84rem', margin: '0 0 8px' }}>
            共掃描 {drySummary.scanned} 筆近 90 天帳目，有 {drySummary.diffs.length} 筆分類或帳戶會受影響
          </p>
          {drySummary.diffs.length === 0 ? (
            <div className="muted" style={{ fontSize: '0.84rem' }}>沒有歷史帳目會改變分類或帳戶。</div>
          ) : (
            <div className="list">
              {drySummary.diffs.slice(0, 50).map((d) => (
                <div key={d.tx.id} className="row">
                  <div className="row-main">
                    <div className="row-title">
                      {d.tx.date} · {d.tx.merchant || d.tx.note || '（無備註）'}
                      {d.isShadow ? '（觀察期）' : ''}
                    </div>
                    <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                      規則：{d.ruleLabel}
                      {d.newCategoryId && ` · 分類：${categoryLabel(catMap, d.oldCategoryId)} → ${categoryLabel(catMap, d.newCategoryId)}`}
                      {d.newAccountId && ` · 帳戶：${accMap.get(d.oldAccountId)?.name ?? d.oldAccountId} → ${accMap.get(d.newAccountId)?.name ?? d.newAccountId}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
