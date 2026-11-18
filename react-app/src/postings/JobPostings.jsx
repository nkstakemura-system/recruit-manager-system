// 求人一覧（第5弾）。日常の求人管理の起点。公開中の求人を基本表示とし、非公開・すべて・要設定（公開状態が未設定）を切り替える。
// 応募者数・採用数は登録された応募者から数える（求人分析のCSVの応募数とは別）。数字を押すと対象者を表示する。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { VISIBILITY, filterPostings, mediaKey, visibilityCounts } from "../../../shared/jobPostings.mjs";
import { PLAN_STATUS } from "../../../shared/jobMarketing.mjs";
import { Tip } from "../marketing/MarketingForms";
import { postingsApi, errorText } from "./postingsApi";
import { CandidatesModal, NewPostingDialog, VisibilityDialog } from "./PostingDialogs";
import "../marketing/marketing.css";
import "./postings.css";

const VIEWS = [["public", "公開中"], ["private", "非公開"], ["all", "すべて"]];

export function VisibilityChip({ value }) {
  return <span className={`jp-vis is-${value || "unset"}`}>{value ? VISIBILITY[value] : "要設定"}</span>;
}
export function VisibilityButton({ posting, onClick }) {
  const label = posting.visibility === "public" ? "非公開にする" : posting.visibility === "private" ? "公開する" : "公開状態を設定";
  return <button type="button" className={`jm-btn is-small${posting.visibility == null ? " is-primary" : ""}`} onClick={onClick}>{label}</button>;
}
export function CountButton({ value, label, onClick }) {
  return value > 0
    ? <button type="button" className="jp-count" aria-label={`${label} ${value}人の一覧`} onClick={onClick}>{value}</button>
    : <span className="jp-count is-zero" aria-label={`${label} 0人`}>0</span>;
}

