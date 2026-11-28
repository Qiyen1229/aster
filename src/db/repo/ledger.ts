/**
 * 帳目／轉帳存取層：所有會影響帳戶餘額的寫入都必須經過這裡，
 * 並在同一個 IndexedDB 交易中更新 accounts.balanceMinor，確保「帳目 ↔ 餘額」永遠一致。
 */
import Dexie from 'dexie';
import { db, uid } from '../schema';
import type { Debt, Person, Transaction, Transfer, TxType } from '../types';
import { allocate, convertMinor } from '@/domain/money';
import { transferEffects, txEffect } from '@/domain/ledger';
import { getRate } from '@/services/fx';
import { recordFeedback } from '@/services/decisionLog';
import { getSetting } from './settings';

export interface TxInput {
  id?: string;
  type: TxType;
  accountId: string;
  categoryId: string;
  amountMinor: number;
  currency: string;
  /** 原幣→帳戶幣別匯率；未給時自動取用匯率表 */
  fxRateDec?: string;
  date: string;
  ts: number;
  note?: string;
  merchant?: string;
  invoiceNo?: string;
  tagIds?: string[];
  projectId?: string;
  attachmentIds?: string[];
  isSample?: boolean;
  excludeFromBudget?: boolean;
  excludeFromStats?: boolean;
  transferId?: string;
  recurringRuleId?: string;
  installmentId?: string;
  installmentNo?: number;
  stockTradeId?: string;
  dividendId?: string;
  accountSource?: string;
  categorySource?: string;
  reconcileTargetId?: string;
  decisionId?: string;
  split?: Transaction['split'];
}

/**
 * 調整帳戶快取餘額。刻意寫成 Dexie Promise 鏈（非 async function），
 * 減少原生 await 巢狀層數，避免 IndexedDB 交易在巢狀呼叫中提前提交（PrematureCommitError）。
 */
function bump(accountId: string, delta: number): Promise<unknown> {
  if (delta === 0) return Dexie.Promise.resolve();
  return db.accounts.get(accountId).then((acc) => {
    if (!acc) throw new Error(`找不到帳戶 ${accountId}`);
    const next = acc.balanceMinor + delta;
    if (!Number.isSafeInteger(next)) throw new RangeError('帳戶餘額超出範圍');
    return db.accounts.update(accountId, { balanceMinor: next, updatedAt: Date.now() });
  });
}

/** 依帳戶幣別、主幣別換算金額 */
export async function resolveAmounts(input: TxInput): Promise<Pick<Transaction, 'accountAmountMinor' | 'baseAmountMinor' | 'fxRateDec'>> {
  if (!Number.isSafeInteger(input.amountMinor) || (input.type !== 'adjust' && input.amountMinor < 0)) throw new Error('金額必須是非負的整數最小單位');
  const acc = await db.accounts.get(input.accountId);
  if (!acc) throw new Error('帳戶不存在');
  const base = await getSetting('baseCurrency');
  let fxRateDec = input.fxRateDec;
  if (input.currency !== acc.currency && !fxRateDec) {
    const r = await getRate(input.currency, acc.currency);
    if (!r) throw new Error(`缺少 ${input.currency}→${acc.currency} 匯率，請手動輸入`);
    fxRateDec = r.toString();
  }
  const accountAmountMinor = input.currency === acc.currency
    ? input.amountMinor
    : convertMinor(input.amountMinor, input.currency, acc.currency, fxRateDec!);
  let baseAmountMinor = accountAmountMinor;
  if (acc.currency !== base) {
    const r = await getRate(acc.currency, base);
    if (!r) throw new Error(`缺少 ${acc.currency}→${base} 匯率，請先更新或手動輸入匯率`);
    baseAmountMinor = convertMinor(accountAmountMinor, acc.currency, base, r);
  }
  return {
    accountAmountMinor,
    baseAmountMinor: input.type === 'adjust' ? baseAmountMinor : Math.abs(baseAmountMinor),
    fxRateDec: input.currency === acc.currency ? undefined : fxRateDec,
  };
}

