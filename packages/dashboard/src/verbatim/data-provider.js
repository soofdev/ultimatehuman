// The ONE data-provider module of the vendored cockpit (app/): it maps the
// engine's /api/cockpit feed into the exact shapes the reference page already
// consumes, and answers the page's own /api/admin/* calls with engine calls.
// Nothing in app/ knows the engine exists.
//
// Mapping (see REPORT.md for what stays unmapped):
//   finding        -> claim, verdict TRUE  ("Pipeline: true")
//   dropped draft  -> claim, verdict FALSE ("Pipeline: false")
//   Confirm        -> POST /api/findings/:id/file (dry run while no GitHub token)
//   Wrong          -> POST /api/rulings dismiss, the correction is the reason
//   Build this     -> POST /api/rulings park, the request text is the reason
//   Clear ruling   -> POST /api/rulings clear
//   tickets (all tabs but Claims), bundles -> none: the engine has no tickets.

let csrf = '';
let feed = null;
const idOf = new Map(); // clusterId -> claim_id, stable for the page's life
const cardOf = new Map(); // claim_id -> cockpit card

const realFetch = window.fetch.bind(window);

class EngineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function engine(path, body) {
  const res = await realFetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-uh-csrf': csrf }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new EngineError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

const firstAt = (card) => card.history?.[0]?.at || card.finding?.createdAt || card.draft?.at || '';

function toClaim(card, claimId) {
  const f = card.finding;
  const d = card.draft;
  const r = card.ruling;
  return {
    claim_id: claimId,
    topic: f ? `Finding · ${f.severity} severity` : `Dropped draft · ${d.runLabel}`,
    canonical_claim: card.title,
    occurrences: f ? f.impact?.occurrences ?? 1 : d.timesDropped ?? 1,
    first_seen: f ? f.impact?.firstSeen : firstAt(card),
    verdict: f ? 'TRUE' : 'FALSE',
    context: {
      situation: f ? f.symptom : d.reason,
      quote: null,
      platform_truth: f ? f.rootCause?.statement ?? null : null,
      stakes: null,
    },
    tickets: [],
    vincent_ruling: r?.ruling === 'file'
      ? { status: 'confirmed', correction: '', ruled_at: r.at }
      : r?.ruling === 'dismiss' ? { status: 'wrong', correction: r.reason || '', ruled_at: r.at } : null,
    build_request: r?.ruling === 'park' ? { requested_at: r.at, text: r.reason || '' } : null,
  };
}

async function refresh() {
  feed = await engine('/api/cockpit');
  const cards = [...feed.cards].sort((a, b) => firstAt(a).localeCompare(firstAt(b)));
  for (const c of cards) if (!idOf.has(c.clusterId)) idOf.set(c.clusterId, `C-${idOf.size + 1}`);
  cardOf.clear();
  for (const c of cards) cardOf.set(idOf.get(c.clusterId), c);
}

const claims = () => [...cardOf].map(([id, c]) => toClaim(c, id));

/** Signs the page in (CSRF from /api/status) and loads the feed; a lapsed session goes back to the engine's login screen. */
export async function init() {
  try {
    csrf = (await engine('/api/status')).csrf;
    await refresh();
  } catch (e) {
    if (e instanceof EngineError && e.status === 401) window.location.replace('/');
    throw e;
  }
}

const lean = (value) => ({ lean: async () => value() });

// Stand-ins for the reference page's Mongoose models (page.js reads them server-side).
export const PlatformClaim = { find: () => lean(claims) };
export const PipelineTicket = { find: () => lean(() => []) };
export const PipelineBundles = { findOne: () => lean(() => null) };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function ruling({ claim_id: claimId, status, correction }) {
  const card = cardOf.get(claimId);
  if (!card) return json(404, { error: 'Unknown claim' });
  if (status === 'confirmed') {
    if (!card.finding) return json(400, { error: 'The radar dropped this draft: there is no issue to file. Rule it Wrong or Build this.' });
    await engine(`/api/findings/${encodeURIComponent(card.finding.id)}/file`, {});
  } else if (status === 'wrong') {
    await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'dismiss', reason: correction });
  } else {
    await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'clear' });
  }
  await refresh();
  return json(200, { claim: toClaim(cardOf.get(claimId), claimId) });
}

async function buildRequest({ claim_id: claimId, text }) {
  const card = cardOf.get(claimId);
  if (!card) return json(404, { error: 'Unknown claim' });
  await engine('/api/rulings', { clusterId: card.clusterId, ruling: 'park', reason: text });
  await refresh();
  return json(200, { claim: toClaim(cardOf.get(claimId), claimId) });
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/admin/')) return realFetch(input, init);
  const path = url.split('?')[0];
  try {
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/api/admin/claims/ruling') return await ruling(body);
    if (path === '/api/admin/claims/build-request') return await buildRequest(body);
    return json(404, { error: 'Not available in this radar' });
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};
