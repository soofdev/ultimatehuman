// The ONE data-provider module of the vendored pages (app/): it maps the
// engine's /api/cockpit feed into the exact shapes the reference pages already
// consume, and answers the pages' own /api/admin/* calls with engine calls.
// Nothing in app/ knows the engine exists.
//
// The radar's outputs are TICKETS (PipelineTicket rows), not claims: claims are
// an agent's statements, and this radar has no agent. So PlatformClaim is empty
// and the Claims tab shows its own empty state.
//
// Mapping (see the task REPORT.md for what stays unmapped):
//   finding.repo           -> ticket.repo (repo badge beside the key; config repos[].name)
//   finding, no ruling     -> queue 'decision' (Needs decision): File / Dismiss / Not now
//   finding or draft parked -> queue 'decision', answered C (Not now)
//   finding filed          -> queue 'shipped' (filed date as the merge date; the real issue as its link)
//   finding dismissed      -> queue 'cancelled' (Shipped tab, muted "Cancelled" row, your reason)
//   dropped draft          -> queue 'cancelled' (the radar did not advance it; its drop reason)
//   last run               -> PipelineSyncStatus.last_push_at (the live page's "Synced N ago")
//   Answer A               -> POST /api/findings/:id/file (dry run while no GitHub token)
//   Answer B, Cancel ticket -> POST /api/rulings dismiss, the text is the reason
//   Answer C               -> POST /api/rulings park
//   instruction proposal, pending -> queue 'decision' (TEACH-n): A Apply / B Reject / C Not now
//   proposal parked                -> 'decision' unanswered again (A/B/C back), "parked on <date>" in its context
//   proposal applied / rejected or stale -> 'shipped' / 'cancelled'
//   TEACH card extras (src/teach/proposal-cards.jsx): the change as a red/green diff, answer copy in proposal words
//   finding.validation pending/later (features.validationGate) -> queue 'backlog', gate pending/later (Awaiting validation)
//   Validate / Later / Dismiss on it -> POST /api/findings/:id/validate
//   merge, building, manual, bundles, flags, chat -> none: no fix legs in this radar.
//   card.pipelineId / proposal.pipelineId -> a pipeline badge beside the ticket key (src/pipelines/pipeline-badges.jsx)
//   ?pipeline=<id> on the page URL -> only that pipeline's tickets (the badge layer's filter bar sets it)

import { enhanceTeachCards } from '../teach/proposal-cards';
import { enhancePipelineBadges } from '../pipelines/pipeline-badges';
import { cockpitHref, stageOf } from '@/app/lib/pipeline-live';

let csrf = '';
let feed = null;
const keyOf = new Map(); // clusterId -> ticket key, stable for the page's life
const cardOf = new Map(); // ticket key -> cockpit card
const proposalKey = new Map(); // proposal id -> ticket key
const proposalOf = new Map(); // ticket key -> instruction proposal

const realFetch = window.fetch.bind(window);

class EngineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function engine(path, body) {
  const res = await realFetch(path, body === undefined
    ? { credentials: 'same-origin', cache: 'no-store' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-uh-csrf': csrf }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new EngineError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

const historyAts = (card) => (card.history || []).map((h) => h.at).filter(Boolean).sort();
const firstAt = (card) => historyAts(card)[0] || card.finding?.createdAt || card.draft?.at || '';
const lastAt = (card) => historyAts(card).pop() || firstAt(card);
const repoOf = () => feed?.output?.repo || '';
// "vincent38wargnier/jalsa" -> "JALSA": the tickets read like a tracker's keys (JALSA-1)
const keyPrefix = () => (repoOf().split('/').pop() || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[^A-Z]+/, '') || 'BUG';
const when = (v) => new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '?');

const OPTIONS = () => [
  {
    letter: 'A',
    label: repoOf() ? 'File to GitHub' : 'Accept',
    text: !repoOf()
      ? 'Accepts the ticket. No issue tracker is configured: the pipeline keeps its own tickets.'
      : feed?.output?.dryRun
        ? `Records it as filed on ${repoOf()}. Dry run: nothing is sent to GitHub while no GitHub token is set.`
        : `Opens the issue on ${repoOf()}.`,
  },
  { letter: 'B', label: 'Dismiss', text: 'Not a bug. Say why in the box below: the radar keeps it out of the next passes unless its impact grows.' },
  { letter: 'C', label: 'Not now', text: 'Park it. It comes back for a fresh look the first time a pass sees a new occurrence.' },
];

function decisionOf(card) {
  const f = card.finding;
  const d = card.draft;
  if (f) {
    const i = f.impact || {};
    return {
      question: `${card.title}. ${repoOf() ? `File it as an issue on ${repoOf()}?` : 'Accept it as a ticket?'}`,
      options: OPTIONS(),
      recommendation: '',
      context: [
        `What users hit: ${f.symptom}`,
        f.rootCause?.statement && `Root cause (${f.confidence}): ${f.rootCause.statement}`,
        `Impact: ${i.usersAffected} users, ${i.occurrences} occurrences, ${day(i.firstSeen)} to ${day(i.lastSeen)}, trend ${i.trend}. Severity ${f.severity}.`,
        ...(f.rootCause?.codePointers || []).map((p) => `${p.path}:${p.line}: ${p.why}`),
      ].filter(Boolean),
    };
  }
  return {
    question: `${card.title}. The radar dropped it: ${d.reason}.`,
    options: OPTIONS(),
    recommendation: '',
    context: [`Dropped ${d.timesDropped || 1} time${d.timesDropped === 1 ? '' : 's'}, last in the ${d.runLabel} (${day(d.at)}).`],
  };
}

// A real issue ("owner/repo#12") as the ticket's one link; a dry run has none.
function issueLinks(r) {
  const n = /#(\d+)$/.exec(r?.ref || '')?.[1];
  if (!n) return [];
  const repo = r.repo || repoOf();
  return [{ repo: repo.split('/').pop(), number: Number(n), url: `https://github.com/${repo}/issues/${n}`, title: '', base: '', head: '', files: [] }];
}

function toTicket(card, key) {
  const f = card.finding;
  const d = card.draft;
  const r = card.ruling && card.ruling.ruling !== 'clear' && card.ruling.ruling !== 'resurfaced' ? card.ruling : null;
  const base = {
    key,
    title: card.title,
    repo: f?.repo || null,
    plain: { improves: card.title, problem: f ? f.symptom : d.reason, how: '' },
    verdict: '',
    fix_class: '',
    hold: null,
    prs: [],
    evidence: [],
    flags: [],
    chat: [],
    decision: null,
    merged_at: null,
    cancelled_at: null,
    fix_round: null,
    manual: null,
    plan: null,
    jira_status: null,
    jira_created: firstAt(card),
    jira_updated: lastAt(card),
    createdAt: firstAt(card),
    synced_at: lastAt(card),
  };
  if (r?.ruling === 'park') {
    return { ...base, queue: 'decision', decision: decisionOf(card), answer: { option: 'C', text: r.reason || '', answered_at: r.at, acked_at: r.at, ack_error: null } };
  }
  if (f && r?.ruling === 'file') return { ...base, queue: 'shipped', merged_at: r.at, prs: issueLinks(r) };
  if (r?.ruling === 'dismiss') {
    return { ...base, queue: 'cancelled', cancelled_at: r.at, cancel: { reason: `You dismissed it: ${r.reason}`, requested_at: r.at, acked_at: r.at, ack_error: null } };
  }
  // features.validationGate: a finding still waiting for promotion sits in Awaiting validation
  const v = f?.validation;
  if (f && (v?.state === 'pending' || v?.state === 'later')) {
    return { ...base, queue: 'backlog', gate: v.state, gate_at: v.at, plain: { ...base.plain, how: f.rootCause?.statement || '' } };
  }
  if (f) return { ...base, queue: 'decision', decision: decisionOf(card), answer: null };
  return { ...base, queue: 'cancelled', cancelled_at: d.at, cancel: { reason: `The radar dropped it in the ${d.runLabel}: ${d.reason}`, requested_at: d.at, acked_at: d.at, ack_error: null } };
}

// Agent proposals to amend the instructions (SPEC 7b): the same decision grammar as a finding.
const BRIEF_FILE = { mission: 'mission.md', collector: 'collector.md', admission: 'admission.md', gate: 'gate.md', scope: 'scope.md' };
const pipelineName = (id) => feed?.pipelines?.find((p) => p.id === id)?.name || id;
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function proposalDecision(p) {
  const file = BRIEF_FILE[p.brief] || p.brief;
  const next = (feed?.instructionsVersions?.[p.pipelineId] || p.baseVersion) + 1;
  const last = p.rulings[p.rulings.length - 1];
  const removed = p.diff.filter((l) => l.op === '-').length;
  const added = p.diff.filter((l) => l.op === '+').length;
  return {
    question: `Teach ${pipelineName(p.pipelineId)}: ${p.title}. Apply this change to ${file}?`,
    options: [
      { letter: 'A', label: 'Apply', text: `Saves it as ${pipelineName(p.pipelineId)} instructions v${next}; its next pass reads it. Config > Instructions reverts it in one tap.` },
      { letter: 'B', label: 'Reject', text: 'Say why in the box below: the next retrospectives read your reason and do not propose it again without new evidence.' },
      { letter: 'C', label: 'Not now', text: 'Keep it here for later. Nothing changes meanwhile.' },
    ],
    recommendation: '',
    context: [
      p.status === 'parked' && `You parked it on ${when(last.at)}. Apply, Reject or keep it parked.${last.reason ? ` Your note: "${last.reason}"` : ''}`,
      `The gap: ${p.gap}`,
      ...p.evidence.map((e) => `Evidence: ${e.label} (${e.ref}): ${e.what}`),
      `The change to ${file}: ${removed} line${removed === 1 ? '' : 's'} removed, ${added} added (red and green, under the question).`,
      ...p.edits.map((e) => `Why: ${e.because}`),
      `Expected effect: ${p.expectedEffect}`,
      `Size of ${file}: about ${p.tokensBefore} to ${p.tokensAfter} tokens (${signed(p.tokensAfter - p.tokensBefore)}), read on every agent step.`,
      `Drafted by the retrospective of ${p.runId} on instructions v${p.baseVersion}. It never applies itself.`,
    ].filter(Boolean),
  };
}

function proposalTicket(p, key) {
  const last = p.rulings[p.rulings.length - 1] || null;
  const base = {
    key,
    title: `Instructions: ${p.title}`,
    plain: { improves: p.title, problem: p.gap, how: p.expectedEffect },
    verdict: '',
    fix_class: '',
    hold: null,
    prs: [],
    evidence: [],
    flags: [],
    chat: [],
    decision: null,
    merged_at: null,
    cancelled_at: null,
    fix_round: null,
    manual: null,
    plan: null,
    jira_status: null,
    jira_created: p.createdAt,
    jira_updated: last?.at || p.createdAt,
    createdAt: p.createdAt,
    synced_at: last?.at || p.createdAt,
  };
  if (p.status === 'applied') return { ...base, queue: 'shipped', merged_at: last.at };
  if (p.status === 'rejected' || p.status === 'stale') {
    const why = p.status === 'rejected' ? `You rejected it: ${last.reason}` : `Not applied: ${last.reason}`;
    return { ...base, queue: 'cancelled', cancelled_at: last.at, cancel: { reason: why, requested_at: last.at, acked_at: last.at, ack_error: null } };
  }
  // pending or parked: the A/B/C form stays (a parked proposal is still yours to apply)
  return { ...base, queue: 'decision', decision: proposalDecision(p), answer: null };
}

async function refresh() {
  feed = await engine('/api/cockpit');
  const cards = [...feed.cards].sort((a, b) => firstAt(a).localeCompare(firstAt(b)));
  for (const c of cards) if (!keyOf.has(c.clusterId)) keyOf.set(c.clusterId, `${keyPrefix()}-${keyOf.size + 1}`);
  cardOf.clear();
  for (const c of cards) cardOf.set(keyOf.get(c.clusterId), c);
  const props = [...(feed.proposals || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of props) if (!proposalKey.has(p.id)) proposalKey.set(p.id, `TEACH-${proposalKey.size + 1}`);
  proposalOf.clear();
  for (const p of props) proposalOf.set(proposalKey.get(p.id), p);
}

// ?pipeline=<id>: the board shows one pipeline's tickets (and its instruction proposals) only.
const pipelineFilter = () => new URLSearchParams(window.location.search).get('pipeline') || '';
const shown = (pipelineId) => !pipelineFilter() || pipelineFilter() === pipelineId;
const tickets = () => [
  ...[...cardOf].filter(([, c]) => shown(c.pipelineId)).map(([key, c]) => toTicket(c, key)),
  ...[...proposalOf].filter(([, p]) => shown(p.pipelineId)).map(([key, p]) => proposalTicket(p, key)),
];

const PROPOSAL_RULING = { A: 'apply', B: 'reject', C: 'park' };
const answerCopy = new Map(); // TEACH key -> what your last answer did, in proposal words

function proposalAnswerCopy(p, version) {
  if (p.status === 'applied') return `Saved as instructions v${version ?? '?'}: the next pass reads it. Config > Instructions reverts it in one tap.`;
  if (p.status === 'rejected') return 'Rejected. The next retrospectives read your reason and do not propose it again without new evidence.';
  if (p.status === 'stale') return 'Not applied: the brief changed since this was drafted.';
  return 'Parked. Nothing changes meanwhile; it stays in Needs decision with its options.';
}

async function answerProposal(key, option, why) {
  const p = proposalOf.get(key);
  const before = proposalTicket(p, key);
  const ruling = PROPOSAL_RULING[option];
  if (!ruling) return json(400, { error: 'Pick A, B or C: Apply, Reject or Not now.' });
  if (ruling === 'reject' && !why) return json(400, { error: 'Say why in the box: the next retrospectives read your reason.' });
  const res = await engine(`/api/proposals/${encodeURIComponent(p.id)}/rule`, { ruling, reason: why });
  await refresh();
  answerCopy.set(key, proposalAnswerCopy(res.proposal || proposalOf.get(key), res.version));
  const at = new Date().toISOString();
  // a park is not final: "Change my answer" stays, so Apply is one tap away without a reload
  const acked = ruling === 'park' ? null : at;
  return json(200, { ticket: { ...before, answer: { option, text: why, answered_at: at, acked_at: acked, ack_error: null } } });
}

/** When the radar last reported: the running pass's latest phase, else the last pass's end. */
function syncStatus() {
  const run = feed?.runs?.[0];
  if (!run) return null;
  const at = run.phase === 'done' || run.phase === 'failed' ? run.finishedAt || run.startedAt : new Date().toISOString();
  return { last_push_at: at, received: run.signals ?? 0, changed: (run.findings ?? 0) + (run.dropped ?? 0) };
}

/** Signs the page in (CSRF from /api/status) and loads the feed; a lapsed session goes back to the engine's login screen. */
export async function init() {
  try {
    csrf = (await engine('/api/status')).csrf;
    await refresh();
    focusFinding();
  } catch (e) {
    if (e instanceof EngineError && e.status === 401) window.location.replace('/');
    throw e;
  }
}

// ?finding=<id> (a notification link): the engine knows findings, the page knows
// ticket keys, so rewrite it to the link the live page itself would give that
// ticket (its tab + ?focus=KEY) before the page reads the URL.
function focusFinding() {
  const id = new URLSearchParams(window.location.search).get('finding');
  if (!id) return;
  const key = [...cardOf].find(([, c]) => c.finding?.id === id)?.[0];
  const ticket = key && tickets().find((t) => t.key === key);
  window.history.replaceState(null, '', ticket ? cockpitHref(stageOf(ticket), key) : window.location.pathname);
}

const lean = (value) => ({ lean: async () => value() });

// Stand-ins for the reference pages' Mongoose models (page.js reads them server-side).
// Every ticket has a queue and both pages' filters keep all of them; the live page
// re-reads the merge window itself (pipeline-live.js).
export const PlatformClaim = { find: () => lean(() => []) };
export const PipelineTicket = { find: () => lean(tickets) };
export const PipelineBundles = { findOne: () => lean(() => null) };
export const PipelineSyncStatus = { findOne: () => lean(syncStatus) };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function answer({ key, option, text }) {
  if (proposalOf.has(key)) return answerProposal(key, option, (text || '').trim());
  const card = cardOf.get(key);
  if (!card) return json(404, { error: 'Unknown ticket' });
  const before = toTicket(card, key);
  const why = (text || '').trim();
  if (option === 'A') {
    if (!card.finding) return json(400, { error: 'The radar dropped this one: there is no issue to file. Answer B or C.' });
    await engine(`/api/findings/${encodeURIComponent(card.finding.id)}/file`, {});
  } else if (option === 'B') {
    if (!why) return json(400, { error: 'Say why in the box: a dismissal keeps its reason.' });
    await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'dismiss', reason: why });
  } else if (option === 'C') {
    await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'park', reason: why });
  } else {
    return json(400, { error: 'Pick A, B or C: the radar acts on one of the three.' });
  }
  await refresh();
  const at = new Date().toISOString();
  // like the reference: the card stays here with your answer; the next load shows it on its new stage
  return json(200, { ticket: { ...before, answer: { option, text: why, answered_at: at, acked_at: at, ack_error: null } } });
}