function toRow(id: string, input: TxInput, amounts: Awaited<ReturnType<typeof resolveAmounts>>, createdAt: number): Transaction {
  return {
    id,
    type: input.type,
    accountId: input.accountId,
    categoryId: input.categoryId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    ...amounts,
    date: input.date,
    ts: input.ts,
    note: input.note ?? '',
    merchant: input.merchant || undefined,
    invoiceNo: input.invoiceNo || undefined,
    tagIds: input.tagIds ?? [],
    projectId: input.projectId || undefined,
    attachmentIds: input.attachmentIds ?? [],
    transferId: input.transferId,
    recurringRuleId: input.recurringRuleId,
    installmentId: input.installmentId,
    installmentNo: input.installmentNo,
    stockTradeId: input.stockTradeId,
    dividendId: input.dividendId,
    accountSource: input.accountSource,
    categorySource: input.categorySource,
    reconcileTargetId: input.reconcileTargetId,
    decisionId: input.decisionId,
    split: input.split,
    isSample: input.isSample,
    excludeFromBudget: input.excludeFromBudget,
    excludeFromStats: input.excludeFromStats ?? input.type === 'adjust',
    createdAt,
    updatedAt: Date.now(),
  };
}

export async function addTransaction(input: TxInput, prepared?: Awaited<ReturnType<typeof resolveAmounts>>): Promise<Transaction> {
  const targetId = input.id || uid();
  const amounts = prepared ?? await resolveAmounts(input);
  const row = toRow(targetId, input, amounts, Date.now());
  await db.transaction('rw', db.transactions, db.accounts, db.attachments, async () => {
    // 冪等性檢查：若指定 ID 且該帳目已存在（例如週期排程已在其他裝置入帳並同步過來），不重複寫入與扣款
    if (input.id) {
      const existing = await db.transactions.get(input.id);
      if (existing) return;
    }
    await db.transactions.add(row);
    await bump(row.accountId, txEffect(row));
    for (const aid of row.attachmentIds) await db.attachments.update(aid, { transactionId: row.id });
  });
  return (await db.transactions.get(targetId)) ?? row;
}

export interface SplitShareInput {
  personName: string;
  amountMinor: number;
  debtId?: string;
}

async function applySplitShares(
  tx: Transaction,
  shares: SplitShareInput[],
  opts?: { note?: string; date?: string; oldCurrency?: string },
): Promise<Transaction> {
  if (tx.type !== 'expense') {
    if (shares.length > 0 || tx.split) throw new Error('只有支出帳目可以分帳');
    return tx;
  }
  if ((tx.stockTradeId || tx.dividendId || tx.transferId) && shares.length > 0) {
    throw new Error('連動帳目不支援分帳');
  }

  const byIds = tx.split?.debtIds?.length
    ? (await db.debts.bulkGet(tx.split.debtIds)).filter((d): d is Debt => !!d && !d.deletedAt)
    : [];
  const byTxId = await db.debts.where('transactionId').equals(tx.id).filter((d) => !d.deletedAt).toArray();
  const existingMap = new Map<string, Debt>();
  for (const d of [...byIds, ...byTxId]) existingMap.set(d.id, d);
  const existingDebts = [...existingMap.values()];

  const settledDebts = existingDebts.filter((d) => d.settled === 1);
  const settledSum = settledDebts.reduce((s, d) => s + d.amountMinor, 0);
  if (settledSum > tx.amountMinor) {
    throw new Error(`帳目總金額不可小於已結清的分帳金額（${settledSum}）`);
  }
  if (opts?.oldCurrency && opts.oldCurrency !== tx.currency && settledDebts.length > 0) {
    throw new Error('已有已結清的分帳，不可變更幣別');
  }

  const tsNow = Date.now();
  const matchedIds = new Set<string>();
  const finalDebtIds: string[] = [];
  let othersSum = 0;

  const getOrCreatePerson = async (name: string): Promise<Person> => {
    const n = name.trim();
    if (!n) throw new Error('分帳對象名稱不可為空');
    const exist = await db.people.where('name').equals(n).first();
    if (exist) return exist;
    const p: Person = { id: uid(), name: n, createdAt: tsNow, updatedAt: tsNow };
    await db.people.add(p);
    return p;
  };

  for (const sh of shares) {
    if (!Number.isSafeInteger(sh.amountMinor) || sh.amountMinor < 0) {
      throw new Error('分攤金額必須是非負整數最小單位');
    }
    let matched: Debt | undefined;
    if (sh.debtId && existingMap.has(sh.debtId) && !matchedIds.has(sh.debtId)) {
      matched = existingMap.get(sh.debtId);
    }
    if (matched?.settled === 1) {
      if (matched.amountMinor !== sh.amountMinor) {
        throw new Error('已結清的分帳項目不可修改金額');
      }
      matchedIds.add(matched.id);
      finalDebtIds.push(matched.id);
      othersSum += matched.amountMinor;
      continue;
    }
    if (sh.amountMinor === 0) continue;

    const person = await getOrCreatePerson(sh.personName);
    if (!matched) {
      matched = existingDebts.find((d) => !matchedIds.has(d.id) && d.settled === 0 && d.personId === person.id);
    }
    if (matched) {
      matchedIds.add(matched.id);
      await db.debts.update(matched.id, {
        personId: person.id,
        amountMinor: sh.amountMinor,
        currency: tx.currency,
        date: opts?.date ?? tx.date,
        note: opts?.note ?? (tx.note || '分帳'),
        updatedAt: tsNow,
      });
      finalDebtIds.push(matched.id);
    } else {
      const newId = uid();
      await db.debts.add({
        id: newId,
        personId: person.id,
        direction: 'they_owe_me',
        amountMinor: sh.amountMinor,
        currency: tx.currency,
        transactionId: tx.id,
        groupId: tx.id,
        date: opts?.date ?? tx.date,
        note: opts?.note ?? (tx.note || '分帳'),
        settled: 0,
        createdAt: tsNow,
        updatedAt: tsNow,
      });
      finalDebtIds.push(newId);
    }
    othersSum += sh.amountMinor;
  }

  for (const d of existingDebts) {
    if (matchedIds.has(d.id)) continue;
    if (d.settled === 1) {
      throw new Error('已結清的分帳項目不可刪除');
    }
    await db.debts.update(d.id, { deletedAt: tsNow, updatedAt: tsNow });
  }

  if (othersSum > tx.amountMinor) {
    throw new Error('分攤金額超過帳目總額');
  }
  const myShareMinor = tx.amountMinor - othersSum;
  const nextTx = { ...tx, updatedAt: tsNow };
  if (finalDebtIds.length === 0) {
    delete nextTx.split;
  } else {
    nextTx.split = { myShareMinor, debtIds: finalDebtIds };
  }
  return nextTx;
}

