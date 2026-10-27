/**
 * Helpers for the pipeline cockpit (/administration/claims): validation of the
 * max-system snapshot, and the order a ticket's PRs must be merged in. The
 * platform never merges: Vincent opens each PR on GitHub and merges it there.
 */

export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
export const PR_REPOS = ['magify_agents_api', 'magify_next'];
export const QUEUES = ['backlog', 'merge', 'decision', 'shipped', 'cancelled', 'building', 'manual'];
// Cards Vincent can still chat about or cancel.
export const OPEN_QUEUES = ['merge', 'decision'];
export const CHAT_MAX_TEXT = 4000;
export const CHAT_MAX_MESSAGES = 200;
export const FIX_MAX_TEXT = 2000;
// A fix request made from a bubble carries the messages up to it (this many, newest last).
export const FIX_CONTEXT_MESSAGES = 6;
const FIX_STAGES = ['queued', 'fixing', 'checking'];
// Backend before frontend: a frontend PR may call an endpoint its api PR adds.
const REPO_RANK = { magify_agents_api: 0, magify_next: 1 };
const SHA = /^[0-9a-f]{7,40}$/;
const S3_EVIDENCE_PREFIX = 'admin-pipeline-evidence/';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const date = (v) => {
  const d = typeof v === 'string' && v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

export function evidenceS3Key(key, sha256) {
  return `${S3_EVIDENCE_PREFIX}${key}/${sha256}.png`;
}

export function isEvidenceS3Key(k) {
  return typeof k === 'string' && k.startsWith(S3_EVIDENCE_PREFIX) && !k.includes('..');
}

// ---------------------------------------------------------------- chat screenshots

// Screenshots Vincent attaches in a card's chat: stored like the proofs (private
// bucket, same prefix, named by sha256), so the same viewer route serves them.
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_MAX = 5;
export const CHAT_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** The image type of a buffer from its first bytes ('png' | 'jpg' | 'webp'), else null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function chatImageS3Key(key, sha256, ext) {
  return `${S3_EVIDENCE_PREFIX}${key}/chat/${sha256}.${ext}`;
}

/**
 * The screenshots a chat message (or fix request) carries, as uploaded through
 * /api/admin/pipeline/chat-image -> the stored shape, or null when one is
 * invalid (wrong key, unknown type) or there are more than CHAT_IMAGE_MAX.
 */
export function cleanChatImages(key, images) {
  if (images == null) return [];
  if (!Array.isArray(images) || images.length > CHAT_IMAGE_MAX) return null;
  const out = [];
  const seen = new Set();
  for (const i of images) {
    const sha256 = /^[0-9a-f]{64}$/.test(i?.sha256 || '') ? i.sha256 : null;
    const ext = Object.keys(CHAT_IMAGE_TYPES).find((e) => i?.s3_key === chatImageS3Key(key, sha256, e));
    if (!sha256 || !ext) return null;
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    out.push({
      name: str(i.name, 200) || `screenshot.${ext}`,
      sha256,
      s3_key: i.s3_key,
      type: CHAT_IMAGE_TYPES[ext],
      size: int(i.size),
    });
  }
  return out;
}

// ---------------------------------------------------------------- flags

// Vincent's flags on a ticket card (his state: the sync never writes them).
// "Later" also pauses the pipeline's automatic rounds on the ticket until removed.
export const FLAG_PRESETS = [
  { id: 'waiting-response', label: 'Waiting for response' },
  { id: 'wait-conflict-fix', label: 'Wait for conflict fix' },
  { id: 'warning', label: 'Warning' },
  { id: 'priority', label: 'Priority' },
  { id: 'later', label: 'Later' },
  { id: 'watch-after-ship', label: 'Watch after ship' },
];
export const FLAG_MAX = 12;
export const FLAG_LABEL_MAX = 40;
const FLAG_ID = /^(?:[a-z-]{2,40}|c-[a-z0-9-]{1,40})$/;

/** The id of a custom flag from its label ("Ask Olivier" -> "c-ask-olivier"), or null. */
export function customFlagId(label) {
  const slug = (typeof label === 'string' ? label : '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug ? `c-${slug}` : null;
}

/** { id, label } of a flag to add ({ id } of a preset, or { label } of a custom one), or null. */
export function flagToAdd(input) {
  const preset = FLAG_PRESETS.find((f) => f.id === input?.id);
  if (preset) return { ...preset };
  const label = str(input?.label, FLAG_LABEL_MAX).replace(/\s+/g, ' ');
  const byLabel = FLAG_PRESETS.find((f) => f.label.toLowerCase() === label.toLowerCase());
  if (byLabel) return { ...byLabel };
  const id = customFlagId(label);
  return id ? { id, label } : null;
}

export const isFlagId = (id) => typeof id === 'string' && FLAG_ID.test(id);

/**
 * The tickets a flag filter keeps. `filter` = { flags: [ids] (any of them),
 * only: 'flagged' | 'none' | null }; no filter keeps everything.
 */
export function filterByFlags(tickets, filter) {
  const ids = new Set(filter?.flags || []);
  return (tickets || []).filter((t) => {
    const mine = (t.flags || []).map((f) => f.id);
    if (filter?.only === 'none') return mine.length === 0;
    if (filter?.only === 'flagged' && !mine.length) return false;
    return !ids.size || mine.some((id) => ids.has(id));
  });
}

/** { flagged, none, [flag id]: n } over a list of tickets. */
export function flagCounts(tickets) {
  const out = { flagged: 0, none: 0 };
  (tickets || []).forEach((t) => {
    const flags = t.flags || [];
    if (flags.length) out.flagged += 1; else out.none += 1;
    flags.forEach((f) => { out[f.id] = (out[f.id] || 0) + 1; });
  });
  return out;
}

function cleanPr(p) {
  const repo = str(p?.repo, 60);
  const number = int(p?.number);
  if (!PR_REPOS.includes(repo) || !number) return null;
  return {
    repo,
    number,
    url: str(p.url, 300),
    title: str(p.title, 300),
    base: str(p.base, 200),
    head: str(p.head, 200),
    head_sha: SHA.test(p.head_sha || '') ? p.head_sha : '',
    additions: int(p.additions),
    deletions: int(p.deletions),
    changed_files: int(p.changed_files),
    merged_at: date(p.merged_at),
    files: (Array.isArray(p.files) ? p.files : []).slice(0, 300).map((f) => ({
      path: str(f?.path, 300),
      additions: int(f?.additions),
      deletions: int(f?.deletions),
    })).filter((f) => f.path),
  };
}

function cleanEvidence(e) {
  const name = str(e?.name, 200);
  const sha256 = /^[0-9a-f]{64}$/.test(e?.sha256 || '') ? e.sha256 : '';
  if (!name || !sha256) return null;
  return { name, caption: str(e.caption, 600), sha256 };
}

function cleanDecision(d) {
  if (!d || typeof d !== 'object') return null;
  const options = (Array.isArray(d.options) ? d.options : []).slice(0, 8).map((o) => ({
    letter: str(o?.letter, 4),
    label: str(o?.label, 200),
    text: str(o?.text, 1000),
  })).filter((o) => o.letter);
  return {
    question: str(d.question, 2000),
    options,
    recommendation: str(d.recommendation, 1000),
    context: (Array.isArray(d.context) ? d.context : []).slice(0, 12).map((c) => str(c, 1000)).filter(Boolean),
    raw: str(d.raw, 12000),
  };
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const CLAIM_ID = /^C-[A-Za-z0-9-]{1,20}$/;
const cleanLinks = (v) => (Array.isArray(v) ? v : []).map((l) => str(l, 500))
  .filter((l) => /^https?:\/\//.test(l)).slice(0, 12);

/**
 * The backlog fields of a snapshot ticket (a fix ticket not queued yet): its
 * Jira labels, a short excerpt of what is wrong, evidence links,
 * the claims it came from (also read from its claim-C-xxx labels).
 */
function cleanBacklog(t) {
  const labels = [...new Set((Array.isArray(t.labels) ? t.labels : []).filter((l) => LABEL.test(l || '')))].slice(0, 60);
  const fromLabels = labels.map((l) => /^claim-(C-[A-Za-z0-9-]+)$/.exec(l)?.[1]).filter(Boolean);
  const claimIds = [...new Set([...(Array.isArray(t.claim_ids) ? t.claim_ids : []), ...fromLabels])]
    .filter((c) => CLAIM_ID.test(c || '')).slice(0, 20);
  return {
    labels,
    // a pipeline that does not send labels yet: unknown scope, gated as MAX (see sync)
    labels_known: Array.isArray(t.labels),
    excerpt: str(t.excerpt, 1500),
    links: cleanLinks(t.links),
    claim_ids: claimIds,
  };
}

/** One snapshot ticket -> the stored shape, or null when invalid. */
export function cleanSnapshotTicket(t) {
  const key = str(t?.key, 40);
  if (!TICKET_KEY.test(key) || !QUEUES.includes(t.queue)) return null;
  const prs = (Array.isArray(t.prs) ? t.prs : []).map(cleanPr).filter(Boolean);
  if ((t.queue === 'merge' || t.queue === 'shipped') && !prs.length) return null;
  const mergedAt = t.queue === 'shipped' ? date(t.merged_at) : null;
  if (t.queue === 'shipped' && !mergedAt) return null;
  const cancelledAt = t.queue === 'cancelled' ? date(t.cancelled_at) : null;
  if (t.queue === 'cancelled' && !cancelledAt) return null;
  const manual = t.queue === 'manual' ? cleanManual(t.manual) : null;
  if (t.queue === 'manual' && !manual) return null;
  const seen = new Set();
  const evidence = (Array.isArray(t.evidence) ? t.evidence : []).map(cleanEvidence)
    .filter((e) => e && !seen.has(e.sha256) && seen.add(e.sha256)).slice(0, 40);
  return {
    key,
    queue: t.queue,
    title: str(t.title, 300),
    jira_status: str(t.jira_status, 60) || null,
    plain: {
      improves: str(t.plain?.improves, 600),
      problem: str(t.plain?.problem, 600),
      how: str(t.plain?.how, 600),
    },
    verdict: str(t.verdict, 2000),
    fix_class: str(t.fix_class, 40),
    hold: str(t.hold, 600) || null,
    prs,
    evidence,
    decision: t.queue === 'decision' ? cleanDecision(t.decision) : null,
    merged_at: mergedAt,
    cancelled_at: cancelledAt,
    fix_round: cleanFixRound(t.fix_round),
    manual,
    // COCKPIT_PLAN: only on the cards Plan testing lives on (absent = the old payload)
    plan: PLAN_QUEUES.includes(t.queue) ? cleanPlan(t.plan) : null,
    ...(t.queue === 'backlog' ? { backlog: cleanBacklog(t) } : {}),
    jira_dates: cleanJiraDates(t),
  };
}

// ---------------------------------------------------------------- card order

const JIRA_DATES = ['jira_created', 'jira_updated'];

/**
 * The ticket's Jira created / last updated datetimes the snapshot carries, any
 * queue. Only the fields it sends: a pipeline that does not send them (or
 * could not read Jira this run) leaves the stored dates as they are.
 */
function cleanJiraDates(t) {
  return Object.fromEntries(JIRA_DATES.filter((k) => k in t).map((k) => [k, date(t[k])]));
}

// The orders the cockpit offers within a tab. `default` = each tab's own order.
export const TICKET_SORTS = [
  { key: 'default', label: 'Default order' },
  { key: 'created-desc', label: 'Newest created', field: 'jira_created', dir: -1 },
  { key: 'created-asc', label: 'Oldest created', field: 'jira_created', dir: 1 },
  { key: 'updated-desc', label: 'Recently updated', field: 'jira_updated', dir: -1 },
  { key: 'updated-asc', label: 'Least recently updated', field: 'jira_updated', dir: 1 },
];

export const ticketSort = (key) => TICKET_SORTS.find((s) => s.key === key) || TICKET_SORTS[0];

const timeOf = (v) => {
  const ms = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * A tab's tickets in the chosen order (`list` is in the tab's default order,
 * returned as is for `default`). Tickets without the date (cards older than
 * the field) go last, in their default order.
 */
export function sortTickets(list, key) {
  const { field, dir } = ticketSort(key);
  if (!field) return list;
  return [...list].sort((a, b) => {
    const x = timeOf(a[field]);
    const y = timeOf(b[field]);
    if (x === null || y === null) return (x === null) - (y === null);
    return (x - y) * dir;
  });
}

// ---------------------------------------------------------------- plan testing

// Cards a Plan testing thread can live on: a selection of backlog tickets
// (Awaiting validation) or one Manual ticket (stopped over budget).
export const PLAN_QUEUES = ['backlog', 'manual'];
export const PLAN_MAX_KEYS = 10;
const RUNS_MAX = 8;
const SCENARIOS_MAX = 6;

/** The agreed test strategy -> the stored shape, or null when it is not valid. */
export function cleanStrategy(v) {
  if (!v || typeof v !== 'object') return null;
  const runs = (n) => (Number.isInteger(n) && n >= 1 && n <= RUNS_MAX ? n : null);
  const fix = runs(v.max_fix_runs);
  const exam = runs(v.max_exam_runs);
  const budget = Number.isFinite(v.budget_usd) && v.budget_usd > 0 && v.budget_usd <= 100
    ? Math.round(v.budget_usd * 100) / 100 : null;
  const scenarios = (Array.isArray(v.scenarios) ? v.scenarios : []).map((x) => str(x, 240).replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!fix || !exam || !budget || !scenarios.length || scenarios.length > SCENARIOS_MAX) return null;
  return { max_fix_runs: fix, max_exam_runs: exam, scenarios, budget_usd: budget, agreed_at: date(v.agreed_at) };
}

/** The sync's `plan` of a backlog / manual row: { on, strategy } or null (feature off). */
export function cleanPlan(p) {
  if (!p || typeof p !== 'object' || p.on !== true) return null;
  return { on: true, strategy: cleanStrategy(p.strategy) };
}

/** The `plan_close` of the pipeline's reply closing an agreed plan, or null. */
export function cleanPlanClose(c) {
  if (!c || typeof c !== 'object') return null;
  const tickets = [...new Set((Array.isArray(c.tickets) ? c.tickets : []).filter((k) => TICKET_KEY.test(k || '')))]
    .slice(0, PLAN_MAX_KEYS);
  const strategy = cleanStrategy(c.strategy);
  if (!tickets.length || !tickets.includes(c.survivor) || !strategy) return null;
  return { tickets, survivor: c.survivor, mode: c.mode === 'manual' ? 'manual' : 'select', strategy, merged_at: null, merge_error: null };
}

/**
 * The Plan testing thread a message on this card belongs to ({ keys, mode }),
 * or null when the card has none: a backlog card hosting an opened thread, or
 * a Manual card (its own thread) while the pipeline offers Plan testing.
 */
export function planOf(doc) {
  if (!doc?.plan?.on) return null;
  if (doc.queue === 'manual') return { keys: [doc.key], mode: 'manual' };
  if (doc.queue === 'backlog' && doc.plan_thread?.keys?.length) return { keys: doc.plan_thread.keys, mode: 'select' };
  return null;
}

/**
 * A ticket the pipeline's cost guard stopped over budget, left for Vincent to
 * run by hand: the reviewer's reason (shown verbatim), when it stopped, what
 * the stopped round spent and how that figure was obtained.
 */
function cleanManual(m) {
  const reason = str(m?.reason, 2000);
  const stoppedAt = date(m?.stopped_at);
  if (!reason || !stoppedAt) return null;
  const usd = Number.isFinite(m.spend_usd) && m.spend_usd >= 0 ? Math.round(m.spend_usd * 100) / 100 : null;
  return {
    reason,
    stopped_at: stoppedAt,
    spend_usd: usd,
    spend_note: str(m.spend_note, 200),
    leg_kind: str(m.leg_kind, 40),
  };
}

function cleanFixRound(r) {
  if (!r || typeof r !== 'object' || !CHAT_ID.test(r.request_id || '')) return null;
  return { request_id: r.request_id, stage: FIX_STAGES.includes(r.stage) ? r.stage : 'queued' };
}

const CHAT_ID = /^[A-Za-z0-9-]{1,80}$/;

/**
 * One chat message the pipeline sends back (its reply, or Vincent's own "Q:"
 * comment read on Jira) -> the stored shape, or null when invalid.
 */
export function cleanPipelineMessage(m) {
  const key = str(m?.key, 40);
  const id = str(m?.id, 80);
  const text = str(m?.text, CHAT_MAX_TEXT * 2);
  if (!TICKET_KEY.test(key) || !CHAT_ID.test(id) || !text || !['vincent', 'assistant'].includes(m.role)) return null;
  return {
    key,
    message: {
      id,
      role: m.role,
      text,
      at: date(m.at) || new Date(),
      by: null,
      source: m.role === 'vincent' ? 'jira' : 'pipeline',
      reply_to: m.role === 'assistant' && CHAT_ID.test(m.reply_to || '') ? m.reply_to : null,
      plan_close: m.role === 'assistant' ? cleanPlanClose(m.plan_close) : null,
      acked_at: m.role === 'vincent' ? new Date() : null,
      ack_error: null,
    },
  };
}

/**
 * True while one of Vincent's messages has no reply covering it. A reply
 * covers everything up to its `reply_to` (a follow-up he sent while it was
 * being written stays open), else everything before it. `chat` in time order.
 */
export function chatAwaitingReply(chat) {
  // a fix request is not a chat message: nobody "answers" it in the thread,
  // and the pipeline's reply on its round answers none of his chat messages
  const list = (chat || []).filter((m) => m.kind !== 'directive');
  let covered = -1;
  list.forEach((m, i) => {
    if (m.role !== 'assistant' || fixOutcomeKind(m)) return;
    const to = m.reply_to ? list.findIndex((x) => x.id === m.reply_to) : -1;
    covered = Math.max(covered, to >= 0 ? to : i);
  });
  return list.some((m, i) => m.role === 'vincent' && i > covered);
}

/** Vincent's latest fix request on a ticket (chat in any order), or null. */
export function latestDirective(chat) {
  return (chat || []).filter((m) => m.kind === 'directive')
    .sort((a, b) => new Date(a.at) - new Date(b.at)).pop() || null;
}

const FIX_OUTCOME = /^\s*Fix (delivered|failed):/;

/**
 * 'delivered' | 'failed' when the message is the pipeline's reply on the round
 * of one of his fix requests ("Fix delivered: …" / "Fix failed: …", reply_to =
 * the request), else null.
 */
export function fixOutcomeKind(m) {
  if (m?.role !== 'assistant' || !m.reply_to) return null;
  return (FIX_OUTCOME.exec(m.text || '') || [])[1] || null;
}

/** The pipeline's reply on the round of his latest fix request: { kind, message } or null. */
export function fixOutcome(ticket) {
  const d = latestDirective(ticket?.chat);
  if (!d) return null;
  const m = (ticket.chat || []).find((x) => x.reply_to === d.id && fixOutcomeKind(x));
  return m ? { kind: fixOutcomeKind(m), message: m, request: d } : null;
}

/**
 * The thread in time order, except that the reply on a fix request's round
 * sits right under that request (the chat that came in between follows it).
 */
export function threadOrder(chat) {
  const list = [...(chat || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const ids = new Set(list.filter((m) => m.kind === 'directive').map((m) => m.id));
  const replies = list.filter((m) => ids.has(m.reply_to) && fixOutcomeKind(m));
  const out = [];
  for (const m of list) {
    if (replies.includes(m)) continue;
    out.push(m);
    if (m.kind === 'directive') out.push(...replies.filter((r) => r.reply_to === m.id));
  }
  return out;
}

/**
 * The fix request still in flight on a ticket, or null: not yet taken by the
 * pipeline, or taken and its round still building (the sync reports it as
 * `fix_round`; until the first sync after the ack, the ack itself counts).
 * One at a time: while one is open, the card offers no second one.
 */
export function openFixRequest(ticket) {
  const d = latestDirective(ticket?.chat);
  if (!d) return null;
  if (!d.acked_at) return d;
  if (d.ack_error) return null;
  if (fixOutcome(ticket)) return null; // its round is over: the pipeline replied under it
  if (ticket.fix_round?.request_id === d.id) return d;
  const synced = ticket.synced_at ? new Date(ticket.synced_at).getTime() : 0;
  return new Date(d.acked_at).getTime() >= synced ? d : null;
}

/**
 * The spec context of a fix request made from one of Vincent's bubbles: the
 * last FIX_CONTEXT_MESSAGES chat messages up to and including it, one per
 * line ("Vincent: …" / "Pipeline: …"), each cut to 600 characters. Empty
 * when the bubble is the first message (it is the spec already).
 */
export function directiveContext(chat, fromId) {
  const list = [...(chat || [])].filter((m) => m.kind !== 'directive')
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const i = list.findIndex((m) => m.id === fromId);
  if (i < 1) return '';
  return list.slice(Math.max(0, i - FIX_CONTEXT_MESSAGES + 1), i + 1).map((m) => {
    const t = (m.text || '').replace(/\s+/g, ' ').trim();
    return `${m.role === 'vincent' ? 'Vincent' : 'Pipeline'}: ${t.length > 600 ? `${t.slice(0, 597)}...` : t}`;
  }).join('\n');
}

/**
 * Merge order for one ticket's PRs: a stacked PR (its base is another PR's
 * head) after the PR it sits on, then backend before frontend, then number.
 */
export function mergeOrder(prs) {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  const depth = (p, guard = 0) => {
    const parent = byHead.get(p.base);
    return parent && parent !== p && guard < prs.length ? 1 + depth(parent, guard + 1) : 0;
  };
  return [...prs].sort((a, b) => (depth(a) - depth(b))
    || ((REPO_RANK[a.repo] ?? 9) - (REPO_RANK[b.repo] ?? 9))
    || (a.number - b.number));
}

/**
 * The ordered merge plan the page shows: each PR with its step (1-based) and,
 * for a stacked PR, the PR of this ticket it sits on (`parent`).
 */
export function mergePlan(prs) {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  return mergeOrder(prs).map((p, i) => {
    const parent = byHead.get(p.base);
    return { pr: p, step: i + 1, parent: parent && parent !== p ? parent : null };
  });
}

// ---------------------------------------------------------------- suggested bundles

// Pipeline flag COCKPIT_BUNDLES: groups of waiting tickets the pipeline suggests
// testing together (one fix round + one exam), shown above Awaiting validation.
export const BUNDLE_MAX_GROUPS = 30;
export const BUNDLE_MAX_KEYS = 3;
const HASH = /^[0-9a-f]{8,64}$/;
const BUNDLE_ID = /^b-[0-9a-f]{6,40}$/;
const usd = (v) => (Number.isFinite(v) && v >= 0 && v < 1000 ? Math.round(v * 100) / 100 : 0);

/** The snapshot's `bundles` -> the stored shape, or null when it is not valid. */
export function cleanBundles(b) {
  if (!b || typeof b !== 'object' || !HASH.test(b.live_hash || '')) return null;
  const seen = new Set();
  const groups = [];
  for (const g of Array.isArray(b.groups) ? b.groups.slice(0, BUNDLE_MAX_GROUPS) : []) {
    const keys = [...new Set((Array.isArray(g?.keys) ? g.keys : []).filter((k) => TICKET_KEY.test(k || '')))];
    if (!BUNDLE_ID.test(g?.id || '') || seen.has(g.id) || keys.length < 2 || keys.length > BUNDLE_MAX_KEYS) continue;
    seen.add(g.id);
    groups.push({
      id: g.id,
      name: str(g.name, 80),
      mode: g.mode === 'relevance' ? 'relevance' : 'bundle',
      keys,
      surface: str(g.surface, 200),
      scenario: str(g.scenario, 400),
      est: { bundle_usd: usd(g.est?.bundle_usd), apart_usd: usd(g.est?.apart_usd), savings_usd: usd(g.est?.savings_usd) },
    });
  }
  return {
    input_hash: HASH.test(b.input_hash || '') ? b.input_hash : null,
    live_hash: b.live_hash,
    generated_at: date(b.generated_at),
    running: b.running === true,
    groups,
  };
}

/**
 * What the strip shows: `stale` while the groups were computed on another
 * waiting set (or none yet), else the groups not dismissed under this set
 * whose members all still wait for validation (`waiting`: keys on the page).
 */
export function visibleBundles(doc, waiting) {
  if (!doc) return null;
  const stale = !doc.input_hash || doc.input_hash !== doc.live_hash;
  const gone = new Set((doc.dismissed || []).filter((d) => d.input_hash === doc.input_hash).map((d) => d.id));
  const groups = stale ? [] : (doc.groups || []).filter((g) => !gone.has(g.id) && g.keys.every((k) => waiting.has(k)));
  return { stale, running: !!doc.running, generated_at: doc.generated_at || null, input_hash: doc.input_hash, groups };
}
