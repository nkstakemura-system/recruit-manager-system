import { formatDate } from "./selectionApi";

const tone = kind => {
  if (["declined", "no_contact", "rejected"].includes(kind)) return "end";
  if (kind === "joined") return "joined";
  if (kind === "offer" || kind === "join_planned") return "offer";
  return "step";
};

// 選考タイムライン。受付は自動表示し、到達済みで取消されていない工程のみ並べる（未到達の工程は出さない）。
export default function SelectionTimeline({ view, renderActions }) {
  if (!view) return null;
  return (
    <ol className="nks-timeline">
      <li className="nks-timeline-item" data-tone="start">
        <span className="nks-timeline-dot" aria-hidden="true" />
        <div className="nks-timeline-body">
          <div className="nks-timeline-head">
            <strong>受付・応募</strong>
            <span className="nks-timeline-date">{formatDate(view.applied_date)}</span>
          </div>
        </div>
      </li>
      {view.records.map(record => (
        <li key={record.id} className="nks-timeline-item" data-tone={tone(record.kind)}>
          <span className="nks-timeline-dot" aria-hidden="true" />
          <div className="nks-timeline-body">
            <div className="nks-timeline-head">
              <strong>{record.label}</strong>
              <span className="nks-timeline-date">{formatDate(record.event_date)}</span>
            </div>
            {record.corrected && (
              <div className="nks-timeline-note">訂正済み（元の日付：{formatDate(record.original_date)}）</div>
            )}
            {record.attendee && <div className="nks-timeline-note">同席者：{record.attendee}</div>}
            {record.note && <div className="nks-timeline-note">{record.note}</div>}
            {record.source === "legacy" && <div className="nks-timeline-legacy">従来データ</div>}
            {renderActions && renderActions(record)}
          </div>
        </li>
      ))}
    </ol>
  );
}

// 変更履歴（監査用）。訂正・取消も含め、追記された順に全て表示する。
export function SelectionHistory({ view }) {
  if (!view || !view.history.length) return null;
  return (
    <details className="nks-sel-history">
      <summary>変更履歴（{view.history.length}件）</summary>
      <ol>
        {view.history.map(entry => (
          <li key={entry.id}>
            <span className="nks-sel-history-time">{entry.created_at || ""}</span>
            <span>{entry.label}</span>
            {entry.event_date && <span className="nks-sel-history-sub">{formatDate(entry.event_date)}</span>}
            {entry.reason && <span className="nks-sel-history-sub">理由：{entry.reason}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
