/**
 * 備份／還原與匯出：
 * - JSON 完整備份：所有資料表（含收據照片，以 base64 內嵌）
 * - 還原：取代全部 或 合併（以 id 覆蓋）
 * - CSV（帳目＋轉帳）、Excel（帳目／帳戶／投資交易／股利 多工作表）
 * - 儲存：桌機用 File System Access API；iPhone 用分享表單（可存到「檔案」或 iCloud Drive）；否則下載
 */
import { db } from '@/db/schema';
import type { Account, Category, Transaction, Transfer } from '@/db/types';
import { fromMinor } from '@/domain/money';
import { toCSV } from './csv';
import { DEFAULT_SETTINGS, getSetting } from '@/db/repo/settings';
import { buildXlsx } from './xlsx';
import { DEVICE_ONLY_SETTINGS, OUTBOX, markRestore } from '@/db/sync-tracking';
import { E2EE_ITERATIONS, deriveKey } from './e2ee';

const BACKUP_FORMAT = 1;
/**
 * 不放進備份、也不從備份還原的資料表：
 * - meta：裝置 id、同步游標、資料庫擁有者等「這台裝置」的狀態；還原到別台裝置會讓同步漏資料或互相略過
 * - sync_outbox：待上傳佇列，屬於產生它的那台裝置
 * - errors：本機未捕捉錯誤日誌，僅保存在發生問題的裝置
 */
const DEVICE_STATE_TABLES = new Set(['meta', OUTBOX, 'errors']);

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBlob(b64: string, type: string): Blob {
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
}

export async function buildBackup(includePhotos = true): Promise<Blob> {
  const tables = db.tables.filter((t) => !DEVICE_STATE_TABLES.has(t.name) && (includePhotos || t.name !== 'attachments'));
  const data: Record<string, unknown[]> = await db.transaction('r', tables, async () =>
    Object.fromEntries(await Promise.all(tables.map(async (t) => [t.name, await t.toArray()]))));
  if (data.attachments) data.attachments = await Promise.all(data.attachments.map(async (row) => {
    const a = row as import('@/db/types').Attachment;
    return { ...a, blob: await blobToB64(a.blob), thumb: await blobToB64(a.thumb) };
  }));
  const payload = { app: 'aster', format: BACKUP_FORMAT, version: __APP_VERSION__, schema: db.verno, exportedAt: new Date().toISOString(), data };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

// ───── 加密備份 ─────
// 檔案格式（JSON）：{ app, format: 'encrypted-1', kdf, iterations, salt, iv, ct, version, exportedAt }
// 以密碼經 PBKDF2-SHA256（310,000 次、隨機鹽）導出 AES-256-GCM 金鑰；內容是整份明文備份 JSON。
// GCM 驗證碼同時保護密文與標頭字串（AAD），密碼錯誤或檔案被改過都會解密失敗。忘記密碼無法復原。
const ENC_FORMAT = 'encrypted-1';
const AAD = new TextEncoder().encode('aster-backup:encrypted-1');
export const MIN_BACKUP_PASSPHRASE = 8;

export class BackupPassphraseError extends Error {
  constructor(message: string, public needed = false) { super(message); this.name = 'BackupPassphraseError'; }
}

const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 產生加密備份檔；密碼至少 8 個字元 */
export async function buildEncryptedBackup(passphrase: string, includePhotos = true): Promise<Blob> {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE) throw new BackupPassphraseError(`備份密碼至少 ${MIN_BACKUP_PASSPHRASE} 個字元`);
  const plain = new Uint8Array(await (await buildBackup(includePhotos)).arrayBuffer());
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, E2EE_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
  const env = { app: 'aster', format: ENC_FORMAT, kdf: 'PBKDF2-SHA256', iterations: E2EE_ITERATIONS, salt, iv: toB64(iv), ct: toB64(ct), version: __APP_VERSION__, exportedAt: new Date().toISOString() };
  return new Blob([JSON.stringify(env)], { type: 'application/json' });
}

/** 這個備份檔是不是加密的（不需要密碼就能判斷） */
export async function isEncryptedBackup(file: File): Promise<boolean> {
  try { return JSON.parse(await file.text()).format === ENC_FORMAT; } catch { return false; }
}

