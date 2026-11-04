/**
 * The live picture of the bug pipeline (/administration/pipeline-live): every
 * stored ticket placed on one stage of the flow, the same way the cockpit tabs
 * count them (/administration/claims), plus what shipped per day. Pure: the
 * page computes it in the browser, so days are the viewer's days.
 */

export const LIVE_REFRESH_MS = 30 * 1000;
export const SHIPPED_TAB_DAYS = 7; // the cockpit's Shipped tab window
export const CHART_DAYS = 14;
const DAY = 24 * 3600 * 1000;

// What GET /api/admin/pipeline/live reads of each ticket (legacy rows may miss any of it).
export const LIVE_PROJECTION = {
  _id: 0, key: 1, queue: 1, title: 1, 'plain.improves': 1, hold: 1, gate: 1, gate_at: 1, merged_into: 1,
  'prs.repo': 1, 'prs.number': 1, 'decision.question': 1, 'answer.answered_at': 1, fix_round: 1,
  'manual.stopped_at': 1, 'manual.spend_usd': 1, 'flags.id': 1, 'flags.label': 1,
  jira_created: 1, jira_updated: 1, merged_at: 1, cancelled_at: 1, synced_at: 1, createdAt: 1,
};

/**
 * The stages left to right. `owner` says whose move it is: 'you' (Vincent),
 * 'pipeline' or 'done'. `tab` is the cockpit tab the stage's cards live on.
 */
export const STAGES = [
  { key: 'validate', label: 'To validate', owner: 'you', tab: 'validate', hint: 'MAX fixes wait for your go before anything runs.' },
  { key: 'queued', label: 'Fix queue', owner: 'pipeline', tab: 'validate', hint: 'Validated, or not using MAX: the pipeline picks them up.' },
  { key: 'building', label: 'Building', owner: 'pipeline', tab: 'merge', hint: 'A fix round is running.' },
  { key: 'decide', label: 'Needs decision', owner: 'you', tab: 'decide', hint: 'The pipeline asks you to choose.' },
  { key: 'manual', label: 'Manual', owner: 'you', tab: 'manual', hint: 'Stopped over budget, for you to run by hand.' },
  { key: 'merge', label: 'Ready to merge', owner: 'you', tab: 'merge', hint: 'Passed the hostile check: review and merge on GitHub.' },
  { key: 'shipped', label: 'Shipped', owner: 'done', tab: 'shipped', hint: `Merged on GitHub, last ${SHIPPED_TAB_DAYS} days.` },
];

const ms = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const byKey = (a, b) => a.key.localeCompare(b.key, 'en', { numeric: true });

/** The stage a ticket sits on, or null when it is on none (left the queues, dismissed, merged away...). */
export function stageOf(t, now = Date.now()) {
  if (!t?.key) return null;
  if (t.live_stage && STAGES.some((s) => s.key === t.live_stage)) {
    if (t.live_stage === 'shipped' && (ms(t.merged_at) ?? 0) < now - SHIPPED_TAB_DAYS * DAY) return null;
    return t.live_stage;
  }
  switch (t.queue) {
    case 'backlog':
      if (t.merged_into) return null;
      if (t.gate === 'pending' || t.gate === 'later') return 'validate';
      if (t.gate === 'validated' || t.gate === 'auto') return 'queued';
      return null;
    case 'building': return 'building';
    case 'decision': return 'decide';
    case 'manual': return 'manual';
    case 'merge': return 'merge';
    case 'shipped': {
      const at = ms(t.merged_at);
      return at != null && at >= now - SHIPPED_TAB_DAYS * DAY ? 'shipped' : null;
    }
    default: return null;
  }
}

/**
 * Whose move a ticket is, and the one line the page says about it:
 * { turn: 'you' | 'pipeline' | 'done' | 'parked', status }.
 */
export function ticketState(t, stage) {
  if (t.live_state) return t.live_state;
  const prs = (t.prs || []).length;
  const prsText = `${prs} PR${prs === 1 ? '' : 's'}`;
  const round = t.fix_round?.stage;
  switch (stage) {
    case 'validate':
      return t.gate === 'later'
        ? { turn: 'parked', status: 'Parked with Later: nothing runs until you validate it.' }
        : { turn: 'you', status: 'Waiting for your validation.' };
    case 'queued':
      return { turn: 'pipeline', status: t.gate === 'validated' ? 'Validated by you, in the fix queue.' : 'No MAX cost, in the fix queue on its own.' };
    case 'building':
      return { turn: 'pipeline', status: round ? `Fix round ${round}.` : 'Fix in progress.' };
    case 'decide':
      return t.answer?.answered_at
        ? { turn: 'pipeline', status: 'You answered. The pipeline acts on it.' }
        : { turn: 'you', status: 'Waiting for your decision.' };
    case 'manual':
      return { turn: 'you', status: 'Stopped over budget. Yours to run by hand.' };
    case 'merge':
      if (round) return { turn: 'pipeline', status: `Your fix request is building (${round}).` };
      return t.hold
        ? { turn: 'you', status: `Held: ${t.hold}` }
        : { turn: 'you', status: `Ready: review and merge ${prsText} on GitHub.` };
    case 'shipped':
      return { turn: 'done', status: `Merged on GitHub (${prsText}).` };
    default:
      return { turn: 'pipeline', status: '' };
  }
}

