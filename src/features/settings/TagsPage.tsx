/**
 * 標籤管理：新增、改名、刪除（刪除時同步從帳目移除）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, uid } from '@/db/schema';
import { CATEGORY_COLORS } from '@/db/seed/categories';
import { useTags } from '@/app/hooks';
import { useUI, ask } from '@/stores/ui';
import { EmptyState } from '@/ui/controls';
import { Icon } from '@/ui/Icon';

export default function TagsPage() {
  const navigate = useNavigate();
  const { list } = useTags();
  const [name, setName] = useState('');
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    if (list.some((t) => t.name === n)) { useUI.getState().showSnack({ text: '標籤已存在' }); return; }
    const now = Date.now();
    await db.tags.add({ id: uid(), name: n, color: CATEGORY_COLORS[list.length % CATEGORY_COLORS.length], sort: list.length, createdAt: now, updatedAt: now });
    setName('');
  };
  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>標籤</h1>
        <div style={{ width: 44 }} />
      </header>
      <form onSubmit={(e) => { e.preventDefault(); void add(); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="input" placeholder="新增標籤" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
        <button className="btn small" type="submit" disabled={!name.trim()}>新增</button>
      </form>
      {list.length === 0 ? <EmptyState emoji="🏷️" title="還沒有標籤" text="標籤可以跨分類標記帳目，例如「出差」、「約會」、「報帳」。" /> : (
        <div className="list">
          {list.map((t) => (
            <div key={t.id} className="row">
              <span style={{ width: 12, height: 12, borderRadius: 6, background: t.color }} aria-hidden="true" />
              <input className="row-main" defaultValue={t.name} aria-label="標籤名稱" style={{ border: 0, background: 'transparent', outline: 'none', minHeight: 40 }}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) void db.tags.update(t.id, { name: v, updatedAt: Date.now() }); }} />
              <button className="icon-btn plain" aria-label={`刪除 ${t.name}`} onClick={async () => {
                if (!await ask(`刪除標籤「${t.name}」？帳目本身不會被刪除。`)) return;
                await db.transaction('rw', [db.tags, db.transactions, db.transfers, db.rules, db.templates, db.recurring_rules, db.saved_filters], async () => {
                  const now = Date.now();
                  await db.transactions.where('tagIds').equals(t.id).modify((tx) => { tx.tagIds = tx.tagIds.filter((x) => x !== t.id); tx.updatedAt = now; });
                  await db.transfers.filter((tr) => tr.tagIds.includes(t.id)).modify((tr) => { tr.tagIds = tr.tagIds.filter((x) => x !== t.id); tr.updatedAt = now; });
                  await db.rules.filter((r) => !!r.tagIds?.includes(t.id)).modify((r) => { r.tagIds = r.tagIds?.filter((x) => x !== t.id); r.updatedAt = now; });
                  await db.templates.filter((tpl) => !!tpl.payload.tagIds?.includes(t.id)).modify((tpl) => { tpl.payload.tagIds = tpl.payload.tagIds?.filter((x) => x !== t.id); tpl.updatedAt = now; });
                  await db.recurring_rules.filter((rr) => !!rr.template.tagIds?.includes(t.id)).modify((rr) => { rr.template.tagIds = rr.template.tagIds?.filter((x) => x !== t.id); rr.updatedAt = now; });
                  await db.saved_filters.filter((sf) => !!sf.filter.tagIds?.includes(t.id)).modify((sf) => { sf.filter.tagIds = sf.filter.tagIds?.filter((x) => x !== t.id); sf.updatedAt = now; });
                  await db.tags.delete(t.id);
                });
              }}><Icon name="trash" size={18} /></button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
