// 求人一覧・求人詳細のダイアログ（求人の登録・内容の修正・公開／非公開の切替・応募者一覧）。
import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MEDIA, OTHER_MEDIA, REVISION_FIELDS, VISIBILITY, isDate, mediaKey, todayTokyo } from "../../../shared/jobPostings.mjs";
import { Modal, MIN_DATE, MAX_DATE } from "../marketing/MarketingForms";
import { postingsApi, errorText } from "./postingsApi";

const EMPLOYMENT_TYPES = ["正社員", "パート・アルバイト", "派遣", "契約社員", "委託"];
const DETAIL_FIELDS = REVISION_FIELDS.filter(f => f.key !== "title" && f.key !== "body");

// 求人内容の入力欄（タイトル・全文は常に表示し、その他の項目は折り畳む）
function RevisionFields({ form, set, openDetails }) {
  const filled = DETAIL_FIELDS.some(f => form[f.key]);
  return (
    <>
      <label className="jm-block">求人タイトル<span className="jp-req">必須</span>
        <input className="jm-input" maxLength={200} value={form.title} onChange={e => set("title", e.target.value)} />
      </label>
      <label className="jm-block">求人内容（全文）<span className="jp-hint">求人サイトの本文をそのまま貼り付けできます</span>
        <textarea className="jp-body-input" rows={9} maxLength={20000} value={form.body} onChange={e => set("body", e.target.value)} />
      </label>
      <details className="jp-fold" open={openDetails || filled}>
        <summary>勤務地・雇用形態・給与などの詳細項目</summary>
        <div className="jm-form-grid is-two">
          {DETAIL_FIELDS.map(f => (
            <label key={f.key} className={f.multiline ? "is-span" : undefined}>{f.label}
              {f.key === "employment_type" ? (
                <>
                  <input className="jm-input" list="jp-employment-types" maxLength={f.max} value={form[f.key]} onChange={e => set(f.key, e.target.value)} />
                  <datalist id="jp-employment-types">{EMPLOYMENT_TYPES.map(t => <option key={t} value={t} />)}</datalist>
                </>
              ) : f.multiline
                ? <textarea className="jm-input" rows={2} maxLength={f.max} value={form[f.key]} onChange={e => set(f.key, e.target.value)} />
                : <input className="jm-input" type={f.key === "url" ? "url" : "text"} maxLength={f.max} value={form[f.key]} onChange={e => set(f.key, e.target.value)} placeholder={f.key === "url" ? "https://" : ""} />}
            </label>
          ))}
        </div>
      </details>
    </>
  );
}

const emptyRevision = () => Object.fromEntries(REVISION_FIELDS.map(f => [f.key, ""]));

// 掲載媒体の選択（既定の媒体＋登録済みの媒体＋その他の入力）
function MediaSelect({ value, onChange, options }) {
  const list = options?.length ? options : MEDIA.map(m => m.name);
  const known = !value || list.includes(value);
  const [other, setOther] = useState(!known);
  return (
    <>
      <select className="jm-input" value={other ? OTHER_MEDIA : value} onChange={e => {
        if (e.target.value === OTHER_MEDIA) { setOther(true); onChange(""); } else { setOther(false); onChange(e.target.value); }
      }}>
        <option value="">選択してください</option>
        {list.map(m => <option key={m} value={m}>{m}</option>)}
        <option value={OTHER_MEDIA}>その他（入力）</option>
      </select>
      {other && <input className="jm-input" maxLength={50} placeholder="媒体名" value={value} onChange={e => onChange(e.target.value)} aria-label="媒体名" />}
    </>
  );
}

