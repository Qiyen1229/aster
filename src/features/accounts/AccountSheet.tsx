/**
 * 新增／編輯帳戶：名稱、類型、幣別、期初餘額、是否計入淨資產、圖示顏色；
 * 信用卡另有額度、結帳日、繳款日；貸款另有種類、原始本金、年利率、期數、首次還款日（產生攤還表）。
 */
import { useState } from 'react';
import type { Account, AccountType, LoanInfo } from '@/db/types';
import { LOAN_KIND_LABEL } from '@/domain/loan';
import { addMonths, todayKey } from '@/domain/period';
import { ACCOUNT_TYPES, addAccount, deleteOrArchiveAccount, updateAccount } from '@/db/repo/accounts';
import { CURRENCIES, currencyInfo, fromMinor, toMinor } from '@/domain/money';
import { evaluate } from '@/domain/calc-expr';
import { CATEGORY_COLORS } from '@/db/seed/categories';
import { useAccounts } from '@/app/hooks';
import { useSettings } from '@/stores/settings';
import { useUI, ask } from '@/stores/ui';
import { Sheet } from '@/ui/Sheet';
import { Switch } from '@/ui/controls';
import { CustomDateInput, CustomSelect } from '@/ui/form';
import { CatIcon, iconEmoji, EMOJI_TO_LUCIDE } from '@/ui/Icon';

const ACCOUNT_ICONS: { key: string; label: string }[] = [
  // 金融與日常支付
  { key: 'landmark', label: '銀行' },
  { key: 'credit-card', label: '信用卡' },
  { key: 'banknote', label: '現金' },
  { key: 'wallet', label: '錢包' },
  { key: 'piggy-bank', label: '存錢筒' },
  { key: 'coins', label: '零錢' },
  { key: 'smartphone', label: '行動支付' },
  { key: 'ticket', label: '儲值票證' },
  // 投資與資產
  { key: 'trending-up', label: '證券股票' },
  { key: 'building', label: '不動產' },
  { key: 'home', label: '房產房貸' },
  { key: 'car', label: '車貸載具' },
  { key: 'briefcase', label: '商務公帳' },
  { key: 'handshake', label: '借貸往來' },
  // 生活與專屬目標
  { key: 'shield-check', label: '保險備用' },
  { key: 'sparkles', label: '高利活存' },
  { key: 'target', label: '目標儲蓄' },
  { key: 'plane', label: '外幣旅遊' },
  { key: 'gift', label: '禮金禮券' },
  { key: 'laptop', label: '數位帳戶' },
  { key: 'receipt', label: '載具帳單' },
  { key: 'scale', label: '平衡調節' },
  { key: 'folder', label: '綜合專戶' },
];

export function AccountSheet({ open, onClose, account }: { open: boolean; onClose: () => void; account?: Account }) {
  return open ? <Inner key={account?.id ?? 'new'} onClose={onClose} account={account} /> : <Sheet open={false} onClose={onClose}>{null}</Sheet>;
}

