/**
 * 跨裝置同步引擎（與自架後端 /api/sync/*）。
 *
 * 流程：
 * - 本機每次寫入都會由 DBCore 中介層記到 sync_outbox（見 db/sync-tracking.ts）
 * - 上傳：讀取 outbox，附上每筆資料「當下」的內容（讀不到 = 已刪除）分批送出；伺服器以變更時間做「最後寫入者勝」，
 *   不採用的會回傳伺服器版本，直接套用
 * - 下載：以伺服器游標（meta: sync.cursor）取回其他裝置的變更並套用；本機若有更新的未上傳版本則保留本機
 * - 套用後重算帳戶餘額（餘額為快取，每台裝置自行由帳目算出），設定有變更則重新載入
 *
 * 首次在這台裝置同步：先把既有資料排入 outbox（預設資料的變更時間記為 0，伺服器有版本就以伺服器為準），
 * 先下載再上傳 → 新裝置登入後直接拿到其他裝置的帳目與設定，不會再出現首次設定畫面。
 *
 * 時機：登入後立即、本機變更後約 1 秒、畫面可見時每 15 秒（背景每 60 秒）、切回 App、恢復網路、登出前。
 * 輪詢時若伺服器游標沒變、本機也沒有待上傳的變更，只會發出一個 status 請求。
 *
 * 時鐘：每次同步以 status 的 server_time 校正本機時鐘差（setClockOffset），變更時間一律以伺服器時間記錄。
 * 重新同步：伺服器清除過舊的刪除紀錄（墓碑）後，游標早於清除點的裝置會收到 reset，改為完整下載並移除伺服器上已不存在的資料。
 * 端對端加密（選用，見 e2ee.ts）：上傳前加密每筆資料、下載後在寫入資料庫之前解密；沒有金鑰時暫停同步並請使用者輸入加密密碼。
 */
import { create } from 'zustand';
import { db, uid } from '@/db/schema';
import {
  DEVICE_ONLY_SETTINGS, markRemote, outboxId, setClockOffset, setLocalChangeListener, SYNCED_TABLES, type OutboxEntry, type SyncedTable,
} from '@/db/sync-tracking';
import { recomputeBalances } from '@/db/repo/accounts';
import { loadSettings } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { notifyUser } from './notify';
import { api, ApiError } from './api';
import {
  activate, createConfig, decryptJson, E2EELockedError, encryptJson, isEncrypted, localKey, reconcile, unlock, type E2EEConfig,
} from './e2ee';

export interface SyncChange {
  table: string;
  /** 主鍵的 JSON 字串 */
  key: string;
  updated_at: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
}

interface PushResponse { accepted: number; rejected: SyncChange[]; cursor: number }
interface PullResponse { changes: SyncChange[]; cursor: number; has_more: boolean; reset?: boolean }
interface StatusResponse {
  enabled: boolean; protocol_version: number; records: number; cursor: number; server_time?: number; purged_seq?: number; e2ee?: E2EEConfig | null; key_version?: number;
}

/** locked：帳號已啟用端對端加密，但這台裝置還沒輸入加密密碼 */
export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'locked';

export const useSync = create<{
  phase: SyncPhase;
  lastSyncAt: number | null;
  pending: number;
  error: string;
  e2ee: E2EEConfig | null;
  oversizedItems: string[];
  addOversizedItem: (item: string) => void;
}>(() => ({
  phase: 'off', lastSyncAt: null, pending: 0, error: '', e2ee: null,
  oversizedItems: [],
  addOversizedItem: (item) => useSync.setState((s) => ({ oversizedItems: [...new Set([...s.oversizedItems, item])] })),
}));

const SYNCED = new Set<string>(SYNCED_TABLES);
const META_CURSOR = 'sync.cursor';
const META_DEVICE = 'sync.deviceId';
const META_INIT = 'sync.initialized';
const META_CLOCK = 'sync.clockOffset';
/** 時鐘差小於這個值視為準確（網路延遲誤差） */
const CLOCK_TOLERANCE = 2000;
/** 每批上傳的上限（筆數、約略位元組），避免超過 nginx 的請求大小限制 */
const PUSH_BATCH = 400;
const PUSH_BYTES = 1_500_000;
const MAX_SINGLE_PAYLOAD = 250 * 1024; // 250KB 安全閾值（伺服器單筆上限 256KB）
const BALANCE_TABLES = new Set(['accounts', 'transactions', 'transfers']);

