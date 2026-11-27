/**
 * 自動分類服務：讀取規則與近一年的帳目，提供 suggestCategory()、suggestAccount()。
 * 商家記憶索引快取 5 分鐘（記帳時每次打字都會查，不必每次讀整張表）；規則有變更時呼叫 invalidateAutocat()。
 */
import { db, uid } from '@/db/schema';
import type { Category, CategoryKind, CategoryRule, RuleStatus } from '@/db/types';
import { addDays, todayKey } from '@/domain/period';
import { matchCategory } from '@/domain/nlp-entities';
import { mergeSuggestions, pinnedSuggestions, rankNoteSuggestions, type NoteSuggestion } from '@/domain/notesuggest';
import { listPinned, pinNote } from '@/db/repo/pinned';
import { buildMemory, matchRule, recallCategory, type MemoryIndex } from '@/domain/rules';
import { normalizeMerchantAlias, type MerchantAliasOverride, type NormalizedMerchant } from '@/domain/merchantAlias';
import { evaluateContextRules, type ContextInput, type ContextRule, type RankedCandidate } from '@/domain/contextRules';

export interface CategorySuggestion {
  categoryId: string;
  tagIds: string[];
  source: 'rule' | 'memory';
  ruleId?: string;
  renameNote?: string;
}

export interface AutocatContext {
  source?: string;
  card?: string;
  currency?: string;
  projectId?: string;
  merchant?: string;
}

export interface DraftContextInput {
  rawText: string;
  merchant?: string;
  kind?: 'expense' | 'income' | 'transfer';
  amount?: number;
  source?: string;
  card?: string;
  currency?: string;
  projectId?: string;
}

export interface DraftContextEvaluation {
  primary?: RankedCandidate;
  secondCandidate?: RankedCandidate;
  shadowPredictions: RankedCandidate[];
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  matchedRuleIds: string[];
  merchantAlias: NormalizedMerchant;
}

export interface CreateScopedRuleInput {
  keyword?: string;
  match?: 'contains' | 'equals' | 'regex';
  kind?: CategoryKind | 'any';
  categoryId: string;
  accountId?: string;
  tagIds?: string[];
  renameNote?: string;
  source?: string;
  card?: string;
  currency?: string;
  projectId?: string;
  merchantAlias?: string;
  minAmount?: number;
  maxAmount?: number;
  excludeKeyword?: string;
  priority?: number;
  /** 預設 'shadow'（觀察期），需明確傳入 'active' 才直接啟用 */
  status?: RuleStatus;
}

let cache: {
  dbName: string;
  at: number;
  rules: CategoryRule[];
  memory: MemoryIndex;
  accounts: MemoryIndex;
  cats: Category[];
  aliasOverrides: MerchantAliasOverride[];
} | null = null;
const TTL = 5 * 60 * 1000;

export function invalidateAutocat(): void {
  cache = null;
}

function toContextRule(r: CategoryRule): ContextRule {
  const status: ContextRule['status'] = r.enabled === false ? 'paused' : (r.status ?? 'active');
  return {
    id: r.id,
    name: r.renameNote || r.merchantAlias || r.keyword || undefined,
    status,
    priority: r.priority,
    source: r.source,
    card: r.card,
    merchantAlias: r.merchantAlias,
    rawKeyword: r.keyword || undefined,
    rawKeywordMatch: r.match,
    excludeKeyword: r.excludeKeyword,
    amountMin: r.minAmount,
    amountMax: r.maxAmount,
    currency: r.currency,
    kind: r.kind,
    projectId: r.projectId,
    categoryId: r.categoryId || undefined,
    accountId: r.accountId,
    targetProjectId: r.projectId || undefined,
    tagIds: r.tagIds,
    noteTemplate: r.renameNote,
  };
}

