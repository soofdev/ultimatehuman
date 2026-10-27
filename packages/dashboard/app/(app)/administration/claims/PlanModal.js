'use client';

import { cloneElement, useEffect, useRef, useState } from 'react';
import {
  ArrowRightIcon,
  ArrowsPointingInIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  RectangleStackIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import { chatAwaitingReply } from '@/app/lib/pipeline-cockpit';
import { mergeSavings } from '@/app/lib/pipeline-gate';
import { StrategyBlock, latestPlanClose } from './PlanTesting';

const money = (v) => `$${(Math.round((v || 0) * 10) / 10).toFixed(1)}`;
// the claims tickets' generic prefixes carry no information in a one-line list
const GENERIC = /^(MAX claims ground-truth correction|Feature from claims page):\s*/i;
const oneLine = (s) => (s || '').replace(GENERIC, '');
const ticketNum = (key) => parseInt(String(key).split('-')[1], 10) || 0;
const byTime = (chat) => [...(chat || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** "SCRUM-1", "SCRUM-1 and SCRUM-2", "SCRUM-1, SCRUM-2 and SCRUM-3" */
export function joinKeys(keys) {
  return keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/** The ticket that stays: the bundle's own pick (listed first), else the oldest, like the merge dialog. */
export function planSurvivor(keys, group) {
  if (group?.keys?.length) return group.keys[0];
  return [...keys].sort((a, b) => ticketNum(a) - ticketNum(b))[0];
}

/**
 * The pipeline's current proposal in a thread: each of its replies that is still a proposal ends
 * with a compact list ("tickets: SCRUM-1, SCRUM-2" / "survivor: SCRUM-1", briefs/PLAN-TESTING.md),
 * so agreeing means agreeing to the latest one. -> { keys, survivor } or null.
 */
export function latestProposal(chat) {
  const replies = byTime(chat).filter((m) => m.role === 'assistant' && !m.plan_close);
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    const text = replies[i].text || '';
    const line = [...text.matchAll(/^[\s*>_-]*tickets\W*:(.*)$/gim)].pop(); // the closing list, not a mention above it
    // "tickets: SCRUM-1, SCRUM-2 (SCRUM-3 waits for your ruling)": a key in a side note is not in the plan
    const keys = line ? [...new Set(line[1].split('(')[0].match(/[A-Z][A-Z0-9]+-\d+/g) || [])] : [];
    const surv = [...text.matchAll(/^[\s*>_-]*survivor\W*:\W*([A-Z][A-Z0-9]+-\d+)/gim)].pop()?.[1];
    if (keys.length) return { keys, survivor: keys.includes(surv) ? surv : keys[0] };
  }
  return null;
}

/** The scrolling boxes around the dialog (the admin page scrolls inside <main>, not the window). */
function scrollParents(el) {
  const out = [document.documentElement];
  for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) out.push(n);
  }
  return out;
}

/** Esc closes, Tab stays inside, the page behind cannot scroll, keeps its position and gets focus back. */
function useModal(ref, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    // overflow: hidden keeps scrollTop, so the page is exactly where it was when the dialog closes
    const locked = scrollParents(ref.current).map((el) => ({ el, overflow: el.style.overflowY }));
    locked.forEach(({ el }) => { el.style.overflowY = 'hidden'; });
    ref.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      // an image viewer opened from the thread sits on top: Esc is its own
      if (document.querySelector('[data-lightbox]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      locked.forEach(({ el, overflow }) => { el.style.overflowY = overflow; });
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [ref]);
}

function Label({ children }) {
  return <h3 className="text-sm font-semibold text-gray-900">{children}</h3>;
}

/** The proposition: which tickets, why they belong together, what it saves. */
function Proposal({ keys, plan, changed, group, ticketOf }) {
  const relevance = group?.mode === 'relevance';
  const { keys: agreed, survivor } = plan;
  const listed = [survivor, ...agreed.filter((k) => k !== survivor), ...keys.filter((k) => !agreed.includes(k))];
  return (
    <div className="space-y-5">
      <section aria-labelledby="plan-tickets">
        <Label><span id="plan-tickets">{agreed.length} ticket{agreed.length === 1 ? '' : 's'}{changed ? ', as the pipeline now proposes' : ''}</span></Label>
        {changed && (
          <p data-plan-changed role="status" className="mt-1 text-sm leading-relaxed text-gray-700">
            The conversation changed the suggestion. Agreeing now means agreeing to this version.
          </p>
        )}
        <ul data-plan-tickets className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200">
          {listed.map((k) => {
            const t = ticketOf(k);
            const kept = k === survivor;
            const out = !agreed.includes(k);
            const added = !keys.includes(k);
            return (
              <li key={k} data-plan-ticket={k} data-plan-ticket-state={out ? 'left-out' : added ? 'added' : 'in'} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5 sm:flex-nowrap">
                <span className="mt-0.5 shrink-0 font-mono text-xs text-gray-500 sm:w-[5.75rem]">{k}</span>
                <span className={`order-last min-w-0 basis-full text-sm leading-snug sm:order-none sm:flex-1 sm:basis-auto ${out ? 'text-gray-500 line-through decoration-gray-400' : 'text-gray-900'}`}>
                  {oneLine(t?.title) || k}
                </span>
                {out && (
                  <span title="The pipeline proposes to test this one on its own" className="ml-auto shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 sm:ml-0">
                    Left out
                  </span>
                )}
                {added && !kept && (
                  <span className="ml-auto shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 sm:ml-0">Added</span>
                )}
                {kept && (
                  <span
                    data-plan-kept
                    title="This ticket stays open. The others merge into it as extra problems."
                    className="ml-auto shrink-0 rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-semibold text-white sm:ml-0"
                  >
                    Stays
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="grid gap-5 sm:grid-cols-[1fr_11rem]">
        <section aria-labelledby="plan-why" className="min-w-0 space-y-3">
          <Label><span id="plan-why">Why together</span></Label>
          <p data-plan-why className="text-sm leading-relaxed text-gray-800">
            {group
              ? <>{keys.length === 2 ? 'Both change' : 'They all change'} one part of MAX{group.name ? <>: <span className="font-medium">{group.name}</span></> : ''}. One fix round and one test can cover them.</>
              : 'You picked them together. The pipeline checks whether one fix round and one test can cover them.'}
            {relevance && ' The pipeline thinks they may already be fixed, so the test mainly checks that.'}
          </p>
          {group?.scenario && (
            <p data-plan-scenario className="text-sm leading-relaxed text-gray-800">
              <span className="font-medium text-gray-900">The shared test:</span> {group.scenario}
            </p>
          )}
          {group?.surface && (
            <details data-plan-surface className="group text-xs leading-relaxed text-gray-600">
              <summary className="cursor-pointer select-none font-medium text-gray-600 hover:text-gray-900">The code they share</summary>
              <p className="mt-1 [overflow-wrap:anywhere]">{group.surface}</p>
            </details>
          )}
        </section>
        <section aria-labelledby="plan-saving" data-plan-saving className="self-start rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-inset ring-emerald-100">
          <Label><span id="plan-saving">{changed ? 'First estimate' : 'Estimated saving'}</span></Label>
          {group ? (
            <>
              <p className={`mt-1 font-semibold tabular-nums text-emerald-900 ${changed ? 'text-base' : 'text-2xl'}`}>~{money(group.est.savings_usd)}</p>
              <p className="mt-0.5 text-xs tabular-nums leading-relaxed text-emerald-900/80">
                {money(group.est.bundle_usd)} together instead of {money(group.est.apart_usd)} apart{relevance ? ', if fixed' : ''}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm leading-relaxed text-emerald-900">{mergeSavings(agreed.length)}</p>
          )}
          {changed && group && <p className="mt-1.5 text-xs leading-relaxed text-emerald-900/80">For the first suggestion. The latest reply gives its own estimate.</p>}
        </section>
      </div>
    </div>
  );
}

/** After the pipeline's closing reply: what happened, the binding strategy, where the ticket lives now. */
function Result({ close, survivorTicket }) {
  const others = (close.tickets || []).filter((k) => k !== close.survivor);
  const failed = !!close.merge_error;
  const strategy = survivorTicket?.plan?.strategy || close.strategy;
  let title;
  if (close.mode === 'manual') title = `Plan agreed: ${close.survivor} goes back to the queue`;
  else if (failed) title = 'Plan agreed, but the merge did not go through';
  else if (close.merged_at) title = others.length ? `Merged into ${close.survivor}` : `Plan agreed on ${close.survivor}`;
  else title = others.length ? `Merging into ${close.survivor}…` : `Plan agreed on ${close.survivor}`;
  return (
    <section data-plan-result={failed ? 'error' : close.merged_at ? 'merged' : 'pending'} aria-live="polite" className="space-y-4">
      <div className={`flex gap-3 rounded-xl px-4 py-3.5 ring-1 ring-inset ${failed ? 'bg-red-50 ring-red-200' : 'bg-emerald-50 ring-emerald-200'}`}>
        {failed
          ? <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
          : <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />}
        <div className="min-w-0 text-sm leading-relaxed">
          <p className={`font-semibold ${failed ? 'text-red-900' : 'text-emerald-900'}`}>{title}</p>
          {failed ? (
            <p className="text-red-900 [overflow-wrap:anywhere]">
              {close.merge_error} The strategy is recorded on each ticket; you can still merge them with the merge button.
            </p>
          ) : close.mode === 'manual' ? (
            <p className="text-emerald-900">The next fix round and test follow the strategy below.</p>
          ) : (
            <p className="text-emerald-900">
              {others.length ? <>{joinKeys(others)} {others.length > 1 ? 'are' : 'is'} now part of {close.survivor}. </> : null}
              It waits in <span className="font-medium">Awaiting validation</span> as {close.survivor}: validate it there to start
              one fix round and one test under the strategy below.
            </p>
          )}
        </div>
      </div>
      <StrategyBlock strategy={strategy} />
    </section>
  );
}

/**
 * "Review this bundle": the whole Plan testing job in one dialog (a full
 * screen sheet on a phone), so the page behind never moves. Top: the
 * proposition. Middle: the existing Plan testing thread (renderPlan, the
 * same chat as on a card). Bottom: agree (a plain message the pipeline reads
 * as agreement; its closing reply merges and binds the strategy, as before),
 * dismiss the suggestion, or close and come back later.
 */
export default function PlanModal({ keys, group, host, opening, error, ticketOf, renderPlan, onUpdate, onClose, onDismiss, onShow }) {
  const ref = useRef(null);
  const bodyRef = useRef(null);
  useModal(ref, onClose);
  // entrance: a short fade and lift (none with reduced motion); the dialog is fully usable at once
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const close = latestPlanClose(host?.chat)?.plan_close || null; // the closing reply's agreed plan
  const chat = byTime(host?.chat);
  const awaiting = chatAwaitingReply(chat);
  // what "agree" agrees to: the pipeline's latest proposal in the thread, else the suggestion itself
  const proposed = latestProposal(host?.chat);
  const plan = proposed || { keys, survivor: planSurvivor(keys, group) };
  const changed = !!proposed && (proposed.keys.length !== keys.length || proposed.keys.some((k) => !keys.includes(k))
    || proposed.survivor !== planSurvivor(keys, group));
  const survivor = close?.survivor || plan.survivor;
  const others = plan.keys.filter((k) => k !== survivor);
  const thread = host && renderPlan ? cloneElement(renderPlan(host), { inModal: true }) : null;

  // a new message or reply: show the end of the conversation (not on open: the proposition comes first)
  const seen = useRef(null);
  useEffect(() => {
    // back in a conversation that already started: open on its latest message (the proposition is above)
    if (chat.length && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [!!host]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const n = chat.length + (awaiting ? 1 : 0);
    if (seen.current != null && n !== seen.current && bodyRef.current) {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
    }
    seen.current = n;
  }, [chat.length, awaiting]);

  const agree = async () => {
    setBusy('agree');
    setActionError(null);
    const text = `Agreed${proposed ? ', with your last proposal' : ''}. ${others.length
      ? `Merge ${joinKeys(others)} into ${survivor} and test them as one.`
      : `Test ${survivor} on its own, as proposed.`}`;
    try {
      const res = await fetch('/api/admin/pipeline/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: host.key, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not send (${res.status})`);
      onUpdate(data);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async () => {
    setBusy('dismiss');
    setActionError(null);
    try {
      await onDismiss(group);
      onClose();
    } catch (err) {
      setActionError(err.message);
      setBusy(null);
    }
  };

  const title = close ? 'Test plan agreed' : others.length ? `Test these ${plan.keys.length} tickets as one` : `Test ${survivor} on its own`;
  const agreeLabel = others.length ? `Agree: merge into ${survivor} and test as one` : `Agree: test ${survivor} on its own`;
  const primary = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const secondary = 'inline-flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-lg px-4 text-sm font-medium text-gray-800 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900';

  return (
    <div
      data-plan-modal-backdrop
      className={`fixed inset-0 z-50 flex items-stretch justify-center bg-gray-950/50 transition-opacity duration-200 ease-out motion-reduce:transition-none sm:items-center sm:p-6 ${shown ? 'opacity-100' : 'opacity-0'}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-modal-title"
        tabIndex={-1}
        data-plan-modal={host?.key || ''}
        data-plan-modal-keys={keys.join(',')}
        className={`flex h-full w-full flex-col bg-white shadow-2xl transition-transform duration-200 ease-out focus:outline-none motion-reduce:transition-none sm:h-auto sm:max-h-[min(90vh,880px)] sm:max-w-[52rem] sm:rounded-2xl sm:ring-1 sm:ring-black/5 ${shown ? 'translate-y-0' : 'translate-y-2'}`}
      >
        <header className="flex items-start gap-3 border-b border-gray-100 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pt-5">
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-gray-500">
              <RectangleStackIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
              <span className="shrink-0">{group ? 'Suggested by the pipeline' : 'Your selection'}</span>
              {group?.name && <span className="min-w-0 truncate">· {group.name}</span>}
            </p>
            <h2 id="plan-modal-title" className="mt-1 text-lg font-semibold leading-snug text-gray-900">{title}</h2>
          </div>
          <button
            type="button"
            data-plan-modal-x
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 sm:h-9 sm:w-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div ref={bodyRef} data-plan-modal-body className="min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {close
            ? <Result close={close} survivorTicket={ticketOf(close.survivor)} />
            : <Proposal keys={keys} plan={plan} changed={changed} group={group} ticketOf={ticketOf} />}

          <section aria-labelledby="plan-talk" data-plan-talk>
            <Label><span id="plan-talk">{close ? 'The conversation' : 'Adjust it with the pipeline'}</span></Label>
            {!close && (
              <p className="mt-1 text-sm leading-relaxed text-gray-600">
                Ask why, add or drop a ticket, or change the test. The pipeline answers here in a few minutes. Nothing is
                merged or spent until you agree.
              </p>
            )}
            {thread}
            {!host && opening && <p role="status" className="mt-3 text-sm text-gray-500">Opening the conversation…</p>}
            {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          </section>
        </div>

        <footer className="border-t border-gray-100 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          {actionError && <p role="alert" className="mb-2 text-sm text-red-700">{actionError}</p>}
          {!close && changed && !awaiting && (
            <p data-plan-agree-means className="mb-2 text-sm leading-snug text-gray-700">
              Agree accepts the pipeline&apos;s latest proposal: {joinKeys(plan.keys)}. To change it, reply first.
            </p>
          )}
          {close ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-plan-done onClick={onClose} className={secondary}>Done</button>
              {!close.merge_error && close.mode !== 'manual' && (
                <button type="button" data-plan-show={close.survivor} onClick={() => onShow(close.survivor)} className={primary}>
                  Show {close.survivor} on the page
                  <ArrowRightIcon className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ) : (
            // phone: the agree button on its own row, then Dismiss and Close side by side; wider: one row
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <button
                type="button"
                data-plan-agree
                onClick={agree}
                disabled={!host || !!busy || awaiting}
                className={`${primary} col-span-2 sm:order-4`}
              >
                <ArrowsPointingInIcon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
                {busy === 'agree' ? 'Sending…' : awaiting ? 'The pipeline is answering…' : agreeLabel}
              </button>
              {group && (
                <button
                  type="button"
                  data-plan-dismiss={group.id}
                  onClick={dismiss}
                  disabled={!!busy}
                  title="Hide this suggestion. The tickets stay as they are."
                  className="inline-flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 disabled:opacity-50 sm:order-1 sm:-ml-3"
                >
                  {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss suggestion'}
                </button>
              )}
              <span className="hidden sm:order-2 sm:block sm:flex-1" />
              <button
                type="button"
                data-plan-close
                onClick={onClose}
                title="The conversation stays open: reopen it from the bundle or from the ticket card"
                className={`${secondary} sm:order-3 ${group ? '' : 'col-span-2'}`}
              >
                Close for now
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}

/** An open or agreed Plan testing thread, for the strip and the host card: { key, messages, awaiting, lastFrom, closed }. */
export function planThreadState(host) {
  const chat = byTime(host.chat);
  return {
    key: host.key,
    messages: chat.length,
    awaiting: chatAwaitingReply(chat),
    lastFrom: chat.length ? chat[chat.length - 1].role : null,
    closed: !!host.plan_thread?.closed_at,
    proposal: latestProposal(chat),
  };
}

const REFRESH_MS = 30 * 1000;

/** While the pipeline is answering and the dialog is closed: refresh the thread (the dialog's own thread refreshes itself). */
function usePlanRefresh(host, onUpdate, paused) {
  const waiting = !paused && planThreadState(host).awaiting;
  useEffect(() => {
    if (!waiting) return undefined;
    let stop = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/admin/pipeline/chat?key=${encodeURIComponent(host.key)}`, { cache: 'no-store' });
        if (res.ok && !stop) onUpdate(await res.json());
      } catch {}
    };
    const id = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      stop = true;
      clearInterval(id);
      window.removeEventListener('focus', refresh);
    };
  }, [waiting, host.key, onUpdate]);
}

/** On the card hosting a Plan testing thread: what it is about, and the way back into the dialog. */
export function PlanEntry({ host, onOpen, onUpdate, shown }) {
  usePlanRefresh(host, onUpdate, shown);
  const s = planThreadState(host);
  const others = (host.plan_thread?.keys || []).filter((k) => k !== host.key);
  let line;
  if (s.closed) line = 'Test plan agreed. The conversation is kept.';
  else if (s.awaiting) line = 'The pipeline is answering.';
  else if (!s.messages) line = 'Nothing said yet.';
  else line = `${s.messages} message${s.messages === 1 ? '' : 's'}${s.lastFrom === 'assistant' ? ', the pipeline replied.' : '.'}`;
  return (
    <div data-plan-entry={host.key} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-emerald-50/70 px-3 py-2.5 ring-1 ring-inset ring-emerald-200">
      <p className="min-w-0 flex-1 text-sm leading-snug text-emerald-950">
        <span className="font-semibold">{s.closed ? 'Test plan' : 'Test plan in discussion'}</span>
        {others.length > 0 && <> with {joinKeys(others)}</>}
        <span className="block text-xs text-emerald-900/80">{line}</span>
      </p>
      <button
        type="button"
        data-plan-entry-open={host.key}
        onClick={() => onOpen(host)}
        className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-white px-3 text-xs font-semibold text-emerald-900 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
      >
        {s.closed ? 'View the plan' : 'Open the plan'}
        <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