export function NewPostingDialog({ categories, media, onClose, onSaved }) {
  const today = todayTokyo();
  const [form, setForm] = useState({ ...emptyRevision(), category_id: "", media: "", job_id: "", visibility: "public", effective_date: today });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(""); };
  function check() {
    if (!form.category_id) return "職種を選択してください";
    if (!form.media.trim()) return "掲載媒体を選択してください";
    if (!form.title.trim()) return "求人タイトルを入力してください";
    if (form.visibility && (!isDate(form.effective_date) || form.effective_date > today)) return "公開開始日・非公開日は本日以前の西暦4桁の日付を入力してください";
    return "";
  }
  async function submit() {
    const problem = check();
    if (problem) { setError(problem); return; }
    setBusy(true);
    const res = await postingsApi.create({ ...form, visibility: form.visibility || null });
    setBusy(false);
    if (res.ok) onSaved(res.data.id); else setError(errorText(res, "登録できませんでした"));
  }
  return (
    <Modal title="求人を登録" onClose={onClose} wide>
      <div className="jm-form-grid">
        <label>職種<select className="jm-input" value={form.category_id} onChange={e => set("category_id", e.target.value)}>
          <option value="">選択してください</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : "（募集停止中）"}</option>)}
        </select></label>
        <label>掲載媒体<MediaSelect value={form.media} options={media} onChange={v => set("media", v)} /></label>
        <label className="is-span">求人ID・参照番号（任意）
          <input className="jm-input" maxLength={200} value={form.job_id} onChange={e => set("job_id", e.target.value)} placeholder="Indeedの参照番号、ハローワークの求人番号など" />
        </label>
      </div>
      <RevisionFields form={form} set={set} />
      <div className="jp-vis-pick">
        <span className="jm-field-label">公開状態</span>
        {[["public", "公開中"], ["private", "非公開"], ["", "未設定（後で設定）"]].map(([v, l]) => (
          <label key={v || "none"} className="jm-check"><input type="radio" name="jp-new-vis" checked={form.visibility === v} onChange={() => set("visibility", v)} />{l}</label>
        ))}
        {form.visibility && (
          <label className="jp-inline-date">{form.visibility === "public" ? "公開開始日" : "非公開日"}
            <input type="date" className="jm-input" min={MIN_DATE} max={today} value={form.effective_date} onChange={e => set("effective_date", e.target.value)} />
          </label>
        )}
      </div>
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-primary" disabled={busy} onClick={submit}>登録する</button>
      </div>
    </Modal>
  );
}

// 求人内容の修正（新しい版を追加）。初版未登録の求人は、CSVの確認済み情報（求人名・URL）を初期値にする
export function RevisionDialog({ detail, onClose, onSaved }) {
  const current = detail.current;
  const csv = detail.csv;
  const [form, setForm] = useState(() => current
    ? { ...Object.fromEntries(REVISION_FIELDS.map(f => [f.key, current[f.key] ?? ""])), change_summary: "", change_reason: "" }
    : { ...emptyRevision(), title: detail.posting.csv_title || detail.posting.title || "", url: csv?.job_url || "", location: csv?.location || "", change_summary: "", change_reason: "" });
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(""); };
  async function submit() {
    if (!form.title.trim()) { setError("求人タイトルを入力してください"); return; }
    if (current && !form.change_summary.trim()) { setError("修正内容を入力してください"); return; }
    setBusy(true);
    const res = await postingsApi.addRevision(detail.posting.id, { ...form, expected_revision_no: current ? current.revision_no : 0 });
    setBusy(false);
    if (res.ok) onSaved(res.data.revision_no);
    else { setError(errorText(res, "保存できませんでした")); setStale(res.status === 409); }
  }
  return (
    <Modal title={current ? `求人内容を修正（第${current.revision_no + 1}版として保存）` : "求人内容の初版を登録"} onClose={onClose} wide>
      {!current && (csv || detail.posting.csv_title) && <p className="jm-sub is-info">CSVの確認済みの情報（求人名{csv?.job_url ? "・求人URL" : ""}）を入力済みです。その他の項目は推測で補完していません。</p>}
      <RevisionFields form={form} set={set} />
      {current && (
        <div className="jm-form-grid is-two">
          <label>修正内容<span className="jp-req">必須</span><input className="jm-input" maxLength={500} value={form.change_summary} onChange={e => set("change_summary", e.target.value)} placeholder="例：給与を2万円引き上げ" /></label>
          <label>修正理由（任意）<input className="jm-input" maxLength={500} value={form.change_reason} onChange={e => set("change_reason", e.target.value)} placeholder="例：応募が少ないため" /></label>
        </div>
      )}
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        {stale && <button type="button" className="jm-btn" onClick={() => window.location.reload()}>画面を読み込み直す</button>}
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className="jm-btn is-primary" disabled={busy} onClick={submit}>{current ? "修正を保存" : "初版を登録"}</button>
      </div>
    </Modal>
  );
}