async function cancel({ key, reason }) {
  if (proposalOf.has(key)) {
    if (!(reason || '').trim()) return json(400, { error: 'Say why: the next retrospectives read your reason.' });
    const before = proposalTicket(proposalOf.get(key), key);
    await engine(`/api/proposals/${encodeURIComponent(proposalOf.get(key).id)}/rule`, { ruling: 'reject', reason: reason.trim() });
    await refresh();
    const at = new Date().toISOString();
    return json(200, { ticket: { ...before, cancel: { reason: reason.trim(), requested_at: at, acked_at: at, ack_error: null } } });
  }
  const card = cardOf.get(key);
  if (!card) return json(404, { error: 'Unknown ticket' });
  const why = (reason || '').trim();
  if (!why) return json(400, { error: 'Say why: the radar keeps the reason with the dismissal.' });
  const before = toTicket(card, key);
  await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'dismiss', reason: why });
  await refresh();
  const at = new Date().toISOString();
  return json(200, { ticket: { ...before, cancel: { reason: why, requested_at: at, acked_at: at, ack_error: null } } });
}

async function gate({ key, action, note }) {
  const card = cardOf.get(key);
  if (!card?.finding) return json(404, { error: 'Unknown ticket' });
  if (!['validate', 'later', 'dismiss'].includes(action)) return json(400, { error: 'Validate, Later or Dismiss only.' });
  await engine(`/api/findings/${encodeURIComponent(card.finding.id)}/validate`, { action, note });
  await refresh();
  return json(200, { ticket: toTicket(cardOf.get(key), key) });
}

