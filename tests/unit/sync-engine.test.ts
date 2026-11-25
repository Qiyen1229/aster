/**
 * 同步引擎：兩台「裝置」（兩個獨立 IndexedDB）透過模擬伺服器同步
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openUserDatabase } from '@/db/schema';
import { bootstrap } from '@/db/bootstrap';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions } from '@/db/repo/ledger';
import { saveSetting, loadSettings } from '@/db/repo/settings';
import { updateCategory } from '@/db/repo/categories';

/** 與後端相同規則的記憶體伺服器（最後寫入者勝、時間相同保留伺服器版本、seq 游標、排除自己的裝置） */
function fakeServer() {
  type Rec = { table: string; key: string; updated_at: number; deleted: boolean; payload: unknown; seq: number; device: string };
  const recs = new Map<string, Rec>();
  let seq = 0;
  const state = { purged: 0, clockAhead: 0, keyVersion: 0, e2ee: null as null | Record<string, unknown> };
  let migration: { migration_id: string; expected_version: number; cursor: number; enabled: boolean; salt: string; iterations: number; check: string } | null = null;
  const staged = new Map<string, Rec>();
  const handle = async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/api/sync/status') return json({ enabled: true, protocol_version: 4, records: recs.size, cursor: seq, server_time: Date.now() + state.clockAhead, e2ee: state.e2ee, key_version: state.keyVersion });
    const conflict = () => new Response(JSON.stringify({ detail: '同步資料已變更' }), { status: 409 });
    if (u.pathname === '/api/sync/keys/migration') {
      const b = JSON.parse(String(init!.body));
      if (init?.method === 'POST') {
        if (b.expected_version !== state.keyVersion || b.cursor !== seq) return conflict();
        if (migration?.migration_id !== b.migration_id) staged.clear();
        migration = b;
      } else {
        if (!migration || migration.migration_id !== b.migration_id || migration.cursor !== seq || migration.expected_version !== state.keyVersion) return conflict();
        for (const c of b.changes) staged.set(`${c.table}|${c.key}`, c);
      }
      return json({ ok: true });
    }
    if (u.pathname === '/api/sync/keys/migration/commit') {
      const b = JSON.parse(String(init!.body));
      if (!migration || migration.migration_id !== b.migration_id || migration.cursor !== seq || migration.expected_version !== state.keyVersion) return conflict();
      const live = [...recs.entries()].filter(([, r]) => !r.deleted);
      if (live.some(([k]) => !staged.has(k))) return conflict();
      for (const [k, r] of live) recs.set(k, { ...r, payload: staged.get(k)!.payload, seq: ++seq, device: '' });
      state.keyVersion++;
      state.e2ee = migration.enabled ? { enabled: true, salt: migration.salt, check: migration.check, iterations: migration.iterations, version: state.keyVersion } : null;
      migration = null;
      staged.clear();
      return json({ enabled: true, protocol_version: 4, records: recs.size, cursor: seq, e2ee: state.e2ee, key_version: state.keyVersion });
    }
    if (u.pathname === '/api/sync/keys') {
      if (init?.method === 'PUT') {
        const b = JSON.parse(String(init.body));
        state.keyVersion++;
        state.e2ee = b.enabled ? { ...b, version: state.keyVersion } : null;
      }
      return json(state.e2ee);
    }
    if (u.pathname === '/api/sync/push') {
      const body = JSON.parse(String(init!.body));
      if ((body.key_version ?? 0) !== state.keyVersion) return conflict();
      const rejected: unknown[] = [];
      let accepted = 0;
      const now = Date.now() + state.clockAhead;
      const ahead = now + 5 * 60 * 1000;
      for (const c of body.changes) {
        const clamped = { ...c, updated_at: c.updated_at > ahead ? now : c.updated_at };
        const k = `${clamped.table}|${clamped.key}`;
        const cur = recs.get(k);
        if (cur && cur.updated_at >= clamped.updated_at) { rejected.push({ ...cur }); continue; }
        recs.set(k, { ...clamped, seq: ++seq, device: body.device_id });
        accepted++;
      }
      return json({ accepted, rejected, cursor: seq });
    }
    if (u.pathname === '/api/sync/pull') {
      const since = Number(u.searchParams.get('since')), dev = u.searchParams.get('device_id');
      if (since > 0 && since < state.purged) return json({ changes: [], cursor: since, has_more: false, reset: true });
      const limit = Number(u.searchParams.get('limit') ?? 500);
      const rows = [...recs.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, limit);
      return json({ changes: rows.filter((r) => r.device !== dev), cursor: rows.length ? rows.at(-1)!.seq : Math.max(seq, since), has_more: rows.length === limit });
    }
    return new Response('{}', { status: 404 });
  };
  /** 模擬伺服器清除墓碑：刪除紀錄消失，清除點設為目前游標 */
  const purge = () => {
    for (const [k, r] of recs) if (r.deleted) recs.delete(k);
    state.purged = seq;
  };
  return { handle, recs, state, purge };
}