/** 事後分帳／編輯既有支出的分帳份額：保留 tx.id、decisionId 與帳戶扣款全額，並同步未結清欠款 */
export async function updateTransactionSplit(
  txId: string,
  shares: SplitShareInput[],
  opts?: { note?: string; date?: string },
): Promise<Transaction> {
  let saved!: Transaction;
  await db.transaction('rw', [db.transactions, db.debts, db.people], async () => {
    const old = await db.transactions.get(txId);
    if (!old || old.deletedAt) throw new Error('帳目不存在');
    saved = await applySplitShares(old, shares, opts);
    await db.transactions.put(saved);
  });
  return saved;
}

export async function updateTransaction(
  id: string,
  input: TxInput,
  opts?: { allowLinked?: boolean; splitShares?: SplitShareInput[] },
): Promise<Transaction> {
  const amounts = await resolveAmounts(input);
  let saved!: Transaction;
  await db.transaction('rw', [db.transactions, db.accounts, db.attachments, db.debts, db.people], async () => {
    const old = await db.transactions.get(id);
    if (!old) throw new Error('帳目不存在');
    if (!opts?.allowLinked && (old.stockTradeId || old.dividendId || old.transferId)) {
      if (input.amountMinor !== old.amountMinor || input.currency !== old.currency || input.accountId !== old.accountId || input.type !== old.type) {
        throw new Error('此帳目由股票／股利／轉帳自動連動產生，請回原頁面修改金額或帳戶');
      }
    }
    // 只覆蓋有給值的欄位，保留週期／分期／股票等來源關聯；專案可被清除
    const row = Object.fromEntries(Object.entries(toRow(id, input, amounts, old.createdAt)).filter(([, v]) => v !== undefined));
    saved = { ...old, ...row, projectId: input.projectId || undefined, fxRateDec: amounts.fxRateDec } as Transaction;
    if (opts?.splitShares !== undefined) {
      saved = await applySplitShares(saved, opts.splitShares, { note: saved.note || '分帳', date: saved.date, oldCurrency: old.currency });
    } else if (old.split && (old.amountMinor !== saved.amountMinor || old.currency !== saved.currency || old.type !== saved.type)) {
      if (saved.type !== 'expense') throw new Error('分帳帳目只能是支出');
      const debts = await db.debts.bulkGet(old.split.debtIds);
      if (debts.some((d) => !d || d.deletedAt || d.settled)) throw new Error('請先恢復或取消結清相關欠款，再修改分帳金額');
      const shares = allocate(saved.amountMinor, [old.split.myShareMinor, ...debts.map((d) => d!.amountMinor)]);
      saved.split = { ...old.split, myShareMinor: shares[0] };
      for (let i = 0; i < debts.length; i++) await db.debts.update(debts[i]!.id, { amountMinor: shares[i + 1], currency: saved.currency, updatedAt: Date.now() });
    }
    if (!old.deletedAt) {
      await bump(old.accountId, -txEffect(old));
      await bump(saved.accountId, txEffect(saved));
    }
    await db.transactions.put(saved);
    // 移除的附件一併刪除
    const removed = old.attachmentIds.filter((a) => !saved.attachmentIds.includes(a));
    if (removed.length) await db.attachments.bulkDelete(removed);
    for (const aid of saved.attachmentIds) await db.attachments.update(aid, { transactionId: id });
  });
  return saved;
}

