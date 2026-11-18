// 求人詳細（第5弾）。求人内容（版）・公開状態の履歴・掲載種別の履歴（求人分析と同じ記録）・改善履歴・修正履歴・求人分析の実績を1画面にまとめる。
import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { REVISION_FIELDS, VISIBILITY, mediaKey } from "../../../shared/jobPostings.mjs";
import { PLAN_STATUS, fmtCount } from "../../../shared/jobMarketing.mjs";
import { PlanDialog } from "../marketing/MarketingForms";
import { postingsApi, errorText } from "./postingsApi";
import { CandidatesModal, RevisionDialog, VisibilityDialog } from "./PostingDialogs";
import { CountButton, PostingFlags, VisibilityButton, VisibilityChip, analysisPath } from "./JobPostings";
import "../marketing/marketing.css";
import "./postings.css";

// URLはサーバー側でも http(s) に限定しているが、表示でもリンクにするのは http(s) だけにする
const safeHref = u => typeof u === "string" && /^https?:\/\/\S+$/i.test(u) ? u : null;
const slash = d => d ? String(d).slice(0, 10).replaceAll("-", "/") : "";
const num = v => fmtCount(v == null ? null : Number(v));
const MAIN_FIELDS = ["location", "employment_type", "salary", "work_hours", "holidays", "contact_person"];
const label = key => REVISION_FIELDS.find(f => f.key === key)?.label || key;

function FullText({ text }) {
  const [copied, setCopied] = useState(false);
  if (!text) return <p className="jm-sub">求人内容（全文）は未登録です。</p>;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } };
  return (
    <details className="jp-fold jp-fulltext" open>
      <summary>求人内容（全文）<span className="jp-hint">{text.length.toLocaleString()}文字</span></summary>
      <div className="jp-fulltext-actions"><button type="button" className="jm-btn is-small" onClick={copy}>{copied ? "コピーしました" : "全文をコピー"}</button></div>
      <pre className="jm-note jp-body">{text}</pre>
    </details>
  );
}

