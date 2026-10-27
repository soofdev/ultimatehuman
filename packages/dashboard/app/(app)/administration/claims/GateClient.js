'use client';

import PlanModal, { PlanEntry, planThreadState } from './PlanModal';
import { usePhoneLayout } from './MobileCockpit';
import { PhoneGate } from './PhoneTickets';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ArrowsPointingInIcon,
  BeakerIcon,
  BoltIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  ScaleIcon,
} from '@heroicons/react/20/solid';
import { DISMISS_NOTE_MAX, MERGE_MAX, mergeSavings, mergeable } from '@/app/lib/pipeline-gate';
import { sortTickets, visibleBundles } from '@/app/lib/pipeline-cockpit';
import { StrategyBlock } from './PlanTesting';
import SuggestedBundles from './SuggestedBundles';
import { TicketDates } from './TicketSort';

const JIRA_BROWSE = 'https://magifyfun.atlassian.net/browse/';
const DISMISSED_DAYS = 7;
const ticketNum = (key) => parseInt(String(key).split('-')[1], 10) || 0;
const byKey = (a, b) => ticketNum(a.key) - ticketNum(b.key);
const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const squash = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function formatWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDay(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function KeyBadge({ ticketKey }) {
  return (
    <a
      href={JIRA_BROWSE + ticketKey}
      target="_blank"
      rel="noopener noreferrer"
      data-jira-key={ticketKey}
      className="shrink-0 whitespace-nowrap rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-gray-500 hover:border-gray-300 hover:text-gray-800"
    >
      {ticketKey}
    </a>
  );
}

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset';

function Chip({ kind, icon: Icon, children, title }) {
  const cls = {
    max: 'bg-amber-50 text-amber-800 ring-amber-300',
    nomax: 'bg-gray-50 text-gray-600 ring-gray-200',
    source: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    merged: 'bg-violet-50 text-violet-700 ring-violet-200',
    later: 'bg-sky-50 text-sky-700 ring-sky-200',
    plan: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  }[kind];
  return (
    <span data-chip={kind} title={title} className={`${CHIP} ${cls}`}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      {children}
    </span>
  );
}

function SourceChips({ ticket }) {
  const claims = ticket.claim_ids || [];
  const n = ticket.merge?.blocks?.length || 0;
  return (
    <>
      {ticket.max_related
        ? <Chip kind="max" icon={BoltIcon} title="Fixing and checking it runs MAX conversations">Uses MAX</Chip>
        : <Chip kind="nomax" title="No MAX conversation to fix or check it">No MAX cost</Chip>}
      {n > 1 && <Chip kind="merged" icon={ArrowsPointingInIcon}>Merged · {n} problems</Chip>}
      {claims.slice(0, 3).map((c) => <Chip key={c} kind="source" icon={ScaleIcon}>Claim {c}</Chip>)}
      {!claims.length && n < 2 && <Chip kind="source" icon={MagnifyingGlassIcon}>Found by the radar</Chip>}
    </>
  );
}

function Row({ label, children }) {
  if (!children) return null;
  return (
    <div className="grid gap-0.5 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-400 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-[15px] leading-relaxed text-gray-900 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function EvidenceLinks({ links }) {
  if (!links?.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {links.map((l, i) => (
        <a key={l} href={l} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:text-indigo-900">
          Evidence {i + 1}
        </a>
      ))}
    </span>
  );
}

/** Why the ticket exists: the claim and his ruling or request, else the radar's evidence. */
function WhyItExists({ ticket, claimsById }) {
  const claims = (ticket.claim_ids || []).map((id) => claimsById.get(id) || { claim_id: id });
  if (!claims.length) {
    return (
      <>
        The radar found this problem in real conversations.
        <EvidenceLinks links={ticket.links} />
      </>
    );
  }
  return (
    <span className="block space-y-2">
      {claims.map((c) => (
        <span key={c.claim_id} data-why-claim={c.claim_id} className="block">
          {c.canonical_claim && !squash(ticket.excerpt).includes(squash(c.canonical_claim))
            ? <>MAX said: &ldquo;{c.canonical_claim}&rdquo; (claim {c.claim_id})</>
            : <>From claim {c.claim_id}.</>}
          {c.vincent_ruling?.status === 'wrong' && (
            <span className="block text-gray-600">
              You ruled it wrong{c.vincent_ruling.correction ? `: ${c.vincent_ruling.correction}` : '.'}
            </span>
          )}
          {c.build_request?.text && <span className="block text-gray-600">You asked for: {c.build_request.text}</span>}
        </span>
      ))}
      <EvidenceLinks links={ticket.links} />
    </span>
  );
}

function CostLine({ maxRelated }) {
  return maxRelated ? (
    <span data-cost="max">
      <span className="font-semibold">Uses MAX: yes.</span> Fixing it and checking the fix run real MAX conversations.
      That is what costs money, so it waits for you.
    </span>
  ) : (
    <span data-cost="none"><span className="font-semibold">Uses MAX: no.</span> It goes to the fix queue on its own.</span>
  );
}

function MergedProblems({ ticket, claimsById }) {
  const blocks = ticket.merge?.blocks || [];
  if (blocks.length < 2) return null;
  return (
    <ol data-merged-blocks className="mt-1 space-y-2">
      {blocks.map((b, i) => (
        <li key={b.key} data-block={b.key} className="flex gap-2.5">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[11px] font-bold text-violet-700">
            {i + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] text-gray-900">{b.title || b.key}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
              <KeyBadge ticketKey={b.key} />
              {b.key === ticket.key ? 'this ticket' : 'closed as superseded'}
              {(b.claim_ids || []).map((c) => {
                const claim = claimsById.get(c);
                return <span key={c} title={claim?.canonical_claim || ''}>· claim {c}</span>;
              })}
              {b.max_related && <span className="text-amber-700">· uses MAX</span>}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
  return data;
}

function useEscape(onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
}

function DismissDialog({ ticket, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEscape(onClose, busy);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post('/api/admin/pipeline/gate', { key: ticket.key, action: 'dismiss', note });
      onDone(data.ticket);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`dismiss-title-${ticket.key}`}
        data-dismiss-dialog={ticket.key}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
      >
        <h2 id={`dismiss-title-${ticket.key}`} className="text-base font-semibold text-gray-900">Dismiss {ticket.key}?</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-700">
          The ticket closes on Jira as declined. It is not fixed, and it costs nothing.
        </p>
        <label htmlFor={`dismiss-note-${ticket.key}`} className="mt-4 block text-sm font-medium text-gray-800">Why?</label>
        <textarea
          id={`dismiss-note-${ticket.key}`}
          data-dismiss-note
          autoFocus
          rows={3}
          maxLength={DISMISS_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: not worth a MAX test round, the creator found a way around it."
          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
        />
        <p className="mt-1 text-right text-xs tabular-nums text-gray-400">{note.length}/{DISMISS_NOTE_MAX}</p>
        {error && <p role="alert" className="mt-1 text-sm text-red-700">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-100">
            Keep it
          </button>
          <button
            type="button"
            data-dismiss-confirm
            onClick={confirm}
            disabled={busy || !note.trim()}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Dismissing…' : 'Dismiss ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Jira trouble after a gate choice or a merge: what failed, and a Retry. */
function JiraProblem({ ticket, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mergeError = ticket.merge && !ticket.merge.done_at ? ticket.merge.error : null;
  const gateError = !ticket.gate_jira_at && ['validated', 'dismissed'].includes(ticket.gate) ? ticket.gate_jira_error : null;
  if (!mergeError && !gateError) return null;
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = mergeError
        ? await post('/api/admin/pipeline/merge-tickets', { retry: ticket.key })
        : await post('/api/admin/pipeline/gate', { key: ticket.key, action: 'retry' });
      onUpdate(data.ticket);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alert" data-jira-problem={mergeError ? 'merge' : 'gate'} className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold">{mergeError ? 'The merge is not finished on Jira.' : 'Jira was not updated.'}</span>{' '}
        {mergeError || gateError}
        {error && <span className="block">{error}</span>}
      </p>
      <button
        type="button"
        data-retry
        onClick={retry}
        disabled={busy}
        className="inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-semibold text-red-800 ring-1 ring-inset ring-red-300 hover:bg-red-100 disabled:opacity-50"
      >
        <ArrowPathIcon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

function SelectBox({ ticket, selected, onToggle, disabled }) {
  if (!mergeable(ticket)) return null;
  return (
    <label className="-m-2 flex shrink-0 cursor-pointer items-center p-2" title="Select to merge">
      <input
        type="checkbox"
        data-select={ticket.key}
        checked={selected}
        disabled={disabled && !selected}
        onChange={() => onToggle(ticket.key)}
        aria-label={`Select ${ticket.key} to merge`}
        className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900 disabled:opacity-40"
      />
    </label>
  );
}

function GateCard({ ticket, claimsById, selected, onToggle, selectionFull, onUpdate, planHost, inPlanOf, onOpenPlan, planShown }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dismissing, setDismissing] = useState(false);
  const closeDismiss = useCallback(() => setDismissing(false), []);
  const later = ticket.gate === 'later';
  const merging = !!(ticket.merge && !ticket.merge.done_at);
  const blocks = ticket.merge?.blocks?.length || 0;

  const act = async (action) => {
    setBusy(action);
    setError(null);
    try {
      const data = await post('/api/admin/pipeline/gate', { key: ticket.key, action });
      onUpdate(data.ticket);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      data-gate-card={ticket.key}
      data-gate={ticket.gate}
      className={`rounded-xl border bg-white p-4 shadow-sm sm:p-6 ${selected ? 'border-gray-900 ring-1 ring-gray-900' : 'border-gray-200'}`}
    >
      <div className="flex items-start gap-3">
        <SelectBox ticket={ticket} selected={selected} onToggle={onToggle} disabled={selectionFull} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <KeyBadge ticketKey={ticket.key} />
            <SourceChips ticket={ticket} />
            {later && <Chip kind="later" icon={ClockIcon}>Later · since {formatDay(ticket.gate_at)}</Chip>}
            {inPlanOf && <Chip kind="plan" icon={BeakerIcon} title="This ticket is in an open Plan testing thread">In the test plan on {inPlanOf}</Chip>}
            <TicketDates ticket={ticket} />
          </div>
          <h3 className="mt-2 text-base font-semibold leading-snug text-gray-900">{ticket.title || ticket.key}</h3>
        </div>
      </div>

      <dl className="mt-4 space-y-3">
        {blocks > 1
          ? <Row label={`${blocks} problems`}><MergedProblems ticket={ticket} claimsById={claimsById} /></Row>
          : <Row label="What is wrong">{sentence(ticket.plain?.problem || ticket.excerpt)}</Row>}
        {blocks < 2 && <Row label="Why it exists"><WhyItExists ticket={ticket} claimsById={claimsById} /></Row>}
        <Row label="Cost"><CostLine maxRelated={ticket.max_related} /></Row>
        {blocks > 1 && (
          <Row label="Saved">
            <span data-merge-saved>{mergeSavings(blocks)}</span>
          </Row>
        )}
      </dl>

      <StrategyBlock strategy={ticket.plan?.strategy} />

      <JiraProblem ticket={ticket} onUpdate={onUpdate} />

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
        <button
          type="button"
          data-gate-action="validate"
          onClick={() => act('validate')}
          disabled={!!busy || merging}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckIcon className="h-4 w-4" aria-hidden />
          {busy === 'validate' ? 'Validating…' : 'Validate'}
        </button>
        {later ? (
          <button
            type="button"
            data-gate-action="back"
            onClick={() => act('back')}
            disabled={!!busy}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            <ArrowUturnLeftIcon className="h-4 w-4 text-gray-400" aria-hidden />
            {busy === 'back' ? 'Moving…' : 'Back to waiting'}
          </button>
        ) : (
          <button
            type="button"
            data-gate-action="later"
            onClick={() => act('later')}
            disabled={!!busy}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            <ClockIcon className="h-4 w-4 text-gray-400" aria-hidden />
            {busy === 'later' ? 'Moving…' : 'Later'}
          </button>
        )}
        <button
          type="button"
          data-gate-action="dismiss"
          onClick={() => setDismissing(true)}
          disabled={!!busy || merging}
          className="ml-auto inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50 hover:text-red-800 disabled:opacity-50"
        >
          Dismiss
        </button>
        {later && (
          <p className="basis-full text-xs text-gray-500">Parked: it stays out of the fix queue and costs nothing until you validate it.</p>
        )}
        {error && <p role="alert" className="basis-full text-sm text-red-700">{error}</p>}
      </div>
      {planHost && onOpenPlan && <PlanEntry host={planHost} onOpen={onOpenPlan} onUpdate={onUpdate} shown={planShown} />}
      {dismissing && <DismissDialog ticket={ticket} onClose={closeDismiss} onDone={onUpdate} />}
    </article>
  );
}

function Section({ id, title, hint, count, children }) {
  return (
    <section data-gate-section={id} aria-labelledby={`gate-${id}`} className="space-y-3">
      <h2 id={`gate-${id}`} className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {title}
        {count > 0 && <span className="normal-case tracking-normal"> · {count}</span>}
        {hint && <span className="normal-case tracking-normal"> · {hint}</span>}
      </h2>
      {children}
    </section>
  );
}

function ValidatedRow({ ticket, onUpdate }) {
  const done = !!ticket.gate_jira_at;
  // honest: without max-go on Jira the fix queue cannot take it yet
  return (
    <li data-validated={ticket.key} className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyBadge ticketKey={ticket.key} />
        {done
          ? <Chip kind="ok" icon={CheckCircleIcon}>Validated · in the fix queue</Chip>
          : <Chip kind="max" icon={ClockIcon}>Validated · not queued yet</Chip>}
        {ticket.max_related && <Chip kind="max" icon={BoltIcon}>Uses MAX</Chip>}
        <span className="text-xs text-gray-500">{formatWhen(ticket.gate_at)}</span>
        <TicketDates ticket={ticket} className="ml-auto" />
      </div>
      <p className="mt-1 text-sm font-medium text-gray-900">{ticket.title || ticket.key}</p>
      <p className="mt-0.5 text-xs text-gray-500">
        {done
          ? 'Label max-go is on the Jira ticket. The fix queue takes it on its next run, then it moves to Ready to merge.'
          : ticket.gate_jira_error
            ? 'The fix queue takes it only once the label max-go is on Jira.'
            : 'Adding the label max-go on Jira…'}
      </p>
      <JiraProblem ticket={ticket} onUpdate={onUpdate} />
    </li>
  );
}

function AutoRow({ ticket, selected, onToggle, selectionFull }) {
  return (
    <li data-auto={ticket.key} className={`flex items-start gap-3 px-4 py-3 sm:px-5 ${selected ? 'bg-gray-50' : ''}`}>
      <SelectBox ticket={ticket} selected={selected} onToggle={onToggle} disabled={selectionFull} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <KeyBadge ticketKey={ticket.key} />
          <SourceChips ticket={ticket} />
          <TicketDates ticket={ticket} className="ml-auto" />
        </div>
        <p className="mt-1 text-sm font-medium text-gray-900">{ticket.title || ticket.key}</p>
        {(ticket.plain?.problem || ticket.excerpt) && (
          <p className="mt-0.5 line-clamp-2 text-sm text-gray-600">{sentence(ticket.plain?.problem || ticket.excerpt)}</p>
        )}
      </div>
    </li>
  );
}

function DismissedRow({ ticket, onUpdate }) {
  return (
    <li data-dismissed={ticket.key} className="bg-gray-50/70 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyBadge ticketKey={ticket.key} />
        <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">Dismissed</span>
        <span className="text-xs text-gray-500">{formatWhen(ticket.gate_at)}</span>
        <TicketDates ticket={ticket} className="ml-auto" />
      </div>
      <p className="mt-1 text-sm text-gray-500">{ticket.title || ticket.key}</p>
      {ticket.gate_note && <p className="mt-0.5 text-xs text-gray-500">Reason: {ticket.gate_note}</p>}
      <p className="mt-0.5 text-xs text-gray-400">{ticket.gate_jira_at ? 'Closed on Jira as declined.' : 'Closing on Jira…'}</p>
      <JiraProblem ticket={ticket} onUpdate={onUpdate} />
    </li>
  );
}

function MergeDialog({ tickets, onClose, onDone }) {
  const oldest = [...tickets].sort(byKey)[0].key;
  const [survivor, setSurvivor] = useState(oldest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEscape(onClose, busy);
  const problems = tickets.reduce((sum, t) => sum + Math.max(1, t.merge?.blocks?.length || 0), 0);
  const usesMax = tickets.some((t) => t.max_related);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post('/api/admin/pipeline/merge-tickets', { keys: tickets.map((t) => t.key), survivor });
      onDone(data.ticket, data.absorbed);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        data-merge-dialog
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl bg-white p-5 shadow-2xl"
      >
        <h2 id="merge-title" className="text-base font-semibold text-gray-900">Merge {tickets.length} tickets into one?</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-700">
          One ticket keeps every problem as its own block, with where it came from. The others close as superseded and
          point to it on Jira.
        </p>
        <p data-merge-savings className="mt-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-900">
          {mergeSavings(tickets.length, problems)}
        </p>
        <fieldset className="mt-4 min-h-0 overflow-y-auto">
          <legend className="text-sm font-medium text-gray-800">Which ticket stays?</legend>
          <div className="mt-2 space-y-1.5">
            {[...tickets].sort(byKey).map((t) => (
              <label
                key={t.key}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
                  survivor === t.key ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  name="merge-survivor"
                  data-survivor={t.key}
                  checked={survivor === t.key}
                  onChange={() => setSurvivor(t.key)}
                  className="mt-0.5 h-4 w-4 border-gray-300 text-gray-900 focus:ring-gray-900"
                />
                <span className="min-w-0">
                  <span className="font-mono text-xs text-gray-500">{t.key}</span>
                  {t.max_related && <span className="ml-2 text-xs text-amber-700">uses MAX</span>}
                  <span className="block text-gray-900">{t.title || t.key}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-3 text-xs leading-relaxed text-gray-500">
          {usesMax
            ? 'At least one problem uses MAX, so the merged ticket comes back here for your validation.'
            : 'No problem uses MAX, so the merged ticket goes to the fix queue on its own.'}
        </p>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-100">
            Keep separate
          </button>
          <button
            type="button"
            data-merge-confirm
            onClick={confirm}
            disabled={busy}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-50"
          >
            <ArrowsPointingInIcon className="h-4 w-4" aria-hidden />
            {busy ? 'Merging…' : 'Merge into one ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pinned to the bottom while tickets are selected: what a merge saves, and the button. */
function MergeBar({ selected, onClear, onMerge, onPlan }) {
  if (!selected.length) return null;
  // Plan testing: only while the pipeline offers it on every selected ticket (COCKPIT_PLAN)
  const canPlan = !!onPlan && selected.every((t) => t.plan?.on);
  const problems = selected.reduce((sum, t) => sum + Math.max(1, t.merge?.blocks?.length || 0), 0);
  return (
    <div data-merge-bar className="sticky bottom-4 z-30 mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-gray-900 px-4 py-3 text-white shadow-xl sm:px-5">
      <p className="text-sm font-semibold">{selected.length} selected</p>
      <p data-merge-bar-savings className="min-w-0 flex-1 text-sm text-gray-300">
        {selected.length < 2 ? 'Pick at least one more to merge.' : mergeSavings(selected.length, problems)}
      </p>
      <button type="button" onClick={onClear} className="text-sm font-medium text-gray-300 underline underline-offset-2 hover:text-white">
        Clear
      </button>
      {canPlan && (
        <button
          type="button"
          data-plan-open
          onClick={onPlan}
          title="Debate with the pipeline which of these to test together and how, before any test money is spent"
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white ring-1 ring-inset ring-white/40 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <BeakerIcon className="h-4 w-4" aria-hidden />
          Plan testing
        </button>
      )}
      <button
        type="button"
        data-merge-open
        onClick={onMerge}
        disabled={selected.length < 2}
        className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-white px-4 text-sm font-semibold text-gray-900 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ArrowsPointingInIcon className="h-4 w-4" aria-hidden />
        Merge into one ticket
      </button>
    </div>
  );
}

/** The backlog tickets this tab lists (absorbed ones collapse into their survivor). */
export function gateLists(tickets) {
  const since = Date.now() - DISMISSED_DAYS * 24 * 3600 * 1000;
  const open = tickets.filter((t) => t.queue === 'backlog' && !t.merged_into);
  return {
    pending: open.filter((t) => t.gate === 'pending').sort(byKey),
    later: open.filter((t) => t.gate === 'later').sort(byKey),
    validated: open.filter((t) => t.gate === 'validated').sort((a, b) => new Date(b.gate_at) - new Date(a.gate_at)),
    auto: open.filter((t) => t.gate === 'auto').sort(byKey),
    dismissed: open.filter((t) => t.gate === 'dismissed' && new Date(t.gate_at).getTime() >= since)
      .sort((a, b) => new Date(b.gate_at) - new Date(a.gate_at)),
  };
}

/**
 * "Awaiting validation": fix tickets that would run MAX conversations wait
 * here for Vincent (Validate / Later / Dismiss) before they may enter the fix
 * queue; tickets that do not use MAX flow on their own. Any of them can be
 * merged into one ticket before it is queued.
 */
export default function GateClient({ tickets, claims, onUpdate, onMerged, renderPlan, bundles: initialBundles, sort = 'default' }) {
  // the cockpit's sort applies within each section (Default = the order above)
  const lists = useMemo(() => Object.fromEntries(Object.entries(gateLists(tickets))
    .map(([k, list]) => [k, sortTickets(list, sort)])), [tickets, sort]);
  const claimsById = useMemo(() => new Map((claims || []).map((c) => [c.claim_id, c])), [claims]);
  const [picked, setPicked] = useState([]);
  const [merging, setMerging] = useState(false);
  const closeMerge = useCallback(() => setMerging(false), []);

  const byK = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
  // a ticket that stopped being mergeable (validated, merged) drops out of the selection
  const selected = picked.map((k) => byK.get(k)).filter((t) => mergeable(t));
  const full = selected.length >= MERGE_MAX;
  const toggle = useCallback((key) => setPicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])), []);
  const isSel = (key) => selected.some((t) => t.key === key);

  const merged = (survivor, absorbed) => {
    onMerged(survivor, absorbed);
    setPicked([]);
  };
  const phoneLayout = usePhoneLayout();

  // Plan testing threads: hosted by their anchor (or, once merged away, by its survivor)
  const hosts = useMemo(() => tickets.filter((t) => t.queue === 'backlog' && t.plan_thread && t.plan?.on), [tickets]);
  const planHostOf = (t) => hosts.find((h) => h.key === t.key && !h.merged_into) || hosts.find((h) => h.merged_into === t.key);
  const inPlanOf = (t) => hosts.find((h) => h.key !== t.key && !h.merged_into && !h.plan_thread.closed_at
    && h.plan_thread.keys.includes(t.key))?.key;
  // "Review this bundle" (PlanModal): the proposition, its thread and the agree button in one dialog;
  // the page behind never scrolls. The thread lives on its host card, which reopens the dialog.
  const [planView, setPlanView] = useState(null); // { keys, group, hostKey, opening, error }
  const closePlan = useCallback(() => setPlanView(null), []);
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  const groupOf = (keys) => (bundleDoc?.groups || []).find((g) => sameSet(g.keys, keys)) || null;
  const openThreadOn = (keys) => hosts.find((h) => !h.merged_into && !h.plan_thread.closed_at
    && keys.some((k) => h.plan_thread.keys.includes(k)));
  const openPlan = async (keys = selected.map((t) => t.key), group = groupOf(keys)) => {
    setPicked([]);
    const host = openThreadOn(keys);
    if (host && sameSet(host.plan_thread.keys, keys)) {
      setPlanView({ keys, group, hostKey: host.key });
      return;
    }
    setPlanView({ keys, group, hostKey: null, opening: true });
    try {
      const data = await post('/api/admin/pipeline/plan', { keys });
      onUpdate(data.ticket);
      setPlanView((v) => v && { ...v, hostKey: data.ticket.key, opening: false });
    } catch (err) {
      setPlanView((v) => v && { ...v, opening: false, error: err.message });
    }
  };
  const reopenPlan = (host) => setPlanView({ keys: host.plan_thread.keys, group: groupOf(host.plan_thread.keys), hostKey: host.key });
  const showTicket = (key) => {
    setPlanView(null);
    setTimeout(() => {
      document.querySelector(`[data-gate-card="${key}"], [data-phone-page="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  // Suggested bundles (pipeline flag COCKPIT_BUNDLES): absent = no strip
  const [bundleDoc, setBundleDoc] = useState(initialBundles || null);
  const bundleView = useMemo(
    () => visibleBundles(bundleDoc, new Set(tickets.filter(mergeable).map((t) => t.key))),
    [bundleDoc, tickets],
  );
  const activeBundle = bundleView?.groups.find((g) => g.keys.length === selected.length
    && g.keys.every((k) => isSel(k)))?.id;
  const pickBundle = (g) => setPicked(activeBundle === g.id ? [] : [...g.keys]);
  const bundleThread = (g) => {
    const host = openThreadOn(g.keys);
    return host ? planThreadState(host) : null;
  };
  const dismissBundle = async (g) => {
    const data = await post('/api/admin/pipeline/bundles', { id: g.id, input_hash: bundleView.input_hash });
    setBundleDoc(data.bundles);
    if (activeBundle === g.id) setPicked([]);
  };

  const card = (t) => (
    <GateCard
      key={t.key}
      ticket={t}
      claimsById={claimsById}
      selected={isSel(t.key)}
      onToggle={toggle}
      selectionFull={full}
      onUpdate={onUpdate}
      planHost={planHostOf(t)}
      inPlanOf={inPlanOf(t)}
      onOpenPlan={renderPlan ? reopenPlan : null}
      planShown={!!planView?.hostKey && planView.hostKey === planHostOf(t)?.key}
    />
  );

  const dialogs = (
    <>
      {merging && selected.length >= 2 && <MergeDialog tickets={selected} onClose={closeMerge} onDone={merged} />}
      {planView && (
        <PlanModal
          keys={planView.keys}
          group={planView.group}
          host={planView.hostKey ? byK.get(planView.hostKey) : null}
          opening={planView.opening}
          error={planView.error}
          ticketOf={(k) => byK.get(k)}
          renderPlan={renderPlan}
          onUpdate={onUpdate}
          onClose={closePlan}
          onDismiss={dismissBundle}
          onShow={showTicket}
        />
      )}
    </>
  );

  // phones: the same state, laid out one ticket per screen (MobileCockpit.js)
  if (phoneLayout) {
    return (
      <PhoneGate
        lists={lists}
        onUpdate={onUpdate}
        dialogs={dialogs}
        bundleCount={bundleView?.groups.length || 0}
        renderBundles={(closeSheet) => (
          <SuggestedBundles
            view={bundleView}
            titleOf={(k) => byK.get(k)?.title || k}
            activeId={activeBundle}
            canPlan={(g) => !!renderPlan && g.keys.every((k) => byK.get(k)?.plan?.on)}
            threadOf={bundleThread}
            onPick={(g) => { pickBundle(g); closeSheet(); }}
            onReview={(g) => { closeSheet(); openPlan(g.keys, g); }}
            onDismiss={dismissBundle}
          />
        )}
        sel={{
          selected, full, isSel, toggle,
          onClear: () => setPicked([]),
          onMerge: () => setMerging(true),
          onPlan: renderPlan ? () => openPlan() : null,
        }}
        gate={{
          DismissDialog, SourceChips, mergeable, inPlanOf,
          planHostOf,
          renderDetails: card,
          renderPlanEntry: renderPlan ? (t) => <PlanEntry host={planHostOf(t)} onOpen={reopenPlan} onUpdate={onUpdate} shown={false} /> : null,
        }}
      />
    );
  }

  return (
    <div data-gate-tab>
      {/* the bar and the dialog sit outside space-y-8: its margin-top would push the fixed backdrop down */}
      <div className="space-y-8">
        <SuggestedBundles
          view={bundleView}
          titleOf={(k) => byK.get(k)?.title || k}
          activeId={activeBundle}
          canPlan={(g) => !!renderPlan && g.keys.every((k) => byK.get(k)?.plan?.on)}
          threadOf={bundleThread}
          onPick={pickBundle}
          onReview={(g) => openPlan(g.keys, g)}
          onDismiss={dismissBundle}
        />
        <p className="max-w-3xl text-sm leading-relaxed text-gray-600">
          Fixes that would run MAX conversations wait here for your go: nothing runs and nothing is spent until you validate.
          Validate sends one to the fix queue (one fix round, then one exam); Later parks it for free. Fixes that do not use
          MAX go to the fix queue on their own. Select several to merge them into one ticket, so one fix round and one exam
          cover them all.
        </p>

        <Section id="pending" title="Awaiting your validation" count={lists.pending.length}>
          {lists.pending.length ? (
            <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">{lists.pending.map(card)}</div>
          ) : (
            <p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">
              No MAX fix is waiting for your validation.
            </p>
          )}
        </Section>

        {lists.later.length > 0 && (
          <Section id="later" title="Later" hint="parked, costs nothing" count={lists.later.length}>
            <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">{lists.later.map(card)}</div>
          </Section>
        )}

        {lists.validated.length > 0 && (
          <Section id="validated" title="Validated" hint="your go" count={lists.validated.length}>
            <ul className="divide-y divide-gray-100 rounded-xl border border-emerald-200 bg-white shadow-sm">
              {lists.validated.map((t) => <ValidatedRow key={t.key} ticket={t} onUpdate={onUpdate} />)}
            </ul>
          </Section>
        )}

        {lists.auto.length > 0 && (
          <Section id="auto" title="Flowing on their own" hint="no MAX cost, no validation needed" count={lists.auto.length}>
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
              {lists.auto.map((t) => <AutoRow key={t.key} ticket={t} selected={isSel(t.key)} onToggle={toggle} selectionFull={full} />)}
            </ul>
          </Section>
        )}

        {lists.dismissed.length > 0 && (
          <Section id="dismissed" title="Dismissed" hint={`last ${DISMISSED_DAYS} days`} count={lists.dismissed.length}>
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              {lists.dismissed.map((t) => <DismissedRow key={t.key} ticket={t} onUpdate={onUpdate} />)}
            </ul>
          </Section>
        )}
      </div>
      <MergeBar
        selected={selected}
        onClear={() => setPicked([])}
        onMerge={() => setMerging(true)}
        onPlan={renderPlan ? () => openPlan() : null}
      />
      {dialogs}
    </div>
  );
}
