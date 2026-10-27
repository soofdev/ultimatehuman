'use client';

import { useState } from 'react';
import { ArrowPathIcon, ChatBubbleLeftRightIcon, ChevronRightIcon, RectangleStackIcon } from '@heroicons/react/20/solid';

const money = (v) => `$${(Math.round((v || 0) * 10) / 10).toFixed(1)}`;
// compressed: the claims tickets' generic prefixes carry no information in a one-line list
const GENERIC = /^(MAX claims ground-truth correction|Feature from claims page):\s*/i;
const short = (s, n = 64) => {
  const t = (s || '').replace(GENERIC, '');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

function when(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
}

function threadLine(thread, group) {
  const p = thread.proposal;
  const moved = p && (p.keys.length !== group.keys.length || p.keys.some((k) => !group.keys.includes(k)));
  if (moved && !thread.awaiting) return `In discussion · the pipeline now proposes ${p.keys.length} ticket${p.keys.length === 1 ? '' : 's'}: ${p.keys.join(', ')}`;
  if (thread.awaiting) return 'In discussion · the pipeline is answering';
  if (!thread.messages) return 'Conversation open · nothing said yet';
  const n = `${thread.messages} message${thread.messages === 1 ? '' : 's'}`;
  return thread.lastFrom === 'assistant' ? `In discussion · ${n} · the pipeline replied` : `In discussion · ${n}`;
}

function BundleRow({ group, titleOf, active, canPlan, thread, onPick, onReview, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const relevance = group.mode === 'relevance';
  const dismiss = async (e) => {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await onDismiss(group);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const lit = active || !!thread;
  return (
    <li
      data-bundle={group.id}
      data-bundle-active={active ? 'true' : 'false'}
      data-bundle-thread={thread ? thread.key : undefined}
      className={`group relative px-4 py-3.5 sm:px-5 ${lit ? 'bg-emerald-50/70 hover:bg-emerald-50' : 'hover:bg-gray-50'}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-gray-900">{group.name || 'Bundle'}</span>
            {relevance && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-inset ring-sky-200">
                relevance check only
              </span>
            )}
          </p>
          <ul className="mt-1 space-y-0.5">
            {group.keys.map((k, i) => (
              <li key={k} data-bundle-member={k} className="flex items-baseline gap-2 text-[13px] leading-snug text-gray-700">
                <span className="w-[5.5rem] shrink-0 font-mono text-[11px] text-gray-500" title={i === 0 ? 'Stays when they merge: the others join it' : undefined}>
                  {k}{i === 0 ? ' ★' : ''}
                </span>
                <span className="min-w-0 truncate">{short(titleOf(k))}</span>
              </li>
            ))}
          </ul>
          {group.surface && (
            <p data-bundle-surface className="mt-1.5 text-xs leading-relaxed text-gray-500">
              Shared: {group.surface}
            </p>
          )}
          {thread && (
            <p data-bundle-thread-state className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-800">
              <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden />
              {threadLine(thread, group)}
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-col sm:items-end">
          <span
            data-bundle-saves
            title={`Estimated MAX spend: ${money(group.est.bundle_usd)} together vs ${money(group.est.apart_usd)} apart (desk model, ±40%)`}
            className="whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900"
          >
            saves ~{money(group.est.savings_usd)}{relevance ? ' if fixed' : ''}
          </span>
          <span className="hidden text-[11px] tabular-nums text-gray-500 sm:inline">
            {money(group.est.bundle_usd)} vs {money(group.est.apart_usd)} apart
          </span>
          <div className="ml-auto flex items-center gap-1 sm:ml-0">
            <button
              type="button"
              data-bundle-dismiss={group.id}
              onClick={dismiss}
              disabled={busy}
              className="relative z-10 inline-flex min-h-[36px] items-center rounded-lg px-2.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
            >
              {busy ? 'Dismissing…' : 'Dismiss'}
            </button>
            {/* the whole row is this button's hit area (the ::after covers the row; Dismiss sits above it) */}
            {canPlan ? (
              <button
                type="button"
                data-bundle-review={group.id}
                onClick={() => onReview(group)}
                aria-label={`${thread ? 'Continue the plan' : 'Review proposal'}: ${group.name || group.keys.join(', ')}`}
                className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-3 text-xs font-semibold after:absolute after:inset-0 after:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 ${
                  thread ? 'bg-gray-900 text-white group-hover:bg-gray-700' : 'bg-white text-gray-900 ring-1 ring-inset ring-gray-300 group-hover:bg-gray-50 group-hover:ring-gray-400'
                }`}
              >
                {thread ? 'Continue the plan' : 'Review proposal'}
                <ChevronRightIcon className="h-4 w-4" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                data-bundle-pick={group.id}
                onClick={() => onPick(group)}
                aria-pressed={active}
                className="inline-flex min-h-[36px] items-center rounded-lg px-3 text-xs font-semibold text-gray-800 ring-1 ring-inset ring-gray-300 after:absolute after:inset-0 after:content-[''] hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
              >
                {active ? 'Untick them' : 'Tick them below'}
              </button>
            )}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="relative z-10 mt-1 text-xs text-red-700">{error}</p>}
    </li>
  );
}

/**
 * "Suggested bundles" (pipeline flag COCKPIT_BUNDLES): the pipeline's own
 * grouping of the waiting tickets that share a MAX surface, so one fix round
 * and one exam cover them. A row opens "Review this bundle" (PlanModal: the
 * proposition and its Plan testing thread); a row whose thread is open says
 * so and reopens it. Without Plan testing a row ticks its cards. Dismiss
 * hides it until the waiting set changes. While the set changed since the
 * analysis: "re-analyzing".
 */
export default function SuggestedBundles({ view, titleOf, activeId, canPlan, threadOf, onPick, onReview, onDismiss }) {
  if (!view) return null;
  const total = view.groups.reduce((s, g) => s + (g.est.savings_usd || 0), 0);
  return (
    <section data-bundles aria-labelledby="gate-bundles" className="space-y-3">
      <h2 id="gate-bundles" className="flex flex-wrap items-center gap-x-1 text-xs font-medium uppercase tracking-wide text-gray-400">
        <RectangleStackIcon className="mr-0.5 h-3.5 w-3.5 text-gray-400" aria-hidden />
        Suggested bundles
        {!view.stale && view.groups.length > 0 && (
          <span className="normal-case tracking-normal"> · {view.groups.length} · ~{money(total)} saved if you take them all</span>
        )}
        {!view.stale && view.generated_at && (
          <span className="normal-case tracking-normal"> · analysed {when(view.generated_at)}</span>
        )}
      </h2>
      {view.stale ? (
        <p data-bundles-stale className="flex items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-4 text-sm text-gray-600">
          <ArrowPathIcon className="h-4 w-4 shrink-0 animate-spin text-gray-400" aria-hidden />
          Re-analyzing… the waiting tickets changed since the last suggestions. New ones appear here on their own.
        </p>
      ) : view.groups.length ? (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm">
          {view.groups.map((g) => (
            <BundleRow
              key={g.id}
              group={g}
              titleOf={titleOf}
              active={activeId === g.id}
              canPlan={canPlan(g)}
              thread={threadOf(g)}
              onPick={onPick}
              onReview={onReview}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      ) : (
        <p data-bundles-empty className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-4 text-sm text-gray-500">
          No bundle to suggest: the waiting tickets are best tested one by one.
        </p>
      )}
    </section>
  );
}