async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export async function deviceId(): Promise<string> {
  let id = await getMeta<string>(META_DEVICE);
  if (!id) {
    id = `d-${uid()}`;
    await setMeta(META_DEVICE, id);
  }
  return id;
}

/** 首次同步前的既有資料：預設／未修改過的資料記為 0，修改過的以修改時間為準 */
function initialAt(row: Record<string, unknown>): number {
  const c = row.createdAt, u = row.updatedAt;
  return typeof c === 'number' && typeof u === 'number' && u > c + 1000 ? u : 0;
}

async function enqueueExistingData(): Promise<void> {
  for (const name of SYNCED_TABLES) {
    const table = db.table(name);
    const kp = table.schema.primKey.keyPath;
    const rows = (await table.toArray()) as Record<string, unknown>[];
    if (!rows.length) continue;
    const keyOf = (r: Record<string, unknown>) => (Array.isArray(kp) ? kp.map((p) => r[p]) : r[kp as string]);
    const entries: OutboxEntry[] = [];
    for (const r of rows) {
      const key = keyOf(r);
      if (name === 'settings' && DEVICE_ONLY_SETTINGS.has(String(key))) continue;
      entries.push({ id: outboxId(name, key), table: name, key, at: initialAt(r) });
    }
    // 已在佇列中的（有真實變更時間）保留不覆蓋
    const existing = new Set((await db.sync_outbox.bulkGet(entries.map((e) => e.id))).filter(Boolean).map((e) => e!.id));
    await db.sync_outbox.bulkPut(entries.filter((e) => !existing.has(e.id)));
  }
  await setMeta(META_INIT, true);
}

/** 解密下載的資料（必須在 IndexedDB 交易之外進行，WebCrypto 的 await 會讓交易提早結束） */
async function decodeChanges(changes: SyncChange[]): Promise<SyncChange[]> {
  if (!changes.some((c) => isEncrypted(c.payload))) return changes;
  const key = await localKey();
  if (!key) throw new E2EELockedError();
  return Promise.all(changes.map(async (c) => {
    if (!isEncrypted(c.payload)) return c;
    try {
      return { ...c, payload: await decryptJson<Record<string, unknown>>(key, c.payload) };
    } catch {
      throw new E2EELockedError();
    }
  }));
}