/** The local midnight of a time, as ms. */
function dayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The whole picture from the stored tickets:
 * - stages: [{ ...STAGES[i], nodes: [...], count }] where `count` is what the
 *   matching cockpit tab counts (To validate = pending only, Needs decision =
 *   unanswered only, Shipped = shipped in 7 days, Fix queue = not a tab);
 * - nodes: { key, title, stage, turn, status, held, newToday, created, at, flags, round };
 * - waiting: the counts on Vincent (the four tabs he acts on) and the oldest one;
 * - shipped: per day for CHART_DAYS days (oldest first), from each ticket's merge date,
 *   `known: false` on the days before the stored history;
 * - today: tickets filed today (Jira created) and shipped today.
 */
export function livePicture(tickets, now = Date.now(), stageDefinitions = STAGES) {
  const today = dayStart(now);
  const nodes = [];
  for (const t of tickets || []) {
    const stage = stageOf(t, now);
    if (!stage) continue;
    const { turn, status } = ticketState(t, stage);
    const created = ms(t.jira_created);
    nodes.push({
      key: t.key,
      title: (t.plain?.improves || t.title || '').trim(),
      stage,
      turn,
      status,
      held: stage === 'merge' && !!t.hold && !t.fix_round?.stage,
      round: t.fix_round?.stage || null,
      created,
      newToday: created != null && created >= today,
      // the moment the stage is about: merged, stopped, filed
      at: stage === 'shipped' ? ms(t.merged_at) : (stage === 'manual' ? ms(t.manual?.stopped_at) : created),
      flags: (t.flags || []).map((f) => f.label).filter(Boolean),
      href: t.live_href || null,
      displayKey: t.displayKey || (t.live_stage ? `${t.key.split('-')[0]}-${t.key.slice(-6)}` : null),
    });
  }

  const stages = stageDefinitions.map((s) => {
    const list = nodes.filter((n) => n.stage === s.key);
    // newest merge first on Shipped; elsewhere: his turn first, oldest filed first
    // (undated last), then by key
    list.sort(s.key === 'shipped'
      ? (a, b) => (b.at || 0) - (a.at || 0) || byKey(a, b)
      : (a, b) => (rank(a) - rank(b)) || ((a.created ?? Infinity) - (b.created ?? Infinity)) || byKey(a, b));
    const count = s.key === 'validate' || s.key === 'decide'
      ? list.filter((n) => n.turn === 'you').length
      : list.length;
    return { ...s, nodes: list, count };
  });
  const countOf = (k) => stages.find((s) => s.key === k).count;

  const mine = nodes.filter((n) => n.turn === 'you');
  const oldest = mine.filter((n) => n.created != null).sort((a, b) => a.created - b.created)[0] || null;
  const waiting = {
    total: stageDefinitions === STAGES ? countOf('validate') + countOf('merge') + countOf('decide') + countOf('manual') : mine.length,
    validate: countOf('validate'),
    merge: countOf('merge'),
    held: nodes.filter((n) => n.held).length,
    decide: countOf('decide'),
    manual: countOf('manual'),
    parked: nodes.filter((n) => n.turn === 'parked').length,
    oldest,
  };

  // shipped per day: every stored ticket with a merge date, whatever its queue now. Each
  // push carries the merges of the last SHIPPED_TAB_DAYS days, so the days before the
  // first stored ticket minus that window are unknown (`known: false`), not zero.
  const first = today - (CHART_DAYS - 1) * DAY;
  const seen = (tickets || []).map((t) => ms(t.createdAt)).filter((x) => x != null);
  const knownFrom = seen.length ? dayStart(Math.min(...seen) - SHIPPED_TAB_DAYS * DAY) : null;
  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const start = dayStart(first + i * DAY + 12 * 3600 * 1000); // noon step: safe across DST changes
    return { start, count: 0, keys: [], known: knownFrom == null || start >= knownFrom };
  });
  for (const t of tickets || []) {
    const at = ms(t.merged_at);
    if (at == null || at < first || !t.key) continue;
    const d = days.find((x, i) => at >= x.start && (i === days.length - 1 || at < days[i + 1].start));
    if (d) { d.count += 1; d.keys.push(t.key); d.known = true; }
  }

  return {
    stages,
    nodes,
    waiting,
    shipped: days,
    today: {
      filed: nodes.filter((n) => n.newToday).sort(byKey),
      shipped: nodes.filter((n) => n.stage === 'shipped' && n.at != null && n.at >= today),
    },
  };
}

function rank(n) {
  return { you: 0, pipeline: 1, parked: 2, done: 3 }[n.turn] ?? 4;
}

/** The latest moment the platform heard from the pipeline: the last sync push, else the newest row change. */
export function lastSyncOf(status, tickets) {
  const push = ms(status?.last_push_at);
  if (push != null) return { at: push, kind: 'push' };
  const rows = (tickets || []).map((t) => ms(t.synced_at)).filter((x) => x != null);
  return rows.length ? { at: Math.max(...rows), kind: 'change' } : null;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(t, now = Date.now()) {
  if (t == null) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** The cockpit link that opens a ticket's card: its tab, scrolled to it. */
export function cockpitHref(stageKey, key) {
  const tab = STAGES.find((s) => s.key === stageKey)?.tab || 'merge';
  return `/administration/claims?tab=${tab}${key ? `&focus=${encodeURIComponent(key)}` : ''}`;
}