async function load() {
  const database = db;
  if (cache && cache.dbName === database.name && Date.now() - cache.at < TTL) return cache;
  const since = addDays(todayKey(), -365);
  const [rules, txs, cats, accs, aliases] = await Promise.all([
    db.rules.toArray(),
    db.transactions.where('date').aboveOrEqual(since).toArray(),
    db.categories.toArray(),
    db.accounts.toArray(),
    db.merchant_aliases.toArray(),
  ]);
  const live = new Set(cats.filter((c) => !c.archived && !c.deletedAt).map((c) => c.id));
  const liveAcc = new Set(accs.filter((a) => !a.archived && !a.deletedAt).map((a) => a.id));
  const usable = txs.filter((t) => !t.deletedAt && (t.type === 'expense' || t.type === 'income') && !t.stockTradeId && !t.dividendId);
  const texts = (t: (typeof usable)[number]) => [t.merchant, t.note].filter((x): x is string => !!x?.trim());
  const items = usable.filter((t) => live.has(t.categoryId) && t.categoryId !== 'exp-other_exp' && t.categoryId !== 'inc-other_inc')
    .flatMap((t) => texts(t).map((text) => ({ text, categoryId: t.categoryId, kind: t.type as CategoryKind, ts: t.ts })));
  // 帳戶記憶：同一個商家通常用哪個帳戶付款（沿用分類記憶的索引結構，categoryId 欄位放帳戶 id）
  const accItems = usable.filter((t) => liveAcc.has(t.accountId))
    .flatMap((t) => texts(t).map((text) => ({ text, categoryId: t.accountId, kind: t.type as CategoryKind, ts: t.ts })));
  cache = {
    dbName: database.name, at: Date.now(), rules: rules.filter((r) => !r.deletedAt && (!r.categoryId || live.has(r.categoryId))),
    memory: buildMemory(items), accounts: buildMemory(accItems),
    cats: cats.filter((c) => !c.archived && !c.deletedAt),
    aliasOverrides: aliases.map((a) => ({ rawKey: a.rawKey, alias: a.alias })),
  };
  return cache;
}

/** 多層情境規則評估（含正規化商家別名與觀察期規則預測），供收件匣與規則模擬器使用 */
export async function evaluateDraftContext(input: DraftContextInput): Promise<DraftContextEvaluation> {
  const { rules, aliasOverrides } = await load();
  const merchantRaw = input.merchant?.trim() || input.rawText.trim();
  const merchantAlias = normalizeMerchantAlias(merchantRaw, aliasOverrides);
  const ctxInput: ContextInput = {
    source: input.source,
    card: input.card,
    merchantAlias: merchantAlias.alias || undefined,
    rawText: input.rawText,
    amount: input.amount,
    currency: input.currency,
    kind: input.kind,
    travelProjectId: input.projectId,
  };
  const evalResult = evaluateContextRules(ctxInput, rules.map(toContextRule));
  return {
    primary: evalResult.primary,
    secondCandidate: evalResult.secondCandidate,
    shadowPredictions: evalResult.shadowPredictions,
    confidence: evalResult.confidence,
    reasons: evalResult.reasons,
    matchedRuleIds: evalResult.primary ? [evalResult.primary.rule.id] : [],
    merchantAlias,
  };
}

function isUnscopedRule(r: CategoryRule): boolean {
  return !r.source && !r.card && !r.currency && r.projectId === undefined && !r.merchantAlias;
}

/** 依備註／商家文字建議分類：規則優先（支援多層情境與商家別名），其次是商家記憶，最後參考內建同義詞 */
export async function suggestCategory(
  text: string,
  kind: CategoryKind,
  amount?: number,
  memoryText?: string,
  context?: AutocatContext,
): Promise<CategorySuggestion | null> {
  if (!text.trim() && !context?.merchant?.trim()) return null;
  const { rules, memory, cats, aliasOverrides } = await load();
  const merchantNorm = normalizeMerchantAlias(context?.merchant?.trim() || memoryText?.trim() || text, aliasOverrides);
  const memQuery = memoryText?.trim() || merchantNorm.alias || text;
  const activeRules = rules.filter((r) => r.enabled !== false && (r.status ?? 'active') === 'active');
  const ctxInput: ContextInput = {
    source: context?.source,
    card: context?.card,
    merchantAlias: merchantNorm.alias || undefined,
    rawText: text,
    amount,
    currency: context?.currency,
    kind,
    travelProjectId: context?.projectId,
  };
  const evalRes = evaluateContextRules(ctxInput, activeRules.map(toContextRule));
  const r = (evalRes.primary ? activeRules.find((x) => x.id === evalRes.primary!.rule.id) : undefined)
    ?? matchRule(activeRules.filter(isUnscopedRule), text, kind, amount);
  if (r) {
    const category = r.categoryId ? await db.categories.get(r.categoryId) : undefined;
    const recalled = recallCategory(memory, memQuery, kind)
      ?? (merchantNorm.alias && merchantNorm.alias !== memQuery ? recallCategory(memory, merchantNorm.alias, kind) : undefined);
    const fallbackCat = (category && category.kind === kind && !category.archived && !category.deletedAt ? category.id : '') || recalled || '';
    return {
      categoryId: fallbackCat,
      tagIds: r.tagIds ?? [],
      source: 'rule',
      ruleId: r.id,
      renameNote: r.renameNote?.trim() || undefined,
    };
  }
  const c = recallCategory(memory, memQuery, kind)
    ?? (merchantNorm.alias && merchantNorm.alias !== memQuery ? recallCategory(memory, merchantNorm.alias, kind) : undefined);
  if (c) return { categoryId: c, tagIds: [], source: 'memory' };
  const builtin = matchCategory(memQuery, cats, kind)
    ?? (merchantNorm.alias ? matchCategory(merchantNorm.alias, cats, kind) : undefined)
    ?? (memQuery !== text ? matchCategory(text, cats, kind) : undefined);
  return builtin ? { categoryId: builtin.category.id, tagIds: [], source: 'memory' } : null;
}

