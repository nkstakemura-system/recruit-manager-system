// 応募者の登録・編集（応募経路の種別が「求人」）で使う、掲載媒体 → 求人 の選択（第5弾）。
// * 媒体の表記揺れ（インディード等）は表示上だけ Indeed としてまとめる。利用者が媒体を選び直さない限り、保存されている媒体名は変更しない。
// * 求人の選択は任意（「該当求人なし・不明」可）。非公開の求人も選べる。
import React, { useEffect, useState } from "react";
import { MEDIA, OTHER_MEDIA, VISIBILITY, mediaKey, similarMedia } from "../../../shared/jobPostings.mjs";
import { postingsApi } from "./postingsApi";

// 求人一覧（選択肢）の読み込み。テーブル未作成時は ready:false（求人の選択欄を出さない）
export function usePostingOptions() {
  const [state, setState] = useState({ loaded: false, ready: false, postings: [], media: MEDIA.map(m => m.name) });
  useEffect(() => {
    let alive = true;
    postingsApi.list().then(res => {
      if (!alive) return;
      if (res.ok && res.data?.ready) setState({ loaded: true, ready: true, postings: res.data.postings || [], media: res.data.media || MEDIA.map(m => m.name) });
      else setState(s => ({ ...s, loaded: true, ready: false }));
    }).catch(() => alive && setState(s => ({ ...s, loaded: true, ready: false })));
    return () => { alive = false; };
  }, []);
  return state;
}

const visOrder = { public: 0, undefined: 1, null: 1, private: 2 };
export const postingOptionLabel = p => `${p.title}（${p.category_name}）${p.visibility === "private" ? "・非公開" : p.visibility == null ? "・公開状態未設定" : ""}`;

export default function PostingPicker({ agentName, onMediaChange, postingId, onPostingChange, options, labelStyle, inputStyle }) {
  const selected = mediaKey(agentName);
  const list = [...options.media];
  if (selected && !list.includes(selected)) list.push(selected);
  const [other, setOther] = useState(false);
  const candidates = options.postings
    .filter(p => selected && mediaKey(p.media) === selected)
    .sort((a, b) => (visOrder[a.visibility] ?? 1) - (visOrder[b.visibility] ?? 1) || Number(a.id) - Number(b.id));
  const current = postingId ? options.postings.find(p => p.id === String(postingId)) : null;
  const mismatch = current && !candidates.some(p => p.id === current.id);
  const rawDiffers = agentName && selected && agentName.trim() !== selected;
  return (
    <div className="nks-posting-picker">
      <label style={labelStyle}>掲載媒体
        <select name="agent_media" value={other ? OTHER_MEDIA : selected || ""} style={inputStyle} onChange={e => {
          const v = e.target.value;
          if (v === OTHER_MEDIA) { setOther(true); return; }
          setOther(false);
          onMediaChange(v);
          // 媒体を変えたら、その媒体の求人ではない選択は外す
          if (current && mediaKey(current.media) !== v) onPostingChange("");
        }}>
          <option value="">選択してください</option>
          {list.map(m => <option key={m} value={m}>{m}</option>)}
          <option value={OTHER_MEDIA}>その他（入力）</option>
        </select>
      </label>
      {other && (
        <label style={labelStyle}>媒体名
          <input type="text" name="agent_name" value={agentName || ""} style={inputStyle} onChange={e => {
            onMediaChange(e.target.value);
            if (current && mediaKey(current.media) !== mediaKey(e.target.value)) onPostingChange("");
          }} />
        </label>
      )}
      {/* 登録済みの媒体と表記が近い場合は候補を表示（選ぶまで入力値は変えない） */}
      {other && agentName && similarMedia(agentName, list).length > 0 && (
        <div className="nks-inline-note">登録済みの媒体：{similarMedia(agentName, list).map(n => (
          <button key={n} type="button" className="jm-link" style={{ margin: "0 4px" }} onClick={() => { setOther(false); onMediaChange(n); if (current && mediaKey(current.media) !== n) onPostingChange(""); }}>{n}</button>
        ))}（同じ媒体なら選んでください）</div>
      )}
      {rawDiffers && <div className="nks-inline-note">登録済みの媒体名「{agentName}」は「{selected}」として表示しています（保存されている値は変更しません）。</div>}
      {options.linkError && <div className="nks-inline-note">求人のひも付けを読み込めなかったため、求人は選択できません。画面を再読み込みしてください。</div>}
      {options.ready && (
        <label style={labelStyle}>求人（任意）
          <select name="job_posting" value={postingId || ""} style={inputStyle} onChange={e => onPostingChange(e.target.value)} disabled={!selected && !current}>
            <option value="">該当求人なし・不明</option>
            {mismatch && <option value={current.id}>{postingOptionLabel(current)}・媒体「{mediaKey(current.media)}」</option>}
            {candidates.map(p => <option key={p.id} value={p.id}>{postingOptionLabel(p)}</option>)}
          </select>
        </label>
      )}
      {options.ready && selected && candidates.length === 0 && !current && <div className="nks-inline-note">この媒体の求人は登録されていません（求人一覧から登録できます）。</div>}
      {mismatch && <div className="nks-inline-note">選択中の求人は別の媒体（{mediaKey(current.media)}）の求人です。</div>}
    </div>
  );
}

export const visibilityText = v => VISIBILITY[v] || "公開状態未設定";