async function decryptBackup(env: Record<string, unknown>, passphrase: string | undefined): Promise<unknown> {
  if (!passphrase) throw new BackupPassphraseError('這是加密的備份檔，請輸入備份密碼', true);
  const iterations = Number(env.iterations);
  // 迭代次數來自檔案：限制範圍，避免被惡意檔案拿來讓裝置算很久
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) throw new Error('備份檔格式不正確');
  try {
    const key = await deriveKey(passphrase, String(env.salt), iterations);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(String(env.iv)), additionalData: AAD }, key, fromB64(String(env.ct)));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new BackupPassphraseError('密碼不正確，或備份檔已損毀／被修改', true);
  }
}

export interface RestoreSummary { tables: number; rows: number }

export interface BackupVerifySummary {
  version: string;
  schema: number;
  exportedAt: string;
  encrypted: boolean;
  totalRows: number;
  counts: { transactions: number; accounts: number; categories: number; rules: number; attachments: number };
}

type BackupRows = Record<string, Record<string, unknown>[]>;
interface BackupPayload { app: string; format: number; schema: number; version?: string; exportedAt?: string; data: BackupRows }
const objectRow = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
function badBackup(location: string): never { throw new Error(`備份資料不完整或格式錯誤（${location}）`); }

function validateRows(data: unknown): asserts data is BackupRows {
  if (!objectRow(data)) badBackup('data');
  const required: Record<string, string[]> = {
    accounts: ['name', 'type', 'currency', 'initialBalanceMinor', 'balanceMinor'],
    categories: ['name', 'kind', 'parentId'],
    transactions: ['type', 'accountId', 'categoryId', 'amountMinor', 'accountAmountMinor', 'baseAmountMinor', 'currency', 'date', 'ts', 'note', 'tagIds', 'attachmentIds'],
    transfers: ['fromAccountId', 'toAccountId', 'fromAmountMinor', 'toAmountMinor', 'feeMinor', 'date', 'ts', 'tagIds'],
    debts: ['personId', 'direction', 'amountMinor', 'currency', 'date', 'settled'],
    goals: ['name', 'currency', 'targetMinor', 'manualSavedMinor', 'linkedAccountIds', 'status'],
    budgets: ['name', 'amountMinor', 'currency', 'startDate', 'periodType'],
    recurring_rules: ['name', 'template', 'rule', 'startDate', 'nextDue', 'pendingDates', 'mode', 'doneCount'],
    installments: ['name', 'accountId', 'principalMinor', 'currency', 'periods', 'aprDec', 'firstDate', 'schedule'],
    stocks: ['name', 'symbol', 'market', 'currency'],
    stock_trades: ['stockId', 'accountId', 'type', 'date', 'sharesDec', 'priceDec', 'feeMinor', 'taxMinor', 'fxRateDec'],
    dividends: ['stockId', 'accountId', 'kind', 'exDate', 'payDate', 'grossMinor', 'netMinor', 'currency'],
    rules: ['keyword', 'match', 'kind', 'categoryId', 'enabled', 'priority'],
    attachments: ['transactionId', 'blob', 'thumb', 'mime'],
    settings: ['value'], templates: ['name', 'payload'], projects: ['name', 'status', 'currency', 'start'], tags: ['name'],
    people: ['name'], saved_filters: ['name', 'filter'], budget_periods: ['budgetId', 'start', 'end', 'limitMinor', 'spentMinor', 'carryOverMinor'],
    exchange_rates: ['base', 'quote', 'rateDec', 'updatedAt'], price_cache: ['stockId', 'priceDec', 'updatedAt'],
    price_history: ['stockId', 'date', 'closeDec'], portfolio_snapshots: ['date', 'netWorthMinor', 'byAccount', 'byStock'],
    watchlist: ['stockId', 'alerts'], reminders: ['kind', 'dueAt', 'title'],
    durables: ['name', 'purchaseDate', 'costMinor', 'currency', 'status'], wishes: ['name', 'priceMinor', 'currency', 'status', 'decideAt'],
  };
  const enums: Record<string, Record<string, string[]>> = {
    accounts: { type: ['cash', 'bank', 'epay', 'credit', 'stored', 'brokerage', 'loan', 'other'] },
    categories: { kind: ['expense', 'income'] }, transactions: { type: ['expense', 'income', 'adjust', 'transfer_fee'] },
    debts: { direction: ['they_owe_me', 'i_owe_them'] }, goals: { status: ['active', 'done', 'archived'] },
    budgets: { periodType: ['month', 'week', 'custom'] }, recurring_rules: { mode: ['auto', 'confirm'] },
    stock_trades: { type: ['buy', 'sell', 'stock_dividend', 'split'] }, dividends: { kind: ['cash', 'stock'] },
    rules: { kind: ['expense', 'income', 'any'], match: ['contains', 'equals', 'regex'] },
  };
  const numbers = new Set(['ts', 'createdAt', 'updatedAt', 'deletedAt', 'settledAt', 'priority', 'sort', 'hits', 'doneCount', 'periods', 'width', 'height']);
  const dates = new Set(['date', 'start', 'end', 'startDate', 'nextDue', 'firstDate', 'exDate', 'payDate', 'deadline', 'purchaseDate', 'endDate', 'addedOn', 'decideAt']);
  const checkSetting = (value: unknown, example: unknown, where: string): void => {
    if (example === null || example === undefined) return;
    if (typeof example === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) badBackup(where); return; }
    if (Array.isArray(example)) {
      if (!Array.isArray(value)) badBackup(where);
      const item = example[0] ?? (/whitelist|blacklist|dismissed|Order$/.test(where) ? '' : undefined);
      if (item !== undefined) value.forEach((v) => checkSetting(v, item, where));
      return;
    }
    if (objectRow(example)) {
      if (!objectRow(value)) badBackup(where);
      for (const [key, v] of Object.entries(value)) checkSetting(v, example[key], `${where}.${key}`);
      return;
    }
    if (typeof value !== typeof example) badBackup(where);
  };
  const checkFields = (r: Record<string, unknown>, where: string) => {
    for (const [field, value] of Object.entries(r)) {
      if (value == null) continue;
      if ((field.endsWith('Minor') || numbers.has(field)) && !Number.isSafeInteger(value)) badBackup(`${where}.${field}`);
      if (field.endsWith('Dec') && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))) badBackup(`${where}.${field}`);
      if (dates.has(field) && (field === 'date' || value !== '') && !validDate(value)) badBackup(`${where}.${field}`);
      if ((field.endsWith('Id') || ['name', 'note', 'currency', 'keyword', 'parentId'].includes(field)) && typeof value !== 'string') badBackup(`${where}.${field}`);
      if (field === 'currency' && !/^[A-Z]{3}$/.test(String(value))) badBackup(`${where}.${field}`);
      if (field.endsWith('Ids') && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) badBackup(`${where}.${field}`);
      if (['active', 'archived', 'settled'].includes(field) && value !== 0 && value !== 1) badBackup(`${where}.${field}`);
      if (['enabled', 'includeInNetWorth', 'isLiability', 'excludeFromStats', 'excludeFromBudget'].includes(field) && typeof value !== 'boolean') badBackup(`${where}.${field}`);
    }
  };
  for (const [name, rows] of Object.entries(data)) {
    if (DEVICE_STATE_TABLES.has(name)) continue;
    const table = db.tables.find((t) => t.name === name);
    if (!table || !Array.isArray(rows)) badBackup(name);
    const keyPath = table.schema.primKey.keyPath;
    const keys = Array.isArray(keyPath) ? keyPath : [keyPath as string];
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const where = `${name}[${index + 1}]`;
      if (!objectRow(row)) badBackup(where);
      if (keys.some((k) => typeof row[k] !== 'string' || !row[k] || ['__proto__', 'constructor', 'prototype'].includes(row[k] as string))) badBackup(`${where}.主鍵`);
      const key = JSON.stringify(keys.map((k) => row[k]));
      if (seen.has(key)) badBackup(`${where}.重複主鍵`);
      seen.add(key);
      if ((required[name] ?? []).some((k) => !(k in row) || (row[k] == null && !(name === 'settings' && k === 'value')))) badBackup(`${where}.必要欄位`);
      checkFields(row, where);
      if (name === 'settings' && !DEVICE_ONLY_SETTINGS.has(row.key as string)) checkSetting(row.value, DEFAULT_SETTINGS[row.key as keyof typeof DEFAULT_SETTINGS], `${where}.value`);
      for (const field of ['template', 'payload', 'filter', 'credit', 'brokerage', 'loan']) {
        if (row[field] == null) continue;
        if (!objectRow(row[field])) badBackup(`${where}.${field}`);
        checkFields(row[field], `${where}.${field}`);
      }
      for (const [field, allowed] of Object.entries(enums[name] ?? {})) if (!allowed.includes(String(row[field]))) badBackup(`${where}.${field}`);
      if (name === 'transactions' && row.type !== 'adjust' && ['amountMinor', 'accountAmountMinor', 'baseAmountMinor'].some((k) => Number(row[k]) < 0)) badBackup(`${where}.金額`);
      if (name === 'transfers' && (row.fromAccountId === row.toAccountId || ['fromAmountMinor', 'toAmountMinor', 'feeMinor'].some((k) => Number(row[k]) < 0))) badBackup(`${where}.轉帳`);
      if (objectRow(row.split)) {
        checkFields(row.split, `${where}.split`);
        if (!Array.isArray(row.split.debtIds) || !Number.isSafeInteger(row.split.myShareMinor) || Number(row.split.myShareMinor) < 0 || Number(row.split.myShareMinor) > Number(row.amountMinor)) badBackup(`${where}.分帳`);
      } else if (row.split != null) badBackup(`${where}.split`);
      if (name === 'recurring_rules') {
        if (!objectRow(row.template) || !objectRow(row.rule) || !Array.isArray(row.pendingDates) || row.pendingDates.some((d) => !validDate(d))) badBackup(where);
        checkFields(row.template, `${where}.template`);
        if (!['day', 'week', 'month', 'year'].includes(String(row.rule.freq)) || !Number.isSafeInteger(row.rule.interval) || Number(row.rule.interval) < 1) badBackup(`${where}.週期`);
      }
      if (name === 'installments') {
        if (!Array.isArray(row.schedule) || !Number.isSafeInteger(row.periods) || Number(row.periods) < 2) badBackup(where);
        for (const item of row.schedule) { if (!objectRow(item)) badBackup(where); checkFields(item, `${where}.schedule`); }
      }
      if (name === 'rules' && (row.minAmount != null || row.maxAmount != null)) {
        for (const k of ['minAmount', 'maxAmount']) if (row[k] != null && (typeof row[k] !== 'number' || !Number.isFinite(row[k]) || Number(row[k]) < 0)) badBackup(`${where}.${k}`);
        if (row.minAmount != null && row.maxAmount != null && Number(row.minAmount) > Number(row.maxAmount)) badBackup(`${where}.金額範圍`);
      }
      if (name === 'attachments') for (const field of ['blob', 'thumb']) {
        if (typeof row[field] !== 'string') badBackup(`${where}.${field}`);
        try { atob(row[field] as string); } catch { badBackup(`${where}.${field}`); }
      }
    }
  }
}