export default function JobPostings() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const view = ["public", "private", "all", "unset"].includes(params.get("view")) ? params.get("view") : "public";
  const media = params.get("media") || "";

  const load = useCallback(() => postingsApi.list().then(res => {
    if (!res.ok) { setError(errorText(res, "求人一覧を読み込めませんでした")); return; }
    setData(res.data);
    setError("");
  }).catch(() => setError("求人一覧を読み込めませんでした。再読み込みしてください。")), []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => data?.postings || [], [data]);
  const byMedia = useMemo(() => rows.filter(p => !media || mediaKey(p.media) === media), [rows, media]);
  const counts = useMemo(() => visibilityCounts(byMedia), [byMedia]);
  const shown = useMemo(() => filterPostings(byMedia, { view }), [byMedia, view]);
  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const done = message => { setDialog(null); setNotice(message); load(); };

  if (error) return <div className="jm-page jp-page"><h2 className="jm-h2">求人一覧</h2><p className="jm-error">{error}</p></div>;
  if (!data) return <div className="jm-page jp-page"><h2 className="jm-h2">求人一覧</h2><p>読込中…</p></div>;
  if (!data.ready) return (
    <div className="jm-page jp-page"><h2 className="jm-h2">求人一覧</h2>
      <p className="jm-alert">求人一覧のテーブルが未作成のため、求人一覧は使用できません（データベースの準備後に使用できます）。応募者管理・求人分析は従来どおり使用できます。</p>
    </div>
  );
  const detailState = { state: { from: location.pathname + location.search } };

  return (
    <div className="jm-page jp-page">
      <div className="jp-top">
        <h2 className="jm-h2">求人一覧</h2>
        <button type="button" className="jm-btn is-primary" onClick={() => setDialog({ type: "new" })}>＋ 求人を登録</button>
      </div>
      {counts.unset > 0 && (
        <p className="jp-unset" role="status">
          <span className="jm-chip is-warn">要設定 {counts.unset}件</span>
          <span>公開状態が未設定の求人があります。</span>
          {view !== "unset" && <button type="button" className="jm-link" onClick={() => setFilter("view", "unset")}>確認する</button>}
        </p>
      )}
      <div className="jp-filters">
        <div className="jm-tabs jp-tabs" role="tablist" aria-label="公開状態">
          {VIEWS.map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={`jm-tab${view === v ? " is-on" : ""}`} onClick={() => setFilter("view", v === "public" ? "" : v)}>
              {l}<span className="jm-dot">{counts[v]}</span>
            </button>
          ))}
          {counts.unset > 0 && (
            <button type="button" role="tab" aria-selected={view === "unset"} className={`jm-tab jp-tab-unset${view === "unset" ? " is-on" : ""}`} onClick={() => setFilter("view", "unset")}>
              要設定<span className="jm-dot">{counts.unset}</span>
            </button>
          )}
        </div>
        <label className="jp-media">媒体
          <select className="jm-input" value={media} onChange={e => setFilter("media", e.target.value)}>
            <option value="">すべての媒体</option>
            {(data.media || []).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>
      {notice && <p className="jm-ok" role="status">{notice}</p>}

      <div className="jp-list" role="table" aria-label="求人一覧">
        <div className="jp-row jp-head" role="row">
          <span role="columnheader">求人タイトル・職種</span>
          <span role="columnheader">掲載媒体</span>
          <span role="columnheader" className="jp-num">応募者数<Tip text="この求人を応募経路として登録した応募者の人数です（選考終了・アーカイブを含み、協力業者は除く）。求人分析のCSVの応募数とは別です。" /></span>
          <span role="columnheader" className="jp-num">採用数<Tip text="現在の選考状態が内定・入社予定・入社の応募者です。内定辞退・不採用・内定の取消は含みません。入社後に退職した方は含みます。" /></span>
          <span role="columnheader">公開状態</span>
          <span role="columnheader"><span className="jp-sr">詳細</span></span>
        </div>
        {shown.length === 0 && <p className="jp-empty">{view === "public" ? "公開中の求人はありません。" : "該当する求人はありません。"}{view === "public" && counts.all > 0 ? "「すべて」から登録済みの求人を確認できます。" : ""}</p>}
        {shown.map(p => (
          <div className="jp-row" role="row" key={p.id}>
            <span role="cell" className="jp-title">
              <Link to={`/jobs/${p.id}`} state={detailState.state} className="jp-title-link">{p.title}</Link>
              <span className="jp-sub">
                <span>{p.category_name}</span>
                {p.revision_no === 0 && <span className="jm-chip is-muted jp-mini">初版未登録</span>}
                {p.plan_status && <span className={`jm-dot is-${p.plan_status}`}>{PLAN_STATUS[p.plan_status]}</span>}
              </span>
            </span>
            <span role="cell" className="jp-media-cell" data-label="媒体">{mediaKey(p.media)}{p.job_id && <span className="jp-id">{p.job_id}</span>}</span>
            <span role="cell" className="jp-num" data-label="応募者数"><CountButton value={p.applicants} label="応募者" onClick={() => setDialog({ type: "people", posting: p, kind: "applied" })} /></span>
            <span role="cell" className="jp-num" data-label="採用数"><CountButton value={p.hires} label="採用" onClick={() => setDialog({ type: "people", posting: p, kind: "hired" })} /></span>
            <span role="cell" className="jp-vis-cell" data-label="公開状態">
              <VisibilityChip value={p.visibility} />
              {p.visibility_since && <span className="jp-since">{p.visibility_since.replaceAll("-", "/")}〜</span>}
              <VisibilityButton posting={p} onClick={() => setDialog({ type: "visibility", posting: p })} />
            </span>
            <span role="cell" className="jp-detail-cell"><button type="button" className="jm-btn is-small" onClick={() => navigate(`/jobs/${p.id}`, detailState)}>詳細</button></span>
          </div>
        ))}
      </div>

      {dialog?.type === "new" && <NewPostingDialog categories={data.categories} media={data.media} onClose={() => setDialog(null)} onSaved={id => navigate(`/jobs/${id}`, detailState)} />}
      {dialog?.type === "visibility" && <VisibilityDialog posting={dialog.posting} onClose={() => setDialog(null)} onSaved={v => done(`「${dialog.posting.title}」を${VISIBILITY[v]}にしました。`)} />}
      {dialog?.type === "people" && <CandidatesModal posting={dialog.posting} kind={dialog.kind} onClose={() => setDialog(null)} />}
    </div>
  );
}