/**
 * 判斷帳戶：規則有指定帳戶 → 過去同一個商家最常用的帳戶 → 沒有則回傳 undefined（由呼叫端套用預設帳戶）
 */
export async function suggestAccount(
  text: string,
  kind: CategoryKind = 'expense',
  amount?: number,
  memoryText?: string,
  context?: AutocatContext,
): Promise<{ accountId: string; source: 'rule' | 'memory'; ruleId?: string } | undefined> {
  if (!text.trim() && !context?.merchant?.trim()) return undefined;
  const { rules, accounts, aliasOverrides } = await load();
  const merchantNorm = normalizeMerchantAlias(context?.merchant?.trim() || memoryText?.trim() || text, aliasOverrides);
  const memQuery = memoryText?.trim() || merchantNorm.alias || text;
  const activeAccountRules = rules.filter((r) => r.enabled !== false && (r.status ?? 'active') === 'active' && !!r.accountId);
  const ctxInput: ContextInput = {
    source: context?.source,
    card: context?.card,
    merchantAlias: merchantNorm.alias || undefined,
    rawText: text,
    amount,
    currency: context?.currency,
    kind,
    travelProjectId: context?.projectId,
  };
  const evalRes = evaluateContextRules(ctxInput, activeAccountRules.map(toContextRule));
  const r = (evalRes.primary ? activeAccountRules.find((x) => x.id === evalRes.primary!.rule.id) : undefined)
    ?? matchRule(activeAccountRules.filter(isUnscopedRule), text, kind, amount);
  if (r?.accountId) {
    const account = await db.accounts.get(r.accountId);
    if (account && !account.archived && !account.deletedAt && account.type !== 'loan') return { accountId: account.id, source: 'rule', ruleId: r.id };
  }
  const a = recallCategory(accounts, memQuery, kind)
    ?? (merchantNorm.alias && merchantNorm.alias !== memQuery ? recallCategory(accounts, merchantNorm.alias, kind) : undefined);
  const account = a ? await db.accounts.get(a) : undefined;
  return account && !account.archived && !account.deletedAt && account.type !== 'loan' ? { accountId: account.id, source: 'memory' } : undefined;
}

/** 一鍵建立情境規則（預設進入 'shadow' 觀察模式、version: 1） */
export async function createScopedRule(input: CreateScopedRuleInput): Promise<CategoryRule> {
  const status: RuleStatus = input.status ?? 'shadow';
  return saveRule({
    keyword: (input.keyword ?? input.merchantAlias ?? '').trim(),
    match: input.match ?? 'contains',
    kind: input.kind ?? 'expense',
    categoryId: input.categoryId,
    accountId: input.accountId,
    tagIds: input.tagIds ?? [],
    renameNote: input.renameNote,
    source: input.source,
    card: input.card,
    currency: input.currency,
    projectId: input.projectId,
    merchantAlias: input.merchantAlias,
    minAmount: input.minAmount,
    maxAmount: input.maxAmount,
    excludeKeyword: input.excludeKeyword,
    priority: input.priority ?? 50,
    enabled: true,
    status,
    version: 1,
    statusReason: status === 'shadow' ? '使用者一鍵建立，進入觀察期' : undefined,
  });
}

/** 規則被採用時累計命中次數（不影響排序，只給設定頁參考） */
export async function countRuleHit(ruleId: string): Promise<void> {
  await db.rules.where('id').equals(ruleId).modify((r) => { r.hits = (r.hits ?? 0) + 1; r.updatedAt = Date.now(); });
}