function Inner({ onClose, account }: { onClose: () => void; account?: Account }) {
  const base = useSettings((s) => s.baseCurrency);
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank');
  const [currency, setCurrency] = useState(account?.currency ?? base);
  const [initial, setInitial] = useState(account ? fromMinor(Math.abs(account.initialBalanceMinor), account.currency).toString() : '');
  const [initialNegative, setInitialNegative] = useState(account ? account.initialBalanceMinor < 0 : false);
  const [icon, setIcon] = useState(account?.icon ?? '');
  const [color, setColor] = useState(account?.color ?? CATEGORY_COLORS[6]);
  const [include, setInclude] = useState(account?.includeInNetWorth ?? true);
  const [last4, setLast4] = useState(account?.last4 ?? '');
  const [limit, setLimit] = useState(account?.credit ? fromMinor(account.credit.limitMinor, account.currency).toString() : '');
  const [statementDay, setStatementDay] = useState(account?.credit?.statementDay ?? 20);
  const [dueDay, setDueDay] = useState(account?.credit?.dueDay ?? 5);
  const [autoPay, setAutoPay] = useState(account?.credit?.autoPayAccountId ?? '');
  const { list: allAccounts } = useAccounts();
  const [note, setNote] = useState(account?.note ?? '');
  const [loanOn, setLoanOn] = useState(!!account?.loan);
  const [loanKind, setLoanKind] = useState<LoanInfo['kind']>(account?.loan?.kind ?? 'mortgage');
  const [loanPrincipal, setLoanPrincipal] = useState(account?.loan ? fromMinor(account.loan.principalMinor, account.currency).toString() : '');
  const [loanApr, setLoanApr] = useState(account?.loan?.aprDec ?? '2.2');
  const [loanTerm, setLoanTerm] = useState(String(account?.loan?.termMonths ?? 360));
  const [loanFirst, setLoanFirst] = useState(account?.loan?.firstPaymentDate ?? addMonths(todayKey(), 1));
  const info = ACCOUNT_TYPES.find((t) => t.type === type)!;
  const isLiability = info.liability;

  const save = async () => {
    if (!name.trim()) { useUI.getState().showSnack({ text: '請輸入帳戶名稱' }); return; }
    const v = evaluate(initial || '0');
    if (!v) { useUI.getState().showSnack({ text: '期初餘額格式錯誤' }); return; }
    // 負債類帳戶：輸入「目前欠款」，以負數儲存
    let initialMinor = toMinor(v, currency);
    if (isLiability || initialNegative) initialMinor = -Math.abs(initialMinor);
    const input = {
      name: name.trim(), type, currency, icon: icon || info.icon, color, includeInNetWorth: include, isLiability,
      initialBalanceMinor: initialMinor, note, last4: last4.replace(/\D/g, '').slice(0, 5) || undefined,
      credit: type === 'credit' ? { limitMinor: toMinor(evaluate(limit || '0') ?? 0, currency), statementDay, dueDay, autoPayAccountId: autoPay || undefined } : undefined,
      loan: type === 'loan' && loanOn ? {
        kind: loanKind, principalMinor: toMinor(evaluate(loanPrincipal || '0') ?? 0, currency), aprDec: loanApr || '0',
        termMonths: Math.max(1, Math.round(Number(loanTerm) || 1)), firstPaymentDate: loanFirst, payFromAccountId: account?.loan?.payFromAccountId,
      } : undefined,
    };
    if (input.loan && input.loan.principalMinor <= 0) { useUI.getState().showSnack({ text: '請輸入原始貸款金額' }); return; }
    try {
      if (account) await updateAccount(account.id, input);
      else await addAccount(input);
      useUI.getState().showSnack({ text: account ? '已更新帳戶' : '已新增帳戶' });
      onClose();
    } catch (e) {
      useUI.getState().showSnack({ text: (e as Error).message });
    }
  };

  const remove = async () => {
    if (!account || !await ask(`刪除「${account.name}」？若已有帳目，將改為封存以保留歷史紀錄。`)) return;
    const r = await deleteOrArchiveAccount(account.id);
    useUI.getState().showSnack({ text: r === 'deleted' ? '已刪除帳戶' : '帳戶有帳目，已改為封存' });
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={account ? '編輯帳戶' : '新增帳戶'} full
      right={<button className="accent" style={{ minHeight: 44, fontWeight: 600 }} onClick={() => void save()}>儲存</button>}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 16px' }} role="radiogroup" aria-label="帳戶類型">
        {ACCOUNT_TYPES.map((t) => (
          <button key={t.type} className="pill" role="radio" aria-checked={type === t.type} aria-pressed={type === t.type}
            disabled={!!account && account.type !== t.type && (t.liability !== info.liability)}
            onClick={() => setType(t.type)}>
            <CatIcon icon={t.icon} size={16} style={{ verticalAlign: -2, marginRight: 4 }} />{t.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <span className="cat-icon" style={{ ['--c' as string]: color }}>
          <CatIcon icon={icon || info.icon} />
        </span>
      </div>
      <div className="list">
        <div className="field"><label htmlFor="acc-name">名稱</label><input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`例如：${info.label === '信用卡' ? '國泰 CUBE 卡' : info.label === '銀行' ? '台新 Richart' : info.label}`} maxLength={30} /></div>
        <div className="field">
          <label htmlFor="acc-cur">幣別</label>
          <CustomSelect
            id="acc-cur"
            title="幣別"
            value={currency}
            disabled={!!account}
            onChange={setCurrency}
            options={Object.values(CURRENCIES).map((c) => ({ value: c.code, label: `${c.code} ${c.name}` }))}
          />
        </div>
        <div className="field">
          <label htmlFor="acc-init">{isLiability ? '期初欠款' : '期初餘額'}</label>
          <input id="acc-init" inputMode="decimal" value={initial} disabled={!!account}
            onChange={(e) => setInitial(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" />
          <span className="muted">{currencyInfo(currency).symbol}</span>
        </div>
        {account && (
          <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 12px 8px' }}>
            開戶基準金額不可直接修改；若要調整目前{isLiability ? '欠款' : '餘額'}，請在帳戶明細使用「校正餘額」。
          </p>
        )}
        {!isLiability && !account && (
          <div className="field"><span className="label" style={{ flex: 1 }}>期初為負數（透支）</span><Switch checked={initialNegative} onChange={setInitialNegative} label="期初為負數" /></div>
        )}
        <div className="field"><span className="label" style={{ flex: 1 }}>計入淨資產</span><Switch checked={include} onChange={setInclude} label="計入淨資產" /></div>
        {(type === 'bank' || type === 'epay' || type === 'stored' || type === 'credit') && (
          <div className="field">
            <label htmlFor="acc-last4">末四碼（選填）</label>
            <input id="acc-last4" inputMode="numeric" maxLength={5} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="供自動轉帳比對，如 7068" />
          </div>
        )}
      </div>

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>圖示（Lucide 向量圖標）</span>
        <span className="muted" style={{ fontSize: '0.75rem', fontWeight: 400 }}>點選立即切換</span>
      </div>
      <div className="acc-icon-grid" role="radiogroup" aria-label="帳戶圖示">
        {ACCOUNT_ICONS.map((it) => {
          const currentKey = icon || info.icon;
          const isSelected = currentKey === it.key || EMOJI_TO_LUCIDE[currentKey] === it.key;
          return (
            <button
              key={it.key}
              type="button"
              className={`acc-icon-btn${isSelected ? ' is-selected' : ''}`}
              title={it.label}
              aria-label={it.label}
              aria-pressed={isSelected}
              onClick={() => setIcon(it.key)}
            >
              <CatIcon icon={it.key} size={22} />
              <span className="acc-icon-lbl">{it.label}</span>
            </button>
          );
        })}
      </div>
      <div className="list" style={{ marginTop: 6 }}>
        <div className="field">
          <label htmlFor="acc-icon">自訂圖示／Emoji</label>
          <input
            id="acc-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value.trim())}
            placeholder={`預設：${info.icon}`}
            maxLength={20}
          />
        </div>
      </div>

      {type === 'credit' && (
        <>
          <div className="section-title">信用卡</div>
          <div className="list">
            <div className="field"><label htmlFor="cc-limit">信用額度</label><input id="cc-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
            <div className="field">
              <label htmlFor="cc-st">結帳日</label>
              <CustomSelect
                id="cc-st"
                title="結帳日"
                value={String(statementDay)}
                onChange={(val) => setStatementDay(Number(val))}
                options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `每月 ${i + 1} 日${i === 30 ? '（月底）' : ''}` }))}
              />
            </div>
            <div className="field">
              <label htmlFor="cc-due">繳款日</label>
              <CustomSelect
                id="cc-due"
                title="繳款日"
                value={String(dueDay)}
                onChange={(val) => setDueDay(Number(val))}
                options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `每月 ${i + 1} 日` }))}
              />
            </div>
            <div className="field">
              <label htmlFor="cc-pay">扣繳帳戶</label>
              <CustomSelect
                id="cc-pay"
                title="扣繳帳戶"
                value={autoPay}
                onChange={setAutoPay}
                options={[
                  { value: '', label: '（未設定）' },
                  ...allAccounts.filter((a) => ['bank', 'cash', 'epay', 'stored'].includes(a.type) && a.currency === currency).map((a) => ({ value: a.id, label: `${iconEmoji(a.icon)} ${a.name}` })),
                ]}
              />
            </div>
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 8px 0' }}>扣繳帳戶用在「現金流預測」：繳款日從這個帳戶扣卡費。</p>
        </>
      )}

      {type === 'loan' && (
        <>
          <div className="section-title">貸款攤還（房貸、車貸…）</div>
          <div className="list">
            <div className="field"><span className="label" style={{ flex: 1 }}>產生攤還表</span><Switch checked={loanOn} onChange={setLoanOn} label="產生攤還表" /></div>
            {loanOn && (
              <>
                <div className="field">
                  <label htmlFor="ln-kind">種類</label>
                  <CustomSelect
                    id="ln-kind"
                    title="貸款種類"
                    value={loanKind}
                    onChange={(val) => setLoanKind(val as LoanInfo['kind'])}
                    options={(Object.keys(LOAN_KIND_LABEL) as LoanInfo['kind'][]).map((k) => ({ value: k, label: LOAN_KIND_LABEL[k] }))}
                  />
                </div>
                <div className="field"><label htmlFor="ln-p">原始貸款金額</label><input id="ln-p" inputMode="decimal" value={loanPrincipal} onChange={(e) => setLoanPrincipal(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
                <div className="field"><label htmlFor="ln-apr">年利率（%）</label><input id="ln-apr" inputMode="decimal" value={loanApr} onChange={(e) => setLoanApr(e.target.value.replace(/[^0-9.]/g, ''))} /></div>
                <div className="field">
                  <label htmlFor="ln-term">期數（月）</label>
                  <input id="ln-term" inputMode="numeric" value={loanTerm} onChange={(e) => setLoanTerm(e.target.value.replace(/\D/g, ''))} />
                  <span className="muted">{Number(loanTerm) ? `${(Number(loanTerm) / 12).toFixed(1)} 年` : ''}</span>
                </div>
                <div className="field"><label htmlFor="ln-first">第一期還款日</label><CustomDateInput id="ln-first" title="第一期還款日" value={loanFirst} onChange={setLoanFirst} /></div>
              </>
            )}
          </div>
          {loanOn && <p className="muted" style={{ fontSize: '0.8rem', margin: '-4px 8px 12px' }}>「目前欠款」填實際剩餘本金；原始金額與期數用來計算每期應繳與攤還表（本息平均攤還）。</p>}
        </>
      )}

      <div className="section-title">顏色（20 色）</div>
      <div className="swatches" role="radiogroup" aria-label="顏色">
        {CATEGORY_COLORS.map((c) => (
          <button key={c} className="swatch" style={{ ['--c' as string]: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
        ))}
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        <div className="field"><label htmlFor="acc-note">備註</label><input id="acc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} /></div>
      </div>

      {account && (
        <>
          <button className="btn secondary" style={{ marginBottom: 10 }} onClick={async () => {
            await updateAccount(account.id, { archived: account.archived ? 0 : 1 });
            useUI.getState().showSnack({ text: account.archived ? '已取消封存' : '已封存（不會出現在選單中）' });
            onClose();
          }}>{account.archived ? '取消封存' : '封存帳戶'}</button>
          <button className="btn danger" onClick={() => void remove()}>刪除帳戶</button>
        </>
      )}
    </Sheet>
  );
}
