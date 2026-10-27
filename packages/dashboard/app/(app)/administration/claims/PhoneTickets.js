'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUturnLeftIcon, BeakerIcon, ExclamationTriangleIcon, PauseIcon } from '@heroicons/react/20/solid';
import {
  Banner, FitText, PageTop, ProofButton, ProofZone, Portal, PhoneStrip, SelectToggle, Sheet, StripButton, TextBlock, ThumbBar,
  TicketFeed, icons, ticketDates, useDeferred, useFeedAdvance, usePageSheet,
} from './MobileCockpit';

/**
 * The ticket pages of the phone cockpit, one per queue. Each shows what the
 * triage needs on one screen and opens the desktop card (`kit`, passed by
 * CockpitClient) in its Details sheet, so every action of the card is there too.
 */

const JIRA_BROWSE = 'https://magifyfun.atlassian.net/browse/';
const REPO_SHORT = { magify_agents_api: 'api', magify_next: 'next' };
const prLabel = (p) => `${REPO_SHORT[p.repo] || p.repo}#${p.number}`;
const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const proofsOf = (t) => (t.evidence || []).filter((e) => e.s3_key);

function when(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
  return data;
}

/** The flags in one line (edited in Details), the pipeline's hold marker first. */
function FlagLine({ ticket, kit }) {
  const flags = ticket.flags || [];
  if (!flags.length && !ticket.hold) return null;
  return (
    <div data-phone-flags className="mt-1.5 flex h-6 items-center gap-1 overflow-hidden">
      <kit.AutoChips ticket={ticket} />
      {flags.map((f) => <kit.FlagChip key={f.id} flag={f} size="sm" />)}
    </div>
  );
}