function validateRelations(data: BackupRows, includePhotos = 'attachments' in data): Map<string, number> {
  const ids = new Map(Object.entries(data).map(([name, rows]) => [name, new Set(rows.map((r) => r.id))]));
  const ref = (value: unknown, table: string, where: string, required = false) => {
    if (!value && !required) return;
    if (typeof value !== 'string' || !ids.get(table)?.has(value)) badBackup(`${where} 缺少關聯${table}`);
  };
  const refs: Record<string, string> = {
    accountId: 'accounts', fromAccountId: 'accounts', toAccountId: 'accounts', cashAccountId: 'accounts', feeAccountId: 'accounts',
    categoryId: 'categories', projectId: 'projects', personId: 'people', stockId: 'stocks', budgetId: 'budgets',
    transactionId: 'transactions', feeTransactionId: 'transactions', loanTxId: 'transactions', txId: 'transactions', saleTxId: 'transactions',
    transferId: 'transfers', settleTransferId: 'transfers', recurringRuleId: 'recurring_rules', installmentId: 'installments',
    stockTradeId: 'stock_trades', dividendId: 'dividends', autoPayAccountId: 'accounts', settlementAccountId: 'accounts', payFromAccountId: 'accounts',
  };
  const relationFields = (row: Record<string, unknown>, where: string) => {
    for (const [field, table] of Object.entries(refs)) ref(row[field], table, where);
    for (const [field, table] of [['tagIds', 'tags'], ['linkedAccountIds', 'accounts'], ['debtIds', 'debts']]) {
      for (const id of (row[field] as string[] | undefined) ?? []) ref(id, table, where, true);
    }
  };
  const balances = new Map<string, bigint>();
  for (const a of data.accounts ?? []) balances.set(a.id as string, BigInt(a.initialBalanceMinor as number));
  for (const [name, rows] of Object.entries(data)) {
    if (DEVICE_STATE_TABLES.has(name) || name === 'settings' || name === 'reminders') continue;
    for (const row of rows) {
      relationFields(row, name);
      if (name === 'categories') ref(row.parentId, 'categories', name);
      for (const field of ['template', 'payload', 'split', 'credit', 'brokerage', 'loan']) if (objectRow(row[field])) relationFields(row[field], name);
      if (name === 'installments') for (const item of row.schedule as Record<string, unknown>[]) relationFields(item, name);
      if (name === 'transactions') {
        ref(row.accountId, 'accounts', name, true);
        if (includePhotos) for (const id of row.attachmentIds as string[]) ref(id, 'attachments', name, true);
        if (objectRow(row.split)) {
          const debts = new Map((data.debts ?? []).map((d) => [d.id, d]));
          const total = (row.split.debtIds as string[]).reduce((n, id) => n + BigInt(debts.get(id)!.amountMinor as number), BigInt(row.split.myShareMinor as number));
          if (total !== BigInt(row.amountMinor as number)) badBackup(`${name}.分帳金額不一致`);
        }
      }
      if (row.deletedAt) continue;
      if (name === 'transactions') {
        const id = row.accountId as string;
        const effect = BigInt(row.accountAmountMinor as number) * (row.type === 'expense' || row.type === 'transfer_fee' ? -1n : 1n);
        balances.set(id, balances.get(id)! + effect);
      }
      if (name === 'transfers') {
        ref(row.fromAccountId, 'accounts', name, true); ref(row.toAccountId, 'accounts', name, true);
        const from = row.fromAccountId as string, to = row.toAccountId as string;
        balances.set(from, balances.get(from)! - BigInt(row.fromAmountMinor as number));
        balances.set(to, balances.get(to)! + BigInt(row.toAmountMinor as number));
      }
    }
  }
  const result = new Map<string, number>();
  for (const [id, balance] of balances) {
    if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(Number.MIN_SAFE_INTEGER)) badBackup('帳戶餘額溢位');
    result.set(id, Number(balance));
  }
  return result;
}

