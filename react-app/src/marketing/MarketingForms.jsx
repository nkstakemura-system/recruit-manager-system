// 求人分析の入力ダイアログ（実績の登録・修正、取消、職種の管理、掲載状態の変更、参考求人）。
import React, { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MEDIA, METRICS, METRIC_LABELS, PLAN_STATUS, PLAN_TYPES, fmtRate, isDate, normalizeRecord, periodLabel, rates, recordWarnings, slashDate,
} from "../../../shared/jobMarketing.mjs";
import { marketingApi, errorText, planLabel, postingLabel, sourceLabel, statusLabel } from "./marketingApi";

export const MIN_DATE = "1000-01-01";
export const MAX_DATE = "9999-12-31";

// Esc・閉じるボタンで閉じるダイアログ
export function Modal({ title, onClose, children, wide }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="jm-backdrop">
      <div className={`jm-modal${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="jm-modal-head">
          <strong>{title}</strong>
          <button ref={closeRef} type="button" className="jm-close" aria-label="閉じる" onClick={onClose}>×</button>
        </div>
        <div className="jm-modal-body">{children}</div>
      </div>
    </div>
  );
}

// 補足説明（ホバー・フォーカスで表示）。通常画面に説明文を並べないために使う
export function Tip({ text, label = "説明" }) {
  return <span className="jm-tip" tabIndex={0} role="note" aria-label={`${label}：${text}`} data-tip={text}>?</span>;
}

// 期間が重なる既存記録の解消方法：置き換え（既存は履歴に残る）か、理由付きで重ねて登録（合算しない）
export function ConflictResolver({ problem, records, value, onChange }) {
  if (!problem || !["overlap", "same_period", "overlap_reason"].includes(problem.code)) return null;
  const conflicts = problem.conflicts || [];
  const replace = new Set(value.replace_ids);
  const toggle = cid => {
    const next = new Set(replace);
    if (next.has(cid)) next.delete(cid); else next.add(cid);
    onChange({ ...value, replace_ids: [...next] });
  };
  const same = problem.code === "same_period";
  return (
    <div className="jm-conflict" role="alert">
      <p className="jm-conflict-msg">{problem.message}</p>
      <ul>
        {conflicts.map(c => {
          // 同じCSVの別の列（未登録）とは置き換えられない。どちらかを外すか、理由を付けて重ねて登録する
          if (String(c.id).startsWith("new-")) {
            return <li key={c.id}>このCSVの別の列（{periodLabel(c.period_start, c.period_end)}）と重なっています。どちらかを外すか、重ねて登録してください。</li>;
          }
          const r = records.find(x => String(x.id) === String(c.id));
          return (
            <li key={c.id}>
              <label>
                <input type="checkbox" checked={replace.has(String(c.id))} onChange={() => toggle(String(c.id))} />
                <span>置き換える：{periodLabel(c.period_start, c.period_end)}・{sourceLabel(c.source)}・{planLabel(c.plan_type)}
                  {r ? `・表示${r.impressions ?? "—"}／クリック${r.clicks ?? "—"}` : ""}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!same && (
        <div className="jm-overlap-opt">
          <label className="jm-check">
            <input type="checkbox" checked={value.allow_overlap} onChange={e => onChange({ ...value, allow_overlap: e.target.checked })} />
            置き換えずに重ねて登録（月次では合算しません）
          </label>
          {value.allow_overlap && (
            <input className="jm-input" placeholder="理由（例：旧管理表の集計期間のため参考として残す）" value={value.overlap_reason}
              maxLength={500} onChange={e => onChange({ ...value, overlap_reason: e.target.value })} />
          )}
        </div>
      )}
      <p className="jm-sub">置き換えた記録は削除せず、履歴に残ります。</p>
    </div>
  );
}

const emptyForm = (categoryId, month) => ({
  category_id: categoryId || "", posting_id: "", media: DEFAULT_MEDIA,
  period_start: month ? `${month}-01` : "", period_end: "", plan_type: "",
  impressions: "", clicks: "", apply_starts: "", applies: "", cost: "", note: "",
});

// 月次実績の登録・修正（修正は元の記録を残して新しい記録で置き換える）
export function RecordForm({ categories, postings = [], records, initial, defaultCategory, defaultMonth, onClose, onSaved }) {
  const editing = Boolean(initial);
  // CSVの日別実績は、数値・期間を変えない（掲載種別とメモだけ修正。数値は取消して再取込）
  const locked = Boolean(initial?.daily?.length);
  const [form, setForm] = useState(() => editing
    ? Object.fromEntries(Object.entries({ ...emptyForm(), ...initial }).filter(([k]) => k in emptyForm()).map(([k, v]) => [k, v == null ? "" : String(v)]))
    : emptyForm(defaultCategory, defaultMonth));
  const [resolve, setResolve] = useState({ replace_ids: [], allow_overlap: false, overlap_reason: "" });
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key, value) => { setForm(f => ({ ...f, [key]: value, ...(key === "category_id" ? { posting_id: "" } : {}) })); setProblem(null); };

  let preview = null;
  let localErrors = [];
  try { preview = normalizeRecord(form); } catch (e) { localErrors = e.fields || [e.message]; }
  const r = rates(preview || {});
  const warnings = preview ? recordWarnings(preview).filter(w => !w.startsWith("掲載費用は未入力")) : [];
  const categoryPostings = postings.filter(p => String(p.category_id) === String(form.category_id));

  async function save() {
    setError("");
    if (localErrors.length) { setError(localErrors[0]); return; }
    setBusy(true);
    const body = { record: form, ...resolve, ...(editing ? { supersedes_id: initial.id } : {}) };
    const res = await marketingApi.saveRecord(body);
    setBusy(false);
    if (res.ok) { onSaved(); return; }
    const p = res.data?.problems?.[0];
    if (res.status === 409 && p?.conflicts) { setProblem(p); setResolve(v => ({ ...v, replace_ids: v.replace_ids.filter(id => p.conflicts.some(c => c.id === id)) })); return; }
    setError(errorText(res, "保存できませんでした"));
  }

  const usable = categories.filter(c => c.is_active || String(c.id) === String(form.category_id));
  return (
    <Modal title={editing ? "実績の修正" : "実績を登録"} onClose={onClose} wide>
      <div className="jm-form-grid">
        <label>職種
          <select value={form.category_id} disabled={locked} onChange={e => set("category_id", e.target.value)}>
            <option value="">選択してください</option>
            {usable.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : "（停止中）"}</option>)}
          </select>
        </label>
        {categoryPostings.length > 0 && (
          <label>求人原稿
            <select value={form.posting_id} disabled={locked} onChange={e => set("posting_id", e.target.value)}>
              <option value="">職種全体</option>
              {categoryPostings.map(p => <option key={p.id} value={p.id}>{postingLabel(p)}</option>)}
            </select>
          </label>
        )}
        <label>開始日<input type="date" min={MIN_DATE} max={MAX_DATE} value={form.period_start} disabled={locked} onChange={e => set("period_start", e.target.value)} /></label>
        <label>終了日<input type="date" min={MIN_DATE} max={MAX_DATE} value={form.period_end} disabled={locked} onChange={e => set("period_end", e.target.value)} /></label>
        <label>掲載媒体<input value={form.media} maxLength={50} disabled={locked} onChange={e => set("media", e.target.value)} /></label>
      </div>
      <div className="jm-field-label">掲載種別</div>
      <Segmented name="plan" options={Object.entries(PLAN_TYPES)} value={form.plan_type} onChange={v => set("plan_type", v)} />
      <div className="jm-form-grid is-metrics">
        {METRICS.map(key => (
          <label key={key}>{METRIC_LABELS[key]}
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="未取得" value={form[key]} disabled={locked} onChange={e => set(key, e.target.value)} />
          </label>
        ))}
        <label>掲載費用（円）<input type="number" min="0" step="0.01" inputMode="decimal" placeholder="未入力" value={form.cost} disabled={locked} onChange={e => set("cost", e.target.value)} /></label>
      </div>
      {locked && <p className="jm-sub is-info">CSVの日別実績です。掲載種別とメモだけ修正できます。数値・期間を直すときは取消して再取込してください。</p>}
      <div className="jm-rate-preview" aria-live="polite">
        <span>クリック率（CTR） <b>{fmtRate(r.ctr)}</b></span><span>応募開始率 <b>{fmtRate(r.asr)}</b></span>
        <span>応募完了率 <b>{fmtRate(r.completion)}</b></span><span>応募率 <b>{fmtRate(r.apply_rate)}</b></span>
        <Tip text="空欄は「未取得」として保存し、0件とは区別します。費用の空欄も無料・0円とはみなしません。" />
      </div>
      <label className="jm-block">原稿の変更内容・改善メモ
        <textarea rows={3} maxLength={4000} value={form.note} onChange={e => set("note", e.target.value)} placeholder="例：10/14 タイトルに「未経験可」を追加" />
      </label>
      {warnings.length > 0 && <ul className="jm-warn">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      <ConflictResolver problem={problem} records={records} value={resolve} onChange={v => { setResolve(v); }} />
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-primary" disabled={busy} onClick={save}>{editing ? "修正を登録" : "登録"}</button>
      </div>
    </Modal>
  );
}

// 押しやすいボタン型の単一選択（radio）
export function Segmented({ name, options, value, onChange, label }) {
  return (
    <div className="jm-seg" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <label key={key} className={value === key ? "is-on" : ""}>
          <input type="radio" name={name} checked={value === key} onChange={() => onChange(key)} />{text}
        </label>
      ))}
    </div>
  );
}

export function VoidDialog({ record, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function submit() {
    const res = await marketingApi.voidRecord(record.id, { reason });
    if (res.ok) onSaved(); else setError(errorText(res, "取消できませんでした"));
  }
  return (
    <Modal title="記録の取消" onClose={onClose}>
      <p className="jm-lead">{periodLabel(record.period_start, record.period_end)}の記録を集計から外します（履歴には残ります）。</p>
      <label className="jm-block">取消の理由<input className="jm-input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-danger" disabled={!reason.trim()} onClick={submit}>取消する</button>
      </div>
    </Modal>
  );
}

// 職種の追加・名称変更・募集停止／再開。1職種1行（左：職種名、中央：状態、右：編集）。実績はIDで関連付けているため名称を変えても残る
export function CategoryManager({ categories, onClose, onSaved }) {
  const [editing, setEditing] = useState(null); // { id, name }
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const run = async promise => {
    const res = await promise;
    if (res.ok) { setError(""); onSaved(); return true; }
    setError(errorText(res, "保存できませんでした"));
    return false;
  };
  return (
    <Modal title="職種の管理" onClose={onClose}>
      <ul className="jm-cat-list">
        {categories.map(c => {
          const open = editing?.id === c.id;
          return (
            <li key={c.id} className={open ? "is-open" : ""}>
              <div className="jm-cat-row">
                <span className="jm-cat-name">{c.name}</span>
                <span className={`jm-state ${c.is_active ? "is-on" : "is-off"}`}>{c.is_active ? "募集中" : "停止中"}</span>
                <button type="button" className="jm-btn is-small" aria-expanded={open} onClick={() => setEditing(open ? null : { id: c.id, name: c.name })}>{open ? "閉じる" : "編集"}</button>
              </div>
              {open && (
                <div className="jm-cat-edit">
                  <label className="jm-block">職種名
                    <input className="jm-input" value={editing.name} maxLength={50} onChange={e => setEditing(x => ({ ...x, name: e.target.value }))} />
                  </label>
                  <div className="jm-cat-edit-actions">
                    <button type="button" className="jm-btn is-primary" disabled={!editing.name.trim() || editing.name === c.name}
                      onClick={async () => { if (await run(marketingApi.updateCategory(c.id, { name: editing.name }))) setEditing(null); }}>名称を保存</button>
                    <button type="button" className={`jm-btn${c.is_active ? " is-danger" : ""}`}
                      onClick={async () => { if (await run(marketingApi.updateCategory(c.id, { is_active: !c.is_active }))) setEditing(null); }}>
                      {c.is_active ? "募集停止にする" : "募集を再開する"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="jm-cat-add">
        <input className="jm-input" placeholder="追加する職種名" aria-label="追加する職種名" value={name} maxLength={50} onChange={e => setName(e.target.value)} />
        <button type="button" className="jm-btn is-primary" disabled={!name.trim()}
          onClick={async () => { if (await run(marketingApi.createCategory({ name }))) setName(""); }}>追加</button>
      </div>
      <p className="jm-sub">停止しても過去の実績・参考求人は残ります。</p>
      {error && <p className="jm-error" role="alert">{error}</p>}
    </Modal>
  );
}

const planOptions = Object.entries(PLAN_STATUS);

// 掲載状態の変更（例：無料→有料）。入力 → 確認 → 登録。変更前の実績はそのまま残る
export function PlanDialog({ category, postings = [], current, today, onClose, onSaved }) {
  const [form, setForm] = useState({ posting_id: "", status: current?.status === "free" ? "paid" : "", effective_date: "", budget: "", note: "" });
  const [step, setStep] = useState("input");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(""); };
  const paid = form.status === "paid";
  const dateLabel = paid ? "有料掲載開始日" : "変更日";
  const posting = postings.find(p => String(p.id) === String(form.posting_id));

  function check() {
    if (!form.status) return "掲載状態を選択してください";
    if (!form.effective_date) return `${dateLabel}を入力してください`;
    if (!isDate(form.effective_date)) return `${dateLabel}は西暦4桁の正しい日付で入力してください`;
    if (form.effective_date > today) return `${dateLabel}は本日以前の日付を入力してください`;
    if (form.budget !== "" && !(Number(form.budget) >= 0)) return "予算・費用は0以上の金額で入力してください";
    return "";
  }
  async function submit() {
    setBusy(true);
    const res = await marketingApi.savePlanEvent({ category_id: category.id, ...form, budget: paid ? form.budget : "" });
    setBusy(false);
    if (res.ok) onSaved(); else { setError(errorText(res, "保存できませんでした")); setStep("input"); }
  }
  const before = form.effective_date && isDate(form.effective_date) ? slashDate(form.effective_date) : "";
  return (
    <Modal title="掲載状態の変更" onClose={onClose}>
      <p className="jm-lead"><b>{category.name}</b><span>現在</span><span className={`jm-status is-${current?.status || "none"}`}>{statusLabel(current?.status)}</span></p>
      {step === "input" ? (
        <>
          {postings.length > 0 && (
            <label className="jm-block">対象
              <select className="jm-input" value={form.posting_id} onChange={e => set("posting_id", e.target.value)}>
                <option value="">職種全体</option>
                {postings.map(p => <option key={p.id} value={p.id}>{postingLabel(p)}</option>)}
              </select>
            </label>
          )}
          <div className="jm-field-label">変更後の掲載状態</div>
          <Segmented name="plan-status" label="変更後の掲載状態" options={planOptions} value={form.status} onChange={v => set("status", v)} />
          <div className="jm-form-grid is-two">
            <label><span>{dateLabel}<span className="jm-req">必須</span></span>
              <input type="date" min={MIN_DATE} max={today} value={form.effective_date} onChange={e => set("effective_date", e.target.value)} />
            </label>
            {paid && <label>掲載予算・費用（円）<input type="number" min="0" step="1" inputMode="numeric" placeholder="任意" value={form.budget} onChange={e => set("budget", e.target.value)} /></label>}
          </div>
          <label className="jm-block">{paid ? "切替理由・改善メモ" : "メモ"}<textarea rows={2} maxLength={4000} placeholder="任意" value={form.note} onChange={e => set("note", e.target.value)} /></label>
          {error && <p className="jm-error" role="alert">{error}</p>}
          <div className="jm-actions">
            <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
            <button type="button" className="jm-btn is-primary" onClick={() => { const e = check(); if (e) setError(e); else setStep("confirm"); }}>確認へ</button>
          </div>
        </>
      ) : (
        <>
          <dl className="jm-confirm">
            <dt>対象</dt><dd>{posting ? postingLabel(posting) : "職種全体"}</dd>
            <dt>{dateLabel}</dt><dd>{slashDate(form.effective_date)} から <span className={`jm-status is-${form.status}`}>{PLAN_STATUS[form.status]}</span></dd>
            {paid && <><dt>予算・費用</dt><dd>{form.budget === "" ? "未入力" : `¥${Number(form.budget).toLocaleString("ja-JP")}`}</dd></>}
            {form.note.trim() && <><dt>メモ</dt><dd className="jm-pre">{form.note}</dd></>}
          </dl>
          <p className="jm-sub">{before}より前の実績・掲載履歴はそのまま残ります。</p>
          {error && <p className="jm-error" role="alert">{error}</p>}
          <div className="jm-actions">
            <button type="button" className="jm-btn" onClick={() => setStep("input")}>戻る</button>
            <button type="button" className="jm-btn is-primary" disabled={busy} onClick={submit}>この内容で登録</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function PlanVoidDialog({ event, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  async function submit() {
    const res = await marketingApi.voidPlanEvent(event.id, { reason });
    if (res.ok) onSaved(); else setError(errorText(res, "取消できませんでした"));
  }
  return (
    <Modal title="掲載状態の変更を取消" onClose={onClose}>
      <p className="jm-lead">{slashDate(event.effective_date)} の「{PLAN_STATUS[event.status]}」を取り消します（履歴には残ります）。</p>
      <label className="jm-block">取消の理由<input className="jm-input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-danger" disabled={!reason.trim()} onClick={submit}>取消する</button>
      </div>
    </Modal>
  );
}

const emptyRef = { company_name: "", job_title: "", url: "", memo: "", checked_on: "" };

export function ReferenceForm({ categoryId, initial, onClose, onSaved }) {
  const [form, setForm] = useState(() => initial ? Object.fromEntries(Object.keys(emptyRef).map(k => [k, initial[k] ?? ""])) : emptyRef);
  const [error, setError] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  async function save() {
    const body = { ...form, category_id: categoryId };
    const res = initial ? await marketingApi.updateReference(initial.id, body) : await marketingApi.createReference(body);
    if (res.ok) onSaved(); else setError(errorText(res, "保存できませんでした"));
  }
  return (
    <Modal title={initial ? "参考求人の編集" : "参考求人の追加"} onClose={onClose}>
      <div className="jm-form-grid is-two">
        <label>会社名<input value={form.company_name} maxLength={200} onChange={e => set("company_name", e.target.value)} /></label>
        <label>求人タイトル<input value={form.job_title} maxLength={200} onChange={e => set("job_title", e.target.value)} /></label>
        <label className="is-span">URL（http/https）<input type="url" value={form.url} maxLength={2000} placeholder="https://" onChange={e => set("url", e.target.value)} /></label>
        <label>確認日<input type="date" min={MIN_DATE} max={MAX_DATE} value={form.checked_on} onChange={e => set("checked_on", e.target.value)} /></label>
      </div>
      <label className="jm-block">メモ<textarea rows={3} maxLength={2000} value={form.memo} onChange={e => set("memo", e.target.value)} placeholder="例：給与の幅を明記" /></label>
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-primary" disabled={!form.company_name.trim()} onClick={save}>保存</button>
      </div>
    </Modal>
  );
}