/** 軟刪除（可復原）。轉帳手續費帳目會連同整筆轉帳一起刪除。 */
/**
 * 帳目被刪除時，連動關聯的耐用品（否則會留下每天繼續算成本的幽靈物品）：
 * - 購入時記的支出：耐用品一併標記刪除（復原帳目時一起復原）
 * - 賣出時記的收入：耐用品改回「還在用」，並暫存處置資訊（復原那筆收入時再還原成已賣出）
 */
async function durablesOnTxDelete(txId: string, at: number): Promise<void> {
  for (const d of await db.durables.where('txId').equals(txId).filter((x) => !x.deletedAt).toArray()) {
    await db.durables.update(d.id, { deletedAt: at, updatedAt: at });
  }
  for (const d of await db.durables.filter((x) => x.saleTxId === txId && x.status !== 'active').toArray()) {
    await db.durables.update(d.id, {
      status: 'active', endDate: undefined, saleMinor: undefined, updatedAt: at,
      undoSale: { status: d.status as 'sold' | 'retired', endDate: d.endDate, saleMinor: d.saleMinor },
    });
  }
}

async function durablesOnTxRestore(txId: string): Promise<void> {
  const at = Date.now();
  for (const d of await db.durables.where('txId').equals(txId).filter((x) => !!x.deletedAt).toArray()) {
    await db.durables.update(d.id, { deletedAt: null, updatedAt: at });
  }
  for (const d of await db.durables.filter((x) => x.saleTxId === txId && !!x.undoSale).toArray()) {
    await db.durables.update(d.id, { ...d.undoSale, undoSale: undefined, updatedAt: at });
  }
}

const UNDO_DELETE_WINDOW_MS = 7 * 86_400_000;

export async function deleteTransactions(ids: string[], opts?: { skipUndoFeedback?: boolean }): Promise<void> {
  const undoTargets: Array<{ id: string; decisionId: string }> = [];
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.durables, db.debts, db.stock_trades], async () => {
    const now = Date.now();
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deletedAt) continue;
      if (tx.transferId) {
        await deleteTransfersInner([tx.transferId], now);
        continue;
      }
      if (tx.split) {
        const debts = (await db.debts.bulkGet(tx.split.debtIds)).filter((d) => d && !d.deletedAt);
        if (debts.some((d) => d!.settled)) throw new Error('請先取消結清相關欠款，再刪除分帳帳目');
        for (const d of debts) await db.debts.update(d!.id, { deletedAt: now, updatedAt: now });
      }
      // 若刪除的是還款／收款結清帳目，自動將對應欠款恢復為「未結清」，讓應收／應付頁面重新出現
      for (const d of await db.debts.filter((x) => !x.deletedAt && x.settled === 1 && x.settleTransferId === id).toArray()) {
        await db.debts.update(d.id, { settled: 0, settledAt: undefined, settleTransferId: undefined, updatedAt: now });
      }
      // 若刪除的是股票交易連動的主要帳目，一併軟刪除對應股票交易與手續費帳目
      if (tx.stockTradeId) {
        const st = await db.stock_trades.get(tx.stockTradeId);
        if (st && !st.deletedAt && (!st.transactionId || st.transactionId === tx.id)) {
          await db.stock_trades.update(st.id, { deletedAt: now, updatedAt: now });
          if (st.feeTransactionId && st.feeTransactionId !== tx.id) {
            const feeTx = await db.transactions.get(st.feeTransactionId);
            if (feeTx && !feeTx.deletedAt) {
              await db.transactions.update(feeTx.id, { deletedAt: now, updatedAt: now });
              await bump(feeTx.accountId, -txEffect(feeTx));
            }
          }
        }
      }
      await db.transactions.update(id, { deletedAt: now, updatedAt: now });
      await bump(tx.accountId, -txEffect(tx));
      await durablesOnTxDelete(id, now);
      if (!opts?.skipUndoFeedback && tx.decisionId && now - tx.createdAt <= UNDO_DELETE_WINDOW_MS) {
        undoTargets.push({ id: tx.id, decisionId: tx.decisionId });
      }
    }
  });
  if (undoTargets.length > 0) {
    void Promise.all(
      undoTargets.map((u) =>
        recordFeedback({
          decisionId: u.decisionId,
          txId: u.id,
          signalType: 'undo_delete',
        }).catch(() => undefined),
      ),
    );
  }
}