async function parseBackupPayload(file: File, passphrase?: string): Promise<{ json: BackupPayload; encrypted: boolean }> {
  let json: unknown = JSON.parse(await file.text());
  const encrypted = objectRow(json) && json.format === ENC_FORMAT;
  if (encrypted) json = await decryptBackup(json as Record<string, unknown>, passphrase);
  if (!objectRow(json) || (json.app !== 'aster' && json.app !== 'clure')) throw new Error('不是 Aster 的備份檔');
  if (json.format !== BACKUP_FORMAT || !Number.isSafeInteger(json.schema) || Number(json.schema) < 1) badBackup('標頭');
  if (Number(json.schema) > db.verno) throw new Error('備份檔來自較新版本，請先更新 App');
  validateRows(json.data);
  json.data = Object.fromEntries(Object.entries(json.data).filter(([name]) => !DEVICE_STATE_TABLES.has(name)));
  return { json: json as unknown as BackupPayload, encrypted };
}

/** 僅驗證檔案；不模擬裝置容量、同步狀態或實際寫入。 */
export async function verifyBackup(file: File, passphrase?: string): Promise<BackupVerifySummary> {
  const { json, encrypted } = await parseBackupPayload(file, passphrase);
  validateRelations(json.data);
  const d = json.data;
  const countOf = (k: string) => (Array.isArray(d[k]) ? d[k]!.length : 0);
  const totalRows = Object.values(d).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
  return {
    version: String(json.version ?? ''),
    schema: Number(json.schema ?? 0),
    exportedAt: String(json.exportedAt ?? ''),
    encrypted,
    totalRows,
    counts: {
      transactions: countOf('transactions'),
      accounts: countOf('accounts'),
      categories: countOf('categories'),
      rules: countOf('rules'),
      attachments: countOf('attachments'),
    },
  };
}

