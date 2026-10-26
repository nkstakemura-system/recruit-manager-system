"use strict";
// 選考履歴のルール。DBには接続しない純粋関数のみ（本番APIとローカルプレビューで共用）。
//
// 履歴は追記専用。訂正・取消も「correction」「void」イベントとして追記し、元のイベントは変更しない。
// 現在のタイムラインは「取消されていないイベント＋最新の訂正」から再構成する。
// candidates の既存列（status・面接日・内定日・入社予定日・辞退理由など）は履歴から導出するが、
// その列に関わるイベントが一度も無い場合は既存値に触れない。

// 利用者が追加できる選考工程
const STEP_KINDS = [
  "document_received", "interview_scheduled", "interview_completed", "offer", "join_planned",
  "joined", "declined", "no_contact", "rejected",
];
// 既存データの履歴化でのみ使う工程（既存 status 2「面接打診中」）
const LEGACY_ONLY_KINDS = ["contacting"];
// 工程ではない記録（監査用）
const META_KINDS = ["baseline", "correction", "void", "applied_date_changed", "contact_history_changed"];
const KINDS = [...STEP_KINDS, ...LEGACY_ONLY_KINDS, ...META_KINDS];
const TERMINAL = new Set(["declined", "no_contact", "rejected"]);
const INTERVIEW = new Set(["interview_scheduled", "interview_completed"]);
const NOTE_MAX = 1000;
const ATTENDEE_MAX = 100;

// 個人応募では、これらの列は選考履歴APIだけが更新する（PUTで届いた場合は409）。
const SELECTION_OWNED_FIELDS = [
  "status", "decline_reason", "interview_1_date", "interview_2_date", "interview_2_attendee",
  "offer_date", "expected_join_date", "applied_at", "contact_history",
];
// 履歴から導出し、既存値との一致を確認する列
const MIRROR_FIELDS = ["status", "interview_1_date", "interview_2_date", "interview_2_attendee", "offer_date", "expected_join_date", "decline_reason"];

const FIELD_LABELS = {
  status: "進捗", interview_1_date: "1次面接日", interview_2_date: "2次面接日", interview_2_attendee: "2次面接の同席者",
  offer_date: "内定日", expected_join_date: "入社予定日", decline_reason: "辞退・不採用理由",
};

function selectionError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

