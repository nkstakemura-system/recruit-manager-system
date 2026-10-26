"use strict";
// 選考履歴の読み書き手順。保存先（PostgreSQL / テスト・プレビュー用メモリ）は store で差し替える。
// 全ての書き込みは1トランザクション内で「応募者行のロック → 版の照合 → 追記 → 互換列の同期」を行う。
// 履歴は追記のみ（UPDATE・DELETE しない）。
const flow = require("./selectionFlow");

const STALE_MESSAGE = "他の画面で選考情報が更新されています。最新の内容を読み込み直しました。";
const UNAVAILABLE_MESSAGE = "選考履歴テーブルが未作成のため、選考履歴機能は使用できません";

function mirrorOf(candidate) {
  const picked = {};
  for (const field of flow.SELECTION_OWNED_FIELDS) picked[field] = candidate[field] ?? null;
  return picked;
}

async function ensureReady(store) {
  if (!(await store.ready())) throw flow.selectionError(503, UNAVAILABLE_MESSAGE, { code: "selection_unavailable" });
}

async function loadState(tx, id, lock) {
  const candidate = await tx.getCandidate(id, { lock });
  if (!candidate) throw flow.selectionError(404, "Not Found");
  if (candidate.is_coop === true) throw flow.selectionError(400, "協力業者は従来の進捗更新を使用します");
  return { candidate, log: await tx.listEvents(id) };
}

// 有効な工程（steps）と、取消済みを含む全工程（all）
function stepsOf(candidate, log) {
  if (!log.length) {
    const all = flow.legacyEvents(candidate);
    return { all, steps: all };
  }
  return { all: log.filter(e => !flow.META_KINDS.includes(e.kind)), steps: flow.effectiveSteps(log) };
}

// 既存値と履歴が食い違う場合は自動補正せずに停止する（旧コードでの更新・不整合な既存データ）
function assertInSync(candidate, log) {
  const { steps, all } = stepsOf(candidate, log);
  const issues = flow.syncIssues(candidate, steps, all, log);
  if (issues.length) {
    throw flow.selectionError(409,
      "既存データと選考履歴が一致しないため、自動では更新しません。管理者に確認してください。", { code: "out_of_sync", fields: issues });
  }
}

async function response(tx, id) {
  const { candidate, log } = await loadState(tx, id, false);
  return { ...flow.timelineView(candidate, log), candidate: mirrorOf(candidate) };
}

async function getTimeline(store, id) {
  await ensureReady(store);
  return store.transaction(tx => response(tx, id));
}

async function mutate(store, id, body, operation) {
  await ensureReady(store);
  return store.transaction(async tx => {
    const { candidate, log } = await loadState(tx, id, true);
    if (String(body?.expected_version ?? "") !== flow.selectionVersion(candidate, log))
      throw flow.selectionError(409, STALE_MESSAGE, { code: "stale" });
    await operation(tx, candidate, log);
    return response(tx, id);
  });
}

const nextSeq = log => log.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0) + 1;

// 最初の書き込み時に、既存列の値（baseline）と既存工程（legacy）を追記する。既存列は変更しない。
async function materialize(tx, candidate, log, actor) {
  if (log.length) return log;
  await tx.insertEvent(candidate.id, {
    kind: "baseline", stage_number: null, event_date: null, note: null, attendee: null, ended_stage: null,
    source: "legacy", target_event_id: null, payload: flow.snapshotOf(candidate), actor,
  }, 1);
  const legacy = flow.legacyEvents(candidate);
  for (let i = 0; i < legacy.length; i += 1) {
    // 従来データの印（受付のまま1次面接日のみ等）は payload に残す
    await tx.insertEvent(candidate.id, { ...legacy[i], target_event_id: null, payload: legacy[i].payload ?? null, actor }, i + 2);
  }
  return tx.listEvents(candidate.id);
}