/** 套用伺服器的變更；回傳實際有變動的資料表 */
export async function applyRemoteChanges(changes: SyncChange[]): Promise<Set<string>> {
  const touched = new Set<string>();
  const list = (await decodeChanges(changes)).filter((c) => SYNCED.has(c.table));
  if (!list.length) return touched;
  const tables = [...new Set(list.map((c) => c.table))].map((t) => db.table(t));
  await db.transaction('rw', [...tables, db.sync_outbox], async (tx) => {
    markRemote(tx);
    const parsed: { c: SyncChange; key: unknown; oid: string }[] = [];
    for (const c of list) {
      let key: unknown;
      try { key = JSON.parse(c.key); } catch { continue; }
      if (c.table === 'settings' && DEVICE_ONLY_SETTINGS.has(String(key))) continue;
      parsed.push({ c, key, oid: outboxId(c.table, key) });
    }
    const pendings = await db.sync_outbox.bulkGet(parsed.map((p) => p.oid));
    for (let i = 0; i < parsed.length; i++) {
      const { c, key, oid } = parsed[i];
      const pending = pendings[i];
      // 本機有更新、尚未上傳的版本 → 保留本機，稍後上傳
      if (pending && pending.at > c.updated_at) continue;
      const table = db.table(c.table);
      if (c.deleted) await table.delete(key as string);
      else if (c.payload) await table.put(c.payload);
      else continue;
      if (pending) await db.sync_outbox.delete(oid);
      touched.add(c.table);
    }
  });
  if ([...touched].some((t) => BALANCE_TABLES.has(t))) {
    await db.transaction('rw', db.accounts, db.transactions, db.transfers, async (tx) => {
      markRemote(tx);
      await recomputeBalances();
    });
  }
  if (['stocks', 'watchlist', 'tags', 'people'].some((t) => touched.has(t))) {
    // 兩台裝置各自新增了同一檔股票／同名標籤時合併（整理結果會再同步回去）
    await (await import('@/db/dedupe')).reconcileDuplicates().catch(() => undefined);
  }
  if (touched.has('settings')) useSettings.getState().hydrate(await loadSettings());
  return touched;
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

async function pushPending(device: string, key: CryptoKey | null, version: number): Promise<string | undefined> {
  const blocked = new Set<string>();
  useSync.setState({ oversizedItems: [] });
  const retain = (e: OutboxEntry) => {
    blocked.add(e.id);
    useSync.getState().addOversizedItem(`${e.table}/${String(e.key)}`);
  };
  const send = async (changes: SyncChange[], sent: OutboxEntry[]): Promise<void> => {
    let res: PushResponse;
    try {
      res = await api<PushResponse>('/sync/push', { method: 'POST', body: { device_id: device, key_version: version, changes } });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 413) throw err;
      if (err.code === 'quota_exceeded' || /容量|筆數/.test(err.message)) throw err;
      if (sent.length === 1) { retain(sent[0]); return; }
      const mid = Math.floor(sent.length / 2);
      await send(changes.slice(0, mid), sent.slice(0, mid));
      await send(changes.slice(mid), sent.slice(mid));
      return;
    }
    if (res.rejected.length) await applyRemoteChanges(res.rejected);
    await db.transaction('rw', db.sync_outbox, async () => {
      const cur = await db.sync_outbox.bulkGet(sent.map((e) => e.id));
      await db.sync_outbox.bulkDelete(sent.filter((e, i) => cur[i]?.at === e.at).map((e) => e.id));
    });
  };
  for (let round = 0; round < 1000; round++) {
    const entries = await db.sync_outbox.orderBy('at').filter((e) => !blocked.has(e.id)).limit(PUSH_BATCH).toArray();
    if (!entries.length) break;
    const changes: SyncChange[] = [];
    const sent: OutboxEntry[] = [];
    let bytes = byteLength({ device_id: device, key_version: version, changes: [] });
    const rows = new Map<string, Record<string, unknown> | undefined>();
    const byTable = new Map<string, OutboxEntry[]>();
    for (const e of entries) byTable.set(e.table, [...(byTable.get(e.table) ?? []), e]);
    for (const [name, list] of byTable) {
      const got = await db.table(name).bulkGet(list.map((e) => e.key as string));
      list.forEach((e, i) => rows.set(e.id, got[i] as Record<string, unknown> | undefined));
    }
    for (const e of entries) {
      const row = rows.get(e.id);
      const payload = row ? (key ? (await encryptJson(key, row, version)) as unknown as Record<string, unknown> : row) : null;
      if (byteLength(payload) > MAX_SINGLE_PAYLOAD) { retain(e); continue; }
      const change: SyncChange = { table: e.table, key: JSON.stringify(e.key), updated_at: e.at, deleted: !row, payload };
      const size = byteLength(change) + 1;
      if (sent.length && bytes + size > PUSH_BYTES) break;
      bytes += size;
      changes.push(change);
      sent.push(e);
    }
    if (changes.length) await send(changes, sent);
  }
  if (blocked.size) {
    const message = `${blocked.size} 筆資料過大無法同步，已保留待重試；其他資料照常同步`;
    notifyUser({ text: message });
    return message;
  }
  return undefined;
}

/** 下載變更；回傳 false 代表伺服器要求完整重新同步（游標早於已清除的墓碑） */
async function pullChanges(device: string): Promise<boolean> {
  let cursor = (await getMeta<number>(META_CURSOR)) ?? 0;
  for (let round = 0; round < 10_000; round++) {
    const res = await api<PullResponse>('/sync/pull', { query: { since: cursor, device_id: device, limit: 500 } });
    if (res.reset) return false;
    await applyRemoteChanges(res.changes);
    cursor = res.cursor;
    await setMeta(META_CURSOR, cursor);
    if (!res.has_more) return true;
  }
  return true;
}

