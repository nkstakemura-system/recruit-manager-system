import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api";
import { contactSnapshot, resolvePrimary } from "../../../shared/contacts.mjs";
import { forceHalfWidthTel, forceHalfWidthEmail, formatTelOnBlur } from "./contactInput";
import "../selection/selection.css";
import "./contact.css";

const DISCARD_CONFIRM = "入力中の内容は保存されていません。閉じてよろしいですか？";
const KINDS = [
  { kind: "tel", label: "TEL", add: "TELを追加", type: "tel", clean: forceHalfWidthTel },
  { kind: "email", label: "Email", add: "Emailを追加", type: "email", clean: forceHalfWidthEmail },
];

async function request(url, method = "GET", body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await apiFetch(url, options);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

// 画面の入力欄（空なら1行の空欄を表示）
const draftOf = (snapshot) => {
  const primary = resolvePrimary(snapshot);
  return {
    tel: snapshot.tel.length ? [...snapshot.tel] : [""],
    email: snapshot.email.length ? [...snapshot.email] : [""],
    primary: primary ? `${primary.kind}_${primary.index}` : null,
  };
};

// 連絡先（TEL・Email・代表連絡先）だけを編集する。他の応募者情報・選考情報は送らない。
// 開いた時点の連絡先を expected として送り、他の画面で更新済みなら409で停止して最新を読み直す。
export default function ContactModal({ candidateId, name, onClose, onSaved }) {
  const [base, setBase] = useState(null);
  const [initial, setInitial] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const accept = useCallback((candidate) => {
    const snapshot = contactSnapshot(candidate);
    const next = draftOf(snapshot);
    setBase(snapshot);
    setInitial(next);
    setDraft(next);
    setError("");
  }, []);

  // 最新の連絡先を読み込む（閉じた後に届いた結果は反映しない）
  const load = useCallback((isActive = () => true) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}`).then((result) => {
      if (!isActive()) return;
      if (!result.ok || !result.data) return setError("連絡先を読み込めませんでした");
      accept(result.data);
    }).catch(() => {
      if (isActive()) setError("通信エラーのため連絡先を読み込めませんでした");
    }), [candidateId, accept]);

  useEffect(() => {
    let active = true;
    load(() => active);
    return () => { active = false; };
  }, [load]);

  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(initial);
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm(DISCARD_CONFIRM)) return;
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); requestClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // 代表に空欄を選んでいる・片方しかない場合は、保存時と同じ規則で代表になる連絡先に印を付ける
  const effective = draft && resolvePrimary({ tel: draft.tel, email: draft.email, primary_contact: draft.primary });
  const isPrimary = (kind, index) => effective?.kind === kind && effective.index === index;

  const setValue = (kind, index, value) =>
    setDraft((d) => ({ ...d, [kind]: d[kind].map((v, i) => (i === index ? value : v)) }));
  const addRow = (kind) => setDraft((d) => ({ ...d, [kind]: [...d[kind], ""] }));
  const removeRow = (kind, index) =>
    setDraft((d) => {
      const list = d[kind].filter((_, i) => i !== index);
      let primary = d.primary;
      const [pKind, pIndex] = (primary || "").split("_");
      if (pKind === kind) {
        const n = Number(pIndex);
        if (n === index) primary = null;
        else if (n > index) primary = `${kind}_${n - 1}`;
      }
      return { ...d, [kind]: list.length ? list : [""], primary };
    });

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await request(`/api/candidates/${encodeURIComponent(candidateId)}/contacts`, "PATCH", {
        tel: draft.tel,
        email: draft.email,
        primary_contact: effective ? `${effective.kind}_${effective.index}` : draft.primary,
        expected: base,
      });
      if (result.ok) {
        onSaved?.(result.data);
        onClose();
      } else if (result.status === 409 && result.data?.code === "contact_conflict") {
        alert(result.data.error);
        await load();
      } else {
        setError(result.data?.error || "保存できませんでした");
      }
    } catch {
      setError("通信エラーのため保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nks-sel-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="nks-sel-modal nks-contact-modal" role="dialog" aria-modal="true" aria-labelledby="nks-contact-title">
        <header className="nks-sel-header">
          <h3 id="nks-contact-title">連絡先の編集{name ? <span className="nks-contact-modal-name">{name}</span> : null}</h3>
          <button type="button" className="nks-sel-close" aria-label="閉じる" disabled={busy} onClick={requestClose}>×</button>
        </header>
        {error && <div className="nks-sel-error" role="alert">{error}</div>}
        {!draft ? (
          !error && <div className="nks-sel-loading">読込中...</div>
        ) : (
          <div className="nks-sel-content">
            {KINDS.map(({ kind, label, add, type, clean }) => (
              <section key={kind} className="nks-sel-section nks-contact-section">
                <div className="nks-sel-title">{label}</div>
                {draft[kind].map((value, index) => (
                  <div key={index} className="nks-contact-row">
                    <input
                      type={type}
                      inputMode={kind === "tel" ? "tel" : "email"}
                      aria-label={`${label}${index + 1}`}
                      value={value}
                      onChange={(event) => setValue(kind, index, clean(event.target.value))}
                      onBlur={kind === "tel" ? () => setValue(kind, index, formatTelOnBlur(draft.tel[index])) : undefined}
                      className="nks-sel-input nks-contact-input"
                    />
                    <label className={`nks-contact-primary${isPrimary(kind, index) ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="nks-contact-primary"
                        checked={isPrimary(kind, index)}
                        onChange={() => setDraft((d) => ({ ...d, primary: `${kind}_${index}` }))}
                      />
                      代表
                    </label>
                    <button
                      type="button"
                      className="nks-sel-btn nks-sel-btn-small nks-sel-btn-quiet"
                      aria-label={`${label}${index + 1}を削除`}
                      onClick={() => removeRow(kind, index)}
                      disabled={draft[kind].length === 1 && !value}
                    >
                      削除
                    </button>
                  </div>
                ))}
                <button type="button" className="nks-sel-btn nks-sel-btn-small" onClick={() => addRow(kind)}>{add}</button>
              </section>
            ))}
          </div>
        )}
        <footer className="nks-sel-footer nks-contact-footer">
          <button type="button" className="nks-sel-btn" disabled={busy} onClick={requestClose}>キャンセル</button>
          <button type="button" className="nks-sel-btn nks-sel-btn-primary" disabled={busy || !draft || !dirty} onClick={save}>
            {busy ? "保存中..." : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