export async function restoreBackup(file: File, mode: 'replace' | 'merge', passphrase?: string): Promise<RestoreSummary> {
  const { json } = await parseBackupPayload(file, passphrase);
  let rows = 0, tables = 0;
  const names = db.tables.map((t) => t.name).filter((n) => !DEVICE_STATE_TABLES.has(n));
  await db.transaction('rw', [...names.map((n) => db.table(n)), db.meta], async (tx) => {
    markRestore(tx);
    const deviceSettings = await db.settings.bulkGet([...DEVICE_ONLY_SETTINGS]);
    const candidate: BackupRows = {};
    for (const name of names) {
      const table = db.table(name);
      const existing = mode === 'replace' && name in json.data ? [] : await table.toArray() as Record<string, unknown>[];
      const kp = table.schema.primKey.keyPath;
      const keyOf = (row: Record<string, unknown>) => JSON.stringify(Array.isArray(kp) ? kp.map((k) => row[k]) : row[kp as string]);
      const combined = new Map(existing.map((r) => [keyOf(r), r]));
      for (const row of json.data[name] ?? []) combined.set(keyOf(row), row);
      candidate[name] = [...combined.values()];
    }
    const balances = validateRelations(candidate, 'attachments' in json.data);
    for (const name of names) {
      const list = json.data[name];
      const table = db.table(name);
      if (mode === 'replace' && name in json.data) await table.clear();
      if (!list?.length) continue;
      const fixed = name === 'attachments'
        ? list.map((a) => ({ ...a, blob: b64ToBlob(a.blob as string, a.mime as string), thumb: b64ToBlob(a.thumb as string, 'image/jpeg') }))
        : name === 'settings' ? list.filter((r) => !DEVICE_ONLY_SETTINGS.has(String(r.key))) : list;
      await table.bulkPut(fixed);
      rows += fixed.length;
      tables++;
    }
    const keep = deviceSettings.filter((r): r is NonNullable<typeof r> => !!r);
    if (keep.length) await db.settings.bulkPut(keep);
    for (const [id, balanceMinor] of balances) await db.accounts.update(id, { balanceMinor });
    await db.meta.put({ key: 'lastRestoreAt', value: Date.now() });
  });
  return { tables, rows };
}

