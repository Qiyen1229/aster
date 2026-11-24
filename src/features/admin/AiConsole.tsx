/**
 * Cilo 主控台（/admin/ai）：供應商連線狀況（可即時測試）、用量、各使用者用量、最近呼叫，以及開關與額度設定。
 * API Key 只存在伺服器 .env；這裡只顯示最後 4 碼。連線狀況（成功／失敗次數、最近錯誤）記在記憶體，API 重啟會歸零。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/services/api';
import { useUI } from '@/stores/ui';
import { EmptyState, SkeletonRows } from '@/ui/controls';
import { SwitchField } from '@/ui/form';

interface Provider {
  name: string; model: string; base_host: string; configured: boolean; key_hint: string; cooling_down: boolean; cooldown_remaining_s: number;
  ok: number; fail: number; last_ok_at: number | null; last_fail_at: number | null; last_error: string; last_latency_ms: number | null; extra_keys?: string[];
}
interface Settings {
  enabled: boolean; user_daily: number; user_weekly: number; user_monthly: number; global_daily: number; admin_daily: number; admin_weekly: number; admin_monthly: number; overridden: boolean;
  used_today: number; used_today_by_provider: Record<string, number>;
}
interface AsrStatus {
  configured: boolean; url: string; health_ok: boolean | null; health_detail: string; health_latency_ms: number | null;
}
interface AsrTestResult {
  ok: boolean; source: 'local' | 'gemini' | 'none'; text: string; latency_ms: number; detail: string;
}
interface Console {
  settings: Settings; providers: Provider[]; asr?: AsrStatus;
  totals: { today: number; week: number; month: number };
  by_role: Record<'user' | 'admin', { today: number; week: number; month: number }>;
  by_user: { user_id: number; username: string; role: 'user' | 'admin'; today: number; week: number; month: number }[];
  recent: { at: string; username: string; kind: string; provider: string; model: string; cost: number }[];
  daily: { date: string; count: number }[]; timezone: string; server_time: string;
}
interface TestResult { name: string; ok: boolean; latency_ms: number | null; detail: string }

const KIND: Record<string, string> = {
  search_plan: 'Cilo 搜尋', explain: '專案／帳戶解說', agent_plan: '操作助手', statement: '帳單對帳（截圖）',
  parse_entry: '一句話記帳', price_check: '市價檢查（不計額度）', ask: '問 Cilo', budget_plan: '預算建議', insights: '白話解讀', categorize: '整理分類', receipt: '拍照記帳',
};
const epoch = (t: number | null) => (t ? new Date(t * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
const utc = (s: string) => new Date(s + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function status(p: Provider): { icon: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!p.configured) return { icon: '⚪️', text: '未設定（缺 Key／網址／模型）', tone: 'muted' };
  if (p.cooling_down) return { icon: '🟠', text: `冷卻中（連續失敗，約 ${p.cooldown_remaining_s} 秒後再試）`, tone: 'warn' };
  if (p.last_fail_at && (!p.last_ok_at || p.last_fail_at > p.last_ok_at)) return { icon: '🔴', text: '最近一次失敗', tone: 'bad' };
  if (p.last_ok_at) return { icon: '🟢', text: '正常', tone: 'ok' };
  return { icon: '🔵', text: '已設定，尚未測試', tone: 'muted' };
}

type AudioFmt = 'mp4' | 'webm' | 'ogg' | 'wav' | 'mp3' | 'aac';

function inferAudioFormat(file: File): AudioFmt {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'm4a' || ext === 'mp4') return 'mp4';
  if (ext === 'webm') return 'webm';
  if (ext === 'ogg' || ext === 'oga') return 'ogg';
  if (ext === 'wav') return 'wav';
  if (ext === 'mp3') return 'mp3';
  if (ext === 'aac') return 'aac';
  if (file.type.includes('webm')) return 'webm';
  if (file.type.includes('ogg')) return 'ogg';
  if (file.type.includes('wav')) return 'wav';
  if (file.type.includes('mpeg') || file.type.includes('mp3')) return 'mp3';
  if (file.type.includes('aac')) return 'aac';
  return 'mp4';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = typeof reader.result === 'string' ? reader.result : '';
      const i = s.indexOf(',');
      if (!s || i === -1) { reject(new Error('讀取音檔失敗')); return; }
      resolve(s.slice(i + 1));
    };
    reader.onerror = () => reject(new Error('讀取音檔失敗'));
    reader.readAsDataURL(blob);
  });
}

function pickRecorderMime(): { mime: string; format: AudioFmt } {
  const list: { mime: string; format: AudioFmt }[] = [
    { mime: 'audio/mp4', format: 'mp4' },
    { mime: 'audio/webm;codecs=opus', format: 'webm' },
    { mime: 'audio/webm', format: 'webm' },
    { mime: 'audio/ogg;codecs=opus', format: 'ogg' },
    { mime: 'audio/ogg', format: 'ogg' },
  ];
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const c of list) if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', format: 'mp4' };
}

export default function AiConsole() {
  const [d, setD] = useState<Console | null>(null);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState<Record<string, TestResult | 'busy'>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [asrSample, setAsrSample] = useState<{ b64: string; format: AudioFmt; label: string } | null>(null);
  const [asrBusy, setAsrBusy] = useState(false);
  const [asrRes, setAsrRes] = useState<AsrTestResult | null>(null);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: BlobPart[]; format: AudioFmt } | null>(null);

  const load = useCallback(async () => {
    try { setD(await api<Console>('/admin/ai/console')); setErr(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '載入失敗'); }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000);
    return () => clearInterval(id);
  }, [load]);

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: 'busy' }));
    try {
      const r = await api<TestResult>('/admin/ai/test', { method: 'POST', body: { provider: name } });
      setTests((t) => ({ ...t, [name]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { name, ok: false, latency_ms: null, detail: (e as Error).message } }));
    }
    void load();
  };
  const testAll = async () => { for (const p of d?.providers ?? []) if (p.configured) await test(p.name); };

  const onPickAsrFile = async (file: File) => {
    try {
      const b64 = await blobToBase64(file);
      setAsrSample({ b64, format: inferAudioFormat(file), label: `${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB）` });
      setAsrRes(null);
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); }
  };

  const toggleRecord = async () => {
    if (recording && recRef.current) {
      recRef.current.rec.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      useUI.getState().showSnack({ text: '目前瀏覽器不支援錄音，請改用上傳音檔' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const picked = pickRecorderMime();
      const rec = picked.mime ? new MediaRecorder(stream, { mimeType: picked.mime }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        recRef.current = null;
        const blob = new Blob(chunks, { type: picked.mime || 'audio/mp4' });
        if (!blob.size) return;
        const b64 = await blobToBase64(blob);
        setAsrSample({ b64, format: picked.format, label: `即時錄音（${Math.max(1, Math.round(blob.size / 1024))} KB）` });
        setAsrRes(null);
      };
      recRef.current = { rec, stream, chunks, format: picked.format };
      rec.start();
      setRecording(true);
    } catch (e) {
      useUI.getState().showSnack({ text: `無法啟動麥克風：${(e as Error).message}` });
    }
  };

  const runAsrTest = async () => {
    if (!asrSample) return;
    setAsrBusy(true);
    setAsrRes(null);
    try {
      const r = await api<AsrTestResult>('/admin/ai/asr-test', { method: 'POST', body: { audio_b64: asrSample.b64, format: asrSample.format } });
      setAsrRes(r);
    } catch (e) {
      setAsrRes({ ok: false, source: 'none', text: '', latency_ms: 0, detail: (e as Error).message });
    } finally { setAsrBusy(false); }
  };
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api('/admin/ai', { method: 'PATCH', body });
      setDraft({});
      useUI.getState().showSnack({ text: '已更新 Cilo 設定' });
      await load();
    } catch (e) { useUI.getState().showSnack({ text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (err && !d) return <EmptyState emoji="⚠️" title="無法載入 Cilo 主控台" text={err} action={<button className="btn small" onClick={() => void load()}>重試</button>} />;
  if (!d) return <SkeletonRows n={4} />;
  const { settings: st } = d;
  const ready = d.providers.filter((p) => p.configured);
  const healthy = ready.filter((p) => status(p).tone === 'ok').length;
  const summary = !ready.length ? { icon: '⚠️', text: '尚未設定任何供應商：到 NAS 的 .env 填入 API Key，再 docker compose up -d' }
    : !st.enabled ? { icon: '⏸', text: 'Cilo 已由管理員關閉' }
    : { icon: healthy ? '✅' : '🔎', text: `${ready.length} 個供應商已設定，${healthy} 個確認正常${healthy ? '' : '（按「全部測試」確認 Key 是否有效）'}` };
  const limits: [string, string, number][] = [
    ['user_daily', '一般使用者・每人每日', st.user_daily], ['user_weekly', '一般使用者・每人每週', st.user_weekly], ['user_monthly', '一般使用者・每人每月', st.user_monthly],
    ['admin_daily', '管理員・每人每日', st.admin_daily], ['admin_weekly', '管理員・每人每週', st.admin_weekly], ['admin_monthly', '管理員・每人每月', st.admin_monthly],
    ['global_daily', '全站每日（兩者合計）', st.global_daily],
  ];
  const dirty = limits.some(([k, , v]) => draft[k] !== undefined && draft[k] !== String(v));
  const max = Math.max(1, ...d.daily.map((x) => x.count));

  return (
    <>
      <div className="card" role="status" style={{ marginBottom: 12 }}>
        <div className="row-title">{summary.icon} {summary.text}</div>
        <div className="row-sub" style={{ whiteSpace: 'normal' }}>伺服器時間 {utc(d.server_time)}（額度以 {d.timezone} 計算）</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn small" onClick={() => void testAll()} disabled={!ready.length}>全部測試</button>
          <button className="btn small ghost" onClick={() => void load()}>重新整理</button>
        </div>
      </div>

      <div className="section-title">供應商（依嘗試順序）</div>
      <div className="list">
        {d.providers.length === 0 && <div className="row muted">CLURE_AI_PROVIDERS 沒有任何供應商</div>}
        {d.providers.map((p, i) => {
          const s = status(p);
          const t = tests[p.name];
          return (
            <div key={p.name} className="row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span className="row-title">{i + 1}. {p.name} <span className="muted">{s.icon} {s.text}</span></span>
                <button className="btn small" disabled={!p.configured || t === 'busy'} onClick={() => void test(p.name)}>{t === 'busy' ? '測試中…' : '測試連線'}</button>
              </div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                模型 {p.model || '（未設定）'}　主機 {p.base_host || '—'}　Key {p.key_hint || '（未設定）'}{p.extra_keys?.length ? `　額外參數 ${p.extra_keys.join('、')}` : ''}
              </div>
              <div className="row-sub" style={{ whiteSpace: 'normal' }}>
                自上次重啟：成功 {p.ok} 次、失敗 {p.fail} 次　最近成功 {epoch(p.last_ok_at)}{p.last_latency_ms !== null ? `（${p.last_latency_ms} ms）` : ''}
              </div>
              {p.last_error && <div className="row-sub" style={{ whiteSpace: 'normal', color: s.tone === 'ok' ? undefined : 'var(--danger)' }}>最近錯誤 {epoch(p.last_fail_at)}：{p.last_error}</div>}
              {t && t !== 'busy' && (
                <div role="status" style={{ marginTop: 4, color: t.ok ? 'var(--success, #30D158)' : 'var(--danger)' }}>
                  {t.ok ? '✅' : '❌'} {t.detail}{t.latency_ms !== null ? `（${t.latency_ms} ms）` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="set-note">「測試連線」會送 1 次極小的請求（用掉供應商 1 次額度，不扣使用者額度），成功會解除冷卻。Key 只存在伺服器的 .env，這裡只顯示最後 4 碼。</p>

      <div className="section-title">本地語音（Breeze-ASR-25）測試</div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="row-title">
            {d.asr?.configured ? (d.asr.health_ok ? '🟢' : '🔴') : '⚪️'} CLURE_ASR_URL：{d.asr?.configured ? '已設定' : '未設定'}
          </span>
          <button type="button" className="btn small ghost" onClick={() => void load()}>檢查狀態</button>
        </div>
        {d.asr?.configured && (
          <div className="row-sub" style={{ whiteSpace: 'normal', marginTop: 4 }}>
            網址：<code>{d.asr.url}</code>
            <br />
            健康檢查（/health）：{d.asr.health_ok ? `ok${d.asr.health_latency_ms !== null ? `（${d.asr.health_latency_ms} ms）` : ''}` : d.asr.health_detail || '連不上'}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <label className="btn small tinted" style={{ cursor: 'pointer' }}>
            上傳音檔
            <input
              type="file"
              accept="audio/*,.m4a,.mp4,.webm,.ogg,.wav,.mp3,.aac"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onPickAsrFile(f);
              }}
            />
          </label>
          <button type="button" className={`btn small ${recording ? 'danger' : 'tinted'}`} onClick={() => void toggleRecord()}>
            {recording ? '停止錄音' : '直接錄音'}
          </button>
          <button type="button" className="btn small" disabled={!asrSample || asrBusy || recording} onClick={() => void runAsrTest()}>
            {asrBusy ? '轉錄中…' : '測試轉錄'}
          </button>
        </div>
        {asrSample && <div className="row-sub" style={{ marginTop: 8 }}>已準備音檔：{asrSample.label}</div>}
        {asrRes && (
          <div role="status" style={{ marginTop: 10, fontSize: '0.88rem', lineHeight: 1.5 }}>
            <div style={{ color: asrRes.ok ? 'var(--success, #30D158)' : 'var(--danger)', fontWeight: 600 }}>
              {asrRes.ok ? '✅' : '❌'} {asrRes.detail}（來源：{asrRes.source === 'local' ? 'local' : asrRes.source === 'gemini' ? 'fallback gemini' : '無'} · {asrRes.latency_ms} ms）
            </div>
            {asrRes.text && (
              <div style={{ marginTop: 4, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', color: 'var(--text)' }}>
                {asrRes.text}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="section-title">用量（次）</div>
      <div className="admin-grid three">
        {([['今日', d.totals.today, st.global_daily], ['本週', d.totals.week, 0], ['本月', d.totals.month, 0]] as const).map(([k, v, cap]) => (
          <div key={k} className={`admin-stat compact${cap && v >= cap ? ' warn' : ''}`}>
            <div className="k">{k}</div>
            <div className="v num">{v}</div>
            {cap ? <div className="k">全站上限 {cap}</div> : <div className="k">&nbsp;</div>}
          </div>
        ))}
      </div>
      {Object.keys(st.used_today_by_provider).length > 0 && (
        <p className="set-note">今日各供應商：{Object.entries(st.used_today_by_provider).map(([k, v]) => `${k} ${v}`).join('、')}</p>
      )}
      <div className="card usage-chart" role="img" aria-label="近 7 天每日用量">
        <div className="usage-bars">
          {d.daily.map((x) => (
            <div key={x.date} className="usage-bar">
              <div className="num">{x.count}</div>
              <div className="usage-fill" style={{ height: Math.max(3, Math.round((x.count / max) * 56)) }} />
              <div className="muted">{x.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="usage-table" role="table" aria-label="依身分的用量">
        <div className="usage-head" role="row"><span /><span>今日</span><span>本週</span><span>本月</span></div>
        {(['user', 'admin'] as const).map((r) => (
          <div key={r} className="usage-row" role="row">
            <span className="row-title">{r === 'admin' ? '管理員' : '一般使用者'}</span>
            <span className="num">{d.by_role[r].today}</span><span className="num">{d.by_role[r].week}</span><span className="num">{d.by_role[r].month}</span>
          </div>
        ))}
      </div>

      <div className="section-title">各使用者用量（本月前 30 名）</div>
      <div className="usage-table" role="table" aria-label="各使用者用量">
        {d.by_user.length === 0 ? <div className="usage-row muted">本月還沒有人使用</div> : (
          <div className="usage-head" role="row"><span /><span>今日</span><span>本週</span><span>本月</span></div>
        )}
        {d.by_user.map((u) => (
          <div key={u.user_id} className="usage-row" role="row">
            <span className="row-title">{u.username}{u.role === 'admin' ? ' 🛡' : ''}</span>
            <span className="num">{u.today}</span><span className="num">{u.week}</span><span className="num">{u.month}</span>
          </div>
        ))}
      </div>

      <div className="section-title">最近 20 次呼叫</div>
      <div className="list">
        {d.recent.length === 0 && <div className="row muted">還沒有呼叫紀錄</div>}
        {d.recent.map((r, i) => (
          <div key={i} className="row">
            <span className="row-main"><span className="row-title">{r.username}　{KIND[r.kind] ?? r.kind}</span><span className="row-sub" style={{ display: 'block' }}>{r.provider}　{r.model}</span></span>
            <span className="muted">{utc(r.at)}</span>
          </div>
        ))}
      </div>
      <p className="set-note">不記錄使用者輸入的內容，只記次數、供應商與模型。失敗的呼叫不在這裡（看供應商卡片的「最近錯誤」或 docker compose logs api）。</p>

      <div className="section-title">開關與額度</div>
      <div className="list" style={{ marginBottom: 10 }}>
        <SwitchField label="Cilo" checked={st.enabled} onChange={(v) => { if (!busy) void save({ enabled: v }); }}
          sub={st.overridden ? '關閉後所有使用者都不能用 Cilo（記帳規則解析不受影響）' : '額度目前沿用 .env 預設值；在這裡儲存後以後台為準'} />
      </div>
      <div className="quota-card">
        {([['user', '一般使用者', '每人'], ['admin', '管理員', '每人']] as const).map(([role, name, who]) => (
          <div key={role} className="quota-block">
            <div className="quota-title">{name}<span>{who}</span></div>
            <div className="quota-grid">
              {([['daily', '每日'], ['weekly', '每週'], ['monthly', '每月']] as const).map(([per, label]) => {
                const k = `${role}_${per}`;
                const v = (st as unknown as Record<string, number>)[k];
                return (
                  <label key={k} className="quota-field">
                    <span>{label}</span>
                    <input className="num" inputMode="numeric" aria-label={`${name}${who}${label}額度`} value={draft[k] ?? String(v)}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value.replace(/\D/g, '').slice(0, 7) })} />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <div className="quota-block">
          <div className="quota-title">全站每日<span>兩者合計</span></div>
          <div className="quota-grid one">
            <label className="quota-field">
              <span>每日上限</span>
              <input className="num" inputMode="numeric" aria-label="全站每日上限" value={draft.global_daily ?? String(st.global_daily)}
                onChange={(e) => setDraft({ ...draft, global_daily: e.target.value.replace(/\D/g, '').slice(0, 7) })} />
            </label>
          </div>
        </div>
        <p className="quota-note">單位是「次」，填 0＝不限。每日 00:00、每週一 00:00、每月 1 日重置；全站每日上限建議設在免費供應商的每日額度以內。</p>
        <button className="btn" disabled={!dirty || busy} onClick={() => void save(Object.fromEntries(limits.filter(([k]) => draft[k] !== undefined).map(([k]) => [k, Number(draft[k] || 0)])))}>{busy ? '儲存中…' : '儲存額度'}</button>
      </div>
    </>
  );
}
