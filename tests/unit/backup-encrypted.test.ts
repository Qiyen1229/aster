import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from '@/db/schema';
import { BackupPassphraseError, buildBackup, buildEncryptedBackup, isEncryptedBackup, restoreBackup, verifyBackup } from '@/services/backup';


// 備份 service 用到 __APP_VERSION__（Vite 的 define）；測試環境補上
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test';

const file = async (b: Blob, name = 'b.json') => new File([await b.text()], name, { type: 'application/json' });

describe('加密備份', () => {
  beforeEach(async () => {
    await db.delete(); await db.open();
    await db.accounts.add({ id: 'a1', name: '錢包', icon: '', color: '', type: 'cash', currency: 'TWD', initialBalanceMinor: 0, balanceMinor: 0, includeInNetWorth: true, isLiability: false, sort: 0, archived: 0, createdAt: 0, updatedAt: 0 } as never);
    await db.categories.add({ id: 'c', name: '醫療', kind: 'expense', parentId: '', icon: '', color: '', sort: 0, archived: 0, createdAt: 0, updatedAt: 0 });
    await db.transactions.add({ id: 't1', type: 'expense', accountId: 'a1', categoryId: 'c', amountMinor: 12300, currency: 'TWD', accountAmountMinor: 12300, baseAmountMinor: 12300, date: '2026-10-01', ts: 1, note: '機密：醫療費用', tagIds: [], attachmentIds: [], createdAt: 0, updatedAt: 0 } as never);
  });

  it('加密後的檔案看不到任何明文；用正確密碼能完整還原', async () => {
    const enc = await buildEncryptedBackup('correct horse 9', false);
    const text = await enc.text();
    expect(text).not.toContain('機密');
    expect(text).not.toContain('醫療');
    expect(JSON.parse(text)).toMatchObject({ app: 'aster', format: 'encrypted-1', kdf: 'PBKDF2-SHA256', iterations: 310000 });
    const f = await file(enc);
    expect(await isEncryptedBackup(f)).toBe(true);
    await db.transactions.clear();
    const r = await restoreBackup(f, 'replace', 'correct horse 9');
    expect(r.rows).toBeGreaterThan(0);
    expect((await db.transactions.get('t1'))?.note).toBe('機密：醫療費用');
  });

  it('密碼錯誤、沒給密碼、檔案被改過：都不會還原，並回報可理解的訊息', async () => {
    const f = await file(await buildEncryptedBackup('correct horse 9', false));
    await expect(restoreBackup(f, 'merge')).rejects.toMatchObject({ name: 'BackupPassphraseError', needed: true });
    await expect(restoreBackup(f, 'merge', 'wrong password')).rejects.toThrow('密碼不正確');
    const env = JSON.parse(await f.text());
    env.ct = env.ct.slice(0, 40) + (env.ct[40] === 'A' ? 'B' : 'A') + env.ct.slice(41);
    await expect(restoreBackup(new File([JSON.stringify(env)], 'x.json'), 'merge', 'correct horse 9')).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  it('每次加密的鹽與 IV 都不同（同樣內容、同樣密碼，密文也不一樣）', async () => {
    const a = JSON.parse(await (await buildEncryptedBackup('same password 1', false)).text());
    const b = JSON.parse(await (await buildEncryptedBackup('same password 1', false)).text());
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('密碼太短不能加密；惡意檔案的迭代次數太大／太小會被拒絕（避免讓裝置算很久）', async () => {
    await expect(buildEncryptedBackup('short', false)).rejects.toThrow('至少 8');
    const env = JSON.parse(await (await buildEncryptedBackup('long enough pw', false)).text());
    for (const iterations of [1, 99_999_999]) {
      await expect(restoreBackup(new File([JSON.stringify({ ...env, iterations })], 'x.json'), 'merge', 'long enough pw')).rejects.toThrow('格式不正確');
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    (j: any) => { j.format = 999; },
    (j: any) => { j.data.transactions = {}; },
    (j: any) => { j.data.transactions[0].amountMinor = '12300'; },
    (j: any) => { j.data.transactions[0].amountMinor = null; },
    (j: any) => { j.data.transactions[0].amountMinor = -1; },
    (j: any) => { j.data.transactions[0].accountAmountMinor = Number.MAX_SAFE_INTEGER + 1; },
    (j: any) => { j.data.transactions[0].date = '2026-02-30'; },
    (j: any) => { j.data.transactions[0].accountId = 'missing'; },
    (j: any) => { j.data.transactions[0].tagIds = 'tag'; },
    (j: any) => { j.data.transactions.push(j.data.transactions[0]); },
    (j: any) => { j.data.settings.push({ key: 'inbox', value: { whitelist: 123 } }); },
    (j: any) => { j.data.accounts[0].initialBalanceMinor = -Number.MAX_SAFE_INTEGER; },
  ])('損壞結構、關聯或金額不通過檢查，也不改動現有帳本 #%#', async (damage) => {
    const json = JSON.parse(await (await buildBackup(false)).text());
    const before = await db.transactions.toArray();
    const pending = await db.sync_outbox.toArray();
    damage(json);
    const broken = new File([JSON.stringify(json)], 'broken.json');
    await expect(verifyBackup(broken)).rejects.toThrow('備份');
    await expect(restoreBackup(broken, 'replace')).rejects.toThrow('備份');
    expect(await db.transactions.toArray()).toEqual(before);
    expect(await db.sync_outbox.toArray()).toEqual(pending);
  });

  it('合併時檢查合併後的關聯；舊檔省略的資料表不會留下孤兒資料', async () => {
    const json = JSON.parse(await (await buildBackup(false)).text());
    delete json.data.transactions;
    json.data.accounts = [];
    const older = new File([JSON.stringify(json)], 'older.json');
    await expect(restoreBackup(older, 'replace')).rejects.toThrow('關聯accounts');
    expect(await db.accounts.count()).toBe(1);
    expect(await db.transactions.count()).toBe(1);
    await restoreBackup(older, 'merge');
    expect((await db.accounts.get('a1'))?.balanceMinor).toBe(-12300);
  });

  it('還原餘額與還原紀錄同一交易提交，尾端寫入失敗全部回復', async () => {
    const good = await file(await buildBackup(false));
    await db.transactions.update('t1', { note: '後續修改' });
    const pending = await db.sync_outbox.toArray();
    vi.spyOn(db.meta, 'put').mockRejectedValueOnce(new Error('儲存失敗'));
    await expect(restoreBackup(good, 'replace')).rejects.toThrow('儲存失敗');
    expect((await db.transactions.get('t1'))?.note).toBe('後續修改');
    expect(await db.sync_outbox.toArray()).toEqual(pending);
    expect(await db.meta.get('lastRestoreAt')).toBeUndefined();
  });

  it('匯出期間並行記帳，所有資料表仍取自同一快照', async () => {
    await db.accounts.update('a1', { balanceMinor: -12300 });
    const table = db.tables.find((t) => t.name === 'accounts')!;
    const original = table.toArray.bind(table);
    let writer: Promise<unknown> | undefined;
    vi.spyOn(table, 'toArray').mockImplementationOnce(() => original().then((result) => {
      writer = Dexie.ignoreTransaction(() => db.transaction('rw', db.accounts, db.transactions, async () => {
        await db.transactions.update('t1', { amountMinor: 20000, accountAmountMinor: 20000, baseAmountMinor: 20000 });
        await db.accounts.update('a1', { balanceMinor: -20000 });
      }));
      return result;
    }));
    const json = JSON.parse(await (await buildBackup(false)).text());
    await writer;
    expect(json.data.accounts[0].balanceMinor).toBe(-12300);
    expect(json.data.transactions[0].accountAmountMinor).toBe(12300);
    expect((await db.transactions.get('t1'))?.amountMinor).toBe(20000);
  });

  it('檢查照片編碼與參照，無照片備份仍可驗證與還原', async () => {
    await db.attachments.add({ id: 'photo', transactionId: 't1', blob: new Blob(['photo']), thumb: new Blob(['thumb']), mime: 'image/jpeg', width: 1, height: 1, createdAt: 1 });
    await db.transactions.update('t1', { attachmentIds: ['photo'] });
    const good = await file(await buildBackup(true));
    expect((await verifyBackup(good)).counts.attachments).toBe(1);
    const json = JSON.parse(await good.text());
    json.data.attachments[0].blob = '!notbase64!';
    await expect(verifyBackup(new File([JSON.stringify(json)], 'bad.json'))).rejects.toThrow('blob');
    expect((await verifyBackup(await file(await buildBackup(false)))).counts.attachments).toBe(0);
    await db.attachments.clear();
    await restoreBackup(good, 'replace');
    expect(await (await db.attachments.get('photo'))?.blob.text()).toBe('photo');
  });

  it('不加密的舊備份檔照樣能還原', async () => {
    const plain = await file(await buildBackup(false));
    expect(await isEncryptedBackup(plain)).toBe(false);
    await db.transactions.clear();
    await restoreBackup(plain, 'replace');
    expect(await db.transactions.count()).toBe(1);
  });
});
