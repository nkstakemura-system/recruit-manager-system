import { useCallback, useEffect, useRef, useState } from "react";
import SelectionTimeline, { SelectionHistory } from "./SelectionTimeline";
import { selectionApi, isFourDigitDate, todayTokyo, MIN_DATE, MAX_DATE } from "./selectionApi";
import "./selection.css";

const ENDING = new Set(["declined", "no_contact", "rejected"]);
const NOTE_LABELS = { declined: "辞退理由（必須）", rejected: "不採用理由（任意）", no_contact: "状況メモ（任意）" };
const DATE_ERROR = "日付は西暦4桁の正しい日付で入力してください";
const DISCARD_CONFIRM = "入力中の内容は保存されていません。閉じてよろしいですか？";

function DateInput({ value, onChange, id }) {
  return (
    <input id={id} type="date" min={MIN_DATE} max={MAX_DATE} value={value || ""}
      onChange={event => onChange(event.target.value)} className="nks-sel-input nks-sel-date" />
  );
}

// 個人応募の共通更新モーダル（一覧・詳細の両方から開く）。協力業者は従来の ProgressModal を使う。
export default function SelectionModal({ candidate, onClose, onChanged, onUnavailable }) {
  const id = candidate?.id;
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [appliedDraft, setAppliedDraft] = useState("");
  const [contactDraft, setContactDraft] = useState([]);
  const [adding, setAdding] = useState(null);
  const [editing, setEditing] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  // 親の再描画で関数が変わっても読み直さない
  const unavailableRef = useRef(onUnavailable);
  useEffect(() => { unavailableRef.current = onUnavailable; }, [onUnavailable]);

  const accept = useCallback(next => {
    setView(next);
    setAppliedDraft(next.applied_date || "");
    setContactDraft(next.contact_history || []);
    setAdding(null);
    setEditing(null);
    setCancelling(null);
    setError("");
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await selectionApi.load(id);
      if (result.status === 503) return unavailableRef.current?.();
      if (!result.ok) return setError(result.data?.error || "選考情報を読み込めませんでした");
      accept(result.data);
    } catch {
      setError("通信エラーのため選考情報を読み込めませんでした");
    }
  }, [id, accept]);

  useEffect(() => { if (id != null) load(); }, [id, load]);

  const dirty = Boolean(view) && (Boolean(adding || editing || cancelling) ||
    appliedDraft !== (view.applied_date || "") ||
    JSON.stringify(contactDraft) !== JSON.stringify(view.contact_history || []));

  // 入力中は確認してから閉じる（Esc・背景クリック・閉じるボタン共通）
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm(DISCARD_CONFIRM)) return;
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const onKey = event => { if (event.key === "Escape") { event.preventDefault(); requestClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (!candidate) return null;

  // 保存系の共通処理。他画面で更新済み（409 stale）の場合は最新を読み込み直す。
  const run = async call => {
    setBusy(true);
    setError("");
    try {
      const result = await call({ expected_version: view.version });
      if (result.ok) {
        accept(result.data);
        onChanged?.(result.data);
      } else if (result.status === 409 && result.data?.code === "stale") {
        alert(result.data.error);
        await load();
      } else if (result.status === 503) {
        unavailableRef.current?.();
      } else {
        setError(result.data?.error || "保存できませんでした");
      }
    } catch {
      setError("通信エラーのため保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = () => {
    if (!isFourDigitDate(adding.event_date)) return setError(DATE_ERROR);
    if (adding.requires_note && !adding.note.trim()) return setError("辞退理由を入力してください");
    if (view.applied_date && adding.event_date < view.applied_date &&
      !window.confirm("受付日より前の日付です。このまま登録しますか？")) return;
    if (adding.confirm && !window.confirm(adding.confirm)) return;
    if (!adding.confirm && ENDING.has(adding.kind) && !window.confirm(`「${adding.label}」として選考を終了します。よろしいですか？`)) return;
    const { kind, event_date, note, attendee } = adding;
    run(v => selectionApi.addStep(id, { ...v, kind, event_date, note, attendee }));
  };

  const submitCorrection = () => {
    if (!isFourDigitDate(editing.event_date)) return setError(DATE_ERROR);
    const { id: eventId, event_date, note, attendee, reason } = editing;
    run(v => selectionApi.correct(id, eventId, { ...v, event_date, note, attendee, reason }));
  };

  const submitCancel = () => {
    if (!window.confirm(`「${cancelling.label}」を取り消します。取消の記録は履歴に残ります。よろしいですか？`)) return;
    const { id: eventId, reason } = cancelling;
    run(v => selectionApi.cancel(id, eventId, { ...v, reason }));
  };

  const saveApplied = () => {
    if (!isFourDigitDate(appliedDraft)) return setError(DATE_ERROR);
    run(v => selectionApi.setAppliedDate(id, { ...v, date: appliedDraft }));
  };

  const saveContact = () => {
    if (contactDraft.some(item => item.date && !isFourDigitDate(item.date))) return setError(DATE_ERROR);
    run(v => selectionApi.setContactHistory(id, { ...v, contact_history: contactDraft }));
  };

  const startAdd = action => {
    setEditing(null);
    setCancelling(null);
    setError("");
    // 従来データの面接完了など、実施日を推定しない工程は空欄から入力してもらう
    const eventDate = action.date_must_be_entered ? "" : action.default_date || todayTokyo();
    setAdding({ ...action, event_date: eventDate, note: "", attendee: "" });
  };

  const recordActions = record => {
    if (editing?.id === record.id) {
      return (
        <div className="nks-sel-form nks-sel-form-inline">
          <div className="nks-sel-form-title">訂正（元の記録は履歴に残ります）</div>
          <label className="nks-sel-label">日付
            <DateInput value={editing.event_date} onChange={value => setEditing({ ...editing, event_date: value })} />
          </label>
          {record.kind === "interview_scheduled" && (
            <label className="nks-sel-label">同席者（任意）
              <input className="nks-sel-input" value={editing.attendee} maxLength={100}
                onChange={event => setEditing({ ...editing, attendee: event.target.value })} />
            </label>
          )}
          <label className="nks-sel-label">{NOTE_LABELS[record.kind] || "メモ（任意）"}
            <textarea className="nks-sel-input nks-sel-textarea" value={editing.note} maxLength={1000}
              onChange={event => setEditing({ ...editing, note: event.target.value })} />
          </label>
          <label className="nks-sel-label">訂正理由（任意）
            <input className="nks-sel-input" value={editing.reason} maxLength={1000}
              onChange={event => setEditing({ ...editing, reason: event.target.value })} />
          </label>
          <div className="nks-sel-buttons">
            <button type="button" className="nks-sel-btn" disabled={busy} onClick={() => setEditing(null)}>キャンセル</button>
            <button type="button" className="nks-sel-btn nks-sel-btn-primary" disabled={busy} onClick={submitCorrection}>訂正を記録</button>
          </div>
        </div>
      );
    }
    if (cancelling?.id === record.id) {
      return (
        <div className="nks-sel-form nks-sel-form-inline">
          <div className="nks-sel-form-title">取消（元の記録は履歴に残ります）</div>
          <label className="nks-sel-label">取消理由（任意）
            <input className="nks-sel-input" value={cancelling.reason} maxLength={1000}
              onChange={event => setCancelling({ ...cancelling, reason: event.target.value })} />
          </label>
          <div className="nks-sel-buttons">
            <button type="button" className="nks-sel-btn" disabled={busy} onClick={() => setCancelling(null)}>戻る</button>
            <button type="button" className="nks-sel-btn nks-sel-btn-danger" disabled={busy} onClick={submitCancel}>取消を記録</button>
          </div>
        </div>
      );
    }
    if (view.sync_issues.length) return null;
    return (
      <div className="nks-timeline-actions">
        <button type="button" className="nks-sel-btn nks-sel-btn-small" disabled={busy}
          onClick={() => {
            setAdding(null); setCancelling(null); setError("");
            setEditing({ id: record.id, event_date: record.event_date || "", note: record.note || "", attendee: record.attendee || "", reason: "" });
          }}>
          訂正
        </button>
        {record.is_latest && (
          <button type="button" className="nks-sel-btn nks-sel-btn-small nks-sel-btn-quiet" disabled={busy}
            onClick={() => { setAdding(null); setEditing(null); setError(""); setCancelling({ id: record.id, label: record.label, reason: "" }); }}>
            取消
          </button>
        )}
      </div>
    );
  };

  const progress = view ? view.actions.filter(a => !ENDING.has(a.kind)) : [];
  const endings = view ? view.actions.filter(a => ENDING.has(a.kind)) : [];
  const last = view?.records[view.records.length - 1];
  const showContact = view && (view.status === "2" || last?.kind === "contacting");

  return (
    <div className="nks-sel-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="nks-sel-modal" role="dialog" aria-modal="true" aria-labelledby="nks-sel-title">
        <header className="nks-sel-header">
          <h3 id="nks-sel-title">選考の更新：{candidate.name_kanji}様</h3>
          <button type="button" className="nks-sel-close" aria-label="閉じる" disabled={busy} onClick={requestClose}>×</button>
        </header>
        {error && <div className="nks-sel-error" role="alert">{error}</div>}
        {!view ? (
          <div className="nks-sel-loading">{error ? "" : "読込中..."}</div>
        ) : (
          <div className="nks-sel-content">
            {view.sync_issues.length > 0 && (
              <div className="nks-sel-warning" role="alert">
                既存データと選考履歴が一致しないため、選考の更新を停止しています（{view.sync_issues.join("・")}）。
                自動では補正しません。管理者に確認してください。
              </div>
            )}
            {(view.notices || []).map(text => (
              <div key={text} className="nks-sel-notice" role="status">{text}</div>
            ))}
            <section className="nks-sel-section">
              <label className="nks-sel-label" htmlFor="nks-sel-applied">受付日</label>
              <div className="nks-sel-row">
                <DateInput id="nks-sel-applied" value={appliedDraft} onChange={setAppliedDraft} />
                {appliedDraft !== (view.applied_date || "") && (
                  <>
                    <button type="button" className="nks-sel-btn" disabled={busy} onClick={() => setAppliedDraft(view.applied_date || "")}>戻す</button>
                    <button type="button" className="nks-sel-btn nks-sel-btn-primary" disabled={busy} onClick={saveApplied}>受付日を変更</button>
                  </>
                )}
              </div>
            </section>

            <section className="nks-sel-section">
              <div className="nks-sel-title">選考の経過</div>
              <SelectionTimeline view={view} renderActions={recordActions} />
              <SelectionHistory view={view} />
            </section>

            {showContact && (
              <section className="nks-sel-section">
                <div className="nks-sel-title">面接打診の連絡履歴</div>
                {contactDraft.map((item, index) => (
                  <div className="nks-sel-row" key={index}>
                    <DateInput value={item.date} onChange={value => setContactDraft(contactDraft.map((c, i) => i === index ? { ...c, date: value } : c))} />
                    <label className="nks-sel-check"><input type="checkbox" checked={item.tel === true}
                      onChange={event => setContactDraft(contactDraft.map((c, i) => i === index ? { ...c, tel: event.target.checked } : c))} />TEL</label>
                    <label className="nks-sel-check"><input type="checkbox" checked={item.email === true}
                      onChange={event => setContactDraft(contactDraft.map((c, i) => i === index ? { ...c, email: event.target.checked } : c))} />Mail</label>
                    <button type="button" className="nks-sel-btn nks-sel-btn-small nks-sel-btn-quiet" aria-label="この連絡履歴を削除"
                      onClick={() => setContactDraft(contactDraft.filter((_, i) => i !== index))}>×</button>
                  </div>
                ))}
                <div className="nks-sel-buttons nks-sel-buttons-start">
                  <button type="button" className="nks-sel-btn" disabled={busy}
                    onClick={() => setContactDraft([...contactDraft, { date: todayTokyo(), tel: false, email: false }])}>＋ 連絡を追加</button>
                  {JSON.stringify(contactDraft) !== JSON.stringify(view.contact_history || []) && (
                    <button type="button" className="nks-sel-btn nks-sel-btn-primary" disabled={busy} onClick={saveContact}>連絡履歴を保存</button>
                  )}
                </div>
              </section>
            )}

            <section className="nks-sel-section">
              <div className="nks-sel-title">次の工程を登録</div>
              {view.actions.length === 0 && view.sync_issues.length === 0 && (
                <div className="nks-sel-hint">
                  {last && ENDING.has(last.kind) ? "選考は終了しています。再開する場合は最新の工程を「取消」してください。"
                    : last?.kind === "joined" ? "入社済みです。退職は詳細画面の「退職処理」から登録します。" : "登録できる工程がありません。"}
                </div>
              )}
              {progress.length > 0 && (
                <div className="nks-sel-actions">
                  {progress.map(action => (
                    <button key={action.kind} type="button" disabled={busy}
                      className={`nks-sel-btn nks-sel-action${adding?.kind === action.kind ? " is-active" : ""}`}
                      onClick={() => startAdd(action)}>{action.label}</button>
                  ))}
                </div>
              )}
              {endings.length > 0 && (
                <div className="nks-sel-actions nks-sel-actions-end">
                  {endings.map(action => (
                    <button key={action.kind} type="button" disabled={busy}
                      className={`nks-sel-btn nks-sel-action nks-sel-action-end${adding?.kind === action.kind ? " is-active" : ""}`}
                      onClick={() => startAdd(action)}>{action.label}</button>
                  ))}
                </div>
              )}
              {adding && (
                <div className="nks-sel-form">
                  <div className="nks-sel-form-title">{adding.label}</div>
                  <label className="nks-sel-label">{adding.date_label || "日付"}
                    <DateInput value={adding.event_date} onChange={value => setAdding({ ...adding, event_date: value })} />
                  </label>
                  {adding.kind === "interview_scheduled" && (
                    <label className="nks-sel-label">同席者（任意）
                      <input className="nks-sel-input" value={adding.attendee} maxLength={100} placeholder="例: 山田部長"
                        onChange={event => setAdding({ ...adding, attendee: event.target.value })} />
                    </label>
                  )}
                  <label className="nks-sel-label">{NOTE_LABELS[adding.kind] || "メモ（任意）"}
                    <textarea className="nks-sel-input nks-sel-textarea" value={adding.note} maxLength={1000}
                      placeholder={adding.kind === "declined" ? "他社で内定が出たため、等" : ""}
                      onChange={event => setAdding({ ...adding, note: event.target.value })} />
                  </label>
                  <div className="nks-sel-buttons">
                    <button type="button" className="nks-sel-btn" disabled={busy} onClick={() => setAdding(null)}>キャンセル</button>
                    <button type="button" disabled={busy} onClick={submitAdd}
                      className={`nks-sel-btn ${ENDING.has(adding.kind) ? "nks-sel-btn-danger" : "nks-sel-btn-primary"}`}>
                      登録する
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
        <footer className="nks-sel-footer">
          <button type="button" className="nks-sel-btn" disabled={busy} onClick={requestClose}>閉じる</button>
        </footer>
      </div>
    </div>
  );
}
