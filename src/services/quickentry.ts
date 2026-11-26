/**
 * 一句話記帳：把 domain/nlp 解析出的草稿補上分類與帳戶，並可一次記下多筆。
 * 分類：文字中直接寫到的分類名稱 → 自動分類規則 → 商家記憶 → 「其他」
 * 帳戶：文字中寫到的帳戶 → 規則指定的帳戶 → 同一個商家過去最常用的帳戶 → 上次使用的帳戶
 */
import Dexie from 'dexie';
import { db } from '@/db/schema';
import { api } from './api';
import type { Account, Project } from '@/db/types';
import { parseEntries, type DraftEntry } from '@/domain/nlp';
import { todayKey } from '@/domain/period';
import { toMinor } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import { countRuleHit, suggestAccount, suggestCategory } from './autocat';
import { addTransaction, addTransfer, resolveAmounts, type TxInput, type TransferInput } from '@/db/repo/ledger';

export interface ResolvedDraft extends DraftEntry {
  accountId: string;
  categoryId?: string;
  projectId?: string;
  tagIds: string[];
  categorySource: 'text' | 'rule' | 'memory' | 'default';
  accountSource: 'text' | 'rule' | 'memory' | 'default';
  ruleIds?: string[];
}

/** 旅遊模式下未明寫專案／幣別的草稿，預設歸入旅遊專案（與記帳面板同一套規則）；草稿有寫就照草稿 */
export function travelDraftDefaults(
  d: Pick<ResolvedDraft, 'projectId' | 'currency'>,
  travel: Pick<Project, 'id' | 'currency'> | undefined,
  accountCurrency: string,
  baseCurrency: string,
): { projectId?: string; currency: string } {
  return {
    projectId: d.projectId ?? travel?.id,
    currency: d.currency ?? (travel && travel.currency !== baseCurrency ? travel.currency : accountCurrency),
  };
}

const usable = (a: Account) => !a.archived && !a.deletedAt && a.type !== 'loan';

export async function parseContext(today = todayKey()) {
  const [accounts, cats] = await Promise.all([db.accounts.orderBy('sort').toArray(), db.categories.toArray()]);
  return {
    today,
    accounts: accounts.filter(usable).map((a) => ({
      id: a.id, name: a.name, type: a.type,
      ...(a.last4 ? { last4: a.last4 } : {}),
      ...(a.credit ? { credit: a.credit } : {}),
    })),
    categories: cats.filter((c) => !c.archived && !c.deletedAt && !c.system).map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId })),
  };
}

/** 依備註補上分類、改寫名稱與帳戶；fallbackAccountId 是沒有任何線索時使用的帳戶；matchText 可傳入完整通知原文做雙向比對 */
export async function resolveDraft(d: DraftEntry, fallbackAccountId: string, matchText?: string, memoryText?: string): Promise<ResolvedDraft> {
  const kind = d.kind === 'income' ? 'income' : 'expense';
  const query = matchText?.trim() || d.note;
  const memQuery = memoryText?.trim() || d.note;
  let categoryId = d.categoryId;
  let note = d.note;
  let tagIds: string[] = [];
  const ruleIds = new Set<string>();
  let categorySource: ResolvedDraft['categorySource'] = categoryId ? 'text' : 'default';
  if (d.kind !== 'transfer' && query) {
    const sug = await suggestCategory(query, kind, d.amount, memQuery).catch(() => null);
    // 規則優先於文字裡的分類名稱（使用者特地設的）；商家記憶只在文字沒寫分類時使用
    if (sug && (sug.source === 'rule' || !categoryId)) {
      if (sug.categoryId) {
        categoryId = sug.categoryId;
        categorySource = sug.source;
      }
      if (sug.ruleId) ruleIds.add(sug.ruleId);
      if (sug.tagIds.length) tagIds = sug.tagIds;
      if (sug.renameNote) note = sug.renameNote;
    }
  }
  if (!categoryId && d.kind !== 'transfer') categoryId = kind === 'income' ? 'inc-other_inc' : 'exp-other_exp';
  let accountId = d.accountId;
  let accountSource: ResolvedDraft['accountSource'] = accountId ? 'text' : 'default';
  if (!accountId && query) {
    const acc = await suggestAccount(query, kind, d.amount, memQuery).catch(() => undefined);
    if (acc) { accountId = acc.accountId; accountSource = acc.source; if (acc.ruleId) ruleIds.add(acc.ruleId); }
  }
  return { ...d, note, accountId: accountId ?? fallbackAccountId, categoryId, tagIds, categorySource, accountSource, ruleIds: [...ruleIds] };
}