async function appendAndSync(tx, candidate, entry) {
  const log = await tx.listEvents(candidate.id);
  await tx.insertEvent(candidate.id, entry, nextSeq(log));
  const after = await tx.listEvents(candidate.id);
  const { steps, all } = stepsOf(candidate, after);
  await tx.updateMirror(candidate.id, flow.deriveMirror(steps, all));
}

// 画面の工程ID（未保存の既存工程は legacy-N）から、有効な工程を特定する
async function resolveTarget(tx, candidate, log, eventId, actor) {
  const legacy = /^legacy-(\d+)$/.exec(String(eventId));
  if (legacy && log.length) throw flow.selectionError(409, STALE_MESSAGE, { code: "stale" });
  const stored = await materialize(tx, candidate, log, actor);
  const steps = flow.effectiveSteps(stored);
  let target;
  if (legacy) {
    const legacyRows = stored.filter(e => e.source === "legacy" && !flow.META_KINDS.includes(e.kind));
    target = steps.find(e => String(e.id) === String(legacyRows[Number(legacy[1])]?.id));
  } else {
    target = steps.find(e => String(e.id) === String(eventId));
  }
  if (!target) {
    const exists = stored.some(e => String(e.id) === String(eventId));
    throw flow.selectionError(exists ? 409 : 404, exists ? "この工程は既に取り消されています" : "履歴が見つかりません");
  }
  return { target, steps };
}

function addStep(store, id, body, actor) {
  return mutate(store, id, body, async (tx, candidate, log) => {
    assertInSync(candidate, log);
    const stored = await materialize(tx, candidate, log, actor);
    const entry = flow.buildStep(flow.effectiveSteps(stored), body, actor);
    await appendAndSync(tx, candidate, entry);
  });
}

function correctStep(store, id, eventId, body, actor) {
  return mutate(store, id, body, async (tx, candidate, log) => {
    assertInSync(candidate, log);
    const { target } = await resolveTarget(tx, candidate, log, eventId, actor);
    await appendAndSync(tx, candidate, flow.buildCorrection(target, body, actor));
  });
}

// 取消は最新の有効な工程のみ（途中の工程を取り消して流れが矛盾しないようにする）
function voidStep(store, id, eventId, body, actor) {
  return mutate(store, id, body, async (tx, candidate, log) => {
    assertInSync(candidate, log);
    const { target, steps } = await resolveTarget(tx, candidate, log, eventId, actor);
    if (String(steps[steps.length - 1].id) !== String(target.id))
      throw flow.selectionError(409, "取り消せるのは最新の工程のみです");
    await appendAndSync(tx, candidate, flow.buildVoid(target, body, actor));
  });
}

function setAppliedDate(store, id, body, actor) {
  return mutate(store, id, body, async (tx, candidate, log) => {
    if (!flow.isDate(body?.date)) throw flow.selectionError(400, "日付は西暦4桁の正しい日付で入力してください");
    const stored = await materialize(tx, candidate, log, actor);
    await tx.insertEvent(candidate.id, {
      kind: "applied_date_changed", stage_number: null, event_date: body.date, note: null, attendee: null, ended_stage: null,
      source: "user", target_event_id: null, payload: { before: candidate.applied_at_key || null, after_date: body.date }, actor,
    }, nextSeq(stored));
    await tx.updateAppliedAt(candidate, body.date);
  });
}

function setContactHistory(store, id, body, actor) {
  return mutate(store, id, body, async (tx, candidate, log) => {
    const list = flow.normalizeContactHistory(body?.contact_history);
    const stored = await materialize(tx, candidate, log, actor);
    await tx.insertEvent(candidate.id, {
      kind: "contact_history_changed", stage_number: null, event_date: null, note: null, attendee: null, ended_stage: null,
      source: "user", target_event_id: null, payload: { before: candidate.contact_history || [], after: list }, actor,
    }, nextSeq(stored));
    await tx.updateContactHistory(candidate.id, list);
  });
}

module.exports = { getTimeline, addStep, correctStep, voidStep, setAppliedDate, setContactHistory, mirrorOf };
