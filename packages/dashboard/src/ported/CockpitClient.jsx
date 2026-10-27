// Ported from the private reference app's claims cockpit (CockpitClient.js +
// ClaimsClient.js, see PROVENANCE.md). The JSX structure and Tailwind classes
// are that page's; what changed is the data (radar findings, dropped drafts,
// passes and rulings from /api/cockpit, mapped below) and the words.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import { get, post } from '../api';
import { Markdown } from '../Markdown';

const TABS = [
  { key: 'new', label: 'New' },
  { key: 'ruled', label: 'Ruled' },
  { key: 'parked', label: 'Parked' },
  { key: 'dropped', label: 'Dropped drafts' },
];

// The claims page's ruling filter, as a filter on what an item is.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'high', label: 'Critical & high' },
  { key: 'low', label: 'Medium & low' },
  { key: 'drafts', label: 'Drafts' },
];

// Same pill looks as the claims page's pipeline verdicts.
const SEVERITY_STYLE = {
  critical: { label: 'Severity: critical', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  high: { label: 'Severity: high', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  medium: { label: 'Severity: medium', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
  low: { label: 'Severity: low', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
};
const DROPPED_STYLE = { label: 'Dropped by the radar', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25' };

const STAGE = {
  floor: 'Below the user floor',
  rank: 'Over the rank cap',
  root_cause: 'The agent declined it',
  gate: 'Failed the gate',
  adversarial: 'Broken in review',
  dedupe: 'Duplicate',
};
const KIND = { recording: 'Session replay', event_series: 'Event data', error_group: 'Error group', funnel: 'Funnel' };
const SOURCE = { posthog: 'PostHog' };

const PILL = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset';

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const plural = (n, w, p = `${w}s`) => `${(n ?? 0).toLocaleString('en-US')} ${n === 1 ? w : p}`;

// ---------------------------------------------------------------------------
// Mappers: one cockpit card from /api/cockpit -> the fields the claim card shows.

/** Finding or dropped draft, in the claim card's vocabulary. */
function toItem(card) {
  if (card.kind === 'finding') {
    const f = card.finding;
    const sources = [...new Set(f.evidence.map((e) => SOURCE[e.sourcePluginId] || e.sourcePluginId))];
    return {
      card,
      kind: 'finding',
      id: f.id,
      clusterId: card.clusterId,
      topic: [f.route || 'All pages', sources.join(' + '), f.confidence === 'confirmed' ? 'Confirmed' : 'Likely'],
      verdict: SEVERITY_STYLE[f.severity] || SEVERITY_STYLE.medium,
      severity: f.severity,
      text: f.title,
      meta: `${plural(f.impact.usersAffected ?? 0, 'person', 'people')} · ${plural(f.impact.occurrences, 'occurrence')}`
        + `${f.impact.firstSeen ? ` · first on ${formatDate(f.impact.firstSeen)}` : ''}`
        + `${f.impact.lastSeen ? ` · last ${formatWhen(f.impact.lastSeen)}` : ''}`,
      finding: f,
    };
  }
  const d = card.draft;
  return {
    card,
    kind: 'draft',
    id: card.clusterId,
    clusterId: card.clusterId,
    topic: [STAGE[d.stage] || d.stage, d.runLabel],
    verdict: DROPPED_STYLE,
    severity: null,
    text: card.title,
    meta: `${Number.isFinite(d.usersAffected) ? `${plural(d.usersAffected, 'person', 'people')} · ` : ''}`
      + `dropped ${formatWhen(d.at)}${d.timesDropped > 1 ? ` · in ${d.timesDropped} passes` : ''}`,
    draft: d,
  };
}

const searchable = (it) => [it.id, it.clusterId, it.text, ...it.topic, it.card.ruling?.reason, it.finding?.symptom,
  it.finding?.rootCause?.statement, it.finding?.route, it.draft?.reason];

// ---------------------------------------------------------------------------
// Card parts (claims page anatomy)

function ContextBlock({ label, children }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500">{label}</h3>
      <div className="mt-1 whitespace-pre-line">{children}</div>
    </div>
  );
}

/** The radar's case for the item: the claims page's context panel, with the finding's fields. */
function ItemContext({ id, item }) {
  const f = item.finding;
  if (!f) {
    const d = item.draft;
    return (
      <div id={id} data-claim-context className="mt-3 space-y-3.5 rounded-lg bg-gray-50 px-3 py-3 text-sm leading-relaxed text-gray-700 [overflow-wrap:anywhere] sm:px-4">
        <ContextBlock label="Why the radar dropped it">{d.reason}</ContextBlock>
        <ContextBlock label="What your ruling decides">
          Dismiss stops later passes from looking at it again. Not now parks it until a pass sees a new occurrence.
        </ContextBlock>
      </div>
    );
  }
  const ev = new Map(f.evidence.map((e) => [e.id, e]));
  return (
    <div id={id} data-claim-context className="mt-3 space-y-3.5 rounded-lg bg-gray-50 px-3 py-3 text-sm leading-relaxed text-gray-700 [overflow-wrap:anywhere] sm:px-4">
      <ContextBlock label="What people hit">{f.symptom}</ContextBlock>
      <blockquote className="border-l-2 border-indigo-300 pl-3 text-[15px] italic text-gray-900">
        {f.rootCause.statement}
      </blockquote>
      <ContextBlock label="How we know">
        <ol className="list-decimal space-y-1 whitespace-normal pl-5">
          {f.rootCause.reasoning.map((r, i) => (
            <li key={i}>
              {r.claim}
              {r.evidenceIds.map((eid) => (
                <a key={eid} href={ev.get(eid)?.url} target="_blank" rel="noopener noreferrer" className="ml-1 font-mono text-xs font-medium text-indigo-600 hover:text-indigo-800">
                  {eid}
                </a>
              ))}
            </li>
          ))}
        </ol>
      </ContextBlock>
      {f.rootCause.codePointers?.length > 0 && (
        <ContextBlock label={`In the code · ${plural(f.rootCause.codePointers.length, 'line')} re-checked against the repo`}>
          <ul className="mt-1.5 divide-y divide-gray-100 whitespace-normal rounded-md border border-gray-100 bg-white font-mono text-xs">
            {f.rootCause.codePointers.map((p, i) => (
              <li key={i} className="px-2.5 py-1.5">
                <div className="flex items-center gap-3">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 flex-1 items-center gap-1 truncate font-medium text-indigo-700 hover:text-indigo-900">
                      {p.path}:{p.line}
                      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-gray-700">{p.path}:{p.line}</span>
                  )}
                  {p.commit && <span className="shrink-0 text-gray-400">at {p.commit.slice(0, 7)}</span>}
                </div>
                {p.text && <pre className="mt-1 overflow-x-auto whitespace-pre text-gray-700">{p.text}</pre>}
                {p.why && <p className="mt-1 font-sans text-gray-500">{p.why}</p>}
              </li>
            ))}
          </ul>
        </ContextBlock>
      )}
      <ContextBlock label="Reproduction">
        {'steps' in f.reproduction ? (
          <ol className="list-decimal space-y-1 whitespace-normal pl-5">
            {f.reproduction.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        ) : `Not established: ${f.reproduction.notEstablished}`}
      </ContextBlock>
      {f.suggestedFix && <ContextBlock label="Suggested direction">{f.suggestedFix}</ContextBlock>}
      <ContextBlock label="Not established">
        {f.openQuestions.length ? (
          <ul className="list-disc space-y-1 whitespace-normal pl-5">
            {f.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        ) : 'Nothing open.'}
      </ContextBlock>
      {f.rootCause.ruledOut?.length > 0 && (
        <ContextBlock label="Ruled out">
          <ul className="list-disc space-y-1 whitespace-normal pl-5">
            {f.rootCause.ruledOut.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </ContextBlock>
      )}
      {f.review && (
        <ContextBlock label={`Adversarial review: ${f.review.verdict === 'holds' ? 'holds' : 'partly holds, corrected'}`}>
          {f.review.reasons[0]}
        </ContextBlock>
      )}
    </div>
  );
}

/** The claims page's ticket badge, as one evidence item (opens it in the source). */
function EvidenceBadge({ evidence }) {
  return (
    <a
      href={evidence.url}
      target="_blank"
      rel="noopener noreferrer"
      data-evidence={evidence.id}
      title={evidence.label || undefined}
      className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
    >
      <span className="font-mono">{evidence.id}</span>
      <span className="text-indigo-500">· {KIND[evidence.kind] || evidence.kind}</span>
    </a>
  );
}

const RULING_LOOK = {
  file: { box: 'bg-emerald-50 text-emerald-900', ring: 'border-emerald-200' },
  dismiss: { box: 'bg-red-50 text-red-900', ring: 'border-red-200' },
  park: { box: 'border border-amber-200 bg-amber-50 text-amber-950', ring: 'border-amber-200' },
};

function rulingHead(r) {
  if (r.ruling === 'file') return r.dryRun ? 'You filed this to GitHub (dry run)' : 'You filed this to GitHub';
  if (r.ruling === 'dismiss') return 'You dismissed this';
  return 'You parked this: not now';
}

function rulingEffect(r) {
  if (r.ruling === 'file') {
    return `${r.dryRun ? 'Nothing was sent: no GitHub token is connected. ' : ''}The radar tracks it for recurrence: it is re-investigated only if it happens again after this ruling.`;
  }
  if (r.ruling === 'dismiss') return 'Suppression rule: later passes skip it before any agent runs. It comes back only if twice as many people hit it.';
  return 'It stays parked until a pass sees a new occurrence after this ruling. Then it comes back on its own for a fresh look.';
}

/** The claims page's "Build this" button, as Not now. */
function ParkButton({ disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-action="park"
      title="Park it. It comes back when a pass sees a new occurrence after now."
      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50"
    >
      <PauseIcon className="h-4 w-4 text-amber-600" aria-hidden />
      Not now
    </button>
  );
}

/** Every event on the item, oldest first, behind the same toggle as the cockpit's Development section. */
function History({ items, id }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const last = items[items.length - 1];
  return (
    <section className="mt-4 border-t border-gray-100 pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-action="history"
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm font-medium text-gray-700 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <ChevronRightIcon className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        History
        <span className="ml-2 min-w-0 truncate font-normal text-gray-400">
          {plural(items.length, 'event')} · last: {last.label}
        </span>
      </button>
      {open && (
        <ol id={id} data-history className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-100 text-sm">
          {items.map((h, i) => (
            <li key={i} data-history-kind={h.kind} className="flex items-start gap-3 px-2.5 py-1.5">
              <span className={`mt-0.5 shrink-0 rounded-full px-1.5 text-[11px] font-medium ${h.by === 'you' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>
                {h.by === 'you' ? 'You' : 'Radar'}
              </span>
              <span className="min-w-0 flex-1 text-gray-700">
                {h.label}
                {h.reason && <span className="text-gray-500"> · “{h.reason}”</span>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-gray-400">{formatWhen(h.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * One finding or dropped draft, laid out as the claims page's claim card.
 * Rulings: File to GitHub (findings only, opens the issue preview), Dismiss
 * (needs a reason), Not now. A ruled card shows the ruling box with Change.
 */
function ItemCard({ item, onRule, onFile }) {
  const { card } = item;
  const r = card.ruling;
  const ruling = r?.ruling || null;
  const [mode, setMode] = useState('idle'); // idle | dismissing | editing
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const contextId = `context-${item.clusterId}`;
  const showActions = !ruling || mode === 'editing';
  const evidence = item.finding?.evidence || [];

  const save = async (status) => {
    if (status === 'dismiss' && !reason.trim()) {
      setError('Write one line on why, so the rule explains itself later.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRule(card.clusterId, status, status === 'dismiss' ? reason.trim() : '');
      setMode('idle');
      setReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const ringCls = ruling ? RULING_LOOK[ruling].ring : 'border-gray-200';
  const look = ruling ? RULING_LOOK[ruling] : null;

  return (
    <article
      data-claim={item.clusterId}
      data-finding={item.finding?.id}
      data-draft={item.kind === 'draft' ? item.clusterId : undefined}
      data-cluster={item.clusterId}
      className={`rounded-xl border bg-white p-4 shadow-sm sm:p-5 ${ringCls}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <span className="font-mono font-semibold text-gray-500">{item.id}</span>
        {item.topic.filter(Boolean).map((t) => (
          <span key={t} className="contents">
            <span className="text-gray-300" aria-hidden>·</span>
            <span className="font-medium text-gray-700">{t}</span>
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5">
          {card.resurfaced && (
            <span data-resurfaced title={card.resurfaced.note} className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
              Back: new evidence
            </span>
          )}
          {item.finding?.recurredFrom && (
            <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20">Recurred</span>
          )}
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${item.verdict.cls}`}>
            {item.verdict.label}
          </span>
        </span>
      </div>

      <p className="mt-3 text-[15px] leading-relaxed text-gray-900">{item.text}</p>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">{item.meta}</p>
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls={contextId}
          data-action="details"
          onClick={() => setDetailsOpen((v) => !v)}
          className="-my-2 inline-flex shrink-0 items-center gap-0.5 rounded-md py-2 pl-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {item.kind === 'draft' ? 'Why dropped' : 'Details'}
          <ChevronRightIcon className={`h-4 w-4 transition-transform ${detailsOpen ? 'rotate-90' : ''}`} aria-hidden />
        </button>
      </div>

      {detailsOpen && <ItemContext id={contextId} item={item} />}

      {evidence.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {evidence.map((e) => <EvidenceBadge key={e.id} evidence={e} />)}
        </div>
      )}

      {ruling && mode !== 'editing' && (
        <div data-ruling={ruling} className={`mt-4 rounded-lg px-3 py-2.5 text-sm ${look.box}`}>
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {rulingHead(r)}
              <span className="font-normal opacity-70"> · {formatDate(r.at)}</span>
            </p>
            <button
              type="button"
              data-action="change-ruling"
              onClick={() => { setMode('editing'); setError(null); }}
              className="shrink-0 text-xs font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
            >
              Change
            </button>
          </div>
          {r.reason && <p className="mt-1.5 whitespace-pre-line">{r.reason}</p>}
          <p className="mt-1.5 text-xs opacity-70">{rulingEffect(r)}</p>
        </div>
      )}

      {showActions && mode !== 'dismissing' && (
        <div data-rulings className="mt-4 flex flex-wrap items-center gap-2">
          {item.kind === 'finding' && ruling !== 'file' && (
            <button
              type="button"
              disabled={saving}
              data-action="file"
              onClick={() => onFile(item)}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              File to GitHub
            </button>
          )}
          {ruling !== 'dismiss' && (
            <button
              type="button"
              disabled={saving}
              data-action="dismiss"
              onClick={() => { setMode('dismissing'); setError(null); }}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
            >
              Dismiss
            </button>
          )}
          {ruling !== 'park' && <ParkButton disabled={saving} onClick={() => save('park')} />}
          {mode === 'editing' && (
            <>
              <button
                type="button"
                disabled={saving}
                data-action="clear-ruling"
                onClick={() => save('clear')}
                className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800"
              >
                Withdraw ruling
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

      {mode === 'dismissing' && (
        <div className="mt-4">
          <label htmlFor={`why-${item.clusterId}`} className="block text-sm font-medium text-gray-800">
            Why dismiss it?
          </label>
          <p className="mt-0.5 text-xs text-gray-500">
            Your reason is stored with the ruling and becomes a suppression rule: later passes skip this before any agent runs.
          </p>
          <textarea
            id={`why-${item.clusterId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && save('dismiss')}
            rows={4}
            maxLength={500}
            required
            autoFocus
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="One line, e.g. expected behaviour, already known, not worth a fix."
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving || !reason.trim()}
              data-action="confirm-dismiss"
              onClick={() => save('dismiss')}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Dismiss with this reason'}
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

      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}

      <History items={card.history} id={`history-${item.clusterId}`} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// File to GitHub: the issue preview, in the cockpit's dialog frame.

function IssueDialog({ preview, onClose, onDone }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await post(`/api/findings/${preview.finding.id}/file`));
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-title"
        data-issue-dialog
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="issue-title" className="text-base font-semibold text-gray-900">New issue in {preview.repo}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <XMarkIcon className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {result ? (
          <div data-file-result className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
            <p>
              <span className="font-semibold">{result.message}.</span> Nothing was sent to GitHub. Your ruling is saved on the card; connect a fine-grained token to file for real.
            </p>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-700">
            <p>
              <span className="font-semibold text-gray-900">Dry run.</span> This would create an issue in <span className="font-mono">{preview.repo}</span>. No GitHub token is connected, so nothing leaves this machine.
            </p>
          </div>
        )}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 px-4 py-3">
          <h3 className="text-lg font-semibold text-gray-900">{preview.issuePreview.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {preview.issuePreview.labels.map((l) => (
              <span key={l} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-200">{l}</span>
            ))}
            <span className="text-xs text-gray-400">rendered from the finding&apos;s structured fields</span>
          </div>
          <div className="mt-3 text-sm text-gray-800"><Markdown text={preview.issuePreview.body} /></div>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-100">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              data-action="confirm-file"
              onClick={confirm}
              disabled={busy}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {busy ? 'Filing…' : 'Create issue (dry run)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passes and decisions

/** A failed or parked pass that needs you: the cockpit's hold alert. */
function DecisionAlert({ d, onAction }) {
  const bad = d.tone === 'bad';
  return (
    <div
      data-decision={d.id}
      role="alert"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${bad ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-950'}`}
    >
      {bad
        ? <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
        : <PauseIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />}
      <p className="min-w-0 flex-1"><span className="font-semibold">{d.title}</span> {d.body}</p>
      {d.action && (
        <button type="button" onClick={() => onAction(d.action)} className="shrink-0 text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100">
          {d.action.label}
        </button>
      )}
    </div>
  );
}

const RUN_LOOK = {
  done: { label: 'Done', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  parked: { label: 'Parked', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
  running: { label: 'Running', cls: 'bg-amber-50 text-amber-800 ring-amber-600/25' },
};

/** One row per pass, in the Shipped list's frame; opens on its notes. */
function PassRow({ r, drafts, busy, onRerun, onOpenRun, onOpenDropped }) {
  const [open, setOpen] = useState(false);
  const phase = ['done', 'failed', 'parked'].includes(r.phase) ? r.phase : 'running';
  const facts = [
    r.phase === 'done' || r.phase === 'failed' ? plural(r.findings, 'finding') : null,
    r.dropped ? `${r.dropped} dropped` : null,
    r.suppressed ? `${r.suppressed} suppressed by ruling` : null,
    `$${r.costUsd.toFixed(2)}`,
  ].filter(Boolean);
  return (
    <li data-run={r.id} className="px-4 py-3 first:rounded-t-xl last:rounded-b-xl sm:px-5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full flex-col gap-1 text-left sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRightIcon className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${RUN_LOOK[phase].cls}`}>{RUN_LOOK[phase].label}</span>
          <p className="min-w-0 truncate text-sm font-medium text-gray-900">
            {r.label}
            <span className="font-normal text-gray-500"> · {facts.join(' · ')}</span>
          </p>
        </div>
        <p className="shrink-0 text-xs tabular-nums text-gray-500">{formatWhen(r.startedAt)}</p>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 pl-6 text-sm text-gray-700">
          {r.emptyReason && <p>{r.emptyReason}</p>}
          {r.notes.map((n) => <p key={n}>{n}</p>)}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
            <button type="button" onClick={() => onOpenRun(r.id)} className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:text-indigo-900">
              Phase timeline
              <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
            </button>
            {drafts > 0 && (
              <button type="button" onClick={onOpenDropped} className="text-indigo-700 hover:text-indigo-900">
                {plural(drafts, 'dropped draft')} in the Dropped tab
              </button>
            )}
            <button type="button" data-action="rerun" disabled={busy} onClick={() => onRerun(r.lookbackHours)} className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 disabled:opacity-50">
              <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden />
              Run this pass again
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Empty({ children, wide = false }) {
  return (
    <p className={`${wide ? 'col-span-full ' : ''}rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500`}>{children}</p>
  );
}

// ---------------------------------------------------------------------------

function tabFromUrl() {
  const t = new URLSearchParams(location.search).get('tab');
  return TABS.some((x) => x.key === t) ? t : 'new';
}

const passName = (run) => (run ? run.label.toLowerCase().replace(/^first pass \((.*)\)$/, '$1 pass') : 'pass');

/**
 * The cockpit: everything the radar waits on you for, on one page. Tabs: new
 * findings, what you ruled, what you parked, and the drafts the radar dropped.
 * The tab lives in ?tab= so a link opens the right one. A card you just ruled
 * stays in its tab until you change tabs, so a ruling never makes the page jump.
 */
export default function CockpitClient({ s }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(tabFromUrl);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  // Items ruled since the tab last changed stay on screen, so the card shows
  // its new state instead of vanishing from the tab.
  const [justRuled, setJustRuled] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const load = useCallback(async () => setData(await get('/api/cockpit')), []);

  useEffect(() => {
    void load();
  }, [load, s.findings, s.run?.phase, s.run?.findings, s.rev]);

  const go = (key) => {
    setTab(key);
    setFilter('all');
    setJustRuled(new Set());
    const u = new URL(location.href);
    if (key === 'new') u.searchParams.delete('tab');
    else u.searchParams.set('tab', key);
    history.replaceState(null, '', u);
  };

  const ruled = (clusterId) => {
    setJustRuled((prev) => new Set(prev).add(clusterId));
    void load();
    void s.refresh();
  };
  const rule = async (clusterId, ruling, reason) => {
    await post('/api/rulings', { clusterId, ruling, reason });
    ruled(clusterId);
  };
  const openFile = async (item) => setPreview(await get(`/api/findings/${item.finding.id}`));

  const lists = useMemo(() => {
    const cards = data?.cards ?? [];
    const kept = (c) => justRuled.has(c.clusterId);
    return {
      new: cards.filter((c) => c.kind === 'finding' && (!c.ruling || (kept(c) && tab === 'new'))),
      ruled: cards.filter((c) => (c.ruling && c.ruling.ruling !== 'park') || (kept(c) && tab === 'ruled')),
      parked: cards.filter((c) => c.ruling?.ruling === 'park' || (kept(c) && tab === 'parked')),
      dropped: cards.filter((c) => c.kind === 'draft' && (!c.ruling || (kept(c) && tab === 'dropped'))),
    };
  }, [data, justRuled, tab]);

  const inTab = useMemo(() => (lists[tab] || []).map(toItem), [lists, tab]);
  const filterCounts = useMemo(() => ({
    all: inTab.length,
    high: inTab.filter((it) => it.severity === 'critical' || it.severity === 'high').length,
    low: inTab.filter((it) => it.severity === 'medium' || it.severity === 'low').length,
    drafts: inTab.filter((it) => it.kind === 'draft').length,
  }), [inTab]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inTab.filter((it) => {
      if (filter === 'high' && !(it.severity === 'critical' || it.severity === 'high')) return false;
      if (filter === 'low' && !(it.severity === 'medium' || it.severity === 'low')) return false;
      if (filter === 'drafts' && it.kind !== 'draft') return false;
      if (!q) return true;
      return searchable(it).some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [inTab, filter, query]);

  if (!data) {
    return (
      <div className="min-h-full bg-gray-50">
        <div className="px-4 pb-10 pt-16 text-sm text-gray-500 sm:px-8 md:pt-8">Loading the cockpit…</div>
      </div>
    );
  }

  const counts = data.counts;
  const running = s.run && !['done', 'failed', 'parked'].includes(s.run.phase);
  const last = data.runs[0];
  const rerun = (hours) => void post('/api/runs', { trigger: 'run_now', lookbackHours: hours }).then(() => s.refresh());
  const onDecision = (a) => (a.do === 'retry' ? rerun(last?.lookbackHours ?? 24) : s.go(a.do === 'open_usage' ? 'usage' : 'runs'));
  const w = s.status?.window;
  const sources = s.status?.plugins?.filter((p) => p.configured && p.kind === 'source').map((p) => p.displayName).join(', ');

  const emptyText = {
    new: running
      ? 'A pass is running. Findings land here the moment one passes the gate and the adversarial review.'
      : last?.emptyReason && !counts.new ? `All caught up. ${last.emptyReason}` : 'Every finding has a ruling. New ones land here the moment they pass the gate and the adversarial review.',
    ruled: 'Nothing ruled yet. Filed and dismissed items land here with your reason and date, and the rule each one created.',
    parked: 'Nothing parked. Not now puts an item here until new evidence arrives.',
    dropped: 'No dropped drafts without a ruling.',
  }[tab];

  return (
    <div className="min-h-full bg-gray-50">
      <div className="px-4 pb-10 pt-16 sm:px-8 md:pt-8">
        <header>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Cockpit</h1>
            <div className="flex shrink-0 items-center gap-2">
              {w && (
                <button
                  type="button"
                  data-window
                  onClick={() => s.go('usage')}
                  title="Live reading from the Claude CLI rate_limit_event"
                  className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  <span className={`h-2 w-2 rounded-full ${w.usedPct === null || w.usedPct >= 100 - w.humanReservePct ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden />
                  {w.usedPct === null ? 'Window usage unavailable' : `Window ${Math.round(w.usedPct)}% used`}
                </button>
              )}
              <button
                type="button"
                data-action="run-now"
                disabled={!!running}
                onClick={() => rerun(last?.lookbackHours ?? 24)}
                className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60"
              >
                <ArrowPathIcon className={`h-4 w-4 text-gray-400 ${running ? 'animate-spin' : ''}`} aria-hidden />
                {running ? 'Pass running' : `Run the ${passName(last)}`}
              </button>
            </div>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            What the radar needs from you{sources ? ` (reading ${sources})` : ''}: findings to file or dismiss, drafts it dropped, items you parked. Every ruling is stored and overrides later passes.
          </p>
        </header>

        {/* the filing note carries its own border so the tab underline still overlaps the nav border */}
        <div className="mt-5 flex">
          <nav role="tablist" aria-label="Cockpit" className="flex min-w-0 flex-1 gap-1 overflow-x-auto border-b border-gray-200">
            {TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-tab={t.key}
                  onClick={() => go(t.key)}
                  className={`-mb-px inline-flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors ${
                    active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {t.label}
                  {counts[t.key] > 0 && (
                    <span className={`rounded-full px-1.5 text-xs tabular-nums ${active ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-600'}`}>
                      {counts[t.key]}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          {data.output?.dryRun && (
            <div
              className="hidden shrink-0 items-center gap-2 border-b border-gray-200 pb-1.5 pl-3 sm:flex"
              title="No GitHub token is connected: File to GitHub records your ruling and shows the exact issue, nothing is sent."
            >
              <span className="text-xs text-gray-500">Filing: dry run{data.output.repo ? ` · ${data.output.repo}` : ''}</span>
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="-mx-4 mt-5 bg-gray-50/95 px-4 pb-3 pt-2 backdrop-blur sm:-mx-8 sm:px-8 md:sticky md:top-0 md:z-10 xl:flex xl:items-center xl:gap-3">
            <div role="tablist" aria-label="Filter items" className="grid grid-cols-4 gap-1 rounded-lg bg-gray-200/70 p-1 xl:w-[40rem] xl:shrink-0">
              {FILTERS.map((f) => {
                const active = filter === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-filter={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`flex min-h-[44px] flex-col items-center justify-center whitespace-nowrap rounded-md px-1 text-[13px] font-medium leading-tight transition-colors sm:min-h-[36px] sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm ${
                      active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {f.label}
                    <span className={`tabular-nums text-xs ${active ? 'text-indigo-600' : 'text-gray-400'}`}>{filterCounts[f.key]}</span>
                  </button>
                );
              })}
            </div>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search findings, pages, reasons"
              aria-label="Search findings"
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm xl:mt-0 xl:max-w-md text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {tab === 'new' && data.decisions.length > 0 && (
            <div className="mt-2 space-y-2">
              {data.decisions.map((d) => <DecisionAlert key={d.id} d={d} onAction={onDecision} />)}
            </div>
          )}
          {tab === 'parked' && lists.parked.length > 0 && (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700">
              <PauseIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
              Parked items are checked on every pass. One comes back on its own, re-investigated, the first time a pass sees an occurrence after you parked it.
            </p>
          )}

          <div className="mt-2 grid grid-cols-1 items-start gap-3 2xl:grid-cols-2">
            {visible.map((it) => <ItemCard key={it.clusterId} item={it} onRule={rule} onFile={openFile} />)}
            {visible.length === 0 && (
              <Empty wide>
                {inTab.length === 0 ? emptyText : query ? `Nothing matches "${query}".` : 'Nothing here for this filter.'}
              </Empty>
            )}
          </div>

          {tab === 'new' && counts.dropped > 0 && (
            <p className="mt-3 text-sm text-gray-600">
              <button type="button" data-action="open-dropped" onClick={() => go('dropped')} className="font-medium text-indigo-700 hover:text-indigo-900">
                {plural(counts.dropped, 'draft')} the radar dropped
              </button>
              , each with the reason it was dropped. Rule on any of them so later passes skip it.
            </p>
          )}

          {tab === 'new' && data.runs.length > 0 && (
            <section data-passes aria-label="Recent passes" className="mt-8">
              <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Recent passes <span className="normal-case tracking-normal">· open one for its notes</span>
              </h2>
              <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
                {data.runs.map((r) => (
                  <PassRow
                    key={r.id}
                    r={r}
                    busy={!!running}
                    drafts={data.cards.filter((c) => c.kind === 'draft' && c.draft.runId === r.id && !c.ruling).length}
                    onRerun={rerun}
                    onOpenRun={(id) => s.go('runs', id)}
                    onOpenDropped={() => go('dropped')}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {preview && createPortal(
        <IssueDialog preview={preview} onClose={() => setPreview(null)} onDone={() => ruled(preview.finding.clusterId)} />,
        document.body,
      )}
    </div>
  );
}