export async function listDeletedTransactions(limit = 50): Promise<Transaction[]> {
  const rows = await db.transactions.filter((t) => !!t.deletedAt && !t.transferId).toArray();
  return rows.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)).slice(0, limit);
}

export async function restoreTransactions(ids: string[]): Promise<void> {
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.durables, db.debts, db.stock_trades], async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || !tx.deletedAt) continue;
      if (tx.transferId) {
        await restoreTransfersInner([tx.transferId]);
        continue;
      }
      if (tx.split) {
        for (const d of await db.debts.bulkGet(tx.split.debtIds)) {
          if (d?.deletedAt === tx.deletedAt) await db.debts.update(d.id, { deletedAt: null, updatedAt: Date.now() });
        }
      }
      if (tx.stockTradeId) {
        const st = await db.stock_trades.get(tx.stockTradeId);
        if (st && st.deletedAt && (!st.transactionId || st.transactionId === tx.id)) {
          const ts = Date.now();
          await db.stock_trades.update(st.id, { deletedAt: null, updatedAt: ts });
          if (st.feeTransactionId && st.feeTransactionId !== tx.id) {
            const feeTx = await db.transactions.get(st.feeTransactionId);
            if (feeTx && feeTx.deletedAt) {
              await db.transactions.update(feeTx.id, { deletedAt: null, updatedAt: ts });
              await bump(feeTx.accountId, txEffect(feeTx));
            }
          }
        }
      }
      await db.transactions.update(id, { deletedAt: null, updatedAt: Date.now() });
      await bump(tx.accountId, txEffect(tx));
      await durablesOnTxRestore(id);
    }
  });
}

/** 批次修改（分類、帳戶、日期…）；帳戶變更時一併搬移餘額影響 */
export async function batchUpdate(ids: string[], patch: Partial<Pick<Transaction, 'categoryId' | 'accountId' | 'date' | 'projectId' | 'tagIds'>>): Promise<void> {
  await db.transaction('rw', db.transactions, db.accounts, db.durables, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deletedAt || tx.transferId) continue;
      if (patch.accountId && patch.accountId !== tx.accountId) {
        const [from, to] = await Promise.all([db.accounts.get(tx.accountId), db.accounts.get(patch.accountId)]);
        // 跨幣別帳戶間批次搬移會改變金額語意，跳過以保資料正確
        if (!from || !to || from.currency !== to.currency) continue;
        await bump(tx.accountId, -txEffect(tx));
        await bump(patch.accountId, txEffect(tx));
      }
      const tsNow = Date.now();
      await db.transactions.update(id, { ...patch, updatedAt: tsNow });
      if (patch.date && patch.date !== tx.date) {
        await db.durables.where('txId').equals(id).filter((d) => !d.deletedAt).modify({ purchaseDate: patch.date, updatedAt: tsNow });
      }
    }
  });
}

// ───────────── 轉帳 ─────────────