/**
 * 完整重新同步：從頭下載伺服器上「目前存在」的全部資料，
 * 本機有、伺服器沒有、也不在待上傳佇列的資料代表已在其他裝置刪除（墓碑已清除），一併移除。
 */
async function fullResync(): Promise<void> {
  const seen = new Map<string, Set<string>>();
  let cursor = 0;
  for (let round = 0; round < 10_000; round++) {
    // 不帶 device_id：自己上傳過的資料也要列入「伺服器上存在」
    const res = await api<PullResponse>('/sync/pull', { query: { since: cursor, limit: 500 } });
    for (const c of res.changes) {
      if (!c.deleted) {
        if (!seen.has(c.table)) seen.set(c.table, new Set());
        seen.get(c.table)!.add(c.key);
      }
    }
    await applyRemoteChanges(res.changes);
    cursor = res.cursor;
    if (!res.has_more) break;
  }
  for (const name of SYNCED_TABLES) {
    const table = db.table(name);
    await db.transaction('rw', table, db.sync_outbox, async (tx) => {
      const pending = new Set((await db.sync_outbox.toArray()).map((e) => e.id));
      const keys = await table.toCollection().primaryKeys();
      const gone = keys.filter((k) => {
        if (name === 'settings' && DEVICE_ONLY_SETTINGS.has(String(k))) return false;
        return !seen.get(name)?.has(JSON.stringify(k)) && !pending.has(outboxId(name, k));
      });
      if (!gone.length) return;
      markRemote(tx);
      await table.bulkDelete(gone as string[]);
    });
  }
  await db.transaction('rw', db.accounts, db.transactions, db.transfers, async (tx) => {
    markRemote(tx);
    await recomputeBalances();
  });
  useSettings.getState().hydrate(await loadSettings());
  await setMeta(META_CURSOR, cursor);
}

async function runSync(): Promise<void> {
  const device = await deviceId();
  const t0 = Date.now();
  let status = await api<StatusResponse>('/sync/status');
  if (typeof status.server_time === 'number') {
    const offset = status.server_time - (t0 + Date.now()) / 2;
    const applied = Math.abs(offset) < CLOCK_TOLERANCE ? 0 : Math.round(offset);
    setClockOffset(applied);
    void setMeta(META_CLOCK, applied);
  }
  if (!status.enabled) { useSync.setState({ phase: 'off' }); return; }
  const migration = await getMeta<EncryptionMigration>(META_MIGRATION);
  if (migration) status = await resumeEncryption(migration, status);
  useSync.setState({ e2ee: status.e2ee ?? null });
  const key = await reconcile(status.e2ee);
  // 伺服器資料被清空或換了一台伺服器（游標倒退）→ 重新完整上傳、從頭下載
  const cursor = (await getMeta<number>(META_CURSOR)) ?? 0;
  if (status.cursor < cursor) {
    await setMeta(META_CURSOR, 0);
    await setMeta(META_INIT, false);
  }
  if (!(await getMeta<boolean>(META_INIT))) {
    await enqueueExistingData();
    if (!(await pullChanges(device))) await fullResync();
  } else if (status.cursor === cursor && (await db.sync_outbox.count()) === 0) {
    // 沒有任何新變更：省下 push／pull 請求
    return;
  }
  const problem = await pushPending(device, key, status.key_version ?? status.e2ee?.version ?? 0);
  if (!(await pullChanges(device))) await fullResync();
  if (problem) throw new ApiError(413, problem);
}

const META_MIGRATION = 'e2ee.migration';
interface EncryptionMigration {
  id: string;
  version: number;
  cursor: number;
  key: CryptoKey | null;
  config: Omit<E2EEConfig, 'version'>;
}