/** Scrolls the opened Details sheet to one part of the card (the merge order, the decision form). */
function useScrollTo(selector) {
  useEffect(() => {
    if (!selector) return;
    const t = setTimeout(() => document.querySelector(`[data-sheet-body] ${selector}`)?.scrollIntoView({ block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [selector]);
}

function DetailsSheet({ ticket, onClose, focus, children }) {
  useScrollTo(focus);
  return (
    <Sheet title={`${ticket.key} · Details`} label="details" tall onClose={onClose}>
      {/* the desktop card, whole: every action it has works here */}
      <div data-phone-details={ticket.key} className="-mx-4 [&>article]:rounded-none [&>article]:border-0 [&>article]:shadow-none">{children}</div>
    </Sheet>
  );
}

function ChatSheet({ ticket, onClose, children }) {
  return (
    <Sheet title={`${ticket.key} · Conversation`} label="chat" tall onClose={onClose}>
      <div className="pt-1">{children}</div>
    </Sheet>
  );
}

const chatCount = (t) => (t.chat || []).length;

function fixActions(ticket, kit, open) {
  return kit.fixRequestAllowed(ticket) ? [{ id: 'fix', label: <><span className="max-[379px]:hidden">Request fix</span><span className="hidden max-[379px]:inline">Fix</span></>, icon: icons.fix, tone: 'fix', onClick: () => open('fix') }] : [];
}

// ---------------------------------------------------------------- Ready to merge

function MergePage({ ticket, active, onUpdate, kit }) {
  kit.useTicketRefresh(ticket, onUpdate);
  const gallery = kit.useGallery(ticket);
  const { sheet, open, close } = usePageSheet();
  const cancelling = !!(ticket.cancel && !ticket.cancel.ack_error);
  const fixReq = kit.openFixRequest(ticket);
  const outcome = fixReq ? null : kit.fixOutcome(ticket);
  const plan = kit.mergePlan(ticket.prs);
  const proofs = proofsOf(ticket);
  const totals = (ticket.prs || []).reduce((a, p) => ({ files: a.files + (p.changed_files || 0), add: a.add + (p.additions || 0), del: a.del + (p.deletions || 0) }), { files: 0, add: 0, del: 0 });

  const pill = cancelling ? { kind: 'muted', label: ticket.cancel.acked_at ? 'Cancelled' : 'Cancel requested' }
    : fixReq ? { kind: 'warn', icon: icons.fix, label: fixReq.acked_at ? 'Fix in progress' : 'Fix requested' }
      : ticket.hold ? { kind: 'bad', icon: ExclamationTriangleIcon, label: 'On hold' }
        : outcome?.kind === 'failed' ? { kind: 'bad', icon: ExclamationTriangleIcon, label: 'Fix failed, needs you' }
          : { kind: 'ok', label: 'Ready to merge' };
  const banner = cancelling ? null
    : fixReq ? <Banner>Do not merge yet: you requested a fix.</Banner>
      : ticket.hold ? <Banner>On hold, do not merge. {ticket.hold}</Banner> : null;
  const held = !!(fixReq || ticket.hold);
  const primary = cancelling || !plan.length ? null
    : plan.length === 1
      ? { id: 'github', label: `Open ${prLabel(plan[0].pr)}`, icon: icons.open, href: plan[0].pr.url, muted: held }
      : { id: 'github', label: `Open ${plan.length} PRs`, icon: icons.open, onClick: () => open('details:[data-github-links]'), muted: held };

  return (
    <article data-phone-card="merge" data-ticket={ticket.key} className="flex h-full flex-col bg-white">
      <PageTop
        ticket={ticket}
        pill={pill}
        dates={ticketDates(ticket)}
        summary={ticket.plain?.improves ? null : ticket.title}
        chips={<FlagLine ticket={ticket} kit={kit} />}
      />
      {/* the three paragraphs of the desktop card, all on screen: each gets its share of the lines */}
      <FitText keepAll hug={proofs.length > 0} className="mt-2 px-4" onMore={() => open('details')}>
        <TextBlock label="What improves" strong>{ticket.plain?.improves}</TextBlock>
        <TextBlock label="Problem it solves">{ticket.plain?.problem}</TextBlock>
        <TextBlock label="How it solves it">{ticket.plain?.how}</TextBlock>
        {!ticket.plain?.problem && !ticket.plain?.how && ticket.plain?.improves && <p className="mt-2.5 text-[15px] text-gray-700">{ticket.title}</p>}
      </FitText>
      {plan.length > 0 && (
        <p data-phone-prs className="shrink-0 truncate px-4 pb-2 pt-1 text-xs text-gray-500">
          {plan.map(({ pr }) => prLabel(pr)).join(', ')} · {totals.files} files
          <span className="text-emerald-700"> +{totals.add}</span>
          <span className="text-red-700"> −{totals.del}</span>
        </p>
      )}
      {proofs.length > 0 && <ProofZone grow><ProofButton grow images={proofs} onOpen={gallery.openProof} eager={active} /></ProofZone>}
      {banner}
      <ThumbBar
        actions={[
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          { id: 'chat', label: 'Chat', icon: icons.chat, badge: chatCount(ticket), onClick: () => open('chat') },
          ...(cancelling ? [] : fixActions(ticket, kit, open)),
        ]}
        primary={primary}
      />
      <Portal>{gallery.viewer}</Portal>
      {sheet?.startsWith('details') && (
        <DetailsSheet ticket={ticket} onClose={close} focus={sheet.split(':')[1]}>
          <kit.MergeCard ticket={ticket} proofSize="small" onUpdate={onUpdate} />
        </DetailsSheet>
      )}
      {sheet === 'chat' && (
        <ChatSheet ticket={ticket} onClose={close}>
          <kit.TicketThread ticket={ticket} onUpdate={onUpdate} locked={cancelling} onOpenImage={gallery.openShot} hint="Chat is for questions. It never merges or changes the fix: use Request a fix for that." />
        </ChatSheet>
      )}
      {sheet === 'fix' && (
        <Sheet title={`${ticket.key} · Request a fix`} label="fix" onClose={close}>
          <kit.FixRequestBar ticket={ticket} onUpdate={onUpdate} startOpen onDone={close} />
        </Sheet>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- Needs decision

function DecisionPage({ ticket, active, onUpdate, kit }) {
  kit.useTicketRefresh(ticket, onUpdate);
  const gallery = kit.useGallery(ticket);
  const { sheet, open, close } = usePageSheet();
  const d = ticket.decision || {};
  const rec = kit.recommendedLetter(d);
  const cancelling = !!(ticket.cancel && !ticket.cancel.ack_error);
  const fixReq = kit.openFixRequest(ticket);
  const locked = cancelling || !!fixReq;
  const final = !!(ticket.answer?.acked_at && !ticket.answer.ack_error);
  const [option, setOption] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const proofs = proofsOf(ticket);
  const options = d.options || [];
  const answering = !locked && !ticket.answer && options.length > 0;
  const advance = useFeedAdvance();

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post('/api/admin/pipeline/answer', { key: ticket.key, option, text: '' });
      advance(ticket.key, `${ticket.key}: option ${option} sent to the pipeline`);
      onUpdate(data.ticket);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pill = cancelling ? { kind: 'muted', label: 'Cancel requested' }
    : fixReq ? { kind: 'warn', icon: icons.fix, label: 'Fix requested' }
      : ticket.answer ? { kind: 'ok', label: final ? 'Answer posted' : 'Answered' }
        : { kind: 'info', label: 'Needs decision' };
  const primary = answering
    ? { id: 'answer', label: busy ? 'Sending…' : option ? `Send ${option}` : `Pick ${options.map((o) => o.letter).join(' or ')}`, icon: icons.check, onClick: send, disabled: busy || !option }
    : !locked && !final ? { id: 'answer', label: ticket.answer ? 'Change answer' : 'Answer', icon: icons.check, onClick: () => open('details'), muted: !!ticket.answer }
      : null;

  return (
    <article data-phone-card="decide" data-ticket={ticket.key} className="flex h-full flex-col bg-white">
      <PageTop ticket={ticket} pill={pill} dates={ticketDates(ticket)} lines={5}
        summary={d.question || 'This ticket needs your decision. The question is on the Jira ticket.'}
        chips={<FlagLine ticket={ticket} kit={kit} />} />
      {answering && (
        <div role="radiogroup" aria-label="Options" data-phone-options className="mt-2 shrink-0 space-y-1.5 px-4">
          {options.map((o) => {
            const on = option === o.letter;
            return (
              <button
                key={o.letter}
                type="button"
                role="radio"
                aria-checked={on}
                data-option={o.letter}
                onClick={() => setOption(on ? null : o.letter)}
                className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-left ${on ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200'}`}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${on ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{o.letter}</span>
                <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug text-gray-900">{o.label}</span>
                {o.letter === rec && <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">Recommended</span>}
              </button>
            );
          })}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
      )}
      {ticket.answer && <div className="mt-2 shrink-0 px-4"><kit.AnswerStatus answer={ticket.answer} /></div>}
      <FitText className="mt-2 px-4" onMore={() => open('details')}>
        {d.recommendation && rec && <TextBlock label="Why recommended">{sentence(d.recommendation.replace(/^\s*[A-Z]\b[\s:.,-]*/, ''))}</TextBlock>}
        {d.context?.length > 0 && <TextBlock label="Why you are asked"><ul className="list-disc space-y-0.5 pl-4 text-sm">{d.context.map((c, i) => <li key={i}>{c}</li>)}</ul></TextBlock>}
        {options.length > 0 && !answering && (
          <TextBlock label="Options">{options.map((o) => <span key={o.letter} className="block text-sm">{o.letter}. {o.label}</span>)}</TextBlock>
        )}
      </FitText>
      {proofs.length > 0 && <ProofZone><ProofButton images={proofs} onOpen={gallery.openProof} eager={active} /></ProofZone>}
      {cancelling ? null : fixReq ? <Banner tone="warn">Fix requested: it answers this decision.</Banner> : null}
      <ThumbBar
        actions={[
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          { id: 'chat', label: 'Chat', icon: icons.chat, badge: chatCount(ticket), onClick: () => open('chat') },
          ...(d.question ? [] : [{ id: 'jira', label: 'Jira', icon: icons.open, href: JIRA_BROWSE + ticket.key }]),
          ...(cancelling || !d.question ? [] : fixActions(ticket, kit, open)),
        ]}
        primary={primary}
      />
      <Portal>{gallery.viewer}</Portal>
      {sheet === 'details' && (
        <DetailsSheet ticket={ticket} onClose={close} focus={!locked && !final ? '[data-send-answer]' : null}>
          <kit.DecisionCard ticket={ticket} onAnswered={onUpdate} onUpdate={onUpdate} proofSize="small" />
        </DetailsSheet>
      )}
      {sheet === 'chat' && (
        <ChatSheet ticket={ticket} onClose={close}>
          <kit.TicketThread ticket={ticket} onUpdate={onUpdate} locked={cancelling} onOpenImage={gallery.openShot} hint="Chat is for questions. It never decides: send your decision with the form, or use Request a fix." />
        </ChatSheet>
      )}
      {sheet === 'fix' && (
        <Sheet title={`${ticket.key} · Request a fix`} label="fix" onClose={close}>
          <kit.FixRequestBar ticket={ticket} onUpdate={onUpdate} startOpen onDone={close} />
        </Sheet>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- Manual, Shipped, building

const usd = (n) => `$${n.toFixed(2)}`;

function ManualPage({ ticket, onUpdate, kit }) {
  const { sheet, open, close } = usePageSheet();
  const m = ticket.manual || {};
  const pr = kit.mergePlan(ticket.prs)[0]?.pr;
  return (
    <article data-phone-card="manual" data-ticket={ticket.key} className="flex h-full flex-col bg-white">
      <PageTop ticket={ticket} pill={{ kind: 'bad', icon: PauseIcon, label: 'Stopped over budget' }} dates={when(m.stopped_at)}
        summary={ticket.plain?.improves || ticket.title || ticket.plain?.problem} chips={<FlagLine ticket={ticket} kit={kit} />} />
      <FitText className="mt-2 px-4" onMore={() => open('details')}>
        <TextBlock label="Automation spent">
          <span className="font-semibold tabular-nums">{m.spend_usd == null ? 'not metered' : usd(m.spend_usd)}</span>
          <span className="text-sm text-gray-500"> {[m.leg_kind && `on its ${m.leg_kind} round`, m.spend_note].filter(Boolean).join(', ')}</span>
        </TextBlock>
        <TextBlock label="Why it stopped"><span className="whitespace-pre-line">{m.reason}</span></TextBlock>
      </FitText>
      <ThumbBar
        actions={[
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          { id: 'jira', label: 'Jira', icon: icons.open, href: JIRA_BROWSE + ticket.key },
          ...(pr ? [{ id: 'pr', label: prLabel(pr), icon: icons.open, href: pr.url }] : []),
        ]}
        primary={ticket.plan?.on ? { id: 'plan', label: 'Plan a test', icon: BeakerIcon, onClick: () => open('plan') } : null}
      />
      {sheet === 'details' && (
        <DetailsSheet ticket={ticket} onClose={close}><kit.ManualList tickets={[ticket]} onUpdate={onUpdate} /></DetailsSheet>
      )}
      {sheet === 'plan' && (
        <Sheet title={`${ticket.key} · Plan a cheaper test`} label="plan" tall onClose={close}>
          <kit.StrategyBlock strategy={ticket.plan.strategy} />
          <kit.PlanThread ticket={ticket} onUpdate={onUpdate} manual />
        </Sheet>
      )}
    </article>
  );
}

function ShippedPage({ ticket, active, onUpdate, kit }) {
  const gallery = kit.useGallery(ticket);
  const { sheet, open, close } = usePageSheet();
  const cancelled = ticket.queue === 'cancelled';
  const pr = kit.mergePlan(ticket.prs)[0]?.pr;
  const proofs = proofsOf(ticket);
  return (
    <article data-phone-card="shipped" data-ticket={ticket.key} className="flex h-full flex-col bg-white">
      <PageTop ticket={ticket}
        pill={cancelled ? { kind: 'muted', label: `Cancelled ${when(ticket.cancelled_at)}` } : { kind: 'ok', label: `Merged ${when(ticket.merged_at)}` }}
        dates={ticketDates(ticket)} summary={ticket.plain?.improves ? null : ticket.title} chips={<FlagLine ticket={ticket} kit={kit} />} />
      <FitText keepAll hug={proofs.length > 0} className="mt-2 px-4" onMore={() => open('details')}>
        {cancelled && ticket.cancel?.reason && <TextBlock label="Why cancelled">{ticket.cancel.reason}</TextBlock>}
        <TextBlock label="What improved" strong>{ticket.plain?.improves}</TextBlock>
        <TextBlock label="Problem it solved">{ticket.plain?.problem}</TextBlock>
        <TextBlock label="How it solved it">{ticket.plain?.how}</TextBlock>
        {(ticket.prs || []).length > 0 && <TextBlock label="PRs">{kit.mergePlan(ticket.prs).map(({ pr: p }) => `${prLabel(p)}${cancelled ? ' (closed)' : ''}`).join(', ')}</TextBlock>}
      </FitText>
      {proofs.length > 0 && <ProofZone grow><ProofButton grow images={proofs} onOpen={gallery.openProof} eager={active} /></ProofZone>}
      <ThumbBar
        actions={[
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          { id: 'jira', label: 'Jira', icon: icons.open, href: JIRA_BROWSE + ticket.key },
        ]}
        primary={pr ? { id: 'pr', label: `Open ${prLabel(pr)}`, icon: icons.open, href: pr.url, muted: true } : null}
      />
      <Portal>{gallery.viewer}</Portal>
      {sheet === 'details' && (
        <DetailsSheet ticket={ticket} onClose={close}><kit.ShippedList tickets={[ticket]} onUpdate={onUpdate} /></DetailsSheet>
      )}
    </article>
  );
}

function BuildingPage({ ticket, onUpdate, kit }) {
  const { sheet, open, close } = usePageSheet();
  const d = kit.latestDirective(ticket.chat);
  return (
    <article data-phone-card="building" data-ticket={ticket.key} className="flex h-full flex-col bg-white">
      <PageTop ticket={ticket} pill={{ kind: 'warn', icon: icons.fix, label: d ? `Fix in progress since ${when(d.at)}` : 'Fix in progress' }}
        dates={ticketDates(ticket)} summary={ticket.plain?.improves || ticket.title} chips={<FlagLine ticket={ticket} kit={kit} />} />
      <FitText className="mt-2 px-4" onMore={() => open('details')}>
        <TextBlock label="Where it stands">{kit.FIX_STAGE_TEXT[ticket.fix_round?.stage] || 'The fix round is building. It comes back to Ready to merge once re-checked.'}</TextBlock>
        {d && <TextBlock label="Your request">{d.text}</TextBlock>}
      </FitText>
      <ThumbBar actions={[
        { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
        { id: 'jira', label: 'Jira', icon: icons.open, href: JIRA_BROWSE + ticket.key },
      ]} />
      {sheet === 'details' && (
        <DetailsSheet ticket={ticket} onClose={close}><kit.BuildingList tickets={[ticket]} onUpdate={onUpdate} /></DetailsSheet>
      )}
    </article>
  );
}

const PAGES = { merge: MergePage, decide: DecisionPage, manual: ManualPage, shipped: ShippedPage, building: BuildingPage };

/** The phone feed of one ticket tab (not Validation, not Claims). */
export default function PhoneTickets({ items, empty, onUpdate, kit }) {
  return (
    <TicketFeed
      items={items}
      empty={empty}
      renderPage={(it, active) => {
        const Page = PAGES[it.kind];
        return <Page ticket={it.ticket} active={active} onUpdate={onUpdate} kit={kit} />;
      }}
    />
  );
}

/** Feed rows for a tab: the ticket, its page kind, and the line the jump list shows. */
export function feedItems(list, kind) {
  return list.map((t) => ({
    key: t.key,
    kind: kind === 'shipped' || kind === 'building' || kind === 'manual' || kind === 'decide' ? kind : 'merge',
    ticket: t,
    summary: kind === 'decide' ? (t.decision?.question || t.title) : (t.plain?.improves || t.title || t.key),
  }));
}

// ---------------------------------------------------------------- Awaiting validation

const GATE_PILL = {
  pending: (t) => (t.max_related ? { kind: 'warn', label: 'Costs MAX runs · awaits you' } : { kind: 'muted', label: 'No MAX cost' }),
  later: (t) => ({ kind: 'muted', label: `Later · since ${when(t.gate_at)}` }),
  validated: (t) => (t.gate_jira_at ? { kind: 'ok', label: 'Validated · in the fix queue' } : { kind: 'warn', label: 'Validated · not queued yet' }),
  auto: () => ({ kind: 'muted', label: 'Flows on its own' }),
  dismissed: () => ({ kind: 'muted', label: 'Dismissed' }),
};

function GatePage({ ticket, gate, sel, onUpdate, kit }) {
  const { sheet, open, close } = usePageSheet();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dismissing, setDismissing] = useState(false);
  const decidable = ticket.gate === 'pending' || ticket.gate === 'later';
  const merging = !!(ticket.merge && !ticket.merge.done_at);
  const blocks = ticket.merge?.blocks || [];
  const planHost = gate.planHostOf(ticket);
  const advance = useFeedAdvance();
  const defer = useDeferred();
  const act = async (action) => {
    setBusy(action);
    setError(null);
    try {
      const data = await post('/api/admin/pipeline/gate', { key: ticket.key, action });
      advance(ticket.key, `${ticket.key}: ${{ validate: 'validated, sent to the fix queue', later: 'moved to Later', back: 'back to waiting' }[action]}`);
      onUpdate(data.ticket);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const later = ticket.gate === 'later';
  return (
    <article data-phone-card="gate" data-ticket={ticket.key} data-gate={ticket.gate} className="flex h-full flex-col bg-white">
      <PageTop
        ticket={ticket}
        select={gate.mergeable(ticket) ? <SelectToggle ticketKey={ticket.key} selected={sel.isSel(ticket.key)} disabled={sel.full} onToggle={() => sel.toggle(ticket.key)} /> : null}
        pill={(GATE_PILL[ticket.gate] || GATE_PILL.auto)(ticket)}
        dates={ticketDates(ticket)}
        summary={ticket.title || ticket.key}
        lines={6}
        chips={(
          <div data-phone-flags className="mt-1.5 flex h-6 items-center gap-1 overflow-hidden">
            <gate.SourceChips ticket={ticket} />
            {gate.inPlanOf(ticket) && <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">In the test plan on {gate.inPlanOf(ticket)}</span>}
          </div>
        )}
      />
      <FitText className="mt-2 px-4" onMore={() => open('details')}>
        {blocks.length > 1
          ? <TextBlock label={`${blocks.length} problems`}>{blocks.map((b, i) => <span key={b.key} className="block text-sm">{i + 1}. {b.title || b.key}</span>)}</TextBlock>
          : <TextBlock label="What is wrong">{sentence(ticket.plain?.problem || ticket.excerpt)}</TextBlock>}
        {blocks.length < 2 && (ticket.claim_ids || []).length > 0 && (
          <TextBlock label="Why it exists">{ticket.claim_ids.map((c) => <span key={c} className="block">From claim {c}.</span>)}</TextBlock>
        )}
        {ticket.gate !== 'pending' && <TextBlock label="Cost">{ticket.max_related ? 'Uses MAX: fixing it and checking the fix run real MAX conversations.' : 'Uses MAX: no. It goes to the fix queue on its own.'}</TextBlock>}
        {ticket.gate_note && <TextBlock label="Reason">{ticket.gate_note}</TextBlock>}
      </FitText>
      {planHost && gate.renderPlanEntry && <div className="shrink-0 px-4 [&_button]:min-h-[44px]">{gate.renderPlanEntry(ticket)}</div>}
      {error && <p role="alert" className="mx-4 mt-1 shrink-0 text-sm text-red-700">{error}</p>}
      {(ticket.gate_jira_error || (ticket.merge && !ticket.merge.done_at && ticket.merge.error)) && <Banner>Jira was not updated. Retry in Details.</Banner>}
      <ThumbBar
        actions={decidable ? [
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          later
            ? { id: 'back', label: busy === 'back' ? 'Moving…' : 'Back', icon: ArrowUturnLeftIcon, onClick: () => act('back'), disabled: !!busy }
            : { id: 'later', label: busy === 'later' ? 'Moving…' : 'Later', icon: icons.later, onClick: () => act('later'), disabled: !!busy },
          { id: 'dismiss', label: 'Dismiss', icon: icons.dismiss, tone: 'danger', onClick: () => setDismissing(true), disabled: !!busy || merging },
        ] : [
          { id: 'details', label: 'Details', icon: icons.details, onClick: () => open('details') },
          { id: 'jira', label: 'Jira', icon: icons.open, href: JIRA_BROWSE + ticket.key },
        ]}
        primary={decidable ? {
          id: 'validate', label: busy === 'validate' ? 'Validating…' : 'Validate', icon: icons.check, disabled: !!busy || merging,
          // Validate labels the ticket on Jira at once: 4 seconds to undo a slip of the thumb first
          onClick: () => (defer ? defer({ text: `Validating ${ticket.key}…`, run: () => act('validate') }) : act('validate')),
        } : null}
      />
      {dismissing && <Portal><gate.DismissDialog ticket={ticket} onClose={() => setDismissing(false)} onDone={(t) => { advance(ticket.key, `${ticket.key}: dismissed`); onUpdate(t); }} /></Portal>}
      {sheet === 'details' && <DetailsSheet ticket={ticket} onClose={close}>{gate.renderDetails(ticket)}</DetailsSheet>}
    </article>
  );
}

/**
 * The Validation tab on a phone: its tickets as pages (waiting, later, then
 * validated, flowing, dismissed), the suggested bundles and the selection in a
 * strip under the header. GateClient keeps all the state; this only lays it out.
 */
export function PhoneGate({ lists, gate, sel, bundleCount, renderBundles, onUpdate, dialogs }) {
  const [bundlesOpen, setBundlesOpen] = useState(false);
  const closeBundles = () => setBundlesOpen(false);
  const order = ['pending', 'later', 'validated', 'auto', 'dismissed'];
  const items = order.flatMap((k) => lists[k].map((t) => ({ key: t.key, ticket: t, summary: t.title || t.key })));
  const selected = sel.selected;
  const canPlan = !!sel.onPlan && selected.length > 0 && selected.every((t) => t.plan?.on);
  return (
    <>
      {selected.length > 0 ? (
        <PhoneStrip>
          <p data-phone-selected className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{selected.length} selected</p>
          <StripButton onClick={sel.onClear} className="ring-0 text-gray-500">Clear</StripButton>
          {canPlan && <StripButton data-plan-open onClick={sel.onPlan}><BeakerIcon className="h-4 w-4" aria-hidden />Plan</StripButton>}
          <StripButton primary data-merge-open onClick={sel.onMerge} disabled={selected.length < 2}>Merge</StripButton>
        </PhoneStrip>
      ) : bundleCount > 0 ? (
        <PhoneStrip>
          <button type="button" data-phone-bundles onClick={() => setBundlesOpen(true)} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left text-sm font-medium text-gray-800">
            <icons.bundles className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            <span className="truncate">{bundleCount} suggested bundle{bundleCount === 1 ? '' : 's'}</span>
            <span className="ml-auto shrink-0 text-indigo-700">Review</span>
          </button>
        </PhoneStrip>
      ) : null}
      <TicketFeed
        items={items}
        empty={<p className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">No MAX fix is waiting for your validation.</p>}
        renderPage={(it) => <GatePage ticket={it.ticket} gate={gate} sel={sel} onUpdate={onUpdate} />}
      />
      {bundlesOpen && (
        <Sheet title="Suggested bundles" label="bundles" tall onClose={closeBundles}>
          <div className="-mx-4 pt-1">{renderBundles(closeBundles)}</div>
        </Sheet>
      )}
      {dialogs}
    </>
  );
}
