/**
 * 股票搜尋：輸入代號或名稱（台股上市／上櫃／興櫃／ETF、美股、港股），選取後建立標的。
 */
import { useDeferredValue, useEffect, useState } from 'react';
import type { Stock } from '@/db/types';
import { ensureStock } from '@/db/repo/invest';
import { searchStocks, type StockMeta } from '@/services/quotes/search';
import { Icon } from '@/ui/Icon';
import { CustomSelect } from '@/ui/form';

export const MARKET_LABEL: Record<string, string> = { TWSE: '上市', TPEX: '上櫃', EMERGING: '興櫃', US: '美股', HK: '港股' };

const defaultAutoFocus = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? false : true;

export function StockSearch({ onPick, autoFocus = defaultAutoFocus }: { onPick: (s: Stock) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [results, setResults] = useState<StockMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [m, setM] = useState<StockMeta>({ market: 'TWSE', symbol: '', name: '', currency: 'TWD', assetType: 'stock' });

  useEffect(() => {
    let alive = true;
    if (!dq.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => {
      searchStocks(dq).then((r) => { if (alive) setResults(r); }).catch(() => undefined).finally(() => alive && setLoading(false));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [dq]);

  const pick = async (meta: StockMeta) => onPick(await ensureStock(meta));

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <input className="input" autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder="代號或名稱，例如 2330、0050、AAPL"
          aria-label="搜尋股票" style={{ paddingLeft: 38 }} enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck={false} />
        <span className="faint" style={{ position: 'absolute', left: 11, top: 12 }}><Icon name="search" size={20} /></span>
      </div>
      {loading && <p className="muted" style={{ fontSize: '0.8rem' }}>搜尋中…（第一次會下載台股名單）</p>}
      {results.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {results.map((r) => (
            <button key={`${r.market}:${r.symbol}`} className="row" onClick={() => void pick(r)}>
              <span className="num" style={{ fontWeight: 700, minWidth: 64 }}>{r.symbol}</span>
              <div className="row-main">
                <div className="row-title">{r.name}</div>
                <div className="row-sub">{MARKET_LABEL[r.market]}{r.assetType !== 'stock' ? ` · ${r.assetType === 'etf' ? 'ETF' : '債券 ETF'}` : ''}{r.industry ? ` · ${r.industry}` : ''} · {r.currency}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {dq && !loading && results.length === 0 && <p className="muted" style={{ textAlign: 'center' }}>找不到「{dq}」。可能離線或代理未設定，可改為手動新增。</p>}
      <button className="btn secondary small" style={{ marginTop: 12 }} onClick={() => setManual((x) => !x)}>{manual ? '收起' : '手動新增標的'}</button>
      {manual && (
        <div className="list" style={{ marginTop: 10 }}>
          <div className="field"><span className="label">市場</span>
            <CustomSelect
              title="市場"
              value={m.market}
              onChange={(val) => { const mk = val as StockMeta['market']; setM({ ...m, market: mk, currency: mk === 'US' ? 'USD' : mk === 'HK' ? 'HKD' : 'TWD' }); }}
              options={Object.entries(MARKET_LABEL).map(([k, v]) => ({ value: k, label: v }))}
            />
          </div>
          <div className="field"><span className="label">代號</span><input autoComplete="off" autoCorrect="off" spellCheck={false} value={m.symbol} onChange={(e) => setM({ ...m, symbol: e.target.value.toUpperCase().trim() })} /></div>
          <div className="field"><span className="label">名稱</span><input autoComplete="off" autoCorrect="off" spellCheck={false} value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></div>
          <div className="field"><span className="label">類型</span>
            <CustomSelect
              title="類型"
              value={m.assetType}
              onChange={(val) => setM({ ...m, assetType: val as StockMeta['assetType'] })}
              options={[
                { value: 'stock', label: '股票' },
                { value: 'etf', label: 'ETF' },
                { value: 'bond_etf', label: '債券 ETF' },
              ]}
            />
          </div>
          <button className="row accent" disabled={!m.symbol || !m.name} onClick={() => void pick(m)}>建立並選取</button>
        </div>
      )}
    </div>
  );
}
