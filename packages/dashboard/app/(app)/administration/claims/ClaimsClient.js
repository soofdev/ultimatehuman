'use client';

import { useMemo, useState } from 'react';
import { ChevronRightIcon, WrenchScrewdriverIcon } from '@heroicons/react/20/solid';

const JIRA_BROWSE = 'https://magifyfun.atlassian.net/browse/';

const FILTERS = [
  { key: 'open', label: 'Needs ruling' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'wrong', label: 'Wrong' },
  { key: 'all', label: 'All' },
];

const VERDICT_STYLE = {
  TRUE: { label: 'Pipeline: true', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  FALSE: { label: 'Pipeline: false', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  'FOR-RULING': { label: 'Pipeline: unsure', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
};

// Jira statuses the team treats as finished (FR + EN workflow names).
const DONE_STATUSES = new Set(['done', 'terminé', 'closed', 'resolved', 'validé sur test']);

const rulingOf = (c) => c.vincent_ruling?.status || null;
const claimNum = (c) => parseInt(c.claim_id.replace(/\D/g, ''), 10) || 0;

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Tickets merged from the cockpit collapse into the ticket that kept them.
function collapseTickets(tickets, mergedInto) {
  const out = new Map();
  (tickets || []).forEach((t) => {
    const into = mergedInto?.[t.key];
    const key = into || t.key;
    const row = out.get(key) || { key, status: into ? null : t.status, merged_from: [] };
    if (into) row.merged_from.push(t.key);
    else row.status = t.status;
    out.set(key, row);
  });
  return [...out.values()];
}

function TicketBadge({ ticket }) {
  const done = DONE_STATUSES.has((ticket.status || '').toLowerCase());
  return (
    <a
      href={JIRA_BROWSE + ticket.key}
      target="_blank"
      rel="noopener noreferrer"
      data-ticket={ticket.key}
      data-merged-from={ticket.merged_from?.length ? ticket.merged_from.join(',') : undefined}
      title={ticket.merged_from?.length ? `Merged from ${ticket.merged_from.join(', ')}` : undefined}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
        done
          ? 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'
          : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
      }`}
    >
      <span className="font-mono">{ticket.key}</span>
      {ticket.status && <span className={done ? 'text-gray-400' : 'text-indigo-500'}>· {ticket.status}</span>}
      {ticket.merged_from?.length > 0 && (
        <span className={done ? 'text-gray-400' : 'text-indigo-500'}>· merged from {ticket.merged_from.join(', ')}</span>
      )}
    </a>
  );
}

const hasContext = (ctx) => !!ctx && ['situation', 'quote', 'platform_truth', 'stakes'].some((k) => ctx[k]);

function ContextBlock({ label, children }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500">{label}</h3>
      <p className="mt-1 whitespace-pre-line">{children}</p>
    </div>
  );
}

// The radar's case for the claim: who asked what, what MAX said, what the
// platform does, and what a ruling settles. Lines can carry long code paths,
// so text wraps anywhere rather than widening the card on a phone.
function ClaimContext({ id, context }) {
  return (
    <div
      id={id}
      data-claim-context
      className="mt-3 space-y-3.5 rounded-lg bg-gray-50 px-3 py-3 text-sm leading-relaxed text-gray-700 [overflow-wrap:anywhere] sm:px-4"
    >
      {context.situation && <ContextBlock label="Situation">{context.situation}</ContextBlock>}
      {context.quote && (
        <blockquote className="border-l-2 border-indigo-300 pl-3 text-[15px] italic text-gray-900">
          &ldquo;{context.quote}&rdquo;
        </blockquote>
      )}
      {context.platform_truth && (
        <ContextBlock label="What the platform really does">{context.platform_truth}</ContextBlock>
      )}
      {context.stakes && <ContextBlock label="What your ruling decides">{context.stakes}</ContextBlock>}
    </div>
  );
}

// A true claim Vincent wants turned into a capability: his words are the spec
// of the feature ticket the next sync files.
function BuildRequest({ request, mergedInto }) {
  return (
    <div data-build-request className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="inline-flex items-center gap-1.5 font-medium">
          <WrenchScrewdriverIcon className="h-4 w-4 text-amber-600" aria-hidden />
          Build requested
          <span className="font-normal opacity-70">· {formatDate(request.requested_at)}</span>
        </p>
        {request.ticket?.key
          ? <TicketBadge ticket={collapseTickets([request.ticket], mergedInto)[0]} />
          : <span className="text-xs text-amber-800/80">Ticket filed on the next sync</span>}
      </div>
      <p className="mt-1.5 whitespace-pre-line [overflow-wrap:anywhere]">{request.text}</p>
    </div>
  );
}

function BuildButton({ disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50"
    >
      <WrenchScrewdriverIcon className="h-4 w-4 text-amber-600" aria-hidden />
      Build this
    </button>
  );
}

function ClaimCard({ claim, onRule, onBuild, mergedInto }) {
  const ruling = rulingOf(claim);
  const buildRequest = claim.build_request?.requested_at ? claim.build_request : null;
  const canBuild = !buildRequest && ruling !== 'wrong';
  const [mode, setMode] = useState('idle'); // idle | correcting | editing | building
  const [correction, setCorrection] = useState(claim.vincent_ruling?.correction || '');
  const [buildText, setBuildText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showDetails = hasContext(claim.context);
  const contextId = `context-${claim.claim_id}`;
  const verdict = VERDICT_STYLE[claim.verdict] || VERDICT_STYLE['FOR-RULING'];
  const showActions = !ruling || mode === 'editing';

  const save = async (status) => {
    if (status === 'wrong' && !correction.trim()) {
      setError('Write what is actually true before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRule(claim.claim_id, status, status === 'wrong' ? correction.trim() : '');
      setMode('idle');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const requestBuild = async () => {
    if (!buildText.trim()) {
      setError('Describe what should exist before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onBuild(claim.claim_id, buildText.trim());
      setMode('idle');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const ringCls = ruling === 'wrong'
    ? 'border-red-200'
    : ruling === 'confirmed' ? 'border-emerald-200' : 'border-gray-200';

  return (
    <article
      data-claim={claim.claim_id}
      className={`rounded-xl border bg-white p-4 shadow-sm sm:p-5 ${ringCls}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <span className="font-mono font-semibold text-gray-500">{claim.claim_id}</span>
        <span className="text-gray-300" aria-hidden>·</span>
        <span className="font-medium text-gray-700">{claim.topic}</span>
        <span className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${verdict.cls}`}>
          {verdict.label}
        </span>
      </div>

      <p className="mt-3 text-[15px] leading-relaxed text-gray-900">{claim.canonical_claim}</p>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">
          Said {claim.occurrences} {claim.occurrences === 1 ? 'time' : 'times'}
          {claim.first_seen ? ` · first on ${formatDate(claim.first_seen)}` : ''}
        </p>
        {showDetails && (
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={contextId}
            onClick={() => setDetailsOpen((v) => !v)}
            className="-my-2 inline-flex shrink-0 items-center gap-0.5 rounded-md py-2 pl-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Details
            <ChevronRightIcon className={`h-4 w-4 transition-transform ${detailsOpen ? 'rotate-90' : ''}`} aria-hidden />
          </button>
        )}
      </div>

      {showDetails && detailsOpen && <ClaimContext id={contextId} context={claim.context} />}

      {claim.tickets?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {collapseTickets(claim.tickets, mergedInto).map((t) => <TicketBadge key={t.key} ticket={t} />)}
        </div>
      )}

      {ruling && mode !== 'editing' && (
        <div
          className={`mt-4 rounded-lg px-3 py-2.5 text-sm ${
            ruling === 'wrong' ? 'bg-red-50 text-red-900' : 'bg-emerald-50 text-emerald-900'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {ruling === 'wrong' ? 'You marked this wrong' : 'You confirmed this'}
              <span className="font-normal opacity-70"> · {formatDate(claim.vincent_ruling?.ruled_at)}</span>
            </p>
            {!buildRequest && (
              <button
                type="button"
                onClick={() => { setMode('editing'); setError(null); }}
                className="shrink-0 text-xs font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
              >
                Change
              </button>
            )}
          </div>
          {ruling === 'wrong' && claim.vincent_ruling?.correction && (
            <p className="mt-1.5 whitespace-pre-line">{claim.vincent_ruling.correction}</p>
          )}
        </div>
      )}

      {buildRequest && <BuildRequest request={buildRequest} mergedInto={mergedInto} />}

      {ruling === 'confirmed' && canBuild && mode === 'idle' && (
        <div className="mt-3">
          <BuildButton onClick={() => { setMode('building'); setError(null); }} />
        </div>
      )}

      {showActions && mode !== 'correcting' && mode !== 'building' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => save('confirmed')}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => { setMode('correcting'); setError(null); }}
            className="inline-flex min-h-[40px] items-center rounded-lg border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
          >
            Wrong
          </button>
          {!ruling && canBuild && (
            <BuildButton disabled={saving} onClick={() => { setMode('building'); setError(null); }} />
          )}
          {mode === 'editing' && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => save(null)}
                className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800"
              >
                Clear ruling
              </button>
              <button
                type="button"
                onClick={() => setMode('idle')}
                className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {mode === 'correcting' && (
        <div className="mt-4">
          <label htmlFor={`correction-${claim.claim_id}`} className="block text-sm font-medium text-gray-800">
            What is actually true?
          </label>
          <p className="mt-0.5 text-xs text-gray-500">
            MAX will be corrected to say this. A fix ticket is filed on the next sync.
          </p>
          <textarea
            id={`correction-${claim.claim_id}`}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            rows={4}
            required
            autoFocus
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="The correct fact, worded the way MAX should say it."
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving || !correction.trim()}
              onClick={() => save('wrong')}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save correction'}
            </button>
            <button
              type="button"
              onClick={() => { setMode(ruling ? 'editing' : 'idle'); setError(null); }}
              className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'building' && (
        <div className="mt-4">
          <label htmlFor={`build-${claim.claim_id}`} className="block text-sm font-medium text-gray-800">
            What should exist instead?
          </label>
          <p className="mt-0.5 text-xs text-gray-500">
            Your words become the spec of a feature ticket, filed on the next sync.
            {!ruling && ' Saving also confirms this claim.'}
          </p>
          <textarea
            id={`build-${claim.claim_id}`}
            value={buildText}
            onChange={(e) => setBuildText(e.target.value)}
            rows={4}
            required
            autoFocus
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            placeholder="The capability, described the way it should work for a creator."
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving || !buildText.trim()}
              onClick={requestBuild}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Request build'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('idle'); setError(null); }}
              className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}
    </article>
  );
}