// 公開／非公開の切替（NKS内部の管理状態。外部サイトは変更しない）
export function VisibilityDialog({ posting, onClose, onSaved }) {
  const today = todayTokyo();
  const current = posting.visibility;
  const [target, setTarget] = useState(current === "public" ? "private" : current === "private" ? "public" : "");
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toPrivate = target === "private";
  async function submit() {
    if (!target) { setError("公開状態を選択してください"); return; }
    if (!isDate(date) || date > today) { setError(`${toPrivate ? "非公開日" : "公開開始日"}は本日以前の西暦4桁の日付を入力してください`); return; }
    if (posting.visibility_since && date < posting.visibility_since) { setError(`日付は直前の切替日（${posting.visibility_since}）以降を入力してください`); return; }
    setBusy(true);
    const res = await postingsApi.setVisibility(posting.id, { visibility: target, effective_date: date, reason, expected_seq: posting.visibility_seq });
    setBusy(false);
    if (res.ok) onSaved(target); else setError(errorText(res, "変更できませんでした"));
  }
  const title = current == null ? "公開状態を設定" : toPrivate ? "この求人を非公開にしますか？" : "この求人を公開しますか？";
  return (
    <Modal title={title} onClose={onClose}>
      <p className="jm-lead"><b>{posting.title}</b><span className={`jp-vis is-${current || "unset"}`}>{current ? VISIBILITY[current] : "要設定"}</span>{current && <><span aria-hidden="true">→</span><span className={`jp-vis is-${target}`}>{VISIBILITY[target]}</span></>}</p>
      {current == null && (
        <div className="jp-vis-pick">
          {[["public", "公開中"], ["private", "非公開"]].map(([v, l]) => (
            <label key={v} className="jm-check"><input type="radio" name="jp-vis" checked={target === v} onChange={() => { setTarget(v); setError(""); }} />{l}</label>
          ))}
        </div>
      )}
      <div className="jm-form-grid is-two">
        <label>{toPrivate ? "非公開日" : "公開開始日"}<input type="date" className="jm-input" min={posting.visibility_since || MIN_DATE} max={today || MAX_DATE} value={date} onChange={e => { setDate(e.target.value); setError(""); }} /></label>
        <label>理由（任意）<input className="jm-input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder={toPrivate ? "例：採用予定数に達したため" : ""} /></label>
      </div>
      <p className="jm-meta">NKS内部の管理状態です。Indeed・ハローワークなどの外部サイトの掲載は変更されません。</p>
      {error && <p className="jm-error" role="alert">{error}</p>}
      <div className="jm-actions">
        <button type="button" className="jm-btn" onClick={onClose}>キャンセル</button>
        <button type="button" className={`jm-btn ${toPrivate ? "is-danger" : "is-primary"}`} disabled={busy} onClick={submit}>{current == null ? "設定する" : toPrivate ? "はい" : "公開する"}</button>
      </div>
    </Modal>
  );
}

// 応募者・採用の対象者一覧。氏名から既存の応募者詳細へ移動する（戻る先として現在の画面・絞り込みを渡す）
export function CandidatesModal({ posting, kind, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState({ loading: true, list: [], error: "" });
  useEffect(() => {
    let alive = true;
    postingsApi.candidates(posting.id, kind).then(res => {
      if (!alive) return;
      setState(res.ok ? { loading: false, list: res.data.candidates, error: "" } : { loading: false, list: [], error: errorText(res, "読み込めませんでした") });
    }).catch(() => alive && setState({ loading: false, list: [], error: "読み込めませんでした" }));
    return () => { alive = false; };
  }, [posting.id, kind]);
  const onList = location.pathname === "/jobs";
  const open = id => navigate(`/candidates/${id}?view=detail`, { state: {
    from: location.pathname + location.search, fromLabel: onList ? "求人一覧へ戻る" : "求人詳細へ戻る",
    // 求人詳細から開いた場合は、その求人詳細の戻り先（一覧の絞り込み）も渡す
    listFrom: onList ? null : (typeof location.state?.from === "string" ? location.state.from : null),
  } });
  return (
    <Modal title={`${kind === "hired" ? "採用" : "応募者"}：${posting.title}`} onClose={onClose} wide>
      <p className="jm-meta">{kind === "hired" ? "現在の選考状態が内定・入社予定・入社の応募者です。" : "この求人を応募経路として登録した応募者です（求人分析のCSVの応募数とは別）。"}</p>
      {state.loading ? <p>読込中…</p> : state.error ? <p className="jm-error">{state.error}</p> : state.list.length === 0 ? <p className="jm-sub">該当する応募者はいません。</p> : (
        <div className="jm-table-wrap">
          <table className="jm-table jp-people">
            <thead><tr><th>氏名</th><th>応募日</th><th>応募経路</th><th>現在の選考状態</th></tr></thead>
            <tbody>
              {state.list.map(c => (
                <tr key={c.id}>
                  <td><button type="button" className="jm-link jp-name" onClick={() => open(c.id)}>{c.name}</button>{c.archived && <span className="jm-chip is-muted jp-mini">アーカイブ</span>}</td>
                  <td>{c.applied_date ? c.applied_date.replaceAll("-", "/") : "—"}</td>
                  <td>{c.source_type || "未設定"}{c.agent_name ? `（${c.agent_name}）` : ""}</td>
                  <td><span className={`jp-sel${c.hired ? " is-hired" : ""}`}>{c.selection_label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export const mediaLabelOf = value => mediaKey(value) || "—";