async function resumeEncryption(m: EncryptionMigration, status: StatusResponse): Promise<StatusResponse> {
  const database = db;
  const checkDatabase = () => {
    if (db !== database) throw new Error('帳號已切換，請在原帳號繼續加密遷移');
  };
  const complete = async (result: StatusResponse) => {
    checkDatabase();
    await activate(m.key, m.version + 1);
    await database.meta.delete(META_MIGRATION);
    return result;
  };
  const version = status.key_version ?? status.e2ee?.version ?? 0;
  if (version === m.version + 1 && (m.config.enabled ? status.e2ee?.check === m.config.check : !status.e2ee)) {
    return complete(status);
  }
  if (version !== m.version || status.cursor !== m.cursor) {
    await database.meta.delete(META_MIGRATION);
    throw new Error('同步資料或加密設定已變更，未套用這次切換，請重新同步後再試');
  }
  const oldKey = await reconcile(status.e2ee);
  try {
    checkDatabase();
    await api('/sync/keys/migration', { method: 'POST', body: { ...m.config, migration_id: m.id, expected_version: m.version, cursor: m.cursor } });
    let cursor = 0;
    let hasMore: boolean;
    do {
      checkDatabase();
      const page = await api<PullResponse>('/sync/pull', { query: { since: cursor, limit: 500 } });
      let batch: SyncChange[] = [];
      let bytes = byteLength({ migration_id: m.id, changes: [] });
      const send = async () => {
        if (!batch.length) return;
        checkDatabase();
        await api('/sync/keys/migration', { method: 'PUT', body: { migration_id: m.id, changes: batch } });
        batch = [];
        bytes = byteLength({ migration_id: m.id, changes: [] });
      };
      for (const c of page.changes) {
        if (c.deleted || !c.payload) continue;
        if (isEncrypted(c.payload) && !oldKey) throw new E2EELockedError();
        const plain = isEncrypted(c.payload) ? await decryptJson<Record<string, unknown>>(oldKey!, c.payload) : c.payload;
        const payload = m.key ? await encryptJson(m.key, plain, m.version + 1) as unknown as Record<string, unknown> : plain;
        const change = { ...c, payload };
        const size = byteLength(change) + 1;
        if (batch.length && bytes + size > PUSH_BYTES) await send();
        batch.push(change);
        bytes += size;
      }
      await send();
      cursor = page.cursor;
      hasMore = page.has_more;
    } while (hasMore);
    checkDatabase();
    return await complete(await api<StatusResponse>('/sync/keys/migration/commit', { method: 'POST', body: { migration_id: m.id } }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) await database.meta.delete(META_MIGRATION);
    throw e;
  }
}

let changingEncryption = false;

export async function setEncryption(passphrase: string | null): Promise<void> {
  if (changingEncryption) throw new Error('加密切換正在進行，請稍候');
  changingEncryption = true;
  const database = db;
  try {
    await syncNow();
    if (useSync.getState().phase === 'locked') throw new E2EELockedError();
    if (useSync.getState().phase !== 'idle' || await db.sync_outbox.count()) throw new Error(useSync.getState().error || '仍有資料尚未同步');
    const status = await api<StatusResponse>('/sync/status');
    if (status.protocol_version < 4) throw new Error('請先更新伺服器，再切換端對端加密');
    const c = passphrase ? await createConfig(passphrase) : null;
    if (db !== database) throw new Error('帳號已切換，未變更加密設定');
    const migration: EncryptionMigration = {
      id: `rekey-${uid()}`, version: status.key_version ?? status.e2ee?.version ?? 0, cursor: status.cursor,
      key: c?.key ?? null,
      config: c ? { enabled: true, salt: c.salt, iterations: c.iterations, check: c.check } : { enabled: false, salt: '', iterations: 0, check: '' },
    };
    await setMeta(META_MIGRATION, migration);
    await syncNow();
    if (useSync.getState().phase !== 'idle' || await database.meta.get(META_MIGRATION)) {
      throw new Error(useSync.getState().error || '加密切換尚未完成；原金鑰已保留，重新同步會繼續處理');
    }
  } finally {
    changingEncryption = false;
  }
}

/** 這台裝置輸入加密密碼；回傳是否正確 */
export async function unlockEncryption(passphrase: string): Promise<boolean> {
  const cfg = useSync.getState().e2ee ?? (await api<E2EEConfig | null>('/sync/keys'));
  if (!cfg?.enabled) return true;
  if (!(await unlock(cfg, passphrase))) return false;
  await syncNow();
  return true;
}

let running: Promise<void> | null = null;
let again = false;
let started = false;

/** 立即同步（同時只會有一個同步在進行；進行中再呼叫會在結束後再跑一次） */
export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  useSync.setState({ phase: 'syncing' });
  running = (async () => {
    try {
      do {
        again = false;
        await runSync();
      } while (again);
      useSync.setState({ phase: 'idle', lastSyncAt: Date.now(), error: '' });
      void setMeta('sync.lastOkAt', Date.now()).catch(() => undefined);
    } catch (e) {
      if (e instanceof E2EELockedError) {
        useSync.setState({ phase: 'locked', error: e.message });
        // 登入當下的解鎖畫面已會詢問密碼；只有在 App 使用中（例如其他裝置更換了密碼）才寫入提醒中心
        if (started) void reportSyncProblem(false, e.message);
        return;
      }
      const offline = !(e instanceof ApiError) || e.status === 0 || e.status >= 502;
      useSync.setState({ phase: offline ? 'offline' : 'error', error: (e as Error).message });
      void reportSyncProblem(offline, (e as Error).message);
    } finally {
      running = null;
      useSync.setState({ pending: await db.sync_outbox.count().catch(() => 0) });
    }
  })();
  return running;
}