/**
 * Vincent's ruling page for MAX platform claims. Filtering and search are
 * client-side (the ledger is small); a ruling PATCHes one claim and updates
 * it in place. `embedded` renders it as the cockpit's Claims tab (no page
 * frame or title).
 */
export default function ClaimsClient({ initialClaims, embedded = false, mergedInto = {} }) {
  const [claims, setClaims] = useState(initialClaims || []);
  const [filter, setFilter] = useState('open');
  const [query, setQuery] = useState('');
  // Claims ruled since the filter last changed stay on screen, so the card
  // shows its new state instead of vanishing from "Needs ruling".
  const [justRuled, setJustRuled] = useState(() => new Set());

  const changeFilter = (key) => { setFilter(key); setJustRuled(new Set()); };

  const counts = useMemo(() => ({
    open: claims.filter((c) => !rulingOf(c)).length,
    confirmed: claims.filter((c) => rulingOf(c) === 'confirmed').length,
    wrong: claims.filter((c) => rulingOf(c) === 'wrong').length,
    all: claims.length,
  }), [claims]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return claims
      .filter((c) => {
        const r = rulingOf(c);
        if (filter === 'open' && r && !justRuled.has(c.claim_id)) return false;
        if (filter === 'confirmed' && r !== 'confirmed') return false;
        if (filter === 'wrong' && r !== 'wrong') return false;
        if (!q) return true;
        return [c.claim_id, c.topic, c.canonical_claim, c.vincent_ruling?.correction, c.build_request?.text,
          c.build_request?.ticket?.key, ...(c.tickets || []).map((t) => t.key)]
          .some((s) => s && s.toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const settled = (c) => !!rulingOf(c) && !justRuled.has(c.claim_id);
        return (settled(a) - settled(b)) || claimNum(b) - claimNum(a);
      });
  }, [claims, filter, query, justRuled]);

  const save = async (url, body) => {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Could not save (${res.status})`);
    setClaims((prev) => prev.map((c) => (c.claim_id === body.claim_id ? data.claim : c)));
    setJustRuled((prev) => new Set(prev).add(body.claim_id));
  };
  const rule = (claimId, status, correction) => save('/api/admin/claims/ruling', { claim_id: claimId, status, correction });
  const requestBuild = (claimId, text) => save('/api/admin/claims/build-request', { claim_id: claimId, text });

  const body = (
    <>
        <div className="-mx-4 mt-5 bg-gray-50/95 px-4 pb-3 pt-2 backdrop-blur sm:-mx-8 sm:px-8 md:sticky md:top-0 md:z-10 xl:flex xl:items-center xl:gap-3">
          <div role="tablist" aria-label="Filter claims" className="grid grid-cols-4 gap-1 rounded-lg bg-gray-200/70 p-1 xl:w-[40rem] xl:shrink-0">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => changeFilter(f.key)}
                  className={`flex min-h-[44px] flex-col items-center justify-center whitespace-nowrap rounded-md px-1 text-[13px] font-medium leading-tight transition-colors sm:min-h-[36px] sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm ${
                    active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {f.label}
                  <span className={`tabular-nums text-xs ${active ? 'text-indigo-600' : 'text-gray-400'}`}>{counts[f.key]}</span>
                </button>
              );
            })}
          </div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search claims, topics, tickets"
            aria-label="Search claims"
            className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm xl:mt-0 xl:max-w-md text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className={`mt-2 grid grid-cols-1 items-start gap-3 ${embedded ? '2xl:grid-cols-2' : ''}`}>
          {visible.map((c) => <ClaimCard key={c.claim_id} claim={c} onRule={rule} onBuild={requestBuild} mergedInto={mergedInto} />)}
          {visible.length === 0 && (
            <p className="col-span-full rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">
              {claims.length === 0
                ? 'No claims yet. They arrive with the next pipeline sync.'
                : query
                  ? `Nothing matches "${query}".`
                  : filter === 'open' ? 'Every claim has a ruling.' : 'No claims here yet.'}
            </p>
          )}
        </div>
    </>
  );

  if (embedded) return body;
  return (
    <div className="min-h-full bg-gray-50">
      {/* pt-16 below md clears the admin sidebar's fixed menu button */}
      <div className="mx-auto max-w-3xl px-4 pb-8 pt-16 sm:px-8 md:pt-8">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">MAX claims</h1>
          <p className="mt-1 text-sm text-gray-600">
            Platform facts MAX told creators, with the pipeline&apos;s verdict. Your ruling is the truth MAX gets corrected to.
          </p>
        </header>
        {body}
      </div>
    </div>
  );
}