// 西暦4桁（0000年を除く）の実在日付。既存の内定日検証（offerDate.js）と同じ基準。
function isDate(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const todayTokyo = (now = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);

function ymd(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? todayTokyo(value) : null;
  const text = String(value);
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? todayTokyo(date) : null;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

const ymdOrRaw = value => ymd(value) ?? (value == null || value === "" ? null : String(value));

function textOrNull(value, max, field) {
  if (value == null) return null;
  if (typeof value !== "string") throw selectionError(400, `Invalid ${field}`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw selectionError(400, `${field} too long`);
  return trimmed || null;
}

const STEP_LABELS = {
  contacting: "面接打診",
  document_received: "書類到着",
  offer: "内定通知",
  join_planned: "入社予定",
  joined: "入社済み",
  declined: "辞退",
  no_contact: "音信不通（不採用）",
  rejected: "不採用",
};

function stepLabel(event) {
  if (event.kind === "interview_scheduled") return `${event.stage_number}次面接（予定）`;
  if (event.kind === "interview_completed") return `${event.stage_number}次面接（完了）`;
  if (event.kind === "declined" && event.ended_stage === "内定") return "内定辞退";
  if (TERMINAL.has(event.kind) && event.ended_stage) return `${event.ended_stage}${STEP_LABELS[event.kind]}`;
  return STEP_LABELS[event.kind] || event.kind;
}

// 一覧バッジ用の短い表示名
function badgeLabel(kind, stage) {
  if (!kind) return null;
  if (kind === "interview_scheduled") return `${stage}次面接予定`;
  if (kind === "interview_completed") return `${stage}次面接済`;
  return {
    contacting: "面接打診中", document_received: "書類選考中", offer: "内定", join_planned: "入社予定",
    joined: "入社", declined: "辞退", no_contact: "音信不通", rejected: "不採用",
  }[kind] || null;
}

// 一覧に付ける選考情報（最新工程の表示名。終了工程なら終了の種別と日付）
function listSelectionFields(kind, stage, date) {
  const fields = { selection_label: badgeLabel(kind, stage) };
  if (TERMINAL.has(kind)) Object.assign(fields, { selection_ended_kind: kind, selection_ended_date: ymd(date) });
  return fields;
}

// 終了時点の段階（辞退理由の文言に使う。既存の「1次面接辞退: 理由」形式に合わせる）
function stageLabel(event) {
  if (!event) return "応募";
  if (INTERVIEW.has(event.kind)) return `${event.stage_number}次面接`;
  if (event.kind === "offer" || event.kind === "join_planned") return "内定";
  if (event.kind === "document_received") return "書類選考";
  if (event.kind === "contacting") return "面接打診";
  return "応募";
}

function declineReason(event) {
  if (event.source === "legacy") return event.note;
  const word = event.kind === "declined" ? "辞退" : event.kind === "no_contact" ? "音信不通（不採用）" : "不採用";
  const base = `${event.ended_stage || ""}${word}`;
  return event.note ? `${base}: ${event.note}` : base;
}

function classifyLegacyTerminal(reason) {
  const text = String(reason || "");
  if (text.includes("音信不通")) return "no_contact";
  if (text.includes("辞退")) return "declined";
  return "rejected";
}

// 既存列の値（基準値）。初回の履歴化で baseline イベントに保存する（読み取れない日付は元の文字列のまま）。
function snapshotOf(candidate) {
  return {
    status: candidate.status == null ? null : String(candidate.status),
    interview_1_date: ymdOrRaw(candidate.interview_1_date),
    interview_2_date: ymdOrRaw(candidate.interview_2_date),
    interview_2_attendee: candidate.interview_2_attendee ?? null,
    offer_date: ymdOrRaw(candidate.offer_date),
    expected_join_date: ymdOrRaw(candidate.expected_join_date),
    decline_reason: candidate.decline_reason ?? null,
    applied_at: candidate.applied_at_key ?? (candidate.applied_at == null ? null : String(candidate.applied_at)),
    contact_history: Array.isArray(candidate.contact_history) ? candidate.contact_history : [],
  };
}

// 従来データで「受付（status 1）のまま1次面接日だけが登録されている」場合の印。
// 1次面接の予定として履歴に残すが、status は受付のまま扱い、面接の実施は推定しない（利用者が明示的に登録する）。
const LEGACY_RECEIVED_WITH_INTERVIEW = { legacy_status: "1" };
const isUnconfirmedLegacyInterview = event => Boolean(event) && event.source === "legacy"
  && event.kind === "interview_scheduled" && Number(event.stage_number) === 1 && event.payload?.legacy_status === "1";

// 履歴が未作成の応募者について、既存列から工程を投影する（保存はしない）。
// 状態と日付が整合していない場合は deriveMirror の結果が既存値と食い違い、syncIssues で検出される。
// 例外として許容するのは「status 1＋1次面接日のみ（2次面接日・内定日・入社予定日なし）」の組み合わせだけ。
function legacyEvents(candidate) {
  const st = String(candidate.status ?? "");
  const rows = [];
  const add = (kind, extra = {}) => rows.push({
    kind, stage_number: null, event_date: null, note: null, attendee: null, ended_stage: null,
    source: "legacy", ...extra,
  });
  const i1 = ymd(candidate.interview_1_date);
  const i2 = ymd(candidate.interview_2_date);
  const offer = ymd(candidate.offer_date);
  const join = ymd(candidate.expected_join_date);
  const offered = Boolean(offer) || ["5", "6"].includes(st) || (st === "9" && Boolean(join));
  if (st === "2") add("contacting");
  const stage1 = i1 || ["3", "4"].includes(st);
  const stage2 = i2 || st === "4";
  const receivedWithInterview = st === "1" && Boolean(i1) && !i2 && !offer && !join;
  if (stage1) {
    add("interview_scheduled", { stage_number: 1, event_date: i1, ...(receivedWithInterview ? { payload: LEGACY_RECEIVED_WITH_INTERVIEW } : {}) });
    if (stage2 || offered) add("interview_completed", { stage_number: 1 });
  }
  if (stage2) {
    add("interview_scheduled", { stage_number: 2, event_date: i2, attendee: candidate.interview_2_attendee ?? null });
    if (offered) add("interview_completed", { stage_number: 2 });
  }
  if (offered) add("offer", { event_date: offer });
  if (join || st === "6") add("join_planned", { event_date: join });
  if (st === "6") add("joined", { event_date: join });
  if (st === "9") {
    add(classifyLegacyTerminal(candidate.decline_reason), {
      note: candidate.decline_reason ?? null, ended_stage: stageLabel(rows[rows.length - 1]),
    });
  }
  return rows;
}

// 追記ログ（listEvents の結果）から、取消されていない工程を訂正込みで並べる。
function effectiveSteps(log) {
  const voided = new Set(log.filter(e => e.kind === "void").map(e => String(e.target_event_id)));
  const corrections = new Map();
  for (const e of log) if (e.kind === "correction") corrections.set(String(e.target_event_id), e);
  return log
    .filter(e => !META_KINDS.includes(e.kind) && !voided.has(String(e.id)))
    .map(e => {
      const fix = corrections.get(String(e.id));
      if (!fix) return { ...e, corrected: false };
      return {
        ...e, corrected: true, original_date: e.event_date ?? null,
        event_date: fix.event_date ?? null, note: fix.note ?? null,
        attendee: INTERVIEW.has(e.kind) ? fix.attendee ?? null : e.attendee ?? null,
      };
    });
}

function lastOf(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (predicate(events[i])) return events[i];
  return null;
}

// 履歴から candidates の互換列を導出する。関わるイベントが一度も無い列は返さない（既存値を保持）。
// steps: 有効な工程, all: 取消済みも含む全工程
function deriveMirror(steps, all) {
  const mirror = {};
  const ever = predicate => all.some(predicate);
  const scheduled = stage => lastOf(steps, e => e.kind === "interview_scheduled" && Number(e.stage_number) === stage);
  if (all.length) {
    const last = steps[steps.length - 1];
    let status = "1";
    if (!last) status = "1";
    else if (isUnconfirmedLegacyInterview(last)) status = "1"; // 従来データの受付のまま（実施状況は未確認）
    else if (TERMINAL.has(last.kind)) status = "9";
    else if (last.kind === "joined") status = "6";
    else if (last.kind === "offer" || last.kind === "join_planned") status = "5";
    else if (INTERVIEW.has(last.kind)) status = Number(last.stage_number) >= 2 ? "4" : "3";
    else if (last.kind === "contacting") status = "2";
    mirror.status = status;
  }
  for (const stage of [1, 2]) {
    if (ever(e => e.kind === "interview_scheduled" && Number(e.stage_number) === stage))
      mirror[`interview_${stage}_date`] = scheduled(stage)?.event_date ?? null;
  }
  if (ever(e => e.kind === "interview_scheduled" && Number(e.stage_number) === 2))
    mirror.interview_2_attendee = scheduled(2)?.attendee ?? null;
  if (ever(e => e.kind === "offer"))
    mirror.offer_date = lastOf(steps, e => e.kind === "offer")?.event_date ?? null;
  if (ever(e => e.kind === "join_planned" || e.kind === "joined")) {
    const join = lastOf(steps, e => e.kind === "joined") || lastOf(steps, e => e.kind === "join_planned");
    mirror.expected_join_date = join?.event_date ?? null;
  }
  if (ever(e => TERMINAL.has(e.kind))) {
    const last = steps[steps.length - 1];
    mirror.decline_reason = last && TERMINAL.has(last.kind) ? declineReason(last) : null;
  }
  return mirror;
}

// 既存 status として定義されている値（これ以外は履歴化せず停止する）
const KNOWN_STATUSES = ["1", "2", "3", "4", "5", "6", "9"];
// 読み取れない日付（西暦1〜9999年の範囲外・形式不正）。保存先は "invalid:元の値" として渡す。
const unreadableDate = value => value != null && value !== "" && !ymd(value);

function normalized(field, value) {
  if (value == null || value === "") return null;
  if (field === "status") return String(value);
  if (field.endsWith("_date")) return ymd(value) ?? "invalid";
  return String(value);
}

// 現在の candidates の値と、履歴から導出した値の食い違い（自動補正せず停止するため）。
// 未定義の status・読み取れない日付も、黙って上書き・消去しないよう食い違いとして扱う。
// log（保存済みの履歴）がある場合、工程の無い列は baseline（初回履歴化時の値）と比較する
// （履歴化後に旧コード等で内定日だけが追加された、等の変更も検出する）。
function syncIssues(candidate, steps, all, log = []) {
  const baseline = log.find(e => e.kind === "baseline")?.payload || null;
  const expected = { ...(baseline ? Object.fromEntries(MIRROR_FIELDS.map(field => [field, baseline[field] ?? null])) : {}), ...deriveMirror(steps, all) };
  const issues = new Set(Object.keys(expected).filter(field => normalized(field, expected[field]) !== normalized(field, candidate[field])));
  if (!KNOWN_STATUSES.includes(String(candidate.status ?? ""))) issues.add("status");
  for (const field of MIRROR_FIELDS) if (field.endsWith("_date") && unreadableDate(candidate[field])) issues.add(field);
  return MIRROR_FIELDS.filter(field => issues.has(field));
}

const COOP_CHANGE_MESSAGE = "この応募者には選考履歴があるため、管理種別（個人応募／協力業者）は変更できません。"
  + "種別を変えると選考履歴と進捗が一致しなくなるためです。今回の保存は行っていません（他の項目も変更されていません）。"
  + "管理種別を元に戻してから保存し直してください。種別の変更が必要な場合は管理者に相談してください。";
const STALE_PUT_MESSAGE = "画面が古いため保存できません。再読み込みしてから入力し直してください（選考情報は選考の更新から変更します）。";

// 基本情報の保存（PUT）を拒否する理由。応募者行をロックした状態で、同じトランザクション内の値で判定する。
// managed: 選考履歴テーブルあり / hasHistory: この応募者の選考履歴が1件以上
function candidatePutConflict({ managed, currentIsCoop, nextIsCoop, hasHistory, body }) {
  if (!managed) return null;
  if (nextIsCoop !== currentIsCoop && hasHistory)
    return selectionError(409, COOP_CHANGE_MESSAGE, { code: "coop_change_has_history" });
  if (!currentIsCoop && SELECTION_OWNED_FIELDS.some(field => Object.prototype.hasOwnProperty.call(body || {}, field)))
    return selectionError(409, STALE_PUT_MESSAGE, { code: "selection_fields_rejected" });
  return null;
}

function nextInterviewStage(steps) {
  return steps.reduce((max, e) => e.kind === "interview_scheduled" ? Math.max(max, Number(e.stage_number) || 0) : max, 0) + 1;
}

const ACTION_DEFS = {
  document_received: { label: "書類選考", date_label: "書類到着日" },
  interview_scheduled: { date_label: "面接予定日" },
  interview_completed: { date_label: "面接実施日" },
  offer: { label: "内定通知", date_label: "内定通知日" },
  join_planned: { label: "入社予定", date_label: "入社予定日" },
  joined: { label: "入社済みにする", date_label: "入社日", confirm: "入社済み（進捗：入社）に変更します。よろしいですか？" },
  declined: { label: "辞退", date_label: "辞退日", requires_note: true },
  no_contact: { label: "音信不通", date_label: "音信不通を確認した日", confirm: "音信不通として不採用にしますか？" },
  rejected: { label: "不採用", date_label: "不採用決定日" },
};

function nextActions(steps) {
  const last = steps[steps.length - 1];
  const kind = last ? last.kind : null;
  let kinds;
  if (!kind) kinds = ["document_received", "interview_scheduled", "declined", "no_contact"];
  else if (kind === "contacting") kinds = ["interview_scheduled", "declined", "no_contact"];
  else if (kind === "document_received") kinds = ["interview_scheduled", "rejected", "declined", "no_contact"];
  else if (kind === "interview_scheduled") kinds = ["interview_completed", "declined", "no_contact"];
  else if (kind === "interview_completed") kinds = ["interview_scheduled", "offer", "rejected", "declined"];
  else if (kind === "offer") kinds = ["join_planned", "declined"];
  else if (kind === "join_planned") kinds = ["joined", "declined"];
  else kinds = [];
  const nextStage = nextInterviewStage(steps);
  return kinds.map(k => {
    const def = ACTION_DEFS[k];
    const stage = k === "interview_scheduled" ? nextStage : k === "interview_completed" ? Number(last.stage_number) : null;
    let label = def.label;
    let confirm = def.confirm || null;
    let dateLabel = def.date_label;
    if (k === "interview_scheduled") label = `${stage}次面接（予定）`;
    if (k === "interview_completed") label = `${stage}次面接（完了）`;
    let defaultDate = k === "interview_completed" ? last.event_date || null : k === "joined" ? last.event_date || null : null;
    if (k === "interview_completed" && isUnconfirmedLegacyInterview(last)) {
      // 面接日を過ぎていても実施済みと推定しない。実施日は空欄から入力してもらう。
      confirm = `従来データでは進捗が「受付」のまま、1次面接日（${last.event_date}）だけが登録されています。1次面接を実施したことを確認しましたか？`;
      defaultDate = null;
    }
    if (k === "declined" && (kind === "offer" || kind === "join_planned")) {
      label = "内定辞退";
      dateLabel = "内定辞退日";
      if (kind === "join_planned") confirm = "入社予定を取り消し、内定辞退として記録します。元の入社予定日は履歴に残ります。よろしいですか？";
    }
    return {
      kind: k, stage_number: stage, label, date_label: dateLabel, confirm,
      requires_note: Boolean(def.requires_note), default_date: defaultDate,
      date_must_be_entered: k === "interview_completed" && isUnconfirmedLegacyInterview(last),
    };
  });
}

// 新規工程の入力検証。返り値はそのまま追記できる形。
function buildStep(steps, body, actor) {
  if (!body || typeof body !== "object") throw selectionError(400, "Invalid request");
  const action = nextActions(steps).find(a => a.kind === body.kind);
  if (!action) throw selectionError(409, "この工程は現在の選考状況から登録できません");
  if (!isDate(body.event_date)) throw selectionError(400, "日付は西暦4桁の正しい日付で入力してください");
  const note = textOrNull(body.note, NOTE_MAX, "note");
  if (action.requires_note && !note) throw selectionError(400, "辞退理由を入力してください");
  return {
    kind: action.kind, stage_number: action.stage_number, event_date: body.event_date, note,
    attendee: action.kind === "interview_scheduled" ? textOrNull(body.attendee, ATTENDEE_MAX, "attendee") : null,
    ended_stage: TERMINAL.has(action.kind) ? stageLabel(steps[steps.length - 1]) : null,
    source: "user", target_event_id: null, payload: null, actor,
  };
}

// 訂正：対象の工程はそのまま残し、訂正内容を追記する
function buildCorrection(target, body, actor) {
  if (!body || typeof body !== "object") throw selectionError(400, "Invalid request");
  if (!isDate(body.event_date)) throw selectionError(400, "日付は西暦4桁の正しい日付で入力してください");
  const note = textOrNull(body.note, NOTE_MAX, "note");
  if (target.kind === "declined" && target.source !== "legacy" && !note) throw selectionError(400, "辞退理由を入力してください");
  return {
    kind: "correction", stage_number: null, event_date: body.event_date, note,
    attendee: target.kind === "interview_scheduled" ? textOrNull(body.attendee, ATTENDEE_MAX, "attendee") : null,
    ended_stage: null, source: "user", target_event_id: target.id,
    payload: { reason: textOrNull(body.reason, NOTE_MAX, "reason"), before: { event_date: target.event_date ?? null, note: target.note ?? null, attendee: target.attendee ?? null } },
    actor,
  };
}

// 取消：対象の工程はそのまま残し、取消記録を追記する
function buildVoid(target, body, actor) {
  return {
    kind: "void", stage_number: null, event_date: null, note: null, attendee: null, ended_stage: null,
    source: "user", target_event_id: target.id,
    payload: { reason: textOrNull(body?.reason, NOTE_MAX, "reason") }, actor,
  };
}

function normalizeContactHistory(value) {
  if (!Array.isArray(value) || value.length > 50) throw selectionError(400, "Invalid contact history");
  return value.map(item => {
    if (!item || typeof item !== "object") throw selectionError(400, "Invalid contact history");
    const date = item.date ? String(item.date) : "";
    if (date && !isDate(date)) throw selectionError(400, "日付は西暦4桁の正しい日付で入力してください");
    return { date, tel: item.tel === true, email: item.email === true };
  });
}

// 楽観ロック用の版。履歴（追記のみ）・受付日・連絡履歴・status・面接日等の互換列のどれかが変われば変わる
// （履歴化前に旧コード等で面接日だけが変更された場合も、古い画面からの更新を409にする）。
function selectionVersion(candidate, log) {
  const source = JSON.stringify([
    String(candidate.status ?? ""), String(candidate.applied_at_key ?? ""),
    JSON.stringify(candidate.contact_history || []), log.map(e => String(e.id)),
    MIRROR_FIELDS.map(field => normalized(field, candidate[field]) ?? ""),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${log.length}-${hash.toString(16).padStart(8, "0")}`;
}

function historyLabel(entry, byId) {
  const target = entry.target_event_id != null ? byId.get(String(entry.target_event_id)) : null;
  const targetLabel = target ? stepLabel(target) : "";
  switch (entry.kind) {
    case "baseline": return "既存データを履歴化";
    case "correction": return `訂正：${targetLabel}`;
    case "void": return `取消：${targetLabel}`;
    case "applied_date_changed": return "受付日を変更";
    case "contact_history_changed": return "面接打診の連絡履歴を変更";
    default: return `${stepLabel(entry)}${entry.source === "legacy" ? "（従来データ）" : ""}`;
  }
}

// 画面表示用。stored=false の場合は既存列からの投影（未保存）。
function timelineView(candidate, log) {
  const stored = log.length > 0;
  const all = stored ? log.filter(e => !META_KINDS.includes(e.kind)) : legacyEvents(candidate).map((e, i) => ({ ...e, id: `legacy-${i}` }));
  const steps = stored ? effectiveSteps(log) : all.map(e => ({ ...e, corrected: false }));
  const issues = syncIssues(candidate, steps, all, log);
  const byId = new Map(log.map(e => [String(e.id), e]));
  return {
    candidate_id: candidate.id,
    applied_date: ymd(candidate.applied_at),
    status: String(candidate.status ?? ""),
    contact_history: Array.isArray(candidate.contact_history) ? candidate.contact_history : [],
    stored,
    records: steps.map((e, i) => ({
      id: String(e.id), kind: e.kind, stage_number: e.stage_number == null ? null : Number(e.stage_number),
      event_date: e.event_date || null, original_date: e.corrected ? e.original_date : null, corrected: Boolean(e.corrected),
      note: e.note || null, attendee: e.attendee || null, ended_stage: e.ended_stage || null, source: e.source || "user",
      label: stepLabel(e), is_latest: i === steps.length - 1,
    })),
    history: log.map(e => ({
      id: String(e.id), kind: e.kind, label: historyLabel(e, byId), event_date: e.event_date || null,
      note: e.note || null, reason: e.payload?.reason || null, created_at: e.created_at || null, actor: e.actor || null,
    })),
    actions: issues.length ? [] : nextActions(steps),
    sync_issues: issues.map(field => FIELD_LABELS[field] || field),
    notices: !issues.length && isUnconfirmedLegacyInterview(steps[steps.length - 1])
      ? [`従来データでは進捗が「受付」のまま、1次面接日（${steps[steps.length - 1].event_date}）だけが登録されています。`
        + "面接を実施したかどうかは推定していません（進捗は「受付」のままです）。実施済みの場合は「1次面接（完了）」を登録してください。"]
      : [],
    version: selectionVersion(candidate, log),
  };
}

module.exports = {
  KINDS, STEP_KINDS, META_KINDS, TERMINAL, SELECTION_OWNED_FIELDS, MIRROR_FIELDS, KNOWN_STATUSES,
  selectionError, isDate, ymd, todayTokyo, snapshotOf, legacyEvents, effectiveSteps, deriveMirror, syncIssues,
  candidatePutConflict, unreadableDate, isUnconfirmedLegacyInterview,
  nextActions, nextInterviewStage, buildStep, buildCorrection, buildVoid, normalizeContactHistory,
  selectionVersion, timelineView, stepLabel, badgeLabel, listSelectionFields, declineReason, stageLabel,
};