/** 預設帳戶：上次記帳用的帳戶 → 第一個非負債帳戶 */
export async function fallbackAccount(): Promise<string> {
  const accs = (await db.accounts.orderBy('sort').toArray()).filter(usable);
  const last = useSettings.getState().lastAccountId;
  return (accs.find((a) => a.id === last) ?? accs.find((a) => !a.isLiability) ?? accs[0])?.id ?? '';
}

export async function draftsFromText(text: string): Promise<ResolvedDraft[]> {
  const ctx = await parseContext();
  const fallback = await fallbackAccount();
  const list = parseEntries(text, ctx);
  return Promise.all(list.map((d) => resolveDraft(d, fallback)));
}

/**
 * 一句話記帳（明確送出時使用）：先用規則解析；規則找不到金額且使用者開啟了 AI 輔助，才請 AI 解析一次。
 * 輸入中的即時預覽請用 draftsFromText，不要用這個（會消耗額度）。
 * AI 失敗不丟錯，把原因放在 aiNote，讓畫面顯示「找不到金額」＋原因。
 */
export async function draftsSmart(text: string): Promise<{ list: ResolvedDraft[]; usedAi: boolean; aiNote?: string; quotaText?: string }> {
  const list = await draftsFromText(text);
  if (list.length) return { list, usedAi: false };
  const ai = await import('./ai');
  if (!ai.aiEnabledLocally()) return { list, usedAi: false };
  try {
    const { drafts, quota } = await ai.aiParse(text);
    const fallback = await fallbackAccount();
    return { list: await Promise.all(drafts.map((d) => resolveDraft(d, fallback))), usedAi: true, quotaText: ai.quotaLabel(quota) };
  } catch (e) {
    return { list, usedAi: false, aiNote: `（Cilo：${(e as Error).message}）` };
  }
}

export const inboxDraftShape = (list: ResolvedDraft[]) => list.map((d) => d.kind === 'transfer' ? 'transfers' : 'transactions');

export async function reserveInboxSource(sourceId: string | undefined, shape: string[]): Promise<void> {
  const id = sourceId?.match(/^inbox-(\d+)$/)?.[1];
  if (!id) return;
  const database = db;
  const key = `inbox.shape:${id}`;
  const expected = JSON.stringify(shape);
  const saved = await database.meta.get(key);
  if (saved?.value === expected) return;
  if (saved) throw new Error('這則通知已登記不同的記帳方式，請先同步確認，或用原方式重試');
  if (Dexie.currentTransaction) throw new Error('請先完成通知來源登記，再寫入帳目');
  await api('/inbox/items/booking', { method: 'POST', body: { id: Number(id), shape } });
  if (db !== database) throw new Error('使用者已切換，請重新開啟收件匣');
  await database.meta.put({ key, value: expected });
}

export async function commitManualEntry(sourceId: string | undefined, save: () => Promise<void>, shape = ['transactions']): Promise<boolean> {
  if (sourceId && !await db.meta.get(`booked:${sourceId}`)) await reserveInboxSource(sourceId, shape);
  return db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.attachments, db.debts, db.people, db.durables, db.rules, db.meta, db.settings, db.exchange_rates, db.categories, db.stock_trades, db.wishes], async () => {
    const key = sourceId ? `booked:${sourceId}` : undefined;
    const rowId = sourceId ? `${sourceId}-0` : undefined;
    if (key && (await db.meta.get(key) || await db.transactions.get(rowId!) || await db.transfers.get(rowId!) || await db.debts.get(rowId!))) return false;
    await save();
    if (key) await db.meta.put({ key, value: true });
    return true;
  });
}