export interface TransferInput {
  id?: string;
  fromAccountId: string;
  toAccountId: string;
  fromAmountMinor: number;
  toAmountMinor: number;
  fxRateDec?: string;
  feeMinor: number;
  date: string;
  ts: number;
  note?: string;
  tagIds?: string[];
  projectId?: string;
  isSample?: boolean;
}

type FeeAmounts = Awaited<ReturnType<typeof resolveAmounts>> | null;

/** 手續費金額需在 DB 交易外先算好（取匯率可能需要連網，不能在 IndexedDB 交易中 await 網路） */
async function feeAmountsFor(input: TransferInput): Promise<FeeAmounts> {
  if (input.feeMinor <= 0) return null;
  const from = await db.accounts.get(input.fromAccountId);
  if (!from) throw new Error('轉出帳戶不存在');
  return resolveAmounts({
    type: 'transfer_fee', accountId: from.id, categoryId: 'sys-transfer-fee', amountMinor: input.feeMinor,
    currency: from.currency, date: input.date, ts: input.ts,
  });
}

async function writeTransfer(id: string, input: TransferInput, createdAt: number, feeAmounts: FeeAmounts): Promise<Transfer> {
  const tr: Transfer = {
    id,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    fromAmountMinor: input.fromAmountMinor,
    toAmountMinor: input.toAmountMinor,
    fxRateDec: input.fxRateDec,
    feeMinor: input.feeMinor,
    baseFeeMinor: feeAmounts?.baseAmountMinor,
    feeAccountId: input.feeMinor > 0 ? input.fromAccountId : undefined,
    date: input.date,
    ts: input.ts,
    note: input.note ?? '',
    tagIds: input.tagIds ?? [],
    projectId: input.projectId || undefined,
    isSample: input.isSample,
    createdAt,
    updatedAt: Date.now(),
  };
  for (const [acc, delta] of transferEffects(tr)) await bump(acc, delta);
  if (tr.feeMinor > 0 && feeAmounts) {
    const from = (await db.accounts.get(tr.fromAccountId))!;
    const feeTx = toRow(uid(), {
      type: 'transfer_fee', accountId: tr.fromAccountId, categoryId: 'sys-transfer-fee',
      amountMinor: tr.feeMinor, currency: from.currency, date: tr.date, ts: tr.ts,
      note: '轉帳手續費', transferId: id, isSample: input.isSample,
    }, feeAmounts, Date.now());
    tr.feeTransactionId = feeTx.id;
    await db.transactions.add(feeTx);
    await bump(feeTx.accountId, txEffect(feeTx));
  }
  await db.transfers.put(tr);
  return tr;
}

export async function addTransfer(input: TransferInput): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw new Error('轉出與轉入帳戶不能相同');
  const fee = await feeAmountsFor(input);
  let tr!: Transfer;
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, async () => {
    const existing = input.id ? await db.transfers.get(input.id) : undefined;
    tr = existing ?? await writeTransfer(input.id ?? uid(), input, Date.now(), fee);
  });
  return tr;
}

export async function updateTransfer(id: string, input: TransferInput): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw new Error('轉出與轉入帳戶不能相同');
  const fee = await feeAmountsFor(input);
  let tr!: Transfer;
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, async () => {
    const old = await db.transfers.get(id);
    if (!old) throw new Error('轉帳不存在');
    await revertTransfer(old);
    if (old.feeTransactionId) await db.transactions.delete(old.feeTransactionId);
    tr = await writeTransfer(id, input, old.createdAt, fee);
  });
  return tr;
}

async function revertTransfer(tr: Transfer): Promise<void> {
  if (tr.deletedAt) return;
  for (const [acc, delta] of transferEffects(tr)) await bump(acc, -delta);
  if (tr.feeTransactionId) {
    const fee = await db.transactions.get(tr.feeTransactionId);
    if (fee && !fee.deletedAt) await bump(fee.accountId, -txEffect(fee));
  }
}

async function deleteTransfersInner(ids: string[], now: number): Promise<void> {
  for (const id of ids) {
    const tr = await db.transfers.get(id);
    if (!tr || tr.deletedAt) continue;
    await revertTransfer(tr);
    await db.transfers.update(id, { deletedAt: now, updatedAt: now });
    if (tr.feeTransactionId) await db.transactions.update(tr.feeTransactionId, { deletedAt: now, updatedAt: now });
  }
}

