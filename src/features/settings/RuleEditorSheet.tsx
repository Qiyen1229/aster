/**
 * 共用的「自動改名與分類規則」編輯抽屜：
 * 供「自動分類規則頁」、「自動入帳偏好頁」與「收件匣（一鍵存為規則）」共用，避免重複邏輯。
 */
import type { Category, CategoryKind, CategoryRule } from '@/db/types';
import { categoryLabel, useAccounts, useCategories, useTags } from '@/app/hooks';
import { deleteRule, saveRule } from '@/services/autocat';
import { ask, useUI } from '@/stores/ui';
import { Segmented } from '@/ui/controls';
import { AccountField, CategoryField, SelectField, SwitchField, TextField } from '@/ui/form';
import { Sheet } from '@/ui/Sheet';

export type RuleDraft = Omit<CategoryRule, 'id' | 'createdAt' | 'updatedAt' | 'hits'> & { id?: string };

export const blankRule = (kind: CategoryKind = 'expense', categoryId = '', keyword = '', renameNote = ''): RuleDraft => ({
  keyword,
  match: 'contains',
  kind,
  renameNote,
  categoryId,
  tagIds: [],
  priority: 100,
  enabled: true,
});

export const RULE_MATCH_LABEL = { contains: '包含', equals: '完全相同', regex: '正規表示式' } as const;

export function ruleTargetSummary(r: Pick<CategoryRule, 'renameNote' | 'categoryId'>, catMap: Map<string, Category>): string {
  const parts: string[] = [];
  if (r.renameNote?.trim()) parts.push(`改名「${r.renameNote.trim()}」`);
  if (r.categoryId) parts.push(categoryLabel(catMap, r.categoryId));
  return parts.join(' · ') || '（未指定）';
}

export function RuleEditorSheet({ draft, onChange, onClose, onSaved }: {
  draft: RuleDraft | null;
  onChange: (next: RuleDraft | null) => void;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { all: cats, map: catMap } = useCategories();
  const { list: tags } = useTags();
  const { list: accounts } = useAccounts();

  const save = async () => {
    if (!draft) return;
    if (!draft.keyword.trim()) { useUI.getState().showSnack({ text: '請輸入關鍵字' }); return; }
    if (!draft.renameNote?.trim() && !draft.categoryId) {
      useUI.getState().showSnack({ text: '請填寫「改寫名稱」或「指定類別」（至少一項）' });
      return;
    }
    if (draft.match === 'regex') {
      try { new RegExp(draft.keyword); } catch { useUI.getState().showSnack({ text: '正規表示式格式錯誤' }); return; }
    }
    await saveRule({
      ...draft,
      keyword: draft.keyword.trim(),
      renameNote: draft.renameNote?.trim() || undefined,
    });
    onClose();
    useUI.getState().showSnack({ text: '已儲存規則' });
    onSaved?.();
  };

  return (
    <Sheet open={!!draft} onClose={onClose} title={draft?.id ? '編輯規則' : '新增規則'}
      right={<button className="accent" onClick={() => void save()}>儲存</button>}>
      {draft && (
        <>
          <div className="list">
            <TextField label="關鍵字" value={draft.keyword} onChange={(v) => onChange({ ...draft, keyword: v })} placeholder="例如：遠東百貨板橋分公司" maxLength={80} />
            <SelectField label="比對方式" value={draft.match} onChange={(v) => onChange({ ...draft, match: v })}
              options={(Object.keys(RULE_MATCH_LABEL) as RuleDraft['match'][]).map((k) => ({ value: k, label: RULE_MATCH_LABEL[k] }))} />
            <TextField label="改寫名稱" value={draft.renameNote ?? ''} onChange={(v) => onChange({ ...draft, renameNote: v })} placeholder="例如：牛肉麵（留空不改名）" maxLength={60} />
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <Segmented value={draft.kind} ariaLabel="適用類型" onChange={(v) => onChange({ ...draft, kind: v, categoryId: v === 'any' || catMap.get(draft.categoryId)?.kind === v ? draft.categoryId : '' })}
                options={[{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }, { value: 'any', label: '兩者' }]} />
            </div>
            <CategoryField value={draft.categoryId} onChange={(v) => onChange({ ...draft, categoryId: v })} categories={cats}
              kind={draft.kind === 'income' ? 'income' : draft.kind === 'expense' ? 'expense' : catMap.get(draft.categoryId)?.kind ?? 'expense'} allowEmpty emptyLabel="不指定（依原本判斷）" />
            <AccountField label="指定帳戶" value={draft.accountId ?? ''} onChange={(v) => onChange({ ...draft, accountId: v || undefined })} accounts={accounts} allowEmpty emptyLabel="不指定" />
            <SelectField label="優先順序" value={draft.priority} onChange={(v) => onChange({ ...draft, priority: v })}
              options={[{ value: 10, label: '最高' }, { value: 50, label: '高' }, { value: 100, label: '一般' }, { value: 200, label: '低' }]} />
            <SwitchField label="啟用" checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} />
          </div>
          {tags.length > 0 && (
            <>
              <div className="section-title">同時加上標籤</div>
              <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 4px 12px' }}>
                {tags.map((t) => {
                  const on = draft.tagIds?.includes(t.id) ?? false;
                  return <button key={t.id} className="pill" aria-pressed={on} onClick={() => onChange({ ...draft, tagIds: on ? draft.tagIds!.filter((x) => x !== t.id) : [...(draft.tagIds ?? []), t.id] })}>#{t.name}</button>;
                })}
              </div>
            </>
          )}
          {draft.id && (
            <button className="btn danger" style={{ width: '100%' }} onClick={async () => {
              if (!await ask('刪除這條規則？')) return;
              await deleteRule(draft.id!);
              onClose();
            }}>刪除規則</button>
          )}
        </>
      )}
    </Sheet>
  );
}