/**
 * 同步問題寫進提醒中心：伺服器拒絕（例如資料過大、需要加密密碼）立即提醒；
 * 離線則等到「有待上傳資料且超過 24 小時沒同步成功」才提醒，避免通勤斷線就跳通知。
 */
async function reportSyncProblem(offline: boolean, message: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const { notify } = await import('./notifications');
    if (!offline) {
      await notify('⚠️ 跨裝置同步失敗', message, '/settings', 'sync', `sync-error:${day}`);
      return;
    }
    const last = useSync.getState().lastSyncAt ?? (await getMeta<number>('sync.lastOkAt')) ?? 0;
    const pending = await db.sync_outbox.count();
    if (pending > 0 && last && Date.now() - last > 86400_000) {
      await notify('☁️ 有帳目尚未同步', `${pending} 筆變更超過一天沒有上傳到伺服器，請確認網路或伺服器狀態`, '/settings', 'sync', `sync-offline:${day}`);
    }
  } catch { /* 提醒失敗不影響同步 */ }
}

/** 登入後第一次同步：最多等 timeoutMs，逾時則在背景繼續（離線時直接略過） */
export async function initialSync(timeoutMs = 20_000): Promise<void> {
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, timeoutMs))]);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
// 切回 App 時下載；切到背景時把剛記的帳先送出
const onVisible = () => void syncNow();
const onOnline = () => void syncNow();

/** 啟動背景同步排程 */
export function startSync(): void {
  if (started) return;
  started = true;
  void getMeta<number>(META_CLOCK).then((v) => { if (typeof v === 'number') setClockOffset(v); }).catch(() => undefined);
  setLocalChangeListener(() => {
    useSync.setState((s) => ({ pending: s.pending + 1 }));
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 1000);
  });
  // 畫面可見時每 15 秒、在背景時每 60 秒檢查其他裝置的變更
  let ticks = 0;
  interval = setInterval(() => {
    ticks++;
    if (document.visibilityState === 'visible' || ticks % 4 === 0) void syncNow();
  }, 15_000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
}

export function stopSync(): void {
  started = false;
  setLocalChangeListener(null);
  clearTimeout(debounce);
  clearInterval(interval);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onOnline);
  setClockOffset(0);
  useSync.setState({ phase: 'off' });
}

/** 登出前盡量把未上傳的變更送出（最多等 5 秒），回傳實際是否清空與剩餘未上傳筆數 */
export async function flushBeforeLogout(): Promise<{ ok: boolean; remaining: number }> {
  if (!started) {
    const remaining = await db.sync_outbox.count().catch(() => 0);
    return { ok: remaining === 0, remaining };
  }
  await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]);
  const remaining = await db.sync_outbox.count().catch(() => 0);
  if (remaining === 0) stopSync();
  return { ok: remaining === 0, remaining };
}

export type { SyncedTable };