function Changes({ changes }) {
  if (!changes.length) return null;
  return (
    <div className="jm-table-wrap">
      <table className="jm-table jp-diff">
        <thead><tr><th>項目</th><th>修正前</th><th>修正後</th></tr></thead>
        <tbody>
          {changes.map(c => (
            <tr key={c.key}><td>{c.label}</td><td className="jp-before">{c.before ?? <span className="jp-none">（なし）</span>}</td><td className="jp-after">{c.after ?? <span className="jp-none">（削除）</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function JobPostingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const backTo = location.state?.from && location.state.from.startsWith("/jobs") ? location.state.from : "/jobs";

  const load = useCallback(() => postingsApi.detail(id).then(res => {
    if (!res.ok) { setError(errorText(res, "求人を読み込めませんでした")); return; }
    setData(res.data);
    setError("");
  }).catch(() => setError("求人を読み込めませんでした。再読み込みしてください。")), [id]);
  useEffect(() => { load(); }, [load]);
  // 一覧の状態表示（原稿未登録・掲載種別未設定）から開いた場合は、該当の操作を最初に開く（?open=revision / plan）。1回だけ
  const openParam = new URLSearchParams(location.search).get("open");
  useEffect(() => {
    if (!data || !openParam) return;
    if (openParam === "revision") setDialog({ type: "revision" });
    if (openParam === "plan" && data.category) setDialog({ type: "plan" });
    navigate(location.pathname, { replace: true, state: location.state });
  }, [data, openParam, navigate, location.pathname, location.state]);
  const done = message => { setDialog(null); setNotice(message); load(); };
  // 求人分析へ（対象の職種・求人原稿を指定）。求人分析の「求人詳細へ戻る」で、この画面の戻り先（一覧の絞り込み）も引き継ぐ
  const analysisState = { postingFrom: backTo };

  if (error) return <div className="jm-page jp-page"><Link to={backTo} className="jp-back">← 求人一覧へ戻る</Link><p className="jm-error">{error}</p></div>;
  if (!data) return <div className="jm-page jp-page"><p>読込中…</p></div>;
  const { posting: p, current, csv, visibility, category } = data;
  const planNow = p.plan_status;

  return (
    <div className="jm-page jp-page jp-detail">
      <button type="button" className="jp-back" onClick={() => navigate(backTo)}>← 求人一覧へ戻る</button>
      <header className="jp-detail-head">
        <div className="jp-detail-title">
          <h2 className="jm-h2">{p.title}</h2>
          <div className="jp-sub">
            <span className="jm-chip">{p.category_name}</span>
            <span className="jm-chip is-muted">{mediaKey(p.media)}</span>
            {p.job_id && <span className="jp-id">求人ID・参照番号 {p.job_id}</span>}
            <VisibilityChip value={p.visibility} />
            {planNow && <span className={`jm-dot is-${planNow}`}>{PLAN_STATUS[planNow]}</span>}
            {current && <span className="jp-ver">第{current.revision_no}版</span>}
          </div>
        </div>
        <div className="jp-detail-actions">
          <button type="button" className="jm-btn is-primary" onClick={() => setDialog({ type: "revision" })}>{current ? "求人原稿を編集" : "求人原稿を登録"}</button>
          <VisibilityButton posting={p} onClick={() => setDialog({ type: "visibility" })} />
          <Link className="jm-btn jp-btn-link" to={analysisPath(p)} state={analysisState}>求人分析で見る</Link>
        </div>
        <div className="jp-detail-counts">
          <span className="jp-detail-flags"><PostingFlags posting={p} analysisTo={analysisPath(p)} analysisState={analysisState}
            onOpen={kind => setDialog({ type: kind === "plan" && category ? "plan" : "revision" })} /></span>
          <span>応募者数</span><CountButton value={p.applicants} label="応募者" onClick={() => setDialog({ type: "people", kind: "applied" })} />
          <span>採用数</span><CountButton value={p.hires} label="採用" onClick={() => setDialog({ type: "people", kind: "hired" })} />
          {/* 現在の状態の日付（公開中なら今回の公開開始日、非公開なら非公開日）。過去の期間は公開状態の履歴に表示 */}
          {p.visibility === "public" && <span className="jp-since">公開開始日 {slash(p.visibility_since)}</span>}
          {p.visibility === "private" && <span className="jp-since">非公開日 {slash(p.visibility_since)}{visibility.first_public ? `（初回公開 ${slash(visibility.first_public)}）` : ""}</span>}
        </div>
      </header>
      {notice && <p className="jm-ok" role="status">{notice}</p>}

      <section className="jm-card jp-section">
        <h3 className="jp-h3">求人内容<span className="jp-hint">掲載した原稿の全文</span></h3>
        {current ? (
          <>
            <dl className="jp-facts">
              {MAIN_FIELDS.filter(k => current[k]).map(k => <React.Fragment key={k}><dt>{label(k)}</dt><dd className="jm-pre">{current[k]}</dd></React.Fragment>)}
              {current.url && <><dt>求人URL</dt><dd>{safeHref(current.url) ? <a href={safeHref(current.url)} target="_blank" rel="noopener noreferrer" className="jp-url">{current.url}</a> : current.url}</dd></>}
              {current.other_conditions && <><dt>その他の条件</dt><dd className="jm-pre">{current.other_conditions}</dd></>}
            </dl>
            <FullText text={current.body} />
            <p className="jm-meta">第{current.revision_no}版・{current.created_at}{current.actor ? `・${current.actor}` : ""}</p>
          </>
        ) : (
          <>
            <p className="jm-sub is-info">求人原稿は未登録です。CSVなどで確認済みの情報だけを表示しています。「求人原稿を登録」から原稿の全文を登録してください。</p>
            <dl className="jp-facts">
              {p.csv_title && <><dt>求人名（CSV）</dt><dd>{p.csv_title}</dd></>}
              {p.job_id && <><dt>求人ID・参照番号</dt><dd>{p.job_id}</dd></>}
              {csv?.job_url && <><dt>求人URL（CSV）</dt><dd>{safeHref(csv.job_url) ? <a href={safeHref(csv.job_url)} target="_blank" rel="noopener noreferrer" className="jp-url">{csv.job_url}</a> : csv.job_url}</dd></>}
              {csv?.csv_status && <><dt>CSV上の状態</dt><dd>{csv.csv_status}（{slash(csv.period_start)}〜{slash(csv.period_end)}のCSV。NKSの公開状態とは別）</dd></>}
            </dl>
          </>
        )}
      </section>

      <section className="jm-card jp-section">
        <h3 className="jp-h3">公開状態の履歴<span className="jp-hint">NKS内部の管理状態（外部サイトの掲載とは別）</span></h3>
        {visibility.events.length === 0 ? <p className="jm-sub">公開状態は未設定です。「公開状態を設定」から登録してください。</p> : (
          <>
            {visibility.public_periods.length > 0 && (
              <p className="jp-periods">公開期間：{visibility.public_periods.map((x, i) => <span key={i} className="jm-chip">{slash(x.start)}〜{x.end ? slash(x.end) : "公開中"}</span>)}</p>
            )}
            <ul className="jp-timeline">
              {visibility.events.map(e => (
                <li key={e.id}>
                  <b>{slash(e.effective_date)}</b>
                  <span>{e.previous_visibility ? VISIBILITY[e.previous_visibility] : "未設定"} → <strong>{VISIBILITY[e.visibility]}</strong></span>
                  {e.reason && <span className="jp-reason">理由：{e.reason}</span>}
                  <span className="jm-meta">{e.created_at}{e.actor ? `・${e.actor}` : ""}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="jm-card jp-section">
        <h3 className="jp-h3">掲載種別の履歴<span className="jp-hint">求人分析と同じ記録</span>
          {category && <button type="button" className="jm-btn is-small jp-h3-btn" onClick={() => setDialog({ type: "plan" })}>掲載状態を変更</button>}
        </h3>
        {data.plan_events.length === 0 ? <p className="jm-sub">掲載種別（無料・有料など）の履歴はありません。</p> : (
          <ul className="jp-timeline">
            {data.plan_events.map(e => (
              <li key={e.id} className={e.state === "voided" ? "is-voided" : undefined}>
                <b>{slash(e.effective_date)}</b>
                <span className={`jm-status is-${e.status}`}>{PLAN_STATUS[e.status]}</span>
                <span className="jp-scope">{e.posting_id ? "この求人" : "職種全体"}</span>
                {e.budget != null && <span>予算 {Number(e.budget).toLocaleString()}円</span>}
                {e.state === "voided" && <span className="jm-chip is-muted jp-mini">取消済み{e.void_reason ? `：${e.void_reason}` : ""}</span>}
                {e.note && <span className="jp-reason">{e.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="jm-card jp-section jp-fold-section" open={data.improvements.length > 0}>
        <summary><h3 className="jp-h3">改善履歴<span className="jm-dot">{data.improvements.length}</span><span className="jp-hint">原稿の変更メモ・求人分析の改善メモ・掲載状態の変更メモ</span></h3></summary>
        {data.improvements.length === 0 ? <p className="jm-sub">改善履歴はありません。</p> : (
          <ul className="jp-timeline">
            {data.improvements.map(i => (
              <li key={i.ref} className={i.state === "voided" ? "is-voided" : undefined}>
                <b>{slash(i.date)}</b><span className="jp-scope">{i.label}</span>
                {i.note && <span className="jp-reason jm-pre">{i.note}</span>}
                <span className="jm-meta">{i.at}{i.actor ? `・${i.actor}` : ""}{i.state === "voided" ? "・取消済み" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="jm-card jp-section jp-fold-section">
        <summary><h3 className="jp-h3">修正履歴<span className="jm-dot">{data.revisions.length}</span><span className="jp-hint">保存した原稿の版ごとの変更内容（修正前・修正後）</span></h3></summary>
        {data.revisions.length === 0 ? <p className="jm-sub">修正履歴はありません（求人原稿が未登録です）。</p> : (
          <ol className="jp-revisions">
            {data.revisions.map(r => (
              <li key={r.id}>
                <div className="jp-rev-head"><b>第{r.revision_no}版</b><span>{r.created_at}</span>{r.actor && <span className="jm-meta">{r.actor}</span>}</div>
                {r.revision_no > 1 ? (
                  <p className="jp-rev-note">修正内容：{r.change_summary}{r.change_reason ? `／修正理由：${r.change_reason}` : ""}</p>
                ) : <p className="jp-rev-note">求人原稿を登録（第1版）{r.change_reason ? `／理由：${r.change_reason}` : ""}</p>}
                {r.revision_no > 1 ? <Changes changes={r.changes} /> : (
                  <details className="jp-fold"><summary>登録した内容</summary><Changes changes={r.changes} /></details>
                )}
              </li>
            ))}
          </ol>
        )}
      </details>

      <details className="jm-card jp-section jp-fold-section">
        <summary><h3 className="jp-h3">求人分析の実績<span className="jm-dot">{data.records.filter(r => r.state === "active").length}</span><span className="jp-hint">表示回数・クリック数・CSVの応募数など</span></h3></summary>
        {data.records.length === 0 ? <p className="jm-sub">この求人の実績はありません。{data.category_records.length ? `職種全体の記録が${data.category_records.length}件あります（求人分析で確認できます）。` : ""}</p> : (
          <div className="jm-table-wrap">
            <table className="jm-table">
              <thead><tr><th>期間</th><th>表示回数</th><th>クリック数</th><th>応募開始数</th><th>CSVの応募数</th><th>状態</th></tr></thead>
              <tbody>
                {data.records.map(r => (
                  <tr key={r.id} className={r.state !== "active" ? "jp-row-muted" : undefined}>
                    <td>{slash(r.period_start)}〜{slash(r.period_end)}</td><td>{num(r.impressions)}</td><td>{num(r.clicks)}</td><td>{num(r.apply_starts)}</td><td>{num(r.applies)}</td>
                    <td>{r.state === "active" ? "有効" : r.state === "superseded" ? "置き換え済み" : "取消済み"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="jm-actions is-left"><Link className="jm-link" to={analysisPath(p)} state={analysisState}>求人分析で詳しく見る</Link></p>
      </details>

      {dialog?.type === "revision" && <RevisionDialog detail={data} onClose={() => setDialog(null)} onSaved={no => done(no === 1 ? "求人原稿を登録しました。" : `求人原稿を第${no}版として保存しました（前の版は修正履歴に残ります）。`)} />}
      {dialog?.type === "visibility" && <VisibilityDialog posting={p} onClose={() => setDialog(null)} onSaved={v => done(`${VISIBILITY[v]}にしました。`)} />}
      {dialog?.type === "people" && <CandidatesModal posting={p} kind={dialog.kind} onClose={() => setDialog(null)} />}
      {dialog?.type === "plan" && category && (
        <PlanDialog category={category} postings={[{ id: p.id, category_id: p.category_id, title: p.title, job_id: p.job_id }]} initialPostingId={p.id}
          current={{ status: planNow }} today={data.as_of} onClose={() => setDialog(null)} onSaved={() => done("掲載状態を変更しました（求人分析にも反映されます）。")} />
      )}
    </div>
  );
}