/** 一次記下多筆；回傳新增的帳目與轉帳 id（給「復原」用） */
export async function bookDrafts(list: ResolvedDraft[], opts: { sourceId?: string; travelProjectId?: string; updateLastAccount?: boolean } = {}): Promise<{ txIds: string[]; transferIds: string[] }> {
  const txIds: string[] = [], transferIds: string[] = [];
  const receiptKey = opts.sourceId ? `booked:${opts.sourceId}` : undefined;
  if (receiptKey && await db.meta.get(receiptKey)) return { txIds, transferIds };
  const accounts = new Map((await db.accounts.toArray()).map((a) => [a.id, a]));
  const st = useSettings.getState();
  const travelId = opts.travelProjectId ?? st.travelModeProjectId;
  const travel = travelId ? await db.projects.get(travelId) : undefined;
  const prepared: ({ kind: 'tx'; input: TxInput; amounts: Awaited<ReturnType<typeof resolveAmounts>>; rules: string[] } | { kind: 'transfer'; input: TransferInput; rules: string[] })[] = [];
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  for (const [i, d] of list.entries()) {
    const acc = accounts.get(d.accountId);
    if (!acc || !usable(acc)) throw new Error('帳戶不存在或已封存，請重新選擇帳戶');
    if (!Number.isFinite(d.amount) || d.amount <= 0) throw new Error('金額需大於 0');
    const ts = new Date(`${d.date}T${d.time || (d.date === todayKey() ? time : '12:00')}:00`).getTime();
    if (!Number.isFinite(ts)) throw new Error('日期或時間格式錯誤');
    const id = opts.sourceId ? `${opts.sourceId}-${i}` : undefined;
    const rules = [...new Set(d.ruleIds ?? [])];
    if (d.kind === 'transfer') {
      const to = d.toAccountId ? accounts.get(d.toAccountId) : undefined;
      if (!to || !usable(to) || to.id === acc.id) throw new Error('轉帳需要兩個不同且未封存的帳戶');
      if (to.currency !== acc.currency) throw new Error('跨幣別轉帳請用記帳面板輸入匯率');
      const amt = toMinor(d.amount, acc.currency);
      prepared.push({ kind: 'transfer', input: { id, fromAccountId: acc.id, toAccountId: to.id, fromAmountMinor: amt, toAmountMinor: amt, feeMinor: 0, date: d.date, ts, note: d.note, tagIds: d.tagIds, projectId: d.projectId }, rules });
    } else {
      const { projectId, currency } = travelDraftDefaults(d, travel, acc.currency, st.baseCurrency);
      const input: TxInput = {
        id, type: d.kind, accountId: acc.id, categoryId: d.categoryId!, amountMinor: toMinor(d.amount, currency), currency,
        date: d.date, ts, note: d.note, tagIds: d.tagIds, projectId,
      };
      prepared.push({ kind: 'tx', input, amounts: await resolveAmounts(input), rules });
    }
  }
  if (list.length) await reserveInboxSource(opts.sourceId, inboxDraftShape(list));
  await db.transaction('rw', [db.transactions, db.transfers, db.accounts, db.attachments, db.rules, db.meta, db.settings, db.exchange_rates], async () => {
    if (receiptKey && await db.meta.get(receiptKey)) return;
    for (const p of prepared) {
      if (p.input.id && (await db.transactions.get(p.input.id) || await db.transfers.get(p.input.id))) continue;
      const ids = p.kind === 'tx' ? [p.input.accountId] : [p.input.fromAccountId, p.input.toAccountId];
      for (const aid of ids) {
        const acc = await db.accounts.get(aid);
        if (!acc || !usable(acc)) throw new Error('帳戶不存在或已封存，請重新選擇帳戶');
      }
      if (p.kind === 'tx') txIds.push((await addTransaction(p.input, p.amounts)).id);
      else transferIds.push((await addTransfer(p.input)).id);
      for (const ruleId of p.rules) await countRuleHit(ruleId);
    }
    if (receiptKey && list.length) await db.meta.put({ key: receiptKey, value: { txIds, transferIds } });
  });
  if (opts.updateLastAccount !== false && (txIds.length || transferIds.length)) useSettings.getState().set('lastAccountId', list[list.length - 1].accountId);
  return { txIds, transferIds };
}

/** 這一筆草稿應該「排程」而不是馬上記：日期在未來，或今天但寫了還沒到的時間（轉帳不排程） */
export function isScheduled(d: Pick<DraftEntry, 'kind' | 'date' | 'time'>, now = new Date()): boolean {
  if (d.kind === 'transfer') return false;
  const today = todayKey();
  if (d.date > today) return true;
  if (d.date < today || !d.time) return false;
  return d.time > `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** 把草稿建成「單次排程」：到那天（那個時間）通知你；預設在收件匣按一下才入帳，auto=true 則到時候由 App 直接記下（要開啟 App 才會寫入）；回傳規則 id 供復原 */
export async function scheduleDrafts(list: ResolvedDraft[], opts: { auto?: boolean } = {}): Promise<string[]> {
  const { saveRecurring } = await import('@/db/repo/plan');
  const accounts = new Map((await db.accounts.toArray()).map((a) => [a.id, a]));
  const ids: string[] = [];
  for (const d of list) {
    const acc = accounts.get(d.accountId);
    if (!acc) throw new Error('找不到帳戶，請先新增帳戶');
    if (d.kind === 'transfer') throw new Error('轉帳不能排程，請直接記帳');
    const cat = d.categoryId ? await db.categories.get(d.categoryId) : undefined;
    const currency = d.currency ?? acc.currency;
    ids.push(await saveRecurring({
      kind: 'normal', name: (d.note || cat?.name || '排程記帳').slice(0, 30), mode: opts.auto ? 'auto' : 'confirm', remindDaysBefore: 0, active: 1,
      startDate: d.date, rule: { freq: 'day', interval: 1, count: 1 }, ...(d.time ? { at: d.time } : {}),
      template: { type: d.kind, accountId: acc.id, categoryId: d.categoryId, amountMinor: toMinor(d.amount, currency), currency, note: d.note, tagIds: d.tagIds },
    }));
  }
  return ids;
}
