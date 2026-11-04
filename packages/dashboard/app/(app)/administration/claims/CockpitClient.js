'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowsRightLeftIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FunnelIcon,
  LockClosedIcon,
  PauseIcon,
  PhotoIcon,
  PlusIcon,
  SparklesIcon,
  TagIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import {
  CHAT_IMAGE_MAX, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, FLAG_LABEL_MAX, FLAG_PRESETS,
  chatAwaitingReply, filterByFlags, fixOutcome, fixOutcomeKind, flagCounts, latestDirective, mergePlan,
  openFixRequest, sortTickets, threadOrder,
} from '@/app/lib/pipeline-cockpit';
import ClaimsClient from './ClaimsClient';
import { PhoneCockpit, useIsPhone } from './MobileCockpit';
import { PhoneViewer, ViewerBoundary } from './PhoneViewer';
import PhoneTickets, { feedItems } from './PhoneTickets';
import GateClient, { gateLists } from './GateClient';
import { PlanOutcome, StrategyBlock, latestPlanClose } from './PlanTesting';
import { SortControl, TicketDates, TicketSortProvider, useStoredTicketSort } from './TicketSort';

const JIRA_BROWSE = 'https://magifyfun.atlassian.net/browse/';
const REPO_SHORT = { magify_agents_api: 'api', magify_next: 'next' };

const TABS = [
  { key: 'validate', label: 'Awaiting validation' },
  { key: 'merge', label: 'Ready to merge' },
  { key: 'decide', label: 'Needs decision' },
  { key: 'manual', label: 'Manual' },
  { key: 'claims', label: 'Claims' },
  { key: 'shipped', label: 'Shipped' },
];

const evidenceSrc = (e) => `/api/admin/pipeline/evidence?k=${encodeURIComponent(e.s3_key)}`;
const prLabel = (p) => `${REPO_SHORT[p.repo] || p.repo}#${p.number}`;

function formatWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

// ultimatehuman: which configured repo a ticket is about (config repos[].name). Absent = no badge.
function RepoBadge({ repo }) {
  if (!repo) return null;
  return (
    <span
      data-repo-badge={repo}
      title={`Repo: ${repo}`}
      className="shrink-0 whitespace-nowrap rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-indigo-700"
    >
      {repo}
    </span>
  );
}

// Label beside the text up to xl; from xl the three rows sit side by side as columns.
function PlainRow({ label, children }) {
  if (!children) return null;
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10.5rem_1fr] sm:gap-4 xl:grid-cols-1 xl:gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-400 sm:pt-0.5 xl:pt-0">{label}</dt>
      <dd className="text-[15px] leading-relaxed text-gray-900">{children}</dd>
    </div>
  );
}

const SWIPE_PX = 50;

/**
 * Full-size proof viewer for one ticket: ←/→ (keys, buttons, swipe) travel
 * through all its images in order and loop; Esc or a click outside closes.
 * The neighbours are preloaded so a switch is instant.
 */