let server: ReturnType<typeof fakeServer>;
let sync: typeof import('@/services/sync');

async function useDevice(name: string) {
  await openUserDatabase(name);
}

describe('跨裝置同步', () => {
  beforeEach(async () => {
    server = fakeServer();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => server.handle(url, init));
    vi.stubGlobal('document', { cookie: 'csrf_token=t', visibilityState: 'visible', documentElement: { dataset: {}, style: {} }, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    sync = await import('@/services/sync');
    for (const n of ['phone', 'laptop']) { await openUserDatabase(n); await db.delete(); }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('手機的帳目、設定、分類修改 → 新電腦登入後全部取得，不會被預設值覆蓋', async () => {
    // 手機：同步功能上線前就有資料
    await useDevice('phone');
    await bootstrap();
    await saveSetting('onboarded', true);
    await saveSetting('baseCurrency', 'JPY');
    await saveSetting('lock', { enabled: true } as never); // 裝置專屬，不應同步
    const acc = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'JPY', initialBalanceMinor: 10000, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 1200, currency: 'JPY', date: '2026-10-11', ts: 1, note: '拉麵' });
    await new Promise((r) => setTimeout(r, 5));
    await updateCategory('exp-food', { name: '吃飯' });
    await sync.syncNow();
    expect(await db.sync_outbox.count()).toBe(0);

    // 電腦：全新登入（先同步再建立預設值）
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    const s = await loadSettings();
    expect(s.onboarded).toBe(true);
    expect(s.baseCurrency).toBe('JPY');
    expect(s.lock.enabled).toBe(false);
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['拉麵']);
    expect((await db.accounts.get(acc.id))!.balanceMinor).toBe(10000 - 1200);
    expect((await db.categories.get('exp-food'))!.name).toBe('吃飯');
    // 電腦的預設分類不會蓋掉手機的修改
    await sync.syncNow();
    await useDevice('phone');
    await sync.syncNow();
    expect((await db.categories.get('exp-food'))!.name).toBe('吃飯');
  });

  it('雙向：電腦新增、刪除 → 手機收到；餘額重算', async () => {
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '銀行', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 100000, includeInNetWorth: true, isLiability: false });
    const t1 = await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 5000, currency: 'TWD', date: '2026-10-11', ts: 1, note: '晚餐' });
    await sync.syncNow();

    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await addTransaction({ type: 'income', accountId: acc.id, categoryId: 'inc-salary', amountMinor: 30000, currency: 'TWD', date: '2026-10-11', ts: 2, note: '獎金' });
    await deleteTransactions([t1.id]);
    await sync.syncNow();

    await useDevice('phone');
    await sync.syncNow();
    const live = (await db.transactions.toArray()).filter((t) => !t.deletedAt).map((t) => t.note);
    expect(live).toEqual(['獎金']);
    expect((await db.accounts.get(acc.id))!.balanceMinor).toBe(130000);
    // 套用遠端變更不會再被排入上傳
    expect(await db.sync_outbox.count()).toBe(0);
  });

  it('同一筆兩邊都改：較晚的修改勝出', async () => {
    await useDevice('phone');
    await bootstrap();
    await sync.syncNow();
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await useDevice('phone');
    await updateCategory('exp-food', { name: '手機改的' });
    await new Promise((r) => setTimeout(r, 5));
    await useDevice('laptop');
    await updateCategory('exp-food', { name: '電腦改的（較晚）' });
    await sync.syncNow();
    await useDevice('phone');
    await sync.syncNow(); // 手機的較早修改被拒，改套用伺服器版本
    expect((await db.categories.get('exp-food'))!.name).toBe('電腦改的（較晚）');
  });

  it('還原備份不會帶入其他裝置的同步狀態（裝置 id、游標、待上傳佇列）', async () => {
    const { buildBackup, restoreBackup } = await import('@/services/backup');
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 100, currency: 'TWD', date: '2026-10-11', ts: 1, note: '早餐' });
    await saveSetting('lock', { enabled: true, pinHash: 'phone' } as never);
    await sync.syncNow();
    const phoneDevice = (await db.meta.get('sync.deviceId'))!.value;
    const blob = await buildBackup(false);
    const parsed = JSON.parse(await blob.text());
    expect(parsed.data.meta).toBeUndefined();
    expect(parsed.data.sync_outbox).toBeUndefined();

    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await saveSetting('lock', { enabled: false, pinHash: 'laptop' } as never);
    const laptopDevice = (await db.meta.get('sync.deviceId'))!.value;
    // 舊版備份檔可能含 meta：還原時也要略過
    parsed.data.meta = [{ key: 'sync.deviceId', value: phoneDevice }, { key: 'sync.cursor', value: 999 }];
    await restoreBackup(new File([JSON.stringify(parsed)], 'b.json'), 'replace');
    expect((await db.meta.get('sync.deviceId'))!.value).toBe(laptopDevice);
    expect((await db.meta.get('sync.cursor'))!.value).not.toBe(999);
    expect(((await db.settings.get('lock'))!.value as { pinHash: string }).pinHash).toBe('laptop');
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['早餐']);
  });

  it('墓碑已清除 → 完整重新同步，移除其他裝置已刪除的資料', async () => {
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    const t1 = await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 100, currency: 'TWD', date: '2026-10-11', ts: 1, note: '要刪的' });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 200, currency: 'TWD', date: '2026-10-11', ts: 2, note: '留著' });
    await sync.syncNow();
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    await sync.syncNow();
    // 手機很久沒開；電腦刪除後伺服器清掉了墓碑
    await db.transactions.delete(t1.id);
    await sync.syncNow();
    server.purge();
    await useDevice('phone');
    await sync.syncNow();
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['留著']);
    expect((await db.accounts.get(acc.id))!.balanceMinor).toBe(-200);
  });

  it('裝置時鐘不準：以伺服器時間記錄變更時間', async () => {
    const { syncClock } = await import('@/db/sync-tracking');
    server.state.clockAhead = 3_600_000; // 伺服器比裝置快 1 小時（＝裝置慢 1 小時）
    await useDevice('phone');
    await bootstrap();
    await sync.syncNow();
    expect(syncClock() - Date.now()).toBeGreaterThan(3_500_000);
    await updateCategory('exp-food', { name: '改' });
    const entry = await db.sync_outbox.get('categories|"exp-food"');
    expect(entry!.at - Date.now()).toBeGreaterThan(3_500_000);
    server.state.clockAhead = 0;
    await sync.syncNow();
    expect(Math.abs(syncClock() - Date.now())).toBeLessThan(2000);
  });

  it('裝置時鐘超前超過 5 分鐘：伺服器端強制截斷為伺服器時間，避免未來時間永遠勝出', async () => {
    await useDevice('phone');
    await bootstrap();
    const futureAt = Date.now() + 60 * 60 * 1000;
    await db.sync_outbox.put({ id: '"exp-food"', key: 'categories|"exp-food"', table: 'categories', at: futureAt });
    const cat = (await db.categories.get('exp-food'))!;
    await db.categories.put({ ...cat, name: '未來時鐘', updatedAt: futureAt });
    await sync.syncNow();
    const stored = [...server.recs.values()].find((r) => r.key === '"exp-food"');
    expect(stored).toBeDefined();
    expect(stored!.updated_at).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('端對端加密：伺服器只存密文；新裝置輸入正確密碼才能同步', async () => {
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '秘密帳戶', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 9900, currency: 'TWD', date: '2026-10-11', ts: 1, note: '不能給別人看' });
    await sync.syncNow();
    await sync.setEncryption('correct horse battery');
    const dump = JSON.stringify([...server.recs.values()].map((r) => r.payload));
    expect(dump).not.toContain('不能給別人看');
    expect(dump).not.toContain('秘密帳戶');
    expect([...server.recs.values()].filter((r) => !r.deleted).every((r) => (r.payload as { $enc?: number }).$enc === 1)).toBe(true);

    await useDevice('laptop');
    await sync.syncNow();
    expect(sync.useSync.getState().phase).toBe('locked');
    expect(await db.transactions.count()).toBe(0);
    expect(await sync.unlockEncryption('wrong password')).toBe(false);
    expect(await sync.unlockEncryption('correct horse battery')).toBe(true);
    expect(sync.useSync.getState().phase).toBe('idle');
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['不能給別人看']);

    // 停用後回到明文
    await sync.setEncryption(null);
    expect(JSON.stringify([...server.recs.values()].map((r) => r.payload))).toContain('不能給別人看');
  });

  it('兩台裝置各自新增同一檔股票、同一檔觀察清單、同名標籤：同步不會卡死，並合併成一份', async () => {
    const stock = (id: string) => ({ id, market: 'TWSE' as const, symbol: '2330', name: '台積電', currency: 'TWD', assetType: 'stock' as const, lotSize: 1000 });
    const mkTag = (id: string) => ({ id, name: '旅遊', color: '#fff', sort: 1 });
    await useDevice('phone');
    await bootstrap();
    await sync.syncNow();
    await useDevice('laptop');
    await sync.syncNow();
    await bootstrap();
    // 兩台各自加入
    await useDevice('phone');
    await db.stocks.put(stock('s-b') as never);
    await db.watchlist.put({ id: 'w-b', stockId: 's-b', sort: 1, alerts: [] } as never);
    await db.tags.put(mkTag('tag-b') as never);
    await db.stock_trades.put({ id: 'tr-b', stockId: 's-b', accountId: 'x', type: 'buy', date: '2026-10-01', ts: 1, sharesDec: '1000' } as never);
    await sync.syncNow();
    await useDevice('laptop');
    await db.stocks.put(stock('s-a') as never);
    await db.watchlist.put({ id: 'w-a', stockId: 's-a', sort: 1, alerts: [] } as never);
    await db.tags.put(mkTag('tag-a') as never);
    await sync.syncNow(); // 以前這裡會因唯一索引衝突而失敗
    expect(sync.useSync.getState().phase).toBe('idle');
    await sync.syncNow();
    const check = async () => {
      expect((await db.stocks.toArray()).map((x) => x.id)).toEqual(['s-a']);
      expect((await db.watchlist.toArray()).map((x) => x.id)).toEqual(['w-a']);
      expect((await db.stock_trades.get('tr-b'))!.stockId).toBe('s-a');
      expect((await db.tags.toArray()).map((x) => x.name).sort()).toEqual(['旅遊', '旅遊 (2)']);
    };
    await check();
    // 手機收到整理結果後也一樣
    await useDevice('phone');
    await sync.syncNow();
    await sync.syncNow();
    await check();
  });

  it('單筆過大資料保留佇列，提示待重試且其他資料正常同步', async () => {
    const { useUI } = await import('@/stores/ui');
    const snackSpy = vi.fn();
    useUI.setState({ showSnack: snackSpy });

    await useDevice('phone');
    await bootstrap();
    await sync.syncNow();

    // 建立一筆正常帳目
    const acc = await addAccount({ name: '測試帳戶', type: 'cash', currency: 'TWD', initialBalanceMinor: 10000, color: '#f00', icon: '💰', includeInNetWorth: true, isLiability: false });
    await addTransaction({
      type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 100, currency: 'TWD', date: '2026-10-10', ts: 1, note: '正常帳目',
    });

    // 建立一筆超大（>250KB）帳目
    const bigString = 'X'.repeat(260 * 1024);
    await addTransaction({
      type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 200, currency: 'TWD', date: '2026-10-10', ts: 2, note: bigString,
    });

    // 執行同步
    await sync.syncNow();

    // 驗證：
    expect(await db.sync_outbox.count()).toBe(1);
    expect(sync.useSync.getState().phase).toBe('error');
    expect(sync.useSync.getState().pending).toBe(1);
    // 2. 使用者收到 snack 提示
    expect(snackSpy).toHaveBeenCalled();
    expect(snackSpy.mock.calls[0][0].text).toContain('資料過大無法同步');
    // 3. useSync 狀態記錄了過大項目
    expect(sync.useSync.getState().oversizedItems.length).toBeGreaterThan(0);
    // 4. 正常帳目已同步至伺服器
    expect([...server.recs.values()].some((r) => (r.payload as any)?.note === '正常帳目')).toBe(true);
    // 5. 過大帳目未進入伺服器
    expect([...server.recs.values()].some((r) => (r.payload as any)?.note === bigString)).toBe(false);
  });

  it('容量與筆數額度不足時保留正常項目，額度恢復後可重試', async () => {
    await useDevice('phone');
    await bootstrap(); await sync.syncNow();
    await saveSetting('baseCurrency', 'JPY');
    const handle = server.handle;
    server.handle = async (url, init) => new URL(url, 'http://x').pathname === '/api/sync/push'
      ? new Response(JSON.stringify({ detail: '同步資料總容量已達上限' }), { status: 413, headers: { 'X-Sync-Error': 'quota_exceeded' } })
      : handle(url, init);
    await sync.syncNow();
    expect(await db.sync_outbox.count()).toBe(1);
    expect(sync.useSync.getState().phase).toBe('error');
    expect(sync.useSync.getState().oversizedItems).toEqual([]);
    server.handle = handle;
    await sync.syncNow();
    expect(await db.sync_outbox.count()).toBe(0);
  });

  it('UTF-8 位元組限制與伺服器批次 413 拆分，過大項目修改後重送', async () => {
    await useDevice('phone');
    await bootstrap(); await sync.syncNow();
    for (let i = 0; i < 8; i++) await db.settings.put({ key: `batch-${i}`, value: '漢'.repeat(70_000) });
    await db.settings.put({ key: 'too-large', value: '漢'.repeat(90_000) });
    const sizes: number[] = [];
    const handle = server.handle;
    server.handle = async (url, init) => {
      if (new URL(url, 'http://x').pathname === '/api/sync/push') {
        const size = new TextEncoder().encode(String(init!.body)).length;
        sizes.push(size);
        if (size > 450_000) return new Response('', { status: 413 });
      }
      return handle(url, init);
    };
    await sync.syncNow();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1_500_000);
    expect(sizes.some((n) => n > 450_000)).toBe(true);
    expect([...server.recs.values()].filter((r) => r.key.startsWith('"batch-'))).toHaveLength(8);
    expect((await db.sync_outbox.toArray()).map((r) => r.key)).toEqual(['too-large']);
    await db.settings.put({ key: 'too-large', value: '已縮小' });
    await sync.syncNow();
    expect(await db.sync_outbox.count()).toBe(0);
    expect(sync.useSync.getState().oversizedItems).toEqual([]);
  });

  it.each(['enable', 'rotate', 'disable'] as const)('加密 %s 中斷不混用格式，重新開啟後可續傳', async (operation) => {
    await useDevice('phone');
    await bootstrap();
    for (let i = 0; i < 510; i++) await db.settings.put({ key: `migration-${i}`, value: `測試-${i}` });
    await sync.syncNow();
    if (operation !== 'enable') await sync.setEncryption('old migration password');
    const before = JSON.stringify([...server.recs.values()]);
    const previous = structuredClone(server.state.e2ee);
    const handle = server.handle;
    let parts = 0;
    server.handle = async (url, init) => {
      if (new URL(url, 'http://x').pathname === '/api/sync/keys/migration' && init?.method === 'PUT' && ++parts === 2) {
        return new Response('{}', { status: 503 });
      }
      return handle(url, init);
    };
    await expect(sync.setEncryption(operation === 'disable' ? null : 'new migration password')).rejects.toThrow();
    expect(JSON.stringify([...server.recs.values()])).toBe(before);
    expect(server.state.e2ee).toEqual(previous);
    expect(await db.meta.get('e2ee.migration')).toBeTruthy();
    server.handle = handle;
    await useDevice('laptop');
    await sync.syncNow();
    if (operation !== 'enable') expect(await sync.unlockEncryption('old migration password')).toBe(true);
    expect((await db.settings.get('migration-509'))?.value).toBe('測試-509');
    await useDevice('phone');
    db.close(); await db.open();
    await sync.syncNow();
    expect(sync.useSync.getState().phase).toBe('idle');
    expect(await db.meta.get('e2ee.migration')).toBeUndefined();
    const rows = [...server.recs.values()].filter((r) => !r.deleted);
    expect(rows.every((r) => ((r.payload as { $enc?: number }).$enc === 1) === (operation !== 'disable'))).toBe(true);
    await useDevice('laptop'); await sync.syncNow();
    if (operation !== 'disable') expect(await sync.unlockEncryption('new migration password')).toBe(true);
    expect(sync.useSync.getState().phase).toBe('idle');
    expect((await db.settings.get('migration-509'))?.value).toBe('測試-509');
  }, 15_000);

  it('切換已提交但回應遺失時，重試採用已保存的新金鑰而不再次切換', async () => {
    await useDevice('phone'); await bootstrap(); await sync.syncNow();
    const handle = server.handle;
    server.handle = async (url, init) => {
      const response = await handle(url, init);
      if (new URL(url, 'http://x').pathname === '/api/sync/keys/migration/commit') throw new Error('回應遺失');
      return response;
    };
    await expect(sync.setEncryption('new migration password')).rejects.toThrow();
    expect(server.state.keyVersion).toBe(1);
    expect(await db.meta.get('e2ee.migration')).toBeTruthy();
    server.handle = handle;
    db.close(); await db.open();
    await sync.syncNow();
    expect(sync.useSync.getState().phase).toBe('idle');
    expect(server.state.keyVersion).toBe(1);
    expect(await db.meta.get('e2ee.migration')).toBeUndefined();
  });

  it('伺服器清空重建（游標倒退）→ 重置本機游標並重新上傳既有資料', async () => {
    await useDevice('phone');
    await bootstrap();
    const acc = await addAccount({ name: '中信', icon: 'landmark', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });
    await addTransaction({ type: 'expense', accountId: acc.id, categoryId: 'exp-food', amountMinor: 15000, currency: 'TWD', date: '2026-10-12', ts: 1, note: '重建後仍須保留' });
    await sync.syncNow();
    expect([...server.recs.values()].some((r) => (r.payload as { note?: string })?.note === '重建後仍須保留')).toBe(true);

    // 模擬伺服器資料被清空重建（seq 歸零）
    server = fakeServer();

    await sync.syncNow();
    expect(sync.useSync.getState().phase).toBe('idle');
    expect([...server.recs.values()].some((r) => (r.payload as { note?: string })?.note === '重建後仍須保留')).toBe(true);
  });
});