async function restoreTransfersInner(ids: string[]): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    const tr = await db.transfers.get(id);
    if (!tr || !tr.deletedAt) continue;
    for (const [acc, delta] of transferEffects(tr)) await bump(acc, delta);
    await db.transfers.update(id, { deletedAt: null, updatedAt: now });
    if (tr.feeTransactionId) {
      const fee = await db.transactions.get(tr.feeTransactionId);
      if (fee && fee.deletedAt) {
        await db.transactions.update(fee.id, { deletedAt: null, updatedAt: now });
        await bump(fee.accountId, txEffect(fee));
      }
    }
  }
}

export async function deleteTransfers(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, () => deleteTransfersInner(ids, Date.now()));
}

export async function restoreTransfers(ids: string[]): Promise<void> {
  await db.transaction('rw', db.transfers, db.transactions, db.accounts, () => restoreTransfersInner(ids));
}

// ───────────── 查詢 ─────────────

export type LedgerItem =
  | { kind: 'tx'; id: string; date: string; ts: number; tx: Transaction }
  | { kind: 'transfer'; id: string; date: string; ts: number; tr: Transfer };

/** 期間內的帳目＋轉帳（已排除軟刪除、排除轉帳手續費的獨立列），新到舊排序 */
export async function listLedger(start: string, end: string, accountId?: string): Promise<LedgerItem[]> {
  const [txs, trs] = await Promise.all([
    accountId
      ? db.transactions.where('[accountId+date]').between([accountId, start], [accountId, end], true, true).toArray()
      : db.transactions.where('date').between(start, end, true, true).toArray(),
    db.transfers.where('date').between(start, end, true, true).toArray(),
  ]);
  const items: LedgerItem[] = [];
  for (const tx of txs) if (!tx.deletedAt && !tx.transferId) items.push({ kind: 'tx', id: tx.id, date: tx.date, ts: tx.ts, tx });
  for (const tr of trs) {
    if (tr.deletedAt) continue;
    if (accountId && tr.fromAccountId !== accountId && tr.toAccountId !== accountId) continue;
    items.push({ kind: 'transfer', id: tr.id, date: tr.date, ts: tr.ts, tr });
  }
  return items.sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1));
}

/** 期間內計入統計的帳目（含轉帳手續費），報表／小計用 */
export async function listStatTxs(start: string, end: string): Promise<Transaction[]> {
  const txs = await db.transactions.where('date').between(start, end, true, true).toArray();
  return txs.filter((t) => !t.deletedAt);
}

/** 最近一筆（複製上一筆用） */
export async function lastTransaction(): Promise<Transaction | undefined> {
  const recent = await db.transactions.orderBy('ts').reverse().limit(20).toArray();
  return recent.find((t) => !t.deletedAt && (t.type === 'expense' || t.type === 'income'));
}

/** 復原部分還款（刪除還款紀錄並還原原借貸金額與分帳連結） */
export async function undoPartialDebtSettlement(targetId: string, origDebtId: string): Promise<void> {
  await db.transaction('rw', [db.debts, db.transactions, db.transfers, db.accounts, db.durables, db.stock_trades], async () => {
    const paid = await db.debts.get(targetId);
    const orig = await db.debts.get(origDebtId);
    if (paid?.settleTransferId) await deleteTransactions([paid.settleTransferId]);
    if (orig && paid) {
      const t = Date.now();
      await db.debts.update(orig.id, { amountMinor: orig.amountMinor + paid.amountMinor, updatedAt: t });
      if (orig.transactionId) {
        const parent = await db.transactions.get(orig.transactionId);
        if (parent?.split) {
          await db.transactions.update(parent.id, {
            split: { ...parent.split, debtIds: parent.split.debtIds.filter((id) => id !== targetId) },
            updatedAt: t,
          });
        }
      }
    }
    await db.debts.delete(targetId);
  });
}

/** 復原剛記下的一筆交易（含連動刪除耐用品追蹤與還原願望狀態） */
export async function undoCreatedTransaction(txId: string, opts?: { durableId?: string; wishId?: string }): Promise<void> {
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.durables, db.debts, db.stock_trades, db.wishes], async () => {
    await deleteTransactions([txId]);
    if (opts?.durableId) await db.durables.delete(opts.durableId);
    if (opts?.wishId) await db.wishes.update(opts.wishId, { status: 'waiting', decidedAt: undefined, transactionId: undefined, updatedAt: Date.now() });
  });
}