export async function saveRule(input: Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> & { id?: string }): Promise<CategoryRule> {
  if ([input.minAmount, input.maxAmount].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))) throw new Error('金額範圍必須是非負數');
  if (input.minAmount !== undefined && input.maxAmount !== undefined && input.minAmount > input.maxAmount) throw new Error('最低金額不能大於最高金額');
  const now = Date.now();
  const old = input.id ? await db.rules.get(input.id) : undefined;
  const row: CategoryRule = { hits: 0, ...old, ...input, id: input.id ?? uid(), createdAt: old?.createdAt ?? now, updatedAt: now };
  await db.rules.put(row);
  invalidateAutocat();
  return row;
}

export async function deleteRule(id: string): Promise<void> {
  await db.rules.delete(id);
  invalidateAutocat();
}

/**
 * 隱式學習（Implicit Learning）：使用者在收件匣編輯通知並入帳時，
 * 自動將「原始商家關鍵字 → 使用者改名／指定分類」沉澱為自動分類規則（已存在同關鍵字則更新）。
 */
export async function learnImplicitMapping(opts: {
  rawKeyword?: string;
  note?: string;
  categoryId?: string;
  kind?: CategoryKind;
  accountId?: string;
}): Promise<boolean> {
  const kw = (opts.rawKeyword ?? '').trim().slice(0, 40);
  if (kw.length < 2) return false;
  const kind: CategoryKind = opts.kind === 'income' ? 'income' : 'expense';
  const note = (opts.note ?? '').trim().slice(0, 24);
  const renameNote = note && note.toLowerCase() !== kw.toLowerCase() ? note : undefined;
  const validCat = opts.categoryId && opts.categoryId !== 'exp-other_exp' && opts.categoryId !== 'inc-other_inc'
    ? opts.categoryId
    : '';
  if (!renameNote && !validCat) return false;

  const existing = (await db.rules.toArray()).find(
    (r) => !r.deletedAt && r.kind === kind && r.keyword.trim().toLowerCase() === kw.toLowerCase(),
  );
  if (existing) {
    await saveRule({
      ...existing,
      categoryId: validCat || existing.categoryId,
      renameNote: renameNote ?? existing.renameNote,
      accountId: opts.accountId ?? existing.accountId,
    });
    return true;
  }
  await saveRule({
    keyword: kw,
    match: 'contains',
    kind,
    categoryId: validCat,
    tagIds: [],
    accountId: opts.accountId,
    renameNote,
    enabled: true,
    priority: 50,
    status: 'shadow',
    version: 1,
  });
  return true;
}

/**
 * 從歷史帳目找出「適合建立規則」的文字：同一個文字出現 3 次以上、而且幾乎都記在同一個分類，尚未有規則涵蓋。
 */
export async function ruleCandidates(limit = 8): Promise<{ text: string; categoryId: string; kind: CategoryKind; count: number }[]> {
  const { rules, memory } = await load();
  const out: { text: string; categoryId: string; kind: CategoryKind; count: number }[] = [];
  for (const [key, m] of memory) {
    const [kind, text] = key.split('|') as [CategoryKind, string];
    const total = [...m.values()].reduce((s, v) => s + v.n, 0);
    const [top] = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    if (!top || total < 3 || top[1].n / total < 0.8) continue;
    if (matchRule(rules, text, kind)) continue;
    out.push({ text, categoryId: top[0], kind, count: total });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * 記帳面板的建議：釘選的常用項目排最前面（不受 90 天、800 筆限制），後面接「最近常記」——
 * 讀最近 800 筆帳目（IndexedDB 本機讀取，很快）依常記與最近排序。
 */
export async function recentNoteSuggestions(query: string, type: 'expense' | 'income', currency: string): Promise<NoteSuggestion[]> {
  const [txs, pins] = await Promise.all([db.transactions.orderBy('ts').reverse().limit(800).toArray(), listPinned()]);
  const pinned = pinnedSuggestions(pins.map((t) => ({
    id: t.id, note: pinNote(t), type: t.payload.type ?? 'expense', currency: t.payload.currency ?? '', amountMinor: t.payload.amountMinor ?? 0,
    categoryId: t.payload.categoryId ?? '', accountId: t.payload.accountId ?? '', tagIds: t.payload.tagIds ?? [], useCount: t.useCount, updatedAt: t.updatedAt,
  })), query, { type, currency });
  return mergeSuggestions(pinned, rankNoteSuggestions(txs, query, { type, currency, limit: 12 }));
}
