/**
 * 分類管理：支出／收入兩層分類。
 * 統一拖曳排序：按住左側 ≡ 手柄即可拖曳整列上下移動，點其他區域可正常捲動或展開編輯。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Category, CategoryKind } from '@/db/types';
import { addCategory, buildTree, deleteOrArchiveCategory, reorderCategories, updateCategory } from '@/db/repo/categories';
import { CATEGORY_COLORS, OTHER_SUB_NAME } from '@/db/seed/categories';
import { useCategories } from '@/app/hooks';
import { useUI, ask } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { CatIcon, Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { DragHandle, SortableList } from '@/ui/SortableList';

type Edit = { cat?: Category; parentId: string; kind: CategoryKind } | null;

export default function CategoriesPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<string>('');
  const [edit, setEdit] = useState<Edit>(null);
  const { all } = useCategories();
  const tree = useMemo(() => buildTree(all, kind, showArchived), [all, kind, showArchived]);

  return (
    <main className="page categories-page" onContextMenu={(e) => e.preventDefault()}>
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>分類管理</h1>
        <button className="icon-btn" aria-label="新增主分類" onClick={() => setEdit({ parentId: '', kind })}>
          <Icon name="plus" />
        </button>
      </header>

      <Segmented
        value={kind}
        onChange={setKind}
        options={[{ value: 'expense', label: '支出分類' }, { value: 'income', label: '收入分類' }]}
        ariaLabel="分類類型"
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 4px 6px' }}>
        <span className="muted" style={{ fontSize: '0.78rem' }}>按住左側 ≡ 可拖曳調整順序</span>
        <button
          type="button"
          className="accent"
          style={{ fontSize: '0.8rem', minHeight: 32 }}
          onClick={() => setShowArchived((s) => !s)}
        >
          {showArchived ? '隱藏封存' : '顯示封存'}
        </button>
      </div>

      <SortableList
        items={tree}
        getKey={(t) => t.main.id}
        className="cat-manage-list"
        gap={6}
        onReorder={async (next) => {
          await reorderCategories(next.map((t) => t.main.id));
        }}
        renderItem={({ main, subs }, _index, { handleProps }) => {
          const isOpen = expanded === main.id;
          return (
            <div className={`cat-card ${main.archived ? 'archived' : ''}`}>
              <div className="cat-card-header">
                <DragHandle handleProps={handleProps} />
                <button
                  type="button"
                  className="cat-card-main"
                  onClick={() => setExpanded((e) => (e === main.id ? '' : main.id))}
                >
                  <span className="cat-icon" style={{ ['--c' as string]: main.color }} aria-hidden="true">
                    <CatIcon icon={main.icon} />
                  </span>
                  <div className="cat-card-info">
                    <span className="cat-card-title">
                      {main.name}{main.archived ? '（已封存）' : ''}
                    </span>
                    <span className="cat-card-count">
                      {subs.length} 個子分類
                    </span>
                  </div>
                  <Icon name={isOpen ? 'chevronD' : 'chevronR'} className="cat-chev" />
                </button>

                <button
                  type="button"
                  className="icon-btn plain cat-edit-btn"
                  aria-label={`編輯 ${main.name}`}
                  title="編輯主分類"
                  onClick={() => setEdit({ cat: main, parentId: '', kind })}
                >
                  <Icon name="edit" size={16} />
                </button>
              </div>

              {isOpen && (
                <div className="cat-sub-wrap">
                  <div className="cat-chips">
                    {subs.map((s) => (
                      <div key={s.id} className="cat-sub-item">
                        <button
                          type="button"
                          className={`cat-chip ${s.archived ? 'archived' : ''}`}
                          onClick={() => setEdit({ cat: s, parentId: s.parentId, kind })}
                        >
                          <span className="cat-chip-icon"><CatIcon icon={s.icon} size={13} /></span>
                          <span className="cat-chip-name">{s.name}{s.archived ? ' (封存)' : ''}</span>
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="cat-chip add"
                      onClick={() => setEdit({ parentId: main.id, kind })}
                    >
                      <Icon name="plus" size={14} />
                      <span>新增子分類</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        }}
      />

      <CategoryEditor edit={edit} onClose={() => setEdit(null)} />
    </main>
  );
}

function CategoryEditor({ edit, onClose }: { edit: Edit; onClose: () => void }) {
  return (
    <Sheet open={!!edit} onClose={onClose} title={edit?.cat ? '編輯分類' : edit?.parentId ? '新增子分類' : '新增主分類'}>
      {edit && <EditorBody key={edit.cat?.id ?? `new-${edit.parentId}`} edit={edit} onClose={onClose} />}
    </Sheet>
  );
}

function EditorBody({ edit, onClose }: { edit: NonNullable<Edit>; onClose: () => void }) {
  const [name, setName] = useState(edit.cat?.name ?? '');
  const [icon, setIcon] = useState(edit.cat?.icon ?? '');
  const [color, setColor] = useState(edit.cat?.color ?? CATEGORY_COLORS[0]);
  const snack = (text: string) => useUI.getState().showSnack({ text });
  const save = async () => {
    if (!name.trim()) return snack('請輸入名稱');
    if (edit.cat) await updateCategory(edit.cat.id, { name: name.trim(), icon: icon || '🏷️', color });
    else await addCategory({ kind: edit.kind, parentId: edit.parentId, name: name.trim(), icon: icon || '🏷️', color });
    onClose();
  };
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <span className="cat-icon" style={{ ['--c' as string]: color }}>
          <CatIcon icon={icon || '🏷️'} />
        </span>
      </div>
      <div className="list">
        <div className="field">
          <label htmlFor="c-name">名稱</label>
          <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={12} placeholder="分類名稱" />
        </div>
        <div className="field">
          <label htmlFor="c-icon">圖示</label>
          <input id="c-icon" value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={16} placeholder="🏷️" />
        </div>
      </div>
      <div className="sub-row" role="radiogroup" aria-label="常用圖示" style={{ flexWrap: 'wrap', margin: '8px 0 12px' }}>
        {['🍽️', '☕', '🛍️', '🚇', '🏠', '🎮', '💊', '📚', '✈️', '🎁', '💼', '💰', '📈', '🏷️'].map((ic) => (
          <button key={ic} type="button" className="pill" aria-pressed={icon === ic} onClick={() => setIcon(ic)}>{ic}</button>
        ))}
      </div>
      {!edit.parentId && (
        <div className="swatches" role="radiogroup" aria-label="顏色">
          {CATEGORY_COLORS.map((c) => (
            <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
          ))}
        </div>
      )}
      <button className="btn" style={{ marginTop: 14 }} onClick={() => void save()}>儲存</button>
      {edit.cat && !edit.cat.system && edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME && (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10, textAlign: 'center' }}>每個分類都固定保留「其他」子分類，無法封存或刪除。</p>
      )}
      {edit.cat && !edit.cat.system && !(edit.cat.parentId && edit.cat.name === OTHER_SUB_NAME) && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={async () => { await updateCategory(edit.cat!.id, { archived: edit.cat!.archived ? 0 : 1 }); onClose(); }}>
            {edit.cat.archived ? '取消封存' : '封存'}
          </button>
          <button className="btn danger" onClick={async () => {
            if (!await ask(`刪除「${edit.cat!.name}」？已被使用的分類會改為封存。`)) return;
            const r = await deleteOrArchiveCategory(edit.cat!.id);
            snack(r === 'deleted' ? '已刪除' : '分類已有帳目，已改為封存');
            onClose();
          }}>刪除</button>
        </div>
      )}
    </>
  );
}