function Lightbox({ images, index, onIndex, onClose }) {
  const n = images.length;
  const image = images[index];
  const step = useCallback((d) => onIndex((index + d + n) % n), [index, n, onIndex]);
  const touch = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (n > 1 && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (n > 1 && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step, n]);
  useEffect(() => {
    if (n < 2) return;
    [images[(index + 1) % n], images[(index - 1 + n) % n]].forEach((e) => { new window.Image().src = evidenceSrc(e); });
  }, [images, index, n]);
  const onTouchStart = (e) => { touch.current = e.touches[0]?.clientX ?? null; };
  const onTouchEnd = (e) => {
    const start = touch.current;
    touch.current = null;
    const dx = start == null ? 0 : (e.changedTouches[0]?.clientX ?? start) - start;
    if (n > 1 && Math.abs(dx) > SWIPE_PX) step(dx < 0 ? 1 : -1);
  };
  // dark and opaque enough to stay visible over a white screenshot (phones: the image spans the width)
  const arrow = 'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-gray-900/70 p-2.5 text-white shadow-lg ring-1 ring-white/20 hover:bg-gray-900/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:p-3';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.caption || image.name}
      data-lightbox
      data-lightbox-index={index}
      data-lightbox-kind={image.chat ? 'chat' : 'proof'}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-gray-950/85 p-4 sm:px-20 sm:py-8"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <XMarkIcon className="h-5 w-5" aria-hidden />
      </button>
      {n > 1 && (
        <>
          <p data-lightbox-position className="absolute left-4 top-4 z-10 rounded-full bg-gray-900/70 px-2.5 py-1 text-xs font-medium tabular-nums text-white" aria-live="polite">
            {index + 1} / {n}
          </p>
          <button type="button" data-lightbox-prev aria-label="Previous image" onClick={(e) => { e.stopPropagation(); step(-1); }} className={`${arrow} left-2 sm:left-5`}>
            <ChevronLeftIcon className="h-6 w-6" aria-hidden />
          </button>
          <button type="button" data-lightbox-next aria-label="Next image" onClick={(e) => { e.stopPropagation(); step(1); }} className={`${arrow} right-2 sm:right-5`}>
            <ChevronRightIcon className="h-6 w-6" aria-hidden />
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={image.sha256}
        src={evidenceSrc(image)}
        alt={image.caption || image.name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[82vh] max-w-full rounded-lg bg-white object-contain shadow-2xl"
      />
      <p data-lightbox-caption className="max-w-3xl text-center text-sm text-gray-200">{image.caption || image.name}</p>
    </div>
  );
}

// Placeholder ratio of the usual 1440x992 QA shot, so lazy images keep their slot until loaded.
const PLACEHOLDER_RATIO = '1440 / 992';

/**
 * One proof at a readable size: never cropped, as wide as its column, and
 * capped to 75vh so a tall phone shot stays whole on screen.
 */
function ProofFigure({ image, onOpen, small }) {
  const [loaded, setLoaded] = useState(false);
  // Small: the compact 4:3 thumbnail from sm up; phones keep the large layout.
  const thumb = small ? ' sm:aspect-[4/3] sm:w-full sm:max-h-none sm:object-cover sm:object-left-top' : '';
  return (
    <figure data-evidence={image.name} className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open full size: ${image.caption || image.name}`}
        className="group block w-full cursor-zoom-in overflow-hidden rounded-lg border border-gray-200 bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={evidenceSrc(image)}
          alt={image.caption || image.name}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          style={loaded ? undefined : { aspectRatio: PLACEHOLDER_RATIO }}
          className={`mx-auto block transition-opacity group-hover:opacity-90 ${
            loaded ? 'h-auto max-h-[75vh] w-auto max-w-full' : 'w-full'
          }${thumb}`}
        />
      </button>
      <figcaption className={`mt-2 text-sm leading-snug text-gray-700${small ? ' sm:mt-1 sm:line-clamp-2 sm:text-xs sm:text-gray-500' : ''}`}>{image.caption || image.name}</figcaption>
    </figure>
  );
}

function Proofs({ evidence, size, onOpen }) {
  const small = size === 'small';
  const ready = evidence.filter((e) => e.s3_key);
  if (!evidence.length) return null;
  return (
    <section className="mt-5" aria-label="Proof screenshots">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400">
        Proof <span className="normal-case tracking-normal text-gray-400">· {evidence.length} screenshots</span>
      </h3>
      {ready.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">The screenshots upload on the next pipeline sync.</p>
      ) : (
        // Large: columns of at least 600px (one per row on a laptop, two at 1920).
        // Small: 3 to 4 thumbnails per row, full size in the lightbox.
        <div
          data-proof-grid
          data-proof-size={small ? 'small' : 'large'}
          className={`mt-3 grid items-start ${
            small
              ? 'grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-3 sm:gap-3 xl:grid-cols-4'
              : 'gap-x-5 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,600px),1fr))]'
          }`}
        >
          {ready.map((e, i) => <ProofFigure key={e.sha256} image={e} onOpen={() => onOpen(i)} small={small} />)}
        </div>
      )}
    </section>
  );
}

/**
 * Every image of one card for the fullscreen viewer: its proofs first (in the
 * grid's order), then the screenshots of its conversation, oldest first. The
 * arrows travel through all of them.
 */
function galleryOf(ticket) {
  const proofs = (ticket.evidence || []).filter((e) => e.s3_key);
  const shots = byTime(ticket.chat).flatMap((m) => {
    const list = m.images || [];
    const what = m.kind === 'directive' ? 'Screenshot with your fix request' : 'Your screenshot in the chat';
    return list.map((img, n) => ({
      ...img,
      chat: m.id,
      caption: `${what} · ${chatWhen(m.at)}${list.length > 1 ? ` · ${n + 1} of ${list.length}` : ''}${img.name ? ` · ${img.name}` : ''}`,
    }));
  });
  return [...proofs, ...shots];
}

/**
 * The card's viewer: open a proof by its index, a chat screenshot by message + sha256.
 * Phones get the touch viewer (PhoneViewer.js) inside its own error boundary.
 */
function useGallery(ticket) {
  const phone = useIsPhone();
  const images = useMemo(() => galleryOf(ticket), [ticket]);
  const [open, setOpen] = useState(null);
  const close = useCallback(() => setOpen(null), []);
  const openProof = useCallback((i) => setOpen(i), []);
  const openShot = useCallback((messageId, sha256) => {
    const i = images.findIndex((x) => x.chat === messageId && x.sha256 === sha256);
    if (i >= 0) setOpen(i);
  }, [images]);
  let viewer = null;
  if (open != null && images[open]) {
    viewer = phone
      ? <ViewerBoundary onClose={close}><PhoneViewer images={images} index={open} onIndex={setOpen} onClose={close} /></ViewerBoundary>
      : <Lightbox images={images} index={open} onIndex={setOpen} onClose={close} />;
  }
  return { openProof, openShot, viewer };
}

function Development({ ticket }) {
  const [open, setOpen] = useState(false);
  const totals = ticket.prs.reduce((acc, p) => ({
    files: acc.files + (p.changed_files || 0),
    add: acc.add + (p.additions || 0),
    del: acc.del + (p.deletions || 0),
  }), { files: 0, add: 0, del: 0 });
  const id = `dev-${ticket.key}`;
  return (
    <section className="mt-5 border-t border-gray-100 pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm font-medium text-gray-700 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <ChevronRightIcon className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        Development
        <span className="ml-2 font-normal text-gray-400">
          {ticket.prs.map(prLabel).join(', ')} · {totals.files} files
          <span className="text-emerald-600"> +{totals.add}</span>
          <span className="text-red-600"> −{totals.del}</span>
        </span>
      </button>
      {open && (
        <div id={id} data-development className="mt-3 space-y-4 text-sm">
          {ticket.prs.map((p) => (
            <div key={`${p.repo}#${p.number}`}>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:text-indigo-900"
              >
                {prLabel(p)}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden />
              </a>
              <span className="ml-2 text-gray-700">{p.title}</span>
              <p className="mt-0.5 text-xs text-gray-400">
                <span className="font-mono">{p.head}</span> into <span className="font-mono">{p.base}</span>
              </p>
              {p.files?.length > 0 && (
                <ul className="mt-1.5 divide-y divide-gray-100 rounded-md border border-gray-100 font-mono text-xs">
                  {p.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-3 px-2.5 py-1">
                      <span className="min-w-0 flex-1 truncate text-gray-700" title={f.path}>{f.path}</span>
                      <span className="shrink-0 tabular-nums text-emerald-600">+{f.additions}</span>
                      <span className="w-10 shrink-0 text-right tabular-nums text-red-600">−{f.deletions}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {ticket.verdict && (
            <div data-verdict>
              <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Hostile check{ticket.fix_class ? ` · ${ticket.fix_class.toLowerCase()} fix` : ''}
              </h4>
              <p className="mt-1 whitespace-pre-line leading-relaxed text-gray-700 [overflow-wrap:anywhere]">{ticket.verdict}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const ordinal = (n) => `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n] || 'th'}`;

/**
 * One "Open on GitHub" row per PR, in merge order. The page never merges:
 * Vincent merges each PR on GitHub, top to bottom. A held ticket keeps its
 * links, below the red warning.
 */
function GitHubLinks({ ticket, held: heldByPage = false }) {
  const plan = mergePlan(ticket.prs);
  const many = plan.length > 1;
  const held = !!ticket.hold || heldByPage;
  return (
    <section data-github-links aria-label="Merge on GitHub" className="space-y-2">
      {many && (
        <p data-merge-order className="text-sm font-semibold text-gray-900">
          Merge order: {plan.length} PRs, one at a time, top to bottom
        </p>
      )}
      <ol className="space-y-2">
        {plan.map(({ pr, step, parent }) => {
          const prev = step > 1 ? plan[step - 2].pr : null;
          return (
            <li
              key={`${pr.repo}#${pr.number}`}
              data-pr-step={step}
              data-pr={prLabel(pr)}
              className="flex flex-col gap-2 rounded-lg border border-gray-200 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
            >
              {many && (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-sm font-bold text-white" aria-hidden>
                  {step}
                </span>
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate text-gray-900" title={pr.title}>
                  <span className="font-semibold">{prLabel(pr)}</span>
                  <span className="text-gray-500"> · {pr.title}</span>
                </p>
                {many && (
                  <p data-step-note className={`mt-0.5 text-xs ${parent ? 'font-medium text-amber-800' : 'text-gray-500'}`}>
                    {step === 1 && 'Merge 1st.'}
                    {step > 1 && parent && `Merge ${ordinal(step)}, after its parent ${prLabel(parent)} (stacked on it). If GitHub still shows this PR into ${parent.head}, change its base to ${parent.base} first.`}
                    {step > 1 && !parent && `Merge ${ordinal(step)}, after ${prLabel(prev)}.`}
                  </p>
                )}
              </div>
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                data-open-github={prLabel(pr)}
                className={`inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  held
                    ? 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:ring-gray-400'
                    : 'bg-gray-900 text-white hover:bg-gray-700 focus:ring-gray-900'
                }`}
              >
                Open {prLabel(pr)} on GitHub
                <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden />
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- conversation

const REFRESH_MS = 30 * 1000;
const SLOW_REPLY_MS = 20 * 60 * 1000;

function chatWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

const byTime = (chat) => [...(chat || [])].sort((a, b) => new Date(a.at) - new Date(b.at));

const BULLET = /^\s*[-•]\s+/;

/** `code` spans as inline code, the rest as text. */
function Inline({ text }) {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (/^`[^`]+`$/.test(part)
    ? <code key={i} className="rounded bg-black/[0.06] px-1 py-px font-mono text-[12.5px]">{part.slice(1, -1)}</code>
    : part));
}

/**
 * The pipeline's plain-text replies: paragraphs split by blank lines, runs of
 * "- " lines as bullet lists (with or without an intro line above them).
 */
function MessageText({ text }) {
  const out = [];
  (text || '').split(/\n\s*\n/).forEach((block, b) => {
    let lines = [];
    let items = [];
    const flush = () => {
      if (lines.length) out.push(<p key={`${b}-p${out.length}`} className="whitespace-pre-line"><Inline text={lines.join('\n')} /></p>);
      if (items.length) {
        out.push(
          <ul key={`${b}-u${out.length}`} className="list-disc space-y-1 pl-4">
            {items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
          </ul>
        );
      }
      lines = [];
      items = [];
    };
    block.split('\n').forEach((l) => {
      if (BULLET.test(l)) {
        if (lines.length) flush(); // the intro line above the list
        items.push(l.replace(BULLET, ''));
      } else if (!l.trim()) {
        // blank line inside a block: ignore
      } else if (items.length && /^\s{2,}\S/.test(l)) {
        items[items.length - 1] += ` ${l.trim()}`; // wrapped bullet
      } else {
        if (items.length) flush();
        lines.push(l);
      }
    });
    flush();
  });
  return out;
}

/** The screenshots of one message: thumbnails, each opens the card's fullscreen viewer. */
function ChatImages({ message, onOpen, align = 'end' }) {
  const images = message.images || [];
  if (!images.length) return null;
  return (
    <div data-chat-images={message.id} className={`mb-1.5 flex flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {images.map((img, n) => (
        <button
          key={img.sha256}
          type="button"
          data-chat-image={img.sha256}
          onClick={() => onOpen?.(message.id, img.sha256)}
          aria-label={`Open screenshot ${n + 1} of ${images.length} full size`}
          className="group block h-24 w-32 cursor-zoom-in overflow-hidden rounded-xl border border-gray-200 bg-gray-100 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:h-28 sm:w-40"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={evidenceSrc(img)} alt={img.name || `Screenshot ${n + 1}`} loading="lazy" className="h-full w-full object-cover object-left-top transition-opacity group-hover:opacity-90" />
        </button>
      ))}
    </div>
  );
}

/** Vincent's fix request in the thread: a directive, not a chat message. */
function DirectiveBubble({ message, onOpenImage }) {
  return (
    <li data-chat-message="directive" data-directive={message.id} className="flex justify-end">
      <div className="flex min-w-0 max-w-[85%] flex-col items-end">
        <ChatImages message={message} onOpen={onOpenImage} />
        <div className="rounded-2xl rounded-br-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[14px] leading-relaxed text-amber-950 [overflow-wrap:anywhere]">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <WrenchScrewdriverIcon className="h-3.5 w-3.5" aria-hidden />
            Fix request
          </p>
          <div className="space-y-2"><MessageText text={message.text} /></div>
          {message.context && (
            <p className="mt-1.5 text-xs text-amber-800/80">With the conversation above it as context.</p>
          )}
        </div>
        <p className="mt-1 px-1 text-[11px] text-gray-400">
          You · {chatWhen(message.at)} · {message.ack_error
            ? <span className="text-red-600">{message.ack_error}</span>
            : (message.acked_at ? 'filed on the ticket' : 'sent to the pipeline')}
        </p>
      </div>
    </li>
  );
}

const OUTCOME_LOOK = {
  delivered: { Icon: CheckCircleIcon, avatar: 'bg-emerald-50 text-emerald-600 ring-emerald-200', bubble: 'bg-emerald-50 text-emerald-950 ring-1 ring-inset ring-emerald-200' },
  failed: { Icon: ExclamationTriangleIcon, avatar: 'bg-red-50 text-red-600 ring-red-200', bubble: 'bg-red-50 text-red-950 ring-1 ring-inset ring-red-200' },
};

function Bubble({ message, onRequestFix, requesting, onOpenImage }) {
  if (message.kind === 'directive') return <DirectiveBubble message={message} onOpenImage={onOpenImage} />;
  const mine = message.role === 'vincent';
  const outcome = OUTCOME_LOOK[fixOutcomeKind(message)];
  const Avatar = outcome?.Icon || SparklesIcon;
  return (
    <li data-chat-message={message.role} data-chat-id={message.id} data-fix-outcome={fixOutcomeKind(message) || undefined} className={`flex gap-2.5 ${mine ? 'justify-end' : 'justify-start'}`}>
      {!mine && (
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${outcome?.avatar || 'bg-indigo-50 text-indigo-600 ring-indigo-100'}`} aria-hidden>
          <Avatar className="h-4 w-4" />
        </span>
      )}
      <div className={`flex min-w-0 max-w-[85%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        <ChatImages message={message} onOpen={onOpenImage} align={mine ? 'end' : 'start'} />
        {message.text && (
          <div
            className={`space-y-2 rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed [overflow-wrap:anywhere] ${
              mine ? 'rounded-br-md bg-gray-900 text-white' : `rounded-bl-md ${outcome?.bubble || 'bg-gray-100 text-gray-900'}`
            }`}
          >
            <MessageText text={message.text} />
          </div>
        )}
        <p className="mt-1 px-1 text-[11px] text-gray-400">
          {mine ? 'You' : 'Pipeline'} · {chatWhen(message.at)}
          {mine && message.source === 'jira' && ' · from Jira'}
          {mine && message.ack_error && <span className="text-red-600"> · {message.ack_error}</span>}
          {mine && onRequestFix && (
            <>
              {' · '}
              <button
                type="button"
                data-request-this-fix={message.id}
                onClick={() => onRequestFix(message.id)}
                disabled={requesting}
                className="inline-flex items-center gap-1 rounded font-medium text-amber-700 hover:text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
              >
                <WrenchScrewdriverIcon className="h-3 w-3" aria-hidden />
                {requesting ? 'Requesting…' : 'Request this fix'}
              </button>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function Answering({ since }) {
  const slow = Date.now() - new Date(since).getTime() > SLOW_REPLY_MS;
  return (
    <li data-chat-answering className="flex gap-2.5" aria-live="polite">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100" aria-hidden>
        <SparklesIcon className="h-4 w-4" />
      </span>
      <div className="flex flex-col items-start">
        <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-gray-100 px-3.5 py-3" aria-hidden>
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
        <p className="mt-1 px-1 text-[11px] text-gray-400">
          {slow
            ? 'Still no answer after 20 minutes. The pipeline may be busy; your message is saved.'
            : 'Answering… replies take a few minutes. You can leave this page.'}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- screenshots in the chat

const ACCEPTED_TYPES = Object.values(CHAT_IMAGE_TYPES);
const LIMIT_MB = Math.round(CHAT_IMAGE_MAX_BYTES / (1024 * 1024));
const sizeMb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const imageFiles = (list) => [...(list || [])].filter((f) => f && f.kind !== 'string');

/**
 * Screenshots attached to the message being written: each uploads as soon as
 * it is picked, pasted or dropped (PNG, JPG or WebP, up to 10 MB, 5 per
 * message). Refused files get a plain reason in `notice`; `images` are the
 * uploaded ones to send.
 */
function useAttachments(ticketKey) {
  const [items, setItems] = useState([]); // { id, name, preview, status: uploading|done|error, image, error }
  const [notice, setNotice] = useState(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  const upload = async (item, file) => {
    const form = new FormData();
    form.append('key', ticketKey);
    form.append('file', file);
    let next;
    try {
      const res = await fetch('/api/admin/pipeline/chat-image', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not upload (${res.status})`);
      next = { status: 'done', image: data };
    } catch (err) {
      next = { status: 'error', error: err.message };
    }
    setItems((prev) => prev.map((x) => (x.id === item.id ? { ...x, ...next } : x)));
  };

  const add = (fileList) => {
    const files = imageFiles(fileList);
    if (!files.length) return;
    const refused = [];
    const room = CHAT_IMAGE_MAX - itemsRef.current.length;
    const fresh = [];
    files.forEach((f) => {
      if (!ACCEPTED_TYPES.includes(f.type)) refused.push(`“${f.name || 'This file'}” is not a PNG, JPG or WebP image.`);
      else if (f.size > CHAT_IMAGE_MAX_BYTES) refused.push(`“${f.name || 'This image'}” is ${sizeMb(f.size)}; the limit is ${LIMIT_MB} MB.`);
      else if (fresh.length >= room) refused.push(`Up to ${CHAT_IMAGE_MAX} screenshots per message: “${f.name || 'image'}” was left out.`);
      else fresh.push(f);
    });
    setNotice(refused.length ? refused.join(' ') : null);
    if (!fresh.length) return;
    const made = fresh.map((f) => ({
      id: newRequestId(), name: f.name || 'pasted image', preview: URL.createObjectURL(f), status: 'uploading', file: f,
    }));
    setItems((prev) => [...prev, ...made.map(({ file, ...rest }) => rest)]);
    made.forEach(({ file, ...item }) => upload(item, file));
  };

  const remove = (id) => setItems((prev) => prev.filter((x) => {
    if (x.id === id) URL.revokeObjectURL(x.preview);
    return x.id !== id;
  }));
  const reset = () => {
    itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
    setNotice(null);
  };
  // the clipboard's images (a screenshot pasted into the text field)
  const onPaste = (e) => {
    const files = imageFiles(e.clipboardData?.files);
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  return {
    items,
    notice,
    add,
    remove,
    reset,
    onPaste,
    images: items.filter((i) => i.status === 'done').map((i) => i.image),
    uploading: items.some((i) => i.status === 'uploading'),
    failed: items.some((i) => i.status === 'error'),
    full: items.length >= CHAT_IMAGE_MAX,
  };
}

/** Drag-and-drop of images onto an area: { dragging, props } to spread on it. */
function useDropZone(onFiles) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  return {
    dragging,
    props: {
      onDragEnter: (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setDragging(true); },
      onDragOver: (e) => { if (hasFiles(e)) e.preventDefault(); },
      onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
      onDrop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        onFiles(e.dataTransfer.files);
      },
    },
  };
}

/** The paperclip: opens the file picker (several images at once). */
function AttachButton({ attachments, label = 'Attach screenshots' }) {
  const input = useRef(null);
  return (
    <>
      <button
        type="button"
        data-chat-attach
        onClick={() => input.current?.click()}
        disabled={attachments.full}
        aria-label={label}
        title={`${label} (PNG, JPG or WebP, up to ${LIMIT_MB} MB, ${CHAT_IMAGE_MAX} per message). You can also paste or drop them here.`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40"
      >
        <PhotoIcon className="h-5 w-5" aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        data-chat-file
        accept={ACCEPTED_TYPES.join(',')}
        multiple
        hidden
        onChange={(e) => { attachments.add(e.target.files); e.target.value = ''; }}
      />
    </>
  );
}

/** The screenshots waiting to be sent: thumbnail, upload state, a remove button. */
function AttachStrip({ attachments }) {
  if (!attachments.items.length && !attachments.notice) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {attachments.items.length > 0 && (
        <ul data-attach-strip className="flex flex-wrap gap-2">
          {attachments.items.map((i) => (
            <li key={i.id} data-attachment={i.status} className="relative h-16 w-20 overflow-hidden rounded-lg border border-gray-200 bg-gray-100" title={i.error || i.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.preview} alt={i.name} className={`h-full w-full object-cover object-left-top ${i.status === 'done' ? '' : 'opacity-50'}`} />
              {i.status === 'uploading' && (
                <span className="absolute inset-0 flex items-center justify-center" aria-label="Uploading">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-gray-900" />
                </span>
              )}
              {i.status === 'error' && (
                <span className="absolute inset-x-0 bottom-0 bg-red-600/90 px-1 py-0.5 text-center text-[10px] font-medium leading-tight text-white">Not sent</span>
              )}
              <button
                type="button"
                data-attachment-remove
                onClick={() => attachments.remove(i.id)}
                aria-label={`Remove ${i.name}`}
                className="absolute right-0.5 top-0.5 rounded-full bg-gray-900/75 p-0.5 text-white hover:bg-gray-900"
              >
                <XMarkIcon className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.items.filter((i) => i.status === 'error').map((i) => (
        <p key={i.id} role="alert" data-attach-error className="text-xs text-red-700">“{i.name}”: {i.error}</p>
      ))}
      {attachments.notice && <p role="status" data-attach-notice className="text-xs text-amber-800">{attachments.notice}</p>}
    </div>
  );
}

/**
 * The conversation about one ticket: Vincent asks, the pipeline answers a few
 * minutes later with the whole ticket in mind. It never decides anything:
 * rulings go through the decision form, merges happen on GitHub.
 */
function TicketThread({ ticket, onUpdate, hint, locked, onOpenImage, title, placeholder, flush = false }) {
  const chat = useMemo(() => byTime(ticket.chat), [ticket.chat]);
  const shown = useMemo(() => threadOrder(ticket.chat), [ticket.chat]);
  const [text, setText] = useState('');
  const attachments = useAttachments(ticket.key);
  const drop = useDropZone(attachments.add);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [requesting, setRequesting] = useState(null); // bubble id being requested as a fix
  const canRequest = !locked && fixRequestAllowed(ticket);
  const requestFix = async (from) => {
    if (requesting) return;
    setRequesting(from);
    setError(null);
    try {
      onUpdate(await postFixRequest({ key: ticket.key, from }));
    } catch (err) {
      setError(err.message);
    } finally {
      setRequesting(null);
    }
  };
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const awaiting = chatAwaitingReply(chat);
  const last = chat[chat.length - 1];

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, awaiting]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const canSend = !busy && !attachments.uploading && (!!text.trim() || attachments.images.length > 0);
  const send = async () => {
    const body = text.trim();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/pipeline/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ticket.key, text: body, images: attachments.images }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not send (${res.status})`);
      onUpdate(data);
      setText('');
      attachments.reset();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  if (locked && !chat.length) return null;
  return (
    <section data-thread={ticket.key} aria-label="Conversation about this ticket" className={flush ? '' : 'mt-5 border-t border-gray-100 pt-4'}>
      <h3 className={flush ? 'sr-only' : 'text-xs font-medium uppercase tracking-wide text-gray-400'}>
        {title || (chat.length ? 'Conversation' : 'Ask about this ticket')}
      </h3>
      {(chat.length > 0 || awaiting) && (
        <ol ref={listRef} data-chat-list className={`mt-3 space-y-3 ${flush ? '' : 'max-h-[32rem] overflow-y-auto pr-1'}`}>
          {shown.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              onRequestFix={canRequest && m.role === 'vincent' && m.kind !== 'directive' ? requestFix : null}
              requesting={requesting === m.id}
              onOpenImage={onOpenImage}
            />
          ))}
          {awaiting && !locked && <Answering since={last.at} />}
        </ol>
      )}
      {!locked && (
        <>
          <div
            data-chat-composer
            data-dragging={drop.dragging || undefined}
            {...drop.props}
            className={`relative mt-3 flex items-end gap-1 rounded-xl border bg-white py-1.5 pl-1.5 pr-1.5 shadow-sm focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 ${
              drop.dragging ? 'border-indigo-500 ring-2 ring-indigo-300' : 'border-gray-300'
            }`}
          >
            {drop.dragging && (
              <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-indigo-50/95 text-sm font-medium text-indigo-800">
                Drop the screenshots to attach them
              </p>
            )}
            <AttachButton attachments={attachments} />
            <label htmlFor={`chat-${ticket.key}`} className="sr-only">Message about {ticket.key}</label>
            <textarea
              ref={inputRef}
              id={`chat-${ticket.key}`}
              data-chat-input
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={attachments.onPaste}
              placeholder={chat.length ? 'Reply…' : (placeholder || 'Ask anything about this ticket…')}
              className="block min-h-[32px] flex-1 resize-none border-0 bg-transparent p-0 py-1.5 text-sm leading-5 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0"
            />
            <button
              type="button"
              data-chat-send
              onClick={send}
              disabled={!canSend}
              aria-label="Send message"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-900 text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:bg-gray-200 disabled:text-gray-400"
            >
              <ArrowUpIcon className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <AttachStrip attachments={attachments} />
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          <p className="mt-1.5 text-xs text-gray-400">{hint} Enter sends, Shift+Enter adds a line. Paste or drop screenshots to attach them.</p>
          {canRequest && <FixRequestBar ticket={ticket} onUpdate={onUpdate} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- plan testing

/**
 * A Plan testing thread (pipeline flag COCKPIT_PLAN): the same card chat, but
 * the pipeline's claude CLI debates with Vincent which tickets to test
 * together and how cheaply, and records the agreed strategy when he agrees.
 * On Awaiting validation it lives on the anchor of his selection; on a Manual
 * card it is the card's own thread. In the "Review this bundle" dialog
 * (`inModal`) the dialog scrolls and says what the thread is for.
 */
function PlanThread({ ticket, onUpdate, manual = false, inModal = false }) {
  useTicketRefresh(ticket, onUpdate);
  const gallery = useGallery(ticket);
  const keys = manual ? [ticket.key] : (ticket.plan_thread?.keys || [ticket.key]);
  const close = latestPlanClose(ticket.chat);
  return (
    <div data-plan-thread={ticket.key} data-plan-keys={keys.join(',')}>
      <TicketThread
        ticket={ticket}
        onUpdate={onUpdate}
        onOpenImage={gallery.openShot}
        flush={inModal}
        title={inModal ? 'Conversation with the pipeline' : manual ? 'Plan a cheaper test' : `Plan testing: ${keys.join(' + ')}`}
        placeholder={manual
          ? 'How should we re-test this one without blowing the budget?'
          : 'Ask why these go together, add or drop one, or say “agreed”…'}
        hint={inModal ? undefined : manual
          ? 'The pipeline proposes a cheaper path; when you agree it writes the strategy into the ticket and puts it back in the queue.'
          : 'The pipeline debates the plan; when you agree it merges the agreed tickets and writes the strategy into each one.'}
      />
      {!inModal && <PlanOutcome message={close} />}
      {gallery.viewer}
    </div>
  );
}

// ---------------------------------------------------------------- fix request

const FIX_STAGE_TEXT = {
  queued: 'Waiting for a free fix slot.',
  fixing: 'The fix is being written.',
  checking: 'The hostile check is re-testing it.',
};

/** A new fix request is possible: none in flight, and no decision answer already sent. */
function fixRequestAllowed(ticket) {
  if (!['merge', 'decision'].includes(ticket.queue)) return false;
  if (ticket.cancel && !ticket.cancel.ack_error) return false;
  if (ticket.queue === 'decision' && ticket.answer && !ticket.answer.ack_error) return false;
  return !openFixRequest(ticket);
}

async function postFixRequest(body) {
  const res = await fetch('/api/admin/pipeline/fix-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not request the fix (${res.status})`);
  return data;
}

const newRequestId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * "Request a fix": a one-line box whose text becomes the spec of a new fix
 * round. One request id per opened box, so a double click files once.
 */
function FixRequestBar({ ticket, onUpdate, startOpen = false, onDone }) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const requestId = useRef(startOpen ? newRequestId() : null);
  const attachments = useAttachments(ticket.key);
  const drop = useDropZone(attachments.add);
  const start = () => {
    requestId.current = newRequestId();
    setOpen(true);
    setError(null);
  };
  const submit = async () => {
    const body = text.trim();
    if (!body || busy || attachments.uploading) return;
    setBusy(true);
    setError(null);
    try {
      onUpdate(await postFixRequest({ key: ticket.key, request_id: requestId.current, text: body, images: attachments.images }));
      setText('');
      attachments.reset();
      setOpen(false);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        data-request-fix={ticket.key}
        onClick={start}
        className="mt-3 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 text-sm font-medium text-amber-800 shadow-sm hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <WrenchScrewdriverIcon className="h-4 w-4" aria-hidden />
        Request a fix
      </button>
    );
  }
  return (
    <div
      data-fix-box={ticket.key}
      {...drop.props}
      className={`mt-3 rounded-xl border bg-amber-50/60 p-3 ${drop.dragging ? 'border-amber-500 ring-2 ring-amber-300' : 'border-amber-300'}`}
    >
      <label htmlFor={`fix-${ticket.key}`} className="text-sm font-medium text-amber-950">Request a fix</label>
      <p className="mt-0.5 text-xs text-amber-900/80">
        Not chat: this becomes the spec of a new fix round on {ticket.key}
        {ticket.queue === 'merge' ? ', and the PRs leave Ready to merge until it passes the hostile check again.' : ', and it answers this decision.'}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id={`fix-${ticket.key}`}
          data-fix-input
          autoFocus
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onPaste={attachments.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            if (e.key === 'Escape' && !busy) setOpen(false);
          }}
          placeholder="What should change?"
          className="block min-h-[40px] w-full min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        />
        <div className="flex shrink-0 items-center gap-2">
          <AttachButton attachments={attachments} label="Attach screenshots to the fix request" />
          <button type="button" onClick={() => { attachments.reset(); setOpen(false); }} disabled={busy} className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-white">
            Never mind
          </button>
          <button
            type="button"
            data-fix-submit
            onClick={submit}
            disabled={busy || attachments.uploading || !text.trim()}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:opacity-50"
          >
            {busy ? 'Requesting…' : 'Request fix'}
          </button>
        </div>
      </div>
      <AttachStrip attachments={attachments} />
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

/** The badge for the fix request in flight (or the reason the last one failed). */
function FixRequestStatus({ ticket }) {
  const open = openFixRequest(ticket);
  const last = latestDirective(ticket.chat);
  if (!open) {
    if (last?.ack_error) {
      return (
        <p role="alert" data-fix-status="error" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-900">
          The pipeline could not file your fix request: {last.ack_error}
        </p>
      );
    }
    return null;
  }
  const stage = ticket.fix_round?.request_id === open.id ? ticket.fix_round.stage : null;
  return (
    <div data-fix-status={open.acked_at ? 'building' : 'sent'} data-fix-stage={stage || undefined} className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <WrenchScrewdriverIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0">
        <p>
          <span className="font-semibold">{open.acked_at ? 'Fix in progress.' : 'Fix requested.'}</span>{' '}
          {open.acked_at
            ? (FIX_STAGE_TEXT[stage] || 'Filed on the ticket as your directive; a new fix round starts on the next pipeline run.')
            : 'The pipeline files it on the ticket within a few minutes.'}
          <span className="text-amber-800/70"> · {chatWhen(open.at)}</span>
        </p>
        <p className="mt-0.5 truncate text-amber-900/80" title={open.text}>“{open.text}”</p>
      </div>
    </div>
  );
}

/**
 * Keeps an open card current while the pipeline owes it something (a reply,
 * a cancel, a fix request): refetch every 30s while the tab is visible, and on focus.
 */
function useTicketRefresh(ticket, onUpdate) {
  const waiting = chatAwaitingReply(byTime(ticket.chat)) || !!(ticket.cancel && !ticket.cancel.acked_at)
    || !!openFixRequest(ticket);
  useEffect(() => {
    if (!waiting) return undefined;
    let stop = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/admin/pipeline/chat?key=${encodeURIComponent(ticket.key)}`, { cache: 'no-store' });
        if (res.ok && !stop) onUpdate(await res.json());
      } catch {}
    };
    const id = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stop = true;
      clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [waiting, ticket.key, onUpdate]);
}

// ---------------------------------------------------------------- flags

// Each preset: its own colour and icon. Custom flags take one of CUSTOM_LOOKS (by name).
const FLAG_LOOK = {
  'waiting-response': { icon: ClockIcon, cls: 'bg-sky-50 text-sky-800 ring-sky-300', hint: 'You wait for someone to answer.' },
  'wait-conflict-fix': { icon: ArrowsRightLeftIcon, cls: 'bg-orange-50 text-orange-800 ring-orange-300', hint: 'Merge after the conflict is fixed.' },
  warning: { icon: ExclamationTriangleIcon, cls: 'bg-rose-50 text-rose-800 ring-rose-300', hint: 'Something to be careful about.' },
  priority: { icon: BoltIcon, cls: 'bg-violet-50 text-violet-800 ring-violet-300', hint: 'Handle this one first.' },
  later: { icon: PauseIcon, cls: 'bg-slate-100 text-slate-700 ring-slate-300', hint: 'Parked: the pipeline starts no automatic round on it until you remove this flag.' },
  'watch-after-ship': { icon: EyeIcon, cls: 'bg-emerald-50 text-emerald-800 ring-emerald-300', hint: 'Check it again once it is live.' },
};
const CUSTOM_LOOKS = [
  'bg-teal-50 text-teal-800 ring-teal-300',
  'bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-300',
  'bg-lime-50 text-lime-800 ring-lime-400',
  'bg-indigo-50 text-indigo-800 ring-indigo-300',
  'bg-cyan-50 text-cyan-800 ring-cyan-300',
]; // no amber/orange/red/slate: too close to the presets

function flagLook(id) {
  if (FLAG_LOOK[id]) return FLAG_LOOK[id];
  let h = 0;
  for (const c of id || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { icon: TagIcon, cls: CUSTOM_LOOKS[h % CUSTOM_LOOKS.length], hint: 'Your own flag.' };
}

async function postFlag(body) {
  const res = await fetch('/api/admin/pipeline/flags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not save the flag (${res.status})`);
  return data;
}

function FlagChip({ flag, onRemove, busy, size = 'md' }) {
  const { icon: Icon, cls, hint } = flagLook(flag.id);
  return (
    <span
      data-flag={flag.id}
      title={hint}
      className={`inline-flex items-center gap-1 rounded-full font-medium ring-1 ring-inset ${cls} ${
        size === 'sm' ? 'py-0.5 pl-1.5 pr-1 text-[11px]' : 'py-0.5 pl-2 pr-1 text-xs'
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="max-w-[14rem] truncate">{flag.label}</span>
      {onRemove ? (
        <button
          type="button"
          data-flag-remove={flag.id}
          onClick={() => onRemove(flag.id)}
          disabled={busy}
          aria-label={`Remove the flag ${flag.label}`}
          className="rounded-full p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-30"
        >
          <XMarkIcon className="h-3 w-3" aria-hidden />
        </button>
      ) : <span className="w-1" />}
    </span>
  );
}

/**
 * The pipeline's own markers (not flags: he cannot remove them, filters never
 * touch them): dashed and grey, with a lock.
 */
function AutoChips({ ticket }) {
  const chips = [];
  // the fix round's own status is the FixBadge under the card's title
  if (ticket.hold && !openFixRequest(ticket)) chips.push({ id: 'hold', label: 'On hold', title: `Set by the pipeline: ${ticket.hold}` });
  return chips.map((c) => (
    <span
      key={c.id}
      data-auto-chip={c.id}
      title={c.title}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-500"
    >
      <LockClosedIcon className="h-3 w-3" aria-hidden />
      {c.label}
    </span>
  ));
}

/** The "+ Flag" picker: one click on a preset adds it; a custom flag by name. */
function FlagPicker({ ticket, onAdd, busy }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const ref = useRef(null);
  const have = new Set((ticket.flags || []).map((f) => f.id));
  const left = FLAG_PRESETS.filter((f) => !have.has(f.id));
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const add = async (body) => {
    if (await onAdd(body)) { setOpen(false); setLabel(''); }
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-flag-add={ticket.key}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 rounded-full border border-gray-300 bg-white py-0.5 pl-1.5 pr-2 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <PlusIcon className="h-3.5 w-3.5" aria-hidden />
        Flag
      </button>
      {open && (
        <div data-flag-menu={ticket.key} className="absolute left-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl">
          {left.length > 0 && (
            <ul className="space-y-0.5">
              {left.map((f) => {
                const { icon: Icon, cls, hint } = flagLook(f.id);
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      data-flag-option={f.id}
                      disabled={busy}
                      onClick={() => add({ id: f.id })}
                      title={hint}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${cls}`}>
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      {f.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className={`flex gap-1.5 ${left.length ? 'mt-1.5 border-t border-gray-100 pt-2' : ''}`}
            onSubmit={(e) => { e.preventDefault(); if (label.trim()) add({ label }); }}
          >
            <label htmlFor={`flag-custom-${ticket.key}`} className="sr-only">Custom flag</label>
            <input
              id={`flag-custom-${ticket.key}`}
              data-flag-custom
              value={label}
              maxLength={FLAG_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="+ custom flag"
              className="block min-h-[34px] w-full min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button type="submit" data-flag-custom-add disabled={busy || !label.trim()} className="shrink-0 rounded-lg bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40">
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** A card's flag row: his flags (x removes), the pipeline's markers, the "+ Flag" picker. */
function TicketFlags({ ticket, onUpdate, size }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (body) => {
    setBusy(true);
    setError(null);
    try {
      onUpdate(await postFlag({ key: ticket.key, ...body }));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-flags={ticket.key} className="flex flex-wrap items-center gap-1.5">
      {(ticket.flags || []).map((f) => (
        <FlagChip key={f.id} flag={f} busy={busy} size={size} onRemove={(id) => run({ remove: id })} />
      ))}
      <AutoChips ticket={ticket} />
      <FlagPicker ticket={ticket} busy={busy} onAdd={(add) => run({ add })} />
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

/** ?flags= in the URL <-> { flags: [ids], only }. "any" = flagged only, "none" = no flags. */
function parseFlagFilter(value) {
  const ids = (value || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.includes('none')) return { flags: [], only: 'none' };
  if (ids.includes('any')) return { flags: [], only: 'flagged' };
  return { flags: ids, only: null };
}

function flagFilterParam(f) {
  if (f.only === 'none') return 'none';
  if (f.only === 'flagged') return 'any';
  return f.flags.join(',');
}

const filterActive = (f) => !!(f.only || f.flags.length);

/**
 * The filter bar: his flags as toggles (several = any of them), "Flagged" and
 * "No flags", each with the count in the open tab. Lives in ?flags=.
 */
function FlagFilter({ tickets, filter, onChange }) {
  const counts = flagCounts(tickets);
  const custom = [...new Map(tickets.flatMap((t) => t.flags || []).filter((f) => !FLAG_LOOK[f.id])
    .map((f) => [f.id, f])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const toggle = (id) => {
    const has = filter.flags.includes(id);
    onChange({ only: null, flags: has ? filter.flags.filter((x) => x !== id) : [...filter.flags, id] });
  };
  const pill = (active) => `inline-flex min-h-[30px] items-center gap-1 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors ${
    active ? 'bg-gray-900 text-white ring-gray-900' : 'bg-white text-gray-700 ring-gray-300 hover:ring-gray-400'
  }`;
  const count = (n, active) => <span className={`tabular-nums ${active ? 'text-white/70' : 'text-gray-400'}`}>{n || 0}</span>;
  return (
    <div data-flag-filter className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-gray-500">
        <FunnelIcon className="h-3.5 w-3.5" aria-hidden />
        Flags
      </span>
      {[['flagged', 'Flagged'], ['none', 'No flags']].map(([only, label]) => {
        const active = filter.only === only;
        return (
          <button key={only} type="button" data-filter-only={only} aria-pressed={active} className={pill(active)}
            onClick={() => onChange({ flags: [], only: active ? null : only })}>
            {label} {count(counts[only], active)}
          </button>
        );
      })}
      <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden />
      {[...FLAG_PRESETS, ...custom].map((f) => {
        const active = filter.flags.includes(f.id);
        const { icon: Icon, cls } = flagLook(f.id);
        return (
          <button key={f.id} type="button" data-filter-flag={f.id} aria-pressed={active} onClick={() => toggle(f.id)}
            className={active ? pill(true) : `inline-flex min-h-[30px] items-center gap-1 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset ${cls} ${counts[f.id] ? '' : 'opacity-50'}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {f.label} {count(counts[f.id], active)}
          </button>
        );
      })}
      {filterActive(filter) && (
        <button type="button" data-filter-clear onClick={() => onChange({ flags: [], only: null })}
          className="ml-1 text-xs font-medium text-gray-500 underline underline-offset-2 hover:text-gray-900">
          Clear
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cancel

function CancelDialog({ ticket, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = (ticket.prs || []).filter((p) => !p.merged_at);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/pipeline/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ticket.key, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not cancel (${res.status})`);
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
        aria-labelledby={`cancel-title-${ticket.key}`}
        data-cancel-dialog={ticket.key}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
      >
        <h2 id={`cancel-title-${ticket.key}`} className="text-base font-semibold text-gray-900">Cancel {ticket.key}?</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-700">
          This closes the ticket and its PRs without merging.
          {open.length > 0 && <> PRs closed: {open.map(prLabel).join(', ')}.</>}
        </p>
        <label htmlFor={`cancel-reason-${ticket.key}`} className="mt-4 block text-sm font-medium text-gray-800">
          Why? <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <textarea
          id={`cancel-reason-${ticket.key}`}
          data-cancel-reason
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="For example: not needed after all, the behaviour is fine."
          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
        />
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-100">
            Keep ticket
          </button>
          <button
            type="button"
            data-cancel-confirm
            onClick={confirm}
            disabled={busy}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelButton({ ticket, onUpdate }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (ticket.cancel && !ticket.cancel.ack_error) return null;
  return (
    <>
      <button
        type="button"
        data-cancel-ticket={ticket.key}
        onClick={() => setOpen(true)}
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        Cancel ticket
      </button>
      {open && <CancelDialog ticket={ticket} onClose={close} onDone={onUpdate} />}
    </>
  );
}

function CancelStatus({ cancel }) {
  if (!cancel) return null;
  if (cancel.ack_error) {
    return (
      <p role="alert" data-cancel-status="error" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-900">
        The pipeline could not cancel this ticket: {cancel.ack_error}
      </p>
    );
  }
  return (
    <div data-cancel-status={cancel.acked_at ? 'done' : 'pending'} className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-700">
      <p>
        <span className="font-semibold text-gray-900">{cancel.acked_at ? 'Cancelled.' : 'Cancel requested.'}</span>{' '}
        {cancel.acked_at
          ? 'The ticket and its PRs are closed without merging. It moves to Shipped as cancelled.'
          : 'The pipeline closes the ticket and its PRs within a few minutes.'}
        <span className="text-gray-400"> · {chatWhen(cancel.requested_at)}</span>
      </p>
      {cancel.reason && <p className="mt-1 text-gray-500">Reason: {cancel.reason}</p>}
    </div>
  );
}

const PILL = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset';

/**
 * Where the fix round he requested stands, under the card's title: in
 * progress (and, on a Ready to merge card, do not merge yet), then the round's
 * result once the pipeline replied under his request.
 */
function FixBadge({ ticket }) {
  const open = openFixRequest(ticket);
  const outcome = open ? null : fixOutcome(ticket);
  if (open) {
    const stage = ticket.fix_round?.request_id === open.id ? FIX_STAGE_TEXT[ticket.fix_round.stage] : null;
    return (
      <div data-fix-badge="in-progress" role="status" className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={`${PILL} bg-amber-50 text-amber-900 ring-amber-300`}>
          <WrenchScrewdriverIcon className="h-3.5 w-3.5 text-amber-600" aria-hidden />
          {open.acked_at ? `Fix in progress, requested ${chatWhen(open.at)}` : `Fix requested ${chatWhen(open.at)}`}
        </span>
        {ticket.queue === 'merge' && (
          <span data-fix-badge-hold className={`${PILL} bg-red-50 text-red-800 ring-red-200`}>
            <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-600" aria-hidden />
            Do not merge yet
          </span>
        )}
        <span className="text-xs text-gray-500">{open.acked_at ? stage : 'Waiting for the pipeline to pick it up.'}</span>
      </div>
    );
  }
  if (outcome?.kind === 'failed') {
    return (
      <div data-fix-badge="failed" role="status" className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={`${PILL} bg-red-50 text-red-800 ring-red-200`}>
          <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-600" aria-hidden />
          Fix failed, needs you
        </span>
        <span className="text-xs text-gray-500">{chatWhen(outcome.message.at)}</span>
      </div>
    );
  }
  if (outcome?.kind === 'delivered' && ticket.queue === 'merge' && !ticket.hold) {
    return (
      <div data-fix-badge="delivered" role="status" className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={`${PILL} bg-emerald-50 text-emerald-800 ring-emerald-200`}>
          <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
          Ready to merge
        </span>
        <span className="text-xs text-gray-500">Fix delivered {chatWhen(outcome.message.at)}</span>
      </div>
    );
  }
  return null;
}

function CardHeader({ ticket, onUpdate }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <KeyBadge ticketKey={ticket.key} />
        <RepoBadge repo={ticket.repo} />
        <p className="min-w-0 flex-1 truncate text-xs text-gray-400" title={ticket.title}>{ticket.title}</p>
        <TicketDates ticket={ticket} />
        <CancelButton ticket={ticket} onUpdate={onUpdate} />
      </div>
      <FixBadge ticket={ticket} />
      <div className="mt-2.5"><TicketFlags ticket={ticket} onUpdate={onUpdate} /></div>
    </>
  );
}

function MergeCard({ ticket, proofSize, onUpdate }) {
  useTicketRefresh(ticket, onUpdate);
  const gallery = useGallery(ticket);
  const cancelling = !!(ticket.cancel && !ticket.cancel.ack_error);
  const fixing = !!openFixRequest(ticket);
  return (
    <article data-ticket-card={ticket.key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <CardHeader ticket={ticket} onUpdate={onUpdate} />

      <dl className="mt-4 space-y-3 xl:grid xl:grid-cols-3 xl:gap-8 xl:space-y-0">
        <PlainRow label="What improves">{ticket.plain?.improves}</PlainRow>
        <PlainRow label="Problem it solves">{ticket.plain?.problem}</PlainRow>
        <PlainRow label="How it solves it">{ticket.plain?.how}</PlainRow>
      </dl>

      <Proofs evidence={ticket.evidence || []} size={proofSize} onOpen={gallery.openProof} />
      <Development ticket={ticket} />

      <CancelStatus cancel={ticket.cancel} />
      <FixRequestStatus ticket={ticket} />
      {!cancelling && (
      <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
        {fixing && (
          <div data-hold="fix-request" role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
            <p><span className="font-semibold">Do not merge yet.</span> You requested a fix: these PRs change in this round and are re-checked before they are ready again.</p>
          </div>
        )}
        {ticket.hold && !fixing && (
          <div data-hold role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
            <p><span className="font-semibold">On hold, do not merge.</span> {ticket.hold}</p>
          </div>
        )}
        <GitHubLinks ticket={ticket} held={fixing} />
      </div>
      )}
      <TicketThread ticket={ticket} onUpdate={onUpdate} locked={cancelling} onOpenImage={gallery.openShot} hint="Chat is for questions. It never merges or changes the fix: use Request a fix for that." />
      {gallery.viewer}
    </article>
  );
}

const recommendedLetter = (d) => (/^\s*([A-Z])\b/.exec(d?.recommendation || '') || [])[1] || null;

function AnswerStatus({ answer }) {
  if (!answer) return null;
  const picked = [answer.option && `Option ${answer.option}`, answer.text && `"${answer.text}"`].filter(Boolean).join(', ');
  if (answer.acked_at && answer.ack_error) {
    return (
      <p role="alert" data-answer-status="error" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-900">
        The pipeline could not use your answer: {answer.ack_error}
      </p>
    );
  }
  return (
    <div
      data-answer-status={answer.acked_at ? 'posted' : 'sent'}
      className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
    >
      <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
      <p>
        You answered {picked}
        <span className="opacity-70"> · {formatWhen(answer.answered_at)}. </span>
        {answer.acked_at
          ? 'Posted on the ticket. The fix resumes on the next pipeline run.'
          : 'The pipeline picks it up within 15 minutes.'}
      </p>
    </div>
  );
}

function DecisionCard({ ticket, onAnswered, onUpdate, proofSize }) {
  useTicketRefresh(ticket, onUpdate);
  const gallery = useGallery(ticket);
  // a fix request answers the decision: no second ruling from the form meanwhile
  const cancelling = !!(ticket.cancel && !ticket.cancel.ack_error) || !!openFixRequest(ticket);
  const d = ticket.decision || {};
  const rec = recommendedLetter(d);
  const final = !!(ticket.answer?.acked_at && !ticket.answer.ack_error);
  const [option, setOption] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [editing, setEditing] = useState(!ticket.answer);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/pipeline/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ticket.key, option, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not save (${res.status})`);
      onAnswered(data.ticket);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article data-ticket-card={ticket.key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <CardHeader ticket={ticket} onUpdate={onUpdate} />

      <p data-question className="mt-3 text-base font-semibold leading-snug text-gray-900">
        {d.question || 'This ticket needs your decision. The question is on the Jira ticket.'}
      </p>

      {d.context?.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            Why you are asked
            <ChevronRightIcon className={`h-4 w-4 transition-transform ${contextOpen ? 'rotate-90' : ''}`} aria-hidden />
          </button>
          {contextOpen && (
            <ul data-context className="mt-2 list-disc space-y-1 rounded-lg bg-gray-50 py-2.5 pl-7 pr-3 text-sm leading-relaxed text-gray-700 [overflow-wrap:anywhere]">
              {d.context.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </div>
      )}

      <Proofs evidence={ticket.evidence || []} size={proofSize} onOpen={gallery.openProof} />

      <CancelStatus cancel={ticket.cancel} />
      <FixRequestStatus ticket={ticket} />

      {!cancelling && ticket.answer && !editing && (
        <div className="mt-4 space-y-2">
          <AnswerStatus answer={ticket.answer} />
          {!final && (
            <button type="button" onClick={() => setEditing(true)} className="text-xs font-medium text-gray-500 underline underline-offset-2 hover:text-gray-800">
              Change my answer
            </button>
          )}
        </div>
      )}

      {!cancelling && editing && !final && (
        <div className="mt-4">
          {d.options?.length > 0 && (
            <div role="radiogroup" aria-label="Options" className="space-y-2">
              {d.options.map((o) => {
                const active = option === o.letter;
                return (
                  <button
                    key={o.letter}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-option={o.letter}
                    onClick={() => setOption(active ? null : o.letter)}
                    className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      active ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
                      active ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'
                    }`}
                    >
                      {o.letter}
                    </span>
                    <span className="min-w-0 text-sm leading-relaxed">
                      <span className="font-semibold text-gray-900">{o.label}</span>
                      {o.letter === rec && (
                        <span className="ml-2 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                          Recommended
                        </span>
                      )}
                      {o.text && <span className="block text-gray-600">{o.text}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {d.recommendation && rec && (
            <p className="mt-2 text-xs leading-relaxed text-gray-500">{d.recommendation.replace(/^\s*[A-Z]\b[\s:.,-]*/, 'Why recommended: ')}</p>
          )}
          <label htmlFor={`answer-${ticket.key}`} className="mt-4 block text-sm font-medium text-gray-800">
            {d.options?.length ? 'Anything to add? (optional)' : 'Your answer'}
          </label>
          <textarea
            id={`answer-${ticket.key}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Your own instruction, in plain words."
          />
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          <div className="mt-3 flex items-center justify-end gap-2">
            {ticket.answer && (
              <button type="button" onClick={() => setEditing(false)} className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800">
                Cancel
              </button>
            )}
            <button
              type="button"
              data-send-answer
              disabled={busy || (!option && !text.trim())}
              onClick={send}
              className="inline-flex min-h-[40px] items-center rounded-lg bg-gray-900 px-5 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send answer'}
            </button>
          </div>
        </div>
      )}
      <TicketThread
        ticket={ticket}
        onUpdate={onUpdate}
        locked={!!(ticket.cancel && !ticket.cancel.ack_error)}
        onOpenImage={gallery.openShot}
        hint="Chat is for questions. It never decides: send your decision with the form above, or use Request a fix."
      />
      {gallery.viewer}
    </article>
  );
}

/**
 * Tickets whose fix round Vincent requested is building: they left Ready to
 * merge (or Needs decision) and come back once the round and its hostile
 * check are done.
 */
function BuildingList({ tickets, onUpdate }) {
  if (!tickets.length) return null;
  return (
    <section data-building aria-label="Fix rounds building" className="pb-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
        Fix rounds building <span className="normal-case tracking-normal">· back here once re-checked</span>
      </h2>
      <ul className="mt-2 divide-y divide-amber-100 rounded-xl border border-amber-200 bg-white shadow-sm">
        {tickets.map((t) => {
          const d = latestDirective(t.chat);
          return (
            <li key={t.key} data-building-row={t.key} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <KeyBadge ticketKey={t.key} />
                <RepoBadge repo={t.repo} />
                <span data-fix-stage={t.fix_round?.stage} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300">
                  <WrenchScrewdriverIcon className="h-3 w-3" aria-hidden />
                  {d ? `Fix in progress, requested ${chatWhen(d.at)}` : 'Fix in progress'}
                </span>
                <span className="text-xs text-gray-500">{FIX_STAGE_TEXT[t.fix_round?.stage] || ''}</span>
                <TicketDates ticket={t} className="ml-auto" />
              </div>
              <p className="text-sm font-medium text-gray-900">{t.plain?.improves || t.title}</p>
              {d && <p className="truncate text-xs text-amber-900/80" title={d.text}>Your request: “{d.text}”</p>}
              <div className="mt-1"><TicketFlags ticket={t} onUpdate={onUpdate} size="sm" /></div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ShippedList({ tickets, onUpdate, empty }) {
  if (!tickets.length) {
    return empty || <Empty>No fix merged on GitHub or cancelled in the last 7 days.</Empty>;
  }
  return (
    <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
      {tickets.map((t) => {
        const cancelled = t.queue === 'cancelled';
        return (
          <li
            key={t.key}
            data-shipped={t.key}
            data-cancelled={cancelled || undefined}
            className={`flex flex-col gap-1 px-4 py-3 first:rounded-t-xl last:rounded-b-xl sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${cancelled ? 'bg-gray-50/70' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${cancelled ? 'text-gray-500' : 'text-gray-900'}`}>
                {cancelled && (
                  <span className="mr-2 rounded-full bg-gray-200 px-1.5 py-0.5 align-[1px] text-[11px] font-medium text-gray-600">Cancelled</span>
                )}
                {t.plain?.improves || t.title}
              </p>
              {cancelled && t.cancel?.reason && <p className="mt-0.5 text-xs text-gray-500">Reason: {t.cancel.reason}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                <KeyBadge ticketKey={t.key} />
                <RepoBadge repo={t.repo} />
                {mergePlan(t.prs).map(({ pr: p }) => (
                  <a key={`${p.repo}#${p.number}`} href={p.url} target="_blank" rel="noopener noreferrer" className={cancelled ? 'text-gray-500 hover:text-gray-800' : 'text-indigo-700 hover:text-indigo-900'}>
                    {prLabel(p)}{cancelled && ' (closed)'}
                  </a>
                ))}
              </div>
              <div className="mt-1.5"><TicketFlags ticket={t} onUpdate={onUpdate} size="sm" /></div>
            </div>
            <p className="shrink-0 text-xs tabular-nums text-gray-500">
              {cancelled ? `Cancelled ${formatWhen(t.cancelled_at)}` : `Merged ${formatWhen(t.merged_at)}`}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

const usd = (n) => `$${n.toFixed(2)}`;

/**
 * Tickets the pipeline's cost guard stopped over budget (even after the $2
 * review): the automation will not run them again, Vincent handles them by
 * hand. Each card: what it is, what the stopped round spent, the reviewer's
 * reason verbatim, the Jira and GitHub links.
 */
function ManualList({ tickets, onUpdate, empty }) {
  if (!tickets.length) {
    return empty || <Empty>No ticket stopped over budget. When the cost guard stops one, it lands here for you to run by hand.</Empty>;
  }
  return (
    <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
      {tickets.map((t) => {
        const m = t.manual || {};
        return (
          <article key={t.key} data-manual-card={t.key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <KeyBadge ticketKey={t.key} />
              <RepoBadge repo={t.repo} />
              <span className={`${PILL} bg-red-50 text-red-800 ring-red-200`}>
                <PauseIcon className="h-3.5 w-3.5 text-red-600" aria-hidden />
                Stopped over budget
              </span>
              <span className="text-xs text-gray-500">{formatWhen(m.stopped_at)}</span>
              {t.jira_status && <span className="ml-auto text-xs text-gray-400">Jira: {t.jira_status}</span>}
            </div>
            <p className="mt-3 text-[15px] font-medium leading-relaxed text-gray-900">{t.plain?.improves || t.title || t.plain?.problem}</p>
            <dl className="mt-4 space-y-3">
              <PlainRow label="Automation spent">
                <span data-manual-spend className="font-semibold tabular-nums">{m.spend_usd == null ? 'not metered' : usd(m.spend_usd)}</span>
                <span className="ml-2 text-sm text-gray-500">
                  {[m.leg_kind && `on its ${m.leg_kind} round`, m.spend_note].filter(Boolean).join(', ')}
                </span>
              </PlainRow>
              <PlainRow label="Why it stopped">
                <span data-manual-reason className="block whitespace-pre-line border-l-2 border-red-200 pl-3 text-gray-800 [overflow-wrap:anywhere]">{m.reason}</span>
              </PlainRow>
            </dl>
            <div data-manual-links className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 pt-3 text-sm">
              <a href={JIRA_BROWSE + t.key} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:text-indigo-900">
                Open {t.key} in Jira
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden />
              </a>
              {mergePlan(t.prs).map(({ pr: p }) => (
                <a key={`${p.repo}#${p.number}`} href={p.url} target="_blank" rel="noopener noreferrer" data-manual-pr={prLabel(p)} className="inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900">
                  {prLabel(p)}
                  {p.title && <span className="text-gray-500">· {p.title}</span>}
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden />
                </a>
              ))}
              {!t.prs?.length && <span className="text-gray-400">No PR</span>}
            </div>
            <div className="mt-3"><TicketFlags ticket={t} onUpdate={onUpdate} size="sm" /></div>
            {t.plan?.on && (
              <>
                <StrategyBlock strategy={t.plan.strategy} />
                <PlanThread ticket={t} onUpdate={onUpdate} manual />
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Empty({ children, wide = false }) {
  return (
    <p data-review-empty className={`${wide ? 'col-span-full ' : ''}rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500`}>{children}</p>
  );
}

const SHIPPED_DAYS = 7;

const PROOF_SIZE_KEY = 'cockpit.proofSize';
const PROOF_SIZES = [
  { key: 'large', label: 'Large' },
  { key: 'small', label: 'Small' },
];

/** Large or small proof images, remembered in this browser. Hidden on phones, which always show large. */
function ProofSizeToggle({ value, onChange }) {
  return (
    <div className="hidden shrink-0 items-center gap-2 border-b border-gray-200 pb-1.5 pl-3 sm:flex">
      <span id="proof-size-label" className="text-xs text-gray-500">Proofs</span>
      <div role="radiogroup" aria-labelledby="proof-size-label" data-proof-toggle className="flex gap-0.5 rounded-lg bg-gray-200/70 p-0.5">
        {PROOF_SIZES.map((s) => {
          const active = value === s.key;
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={active}
              data-proof-size-option={s.key}
              onClick={() => onChange(s.key)}
              className={`min-h-[30px] rounded-md px-3 text-[13px] font-medium transition-colors ${
                active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The pipeline cockpit: everything the max-system pipeline waits on Vincent
 * for, on one page. Tabs: PRs that passed the hostile check (read here, merge
 * on GitHub),
 * tickets needing his decision, the ones stopped over budget he runs by hand,
 * the claims ledger, and what shipped this week.
 * The tab lives in ?tab= so a link opens the right one.
 */
export default function CockpitClient({ initialClaims, initialTickets, initialBundles }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'merge';
  const flagFilter = useMemo(() => parseFlagFilter(params.get('flags')), [params]);
  const [tickets, setTickets] = useState(initialTickets || []);

  // Read after mount so the server render (always large) matches the first client render.
  const [proofSize, setProofSize] = useState('large');
  useEffect(() => {
    try {
      if (localStorage.getItem(PROOF_SIZE_KEY) === 'small') setProofSize('small');
    } catch {}
  }, []);
  const changeProofSize = useCallback((size) => {
    setProofSize(size);
    try { localStorage.setItem(PROOF_SIZE_KEY, size); } catch {}
  }, []);
  // the card order within a tab (Default = each tab's own order), remembered in this browser
  const [sort, setSort] = useStoredTicketSort();

  // A full ticket (answer, cancel) or a partial one (the chat refresh: key, queue, chat, cancel).
  // A Plan testing refresh also carries the thread's other tickets (`related`: an agreed plan merges them).
  const update = useCallback(({ related, ...t }) => setTickets((prev) => {
    const rel = new Map((related || []).map((r) => [r.key, r]));
    return prev.map((x) => (x.key === t.key ? { ...x, ...t } : (rel.has(x.key) ? { ...x, ...rel.get(x.key) } : x)));
  }), []);
  // a merge: the survivor comes back whole, the absorbed tickets collapse into it
  const merged = useCallback((survivor, absorbed) => setTickets((prev) => prev.map((x) => {
    if (x.key === survivor.key) return { ...x, ...survivor };
    return (absorbed || []).includes(x.key) ? { ...x, merged_into: survivor.key } : x;
  })), []);
  const mergedInto = useMemo(() => Object.fromEntries(tickets.filter((t) => t.merged_into)
    .map((t) => [t.key, t.merged_into])), [tickets]);

  const lists = useMemo(() => {
    const since = Date.now() - SHIPPED_DAYS * 24 * 3600 * 1000;
    return {
      merge: tickets.filter((t) => t.queue === 'merge')
        .sort((a, b) => (!!a.hold - !!b.hold) || a.key.localeCompare(b.key, 'en', { numeric: true })),
      building: tickets.filter((t) => t.queue === 'building').sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })),
      decide: tickets.filter((t) => t.queue === 'decision')
        .sort((a, b) => (!!a.answer - !!b.answer) || a.key.localeCompare(b.key, 'en', { numeric: true })),
      // merged on GitHub, and cancelled from here (muted rows), newest first
      shipped: tickets.filter((t) => (t.queue === 'shipped' || t.queue === 'cancelled')
        && new Date(t.merged_at || t.cancelled_at).getTime() >= since)
        .sort((a, b) => new Date(b.merged_at || b.cancelled_at) - new Date(a.merged_at || a.cancelled_at)),
      // stopped over budget, newest stop first
      manual: tickets.filter((t) => t.queue === 'manual')
        .sort((a, b) => new Date(b.manual?.stopped_at) - new Date(a.manual?.stopped_at)),
    };
  }, [tickets]);

  const counts = {
    validate: gateLists(tickets).pending.length,
    merge: lists.merge.length,
    decide: lists.decide.filter((t) => !t.answer).length,
    manual: lists.manual.length,
    claims: (initialClaims || []).filter((c) => !c.vincent_ruling?.status).length,
    shipped: lists.shipped.filter((t) => t.queue === 'shipped').length,
  };

  const go = (key) => {
    const next = new URLSearchParams(params.toString());
    next.set('tab', key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const setFlagFilter = (f) => {
    const next = new URLSearchParams(params.toString());
    const v = flagFilterParam(f);
    if (v) next.set('flags', v); else next.delete('flags');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  // the flag filter applies to the ticket tabs (claims are not tickets)
  const inTab = { merge: [...lists.building, ...lists.merge], decide: lists.decide, manual: lists.manual, shipped: lists.shipped }[tab] || [];
  const shown = (list) => sortTickets(filterByFlags(list, flagFilter), sort);
  // the flag filter only covers the ticket tabs (not validation, not claims)
  const flaggable = ['merge', 'decide', 'manual', 'shipped'].includes(tab);
  const filtering = filterActive(flagFilter) && flaggable;
  const sortable = flaggable || tab === 'validate';
  const noMatch = (
    <Empty wide>
      No ticket in this tab matches the flag filter.{' '}
      <button type="button" onClick={() => setFlagFilter({ flags: [], only: null })} className="font-medium text-gray-700 underline underline-offset-2 hover:text-gray-900">
        Clear the filter
      </button>
    </Empty>
  );

  // Phones (below lg): one ticket per screen, see MobileCockpit.js. Desktop renders below, unchanged.
  const phone = useIsPhone();
  if (phone) {
    const kit = {
      AnswerStatus, AutoChips, BuildingList, DecisionCard, FIX_STAGE_TEXT, FixRequestBar, FlagChip, ManualList, MergeCard,
      PlanThread, ShippedList, StrategyBlock, TicketThread, fixOutcome, fixRequestAllowed, latestDirective, mergePlan,
      openFixRequest, recommendedLetter, useGallery, useTicketRefresh,
    };
    const feed = {
      merge: [...feedItems(shown(lists.building), 'building'), ...feedItems(shown(lists.merge), 'merge')],
      decide: feedItems(shown(lists.decide), 'decide'),
      manual: feedItems(shown(lists.manual), 'manual'),
      shipped: feedItems(shown(lists.shipped), 'shipped'),
    }[tab];
    const empty = filtering && inTab.length ? noMatch : {
      merge: <Empty>No fix is waiting for a merge. New ones arrive with the next pipeline sync.</Empty>,
      decide: <Empty>No ticket is waiting for your decision.</Empty>,
      manual: <Empty>No ticket stopped over budget. When the cost guard stops one, it lands here for you to run by hand.</Empty>,
      shipped: <Empty>No fix merged on GitHub or cancelled in the last 7 days.</Empty>,
    }[tab];
    return (
      <PhoneCockpit
        tab={tab}
        tabs={TABS}
        counts={counts}
        onTab={go}
        filterActive={filtering}
        renderFilters={flaggable ? () => <FlagFilter tickets={inTab} filter={flagFilter} onChange={setFlagFilter} /> : null}
      >
        {tab === 'validate' && (
          <GateClient
            tickets={tickets}
            claims={initialClaims}
            onUpdate={update}
            onMerged={merged}
            renderPlan={(host) => <PlanThread ticket={host} onUpdate={update} />}
            bundles={initialBundles}
          />
        )}
        {feed && <PhoneTickets key={tab} items={feed} empty={empty} onUpdate={update} kit={kit} />}
        <div hidden={tab !== 'claims'} className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <ClaimsClient initialClaims={initialClaims} embedded mergedInto={mergedInto} />
        </div>
      </PhoneCockpit>
    );
  }

  return (
    // before the first client render the server cannot know the width: phones see nothing rather than the squeezed desktop
    <div className={`min-h-full bg-gray-50${phone === null ? ' max-lg:invisible' : ''}`}>
      {/* pt-16 below md clears the admin sidebar's fixed menu button */}
      <div className="px-4 pb-10 pt-16 sm:px-8 md:pt-8">
        <header>
          <div className="flex items-center justify-between gap-3">
            <h1 data-review-title className="text-2xl font-bold text-gray-900">Review</h1>
            <Link href="/administration/pipeline-live" data-live-link className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 hover:text-gray-900">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
              Live view
            </Link>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            Review the evidence. Validate, redirect, or reject the proposed work.
          </p>
        </header>

        {/* the toggle carries its own border so the tab underline still overlaps the nav border */}
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
          {(tab === 'merge' || tab === 'decide') && <ProofSizeToggle value={proofSize} onChange={changeProofSize} />}
        </div>
        {sortable && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
            {flaggable && <FlagFilter tickets={inTab} filter={flagFilter} onChange={setFlagFilter} />}
            <SortControl value={sort} onChange={setSort} />
          </div>
        )}

        <TicketSortProvider value={sort}>
          <div className="mt-5">
            {tab === 'validate' && (
              <GateClient
                tickets={tickets}
                claims={initialClaims}
                onUpdate={update}
                onMerged={merged}
                renderPlan={(host) => <PlanThread ticket={host} onUpdate={update} />}
                bundles={initialBundles}
                sort={sort}
              />
            )}
            {tab === 'merge' && (
              <div className="space-y-4">
                <BuildingList tickets={shown(lists.building)} onUpdate={update} />
                {shown(lists.merge).map((t) => <MergeCard key={t.key} ticket={t} proofSize={proofSize} onUpdate={update} />)}
                {lists.merge.length === 0 && !filtering && <Empty>No fix is waiting for a merge. New ones arrive with the next pipeline sync.</Empty>}
                {filtering && shown(inTab).length === 0 && noMatch}
              </div>
            )}
            {tab === 'decide' && (
              <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
                {shown(lists.decide).map((t) => <DecisionCard key={t.key} ticket={t} onAnswered={update} onUpdate={update} proofSize={proofSize} />)}
                {lists.decide.length === 0 && !filtering && <Empty wide>No ticket is waiting for your decision.</Empty>}
                {filtering && lists.decide.length > 0 && shown(lists.decide).length === 0 && noMatch}
              </div>
            )}
            {tab === 'manual' && <ManualList tickets={shown(lists.manual)} onUpdate={update} empty={filtering && lists.manual.length ? noMatch : null} />}
            {/* kept mounted, so rulings made here survive a tab switch */}
            <div hidden={tab !== 'claims'}>
              <ClaimsClient initialClaims={initialClaims} embedded mergedInto={mergedInto} />
            </div>
            {tab === 'shipped' && <ShippedList tickets={shown(lists.shipped)} onUpdate={update} empty={filtering && lists.shipped.length ? noMatch : null} />}
          </div>
        </TicketSortProvider>
      </div>
    </div>
  );
}
