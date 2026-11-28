/**
 * 首頁小工具：顯示／隱藏與拖曳排序（按住左側 ≡ 手柄上下拖曳）。
 */
import { useNavigate } from 'react-router-dom';
import { ALL_WIDGETS, type WidgetKey } from '@/db/repo/settings';
import { useSettings } from '@/stores/settings';
import { Switch } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { DragHandle, SortableList } from '@/ui/SortableList';

export default function WidgetsPage() {
  const navigate = useNavigate();
  const keys = useSettings((s) => s.homeWidgets);
  const set = useSettings((s) => s.set);
  const hidden = ALL_WIDGETS.filter((w) => !keys.includes(w.key));
  const label = (k: WidgetKey) => ALL_WIDGETS.find((w) => w.key === k)?.label ?? k;

  return (
    <main className="page">
      <header className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={() => navigate(-1)}><Icon name="chevronL" /></button>
        <h1>首頁快覽</h1>
        <div style={{ width: 44 }} />
      </header>
      <div className="section-title">顯示中（按住左側 ≡ 拖曳調整順序）</div>
      {keys.length === 0 ? (
        <div className="list widgets-list">
          <div className="row muted">目前首頁沒有快覽；要的話從下面加回來</div>
        </div>
      ) : (
        <SortableList
          items={keys}
          getKey={(k) => k}
          className="list widgets-list"
          onReorder={(next) => set('homeWidgets', next)}
          renderItem={(k, _i, { handleProps }) => (
            <div className="row">
              <DragHandle handleProps={handleProps} />
              <span className="row-main">{label(k)}</span>
              <Switch checked label={`顯示 ${label(k)}`} onChange={() => set('homeWidgets', keys.filter((x) => x !== k))} />
            </div>
          )}
        />
      )}
      {hidden.length > 0 && (
        <>
          <div className="section-title">已隱藏</div>
          <div className="list widgets-list">
            {hidden.map((w) => (
              <div key={w.key} className="row">
                <span className="row-main">{w.label}</span>
                <Switch checked={false} label={`顯示 ${w.label}`} onChange={() => set('homeWidgets', [...keys, w.key])} />
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
