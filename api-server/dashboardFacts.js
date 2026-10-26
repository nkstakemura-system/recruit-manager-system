"use strict";
// 期別ダッシュボードの集計元。DBには接続しない純粋関数のみ（本番APIとローカルプレビューで共用）。
//
// 応募者ごとに、選考履歴の有効な工程（取消を除き、訂正後の日付）から日付の確定した事実だけを取り出す。
// 氏名・連絡先などの個人情報は含めない。
// 旧データ（履歴未作成の応募者・従来データ由来の工程）で日付が不明なものは、他の日付で補わず date: null のまま返す。
const flow = require("./selectionFlow");

const day = value => flow.ymd(value);

function candidateFacts(candidate, log = []) {
  const facts = {
    id: String(candidate.id),
    coop: candidate.is_coop === true,
    deleted: candidate.is_deleted === true,
    applied: day(candidate.applied_at),
  };
  if (facts.coop) return facts;
  const steps = log.length ? flow.effectiveSteps(log) : flow.legacyEvents(candidate);
  const stage = event => Number(event.stage_number);
  // 面接完了は実施日がある工程だけ（従来データから投影した「完了」は実施日が無いため含めない）
  const completed = steps.filter(e => e.kind === "interview_completed" && day(e.event_date));
  const done = new Set(completed.map(stage));
  const joined = steps.filter(e => e.kind === "joined").at(-1);
  const last = steps.at(-1);
  // 従来データの面接予定で、実施の記録（面接完了）が無いもの（参考表示用。実施済みとは扱わない）
  const unconfirmed = steps
    .filter(e => e.kind === "interview_scheduled" && e.source === "legacy" && day(e.event_date) && !done.has(stage(e)))
    .map(e => ({ stage: stage(e), date: day(e.event_date) }));
  const dated = new Set([...done, ...unconfirmed.map(i => i.stage)]);
  return {
    ...facts,
    interviews: completed.map(e => ({ stage: stage(e), date: day(e.event_date) })),
    unconfirmed,
    // 従来データで面接の日付が無い回（予定・完了とも日付なし）。どの期にも割り当てず、回ごとに1件として参考表示する
    undated_interviews: [...new Set(steps
      .filter(e => (e.kind === "interview_scheduled" || e.kind === "interview_completed") && e.source === "legacy" && !dated.has(stage(e)))
      .map(stage))],
    offers: steps.filter(e => e.kind === "offer").map(e => day(e.event_date)),
    joined: joined ? { date: day(joined.event_date), legacy: joined.source === "legacy" } : null,
    ended: last && flow.TERMINAL.has(last.kind)
      ? { kind: last.kind, date: day(last.event_date), legacy: last.source === "legacy" }
      : null,
  };
}

// events: 全応募者の履歴（candidate_id 付き、応募者ごとに seq 順）
function buildFacts(candidates, events = []) {
  const logs = new Map();
  for (const event of events) {
    const key = String(event.candidate_id);
    if (!logs.has(key)) logs.set(key, []);
    logs.get(key).push(event);
  }
  return candidates.map(candidate => candidateFacts(candidate, logs.get(String(candidate.id)) || []));
}

module.exports = { candidateFacts, buildFacts };