async function live() {
  await refresh();
  return json(200, JSON.parse(JSON.stringify({ tickets: tickets(), sync: syncStatus(), read_at: new Date() })));
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/admin/')) return realFetch(input, init);
  const path = url.split('?')[0];
  try {
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/admin/pipeline/answer') return await answer(body);
    if (path === '/api/admin/pipeline/cancel') return await cancel(body);
    if (path === '/api/admin/pipeline/live') return await live();
    if (path === '/api/admin/pipeline/gate') return await gate(body);
    return json(404, { error: 'Not available in this radar: it has no fix pipeline yet.' });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};

// The reference's ticket badges link to its own Jira (a hard-coded base URL in
// CockpitClient.js). Here a filed ticket links to its GitHub issue; any other
// badge is inert.
const JIRA_BROWSE = /^https:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)$/;
function relink(root) {
  for (const a of root.querySelectorAll?.('a[href*=".atlassian.net/browse/"]') || []) {
    const key = JIRA_BROWSE.exec(a.getAttribute('href'))?.[1];
    const link = key && issueLinks(cardOf.get(key)?.ruling)[0]?.url;
    if (link) a.setAttribute('href', link);
    else {
      a.removeAttribute('href');
      a.removeAttribute('target');
    }
  }
}
new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n.nodeType === 1 && relink(n.parentNode || n))))
  .observe(document.documentElement, { childList: true, subtree: true });

enhancePipelineBadges({
  pipelineOf: (key) => cardOf.get(key)?.pipelineId || proposalOf.get(key)?.pipelineId,
  pipelines: () => feed?.pipelines || [],
  counts: () => {
    const n = {};
    for (const c of cardOf.values()) n[c.pipelineId] = (n[c.pipelineId] || 0) + 1;
    return n;
  },
});

enhanceTeachCards({
  proposalOf: (key) => proposalOf.get(key),
  answerCopy: (key) => answerCopy.get(key) || 'Recorded on the proposal.',
});

// The radar's own pages under /administration (src/teach/) call the engine through the same signed-in helper.
export { engine as engineCall };