/** 儲存檔案：桌機另存新檔 → 行動裝置分享表單 → 下載 */
export async function saveFile(blob: Blob, filename: string, mime: string): Promise<'saved' | 'shared' | 'downloaded' | 'cancelled'> {
  const w = window as any;
  if (w.showSaveFilePicker && !/iPhone|iPad|Android/.test(navigator.userAgent)) {
    try {
      const ext = filename.split('.').pop();
      const handle = await w.showSaveFilePicker({ suggestedName: filename, types: [{ description: filename, accept: { [mime]: [`.${ext}`] } }] });
      const ws = await handle.createWritable();
      await ws.write(blob);
      await ws.close();
      return 'saved';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

export async function exportBackup(includePhotos = true, passphrase?: string) {
  const blob = passphrase ? await buildEncryptedBackup(passphrase, includePhotos) : await buildBackup(includePhotos);
  const r = await saveFile(blob, `aster-backup-${new Date().toISOString().slice(0, 10)}${passphrase ? '.encrypted' : ''}.json`, 'application/json');
  if (r !== 'cancelled') await db.meta.put({ key: 'lastBackupAt', value: Date.now() });
  return r;
}

// ───── 帳目表格 ─────

const TYPE_LABEL: Record<string, string> = { expense: '支出', income: '收入', adjust: '餘額調整', transfer_fee: '手續費', transfer: '轉帳' };

export interface ExportScope { start?: string; end?: string; projectId?: string }

async function ledgerRows(scope: ExportScope) {
  const [txs, trs, accounts, cats, tags, projects, base] = await Promise.all([
    db.transactions.toArray(), db.transfers.toArray(), db.accounts.toArray(), db.categories.toArray(), db.tags.toArray(), db.projects.toArray(),
    getSetting('baseCurrency'),
  ]);
  const acc = new Map<string, Account>(accounts.map((a) => [a.id, a]));
  const cat = new Map<string, Category>(cats.map((c) => [c.id, c]));
  const tag = new Map(tags.map((t) => [t.id, t.name]));
  const proj = new Map(projects.map((p) => [p.id, p.name]));
  const inScope = (x: { date: string; deletedAt?: number | null; projectId?: string }) =>
    !x.deletedAt && (!scope.start || x.date >= scope.start) && (!scope.end || x.date <= scope.end) && (!scope.projectId || x.projectId === scope.projectId);
  const header = ['日期', '時間', '類型', '主分類', '子分類', '金額', '幣別', '帳戶', '轉入帳戶', '轉入金額', '手續費', '主幣別金額', '備註', '標籤', '專案'];
  const out: (string | number)[][] = [];
  const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
  for (const t of txs.filter(inScope) as Transaction[]) {
    if (t.transferId) continue;
    const c = cat.get(t.categoryId);
    const main = c?.parentId ? cat.get(c.parentId)?.name : c?.name;
    out.push([
      t.date, time(t.ts), TYPE_LABEL[t.type], main ?? '', c?.parentId ? c.name : '',
      Number(fromMinor(t.type === 'expense' || t.type === 'transfer_fee' ? -t.amountMinor : t.amountMinor, t.currency)), t.currency,
      acc.get(t.accountId)?.name ?? '', '', '', '', Number(fromMinor(t.baseAmountMinor, base)),
      t.note, t.tagIds.map((x) => tag.get(x)).filter(Boolean).join('|'), t.projectId ? proj.get(t.projectId) ?? '' : '',
    ]);
  }
  for (const tr of trs.filter(inScope) as Transfer[]) {
    const from = acc.get(tr.fromAccountId);
    const to = acc.get(tr.toAccountId);
    out.push([
      tr.date, time(tr.ts), '轉帳', '', '', Number(fromMinor(-tr.fromAmountMinor, from?.currency ?? 'TWD')), from?.currency ?? '',
      from?.name ?? '', to?.name ?? '', Number(fromMinor(tr.toAmountMinor, to?.currency ?? 'TWD')), Number(fromMinor(tr.feeMinor, from?.currency ?? 'TWD')), '',
      tr.note, tr.tagIds.map((x) => tag.get(x)).filter(Boolean).join('|'), tr.projectId ? proj.get(tr.projectId) ?? '' : '',
    ]);
  }
  out.sort((a, b) => `${b[0]}${b[1]}`.localeCompare(`${a[0]}${a[1]}`));
  return [header, ...out];
}

export async function exportCSV(scope: ExportScope = {}, name = 'aster-transactions') {
  const rows = await ledgerRows(scope);
  return saveFile(new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' }), `${name}.csv`, 'text/csv');
}

export async function exportXLSX(scope: ExportScope = {}, name = 'aster') {
  const [rows, accounts, stocks, trades, divs] = await Promise.all([
    ledgerRows(scope), db.accounts.toArray(), db.stocks.toArray(), db.stock_trades.toArray(), db.dividends.toArray(),
  ]);
  const stockMap = new Map(stocks.map((s) => [s.id, s]));
  const data = buildXlsx([
    { name: '帳目', rows, widths: [12, 7, 9, 10, 10, 12, 6, 14, 14, 12, 9, 12, 28, 16, 12] },
    {
      name: '帳戶', widths: [18, 10, 6, 14, 10, 8],
      rows: [['名稱', '類型', '幣別', '餘額', '計入淨資產', '封存'], ...accounts.map((a) => [a.name, a.type, a.currency, Number(fromMinor(a.balanceMinor, a.currency)), a.includeInNetWorth ? '是' : '否', a.archived ? '是' : '否'])],
    },
    {
      name: '投資交易', widths: [12, 10, 16, 8, 10, 10, 10, 10, 8],
      rows: [['日期', '代號', '名稱', '類型', '股數', '價格', '手續費', '交易稅', '匯率'],
        ...trades.filter((t) => !t.deletedAt).map((t) => {
          const s = stockMap.get(t.stockId);
          return [t.date, s?.symbol ?? '', s?.name ?? '', t.type, Number(t.sharesDec), Number(t.priceDec), Number(fromMinor(t.feeMinor, s?.currency ?? 'TWD')), Number(fromMinor(t.taxMinor, s?.currency ?? 'TWD')), Number(t.fxRateDec)];
        })],
    },
    {
      name: '股利', widths: [12, 12, 10, 16, 8, 10, 12, 12],
      rows: [['除息日', '發放日', '代號', '名稱', '種類', '每股', '總額', '淨額'],
        ...divs.map((d) => {
          const s = stockMap.get(d.stockId);
          return [d.exDate, d.payDate, s?.symbol ?? '', s?.name ?? '', d.kind === 'cash' ? '現金' : '股票', Number(d.perShareDec), Number(fromMinor(d.grossMinor, d.currency)), Number(fromMinor(d.netMinor, d.currency))];
        })],
    },
  ]);
  return saveFile(new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
