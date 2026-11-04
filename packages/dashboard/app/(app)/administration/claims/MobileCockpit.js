'use client';

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AdjustmentsHorizontalIcon,
  ArrowsPointingOutIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  RectangleStackIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';

/**
 * The cockpit on a phone (below the lg breakpoint): one ticket fills the screen,
 * a vertical swipe snaps to the next one, its proofs open full screen from one
 * button, and its actions sit in a bar under the thumb. Everything deeper (full texts, PRs,
 * the conversation, flags, cancel) opens in a sheet that renders the desktop
 * card itself, so no behavior is lost on the way.
 */

const PHONE_QUERY = '(max-width: 1023.98px)';
const subscribePhone = (cb) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

/** true on a phone, false from lg up, null before the first client render (the server does not know). */
export function useIsPhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => null);
}

const JIRA_BROWSE = 'https://magifyfun.atlassian.net/browse/';
const evidenceSrc = (e) => `/api/admin/pipeline/evidence?k=${encodeURIComponent(e.s3_key)}`;

function day(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
}

// ---------------------------------------------------------------- shell: header, position, sheets

const PhoneCtx = createContext(null);
const usePhone = () => useContext(PhoneCtx);
const FeedCtx = createContext(null);

/**
 * For a page acting on its own ticket (Validate, Later, an answer): the ticket
 * moves elsewhere in the list, the feed stays put and shows the next one, and a
 * short line says what happened.
 */
export function useFeedAdvance() {
  const feed = useContext(FeedCtx);
  const phone = usePhone();
  return useCallback((key, message) => {
    feed?.advance(key);
    if (message) phone?.toast(message);
  }, [feed, phone]);
}

/** A grace period before an action Jira cannot take back (Validate): the toast offers Undo meanwhile. */
export function useDeferred() {
  return usePhone()?.defer;
}

const GRACE_MS = 4000;

/**
 * The page never zooms on the phone cockpit: only the full-screen viewer zooms
 * its image. iOS ignores user-scalable=no since iOS 10, so this is done with
 * touch-action (pan only, zero specificity so touch-none utilities and the
 * viewer's own touch-action: none still win) plus preventDefault on Safari's
 * gesture events and on any two-finger touchmove. Removed with the cockpit, so
 * desktop is never affected.
 */
const NO_PAGE_ZOOM = ':where(html, body, body *){touch-action:pan-x pan-y}';
function usePageZoomOff() {
  useEffect(() => {
    const block = (e) => { if (e.cancelable) e.preventDefault(); };
    const blockPinch = (e) => { if (e.touches.length > 1 && e.cancelable) e.preventDefault(); };
    const opts = { passive: false };
    document.addEventListener('gesturestart', block, opts);
    document.addEventListener('gesturechange', block, opts);
    document.addEventListener('touchmove', blockPinch, opts);
    return () => {
      document.removeEventListener('gesturestart', block, opts);
      document.removeEventListener('gesturechange', block, opts);
      document.removeEventListener('touchmove', blockPinch, opts);
    };
  }, []);
}

/**
 * One sheet at a time, from the bottom: a grabber you can drag down, a 44px
 * close button, the dimmed page behind it (a tap there closes), Esc closes, and
 * focus comes back to the button that opened it.
 */
export function Sheet({ title, onClose, children, tall = false, label }) {
  const panel = useRef(null);
  const drag = useRef(null);
  const [dy, setDy] = useState(0);
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      // a dialog opened from inside the sheet (viewer, cancel, dismiss) handles its own Esc
      if (e.key === 'Escape' && !document.querySelector('[data-lightbox], [data-cancel-dialog], [data-dismiss-dialog], [data-merge-dialog]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [onClose]);
  const onTouchStart = (e) => { drag.current = e.touches[0].clientY; };
  const onTouchMove = (e) => { if (drag.current != null) setDy(Math.max(0, e.touches[0].clientY - drag.current)); };
  const onTouchEnd = () => {
    const far = dy > 90;
    drag.current = null;
    setDy(0);
    if (far) onClose();
  };
  // portalled: a page is paint-contained (content-visibility), which would trap a fixed sheet inside it
  return createPortal(
    <div className="fixed inset-0 z-[45] flex flex-col justify-end" data-phone-sheet={label}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-gray-950/50 motion-safe:animate-[phoneFade_160ms_ease-out]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        className={`relative flex w-full flex-col rounded-t-2xl bg-white shadow-2xl outline-none motion-safe:animate-[phoneRise_200ms_ease-out] ${tall ? 'h-[92dvh]' : 'max-h-[92dvh]'}`}
      >
        <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} className="shrink-0 touch-none">
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-gray-300" aria-hidden />
          <div className="flex items-center gap-2 pl-4 pr-1.5">
            <h2 className="min-w-0 flex-1 truncate py-2 text-base font-semibold text-gray-900">{title}</h2>
            <button type="button" data-sheet-close onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <XMarkIcon className="h-6 w-6" aria-hidden />
            </button>
          </div>
        </div>
        <div data-sheet-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
          {/* a fade at the bottom edge while there is more below: the sheet scrolls */}
          <div className="pointer-events-none sticky bottom-0 -mx-4 -mt-6 h-6 bg-gradient-to-t from-white to-transparent" aria-hidden />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The fullscreen viewer of a page, out of the page's paint containment. */
export function Portal({ children }) {
  return children ? createPortal(children, document.body) : null;
}

function HeaderButton({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex h-11 shrink-0 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * The phone page: a one-row header that never scrolls away (tab, position,
 * filters) above the active tab's feed. `body` renders the tab; feeds report
 * their position here through the context.
 */
export function PhoneCockpit({ tab, tabs, counts, onTab, filterActive, renderFilters, children }) {
  const [sheet, setSheet] = useState(null); // 'tabs' | 'filters' | 'jump'
  const [pos, setPos] = useState(null); // { index, total, items, jump }
  const [note, setNote] = useState(null); // { text, at, undo? }
  const close = useCallback(() => setSheet(null), []);
  const pending = useRef(null);
  usePageZoomOff();
  const ctx = useMemo(() => ({
    report: setPos,
    toast: (text) => setNote({ text, at: Date.now() }),
    // run() after the grace period unless Undo is tapped; a second deferral runs the first one now
    defer: ({ text, run }) => {
      if (pending.current) { clearTimeout(pending.current.timer); pending.current.run(); }
      const job = { run };
      job.timer = setTimeout(() => { pending.current = null; setNote(null); run(); }, GRACE_MS);
      pending.current = job;
      setNote({ text, at: Date.now(), undo: () => { clearTimeout(job.timer); pending.current = null; setNote({ text: 'Undone: nothing was sent.', at: Date.now() }); } });
    },
  }), []);
  useEffect(() => {
    if (!note || note.undo) return undefined;
    const t = setTimeout(() => setNote(null), 2800);
    return () => clearTimeout(t);
  }, [note]);
  const current = tabs.find((t) => t.key === tab);
  const pct = pos?.total ? ((pos.index + 1) / pos.total) * 100 : 0;
  return (
    <PhoneCtx.Provider value={ctx}>
      <div data-phone-cockpit className="flex h-dvh flex-col overflow-hidden bg-gray-100">
        <style>{`@keyframes phoneRise{from{transform:translateY(100%)}to{transform:none}}@keyframes phoneFade{from{opacity:0}to{opacity:1}}${NO_PAGE_ZOOM}`}</style>
        <header data-phone-header className="relative z-20 shrink-0 border-b border-gray-200 bg-white">
          {/* below md the admin sidebar's menu button sits fixed at the top left */}
          <div className="flex h-16 items-center gap-1 pl-[60px] pr-1.5 pt-2 md:h-14 md:pl-3 md:pt-0">
            <HeaderButton data-phone-tabs onClick={() => setSheet('tabs')} aria-haspopup="dialog" className="min-w-0 flex-1 justify-start gap-1.5 px-2 text-left">
              <span className="truncate text-[15px] font-semibold text-gray-900">{current?.label}</span>
              {!pos?.total && counts[tab] > 0 && <span className="shrink-0 rounded-full bg-gray-900 px-1.5 text-xs font-semibold tabular-nums text-white">{counts[tab]}</span>}
              <ChevronDownIcon className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
            </HeaderButton>
            {pos?.total > 0 && (
              <HeaderButton data-phone-position onClick={() => setSheet('jump')} aria-label={`Ticket ${pos.index + 1} of ${pos.total}. Jump to a ticket`} className="min-w-[64px] px-2 text-sm font-semibold tabular-nums">
                {pos.index + 1}<span className="font-normal text-gray-400">/{pos.total}</span>
              </HeaderButton>
            )}
            {renderFilters && (
              <HeaderButton data-phone-filters onClick={() => setSheet('filters')} aria-label={filterActive ? 'Filters (on)' : 'Filters'} className="relative w-11">
                <AdjustmentsHorizontalIcon className="h-5 w-5" aria-hidden />
                {filterActive && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-indigo-600" aria-hidden />}
              </HeaderButton>
            )}
          </div>
          <div className="h-0.5 bg-gray-100" aria-hidden>
            <div data-phone-progress className="h-full origin-left bg-gray-900 transition-transform duration-200 motion-reduce:transition-none" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {children}
          {note && (
            // just above the thumb bar, where the thumb already is
            <div key={note.at} data-phone-toast role="status" className="absolute inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-30 flex min-h-[48px] items-center gap-3 rounded-xl bg-gray-900 py-1 pl-3.5 pr-1 text-sm font-medium text-white shadow-lg motion-safe:animate-[phoneFade_160ms_ease-out]">
              <span className="min-w-0 flex-1">{note.text}</span>
              {note.undo && (
                <button type="button" data-toast-undo onClick={note.undo} className="h-11 shrink-0 rounded-lg px-3 font-semibold text-amber-300 hover:bg-white/10">
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {sheet === 'tabs' && (
        <Sheet title="Review" label="tabs" onClose={close}>
          <ul className="-mx-1 pb-2">
            {tabs.map((t) => {
              const active = t.key === tab;
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    data-phone-tab={t.key}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => { onTab(t.key); close(); }}
                    className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] ${active ? 'bg-gray-900 font-semibold text-white' : 'text-gray-800 hover:bg-gray-50'}`}
                  >
                    <span className="flex-1">{t.label}</span>
                    {counts[t.key] > 0 && <span className={`text-sm tabular-nums ${active ? 'text-white/70' : 'text-gray-400'}`}>{counts[t.key]}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}
      {sheet === 'filters' && renderFilters && (
        <Sheet title="Filter" label="filters" onClose={close}>
          {/* the shared filter pills are 30px on desktop: 44px tall here */}
          <div className="pb-3 [&_button]:min-h-[44px]">{renderFilters()}</div>
        </Sheet>
      )}
      {sheet === 'jump' && pos?.items && (
        <Sheet title={`${current?.label} · ${pos.total}`} label="jump" onClose={close}>
          <JumpList pos={pos} onPick={(i) => { pos.jump(i); close(); }} />
        </Sheet>
      )}
    </PhoneCtx.Provider>
  );
}

/** Every ticket of the open tab, the current one marked: a tap jumps to it. */
function JumpList({ pos, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <ol ref={ref} className="-mx-1 pb-2">
      {pos.items.map((it, i) => (
        <li key={it.key}>
          <button
            type="button"
            data-phone-jump={it.key}
            aria-current={i === pos.index ? 'true' : undefined}
            onClick={() => onPick(i)}
            className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${i === pos.index ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
          >
            <span className="w-7 shrink-0 text-right text-xs tabular-nums text-gray-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[11px] text-gray-500">{it.key}</span>
              <span className="block truncate text-sm text-gray-900">{it.summary}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- the feed

const WINDOW = 2; // pages rendered on each side of the current one

/**
 * The vertical feed: one page per ticket, snapped (a fast flick still stops at
 * the next one), the current one tracked by key so a ticket that leaves the
 * list (validated, filtered) lands you on its neighbour. Only the pages near
 * the current one render; the rest are empty slots of the same height.
 */
export function TicketFeed({ items, renderPage, empty }) {
  const ref = useRef(null);
  const phone = usePhone();
  const [index, setIndex] = useState(0);
  const currentKey = useRef(items[0]?.key);
  const frame = useRef(0);
  const hold = useRef(false);
  const feedCtx = useMemo(() => ({ advance: (key) => { hold.current = key; } }), []);

  const jump = useCallback((i, smooth = false) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: i * el.clientHeight, behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  // the list changed under us: stay on the same ticket, or its neighbour if it left
  useLayoutEffect(() => {
    // the ticket on screen was acted on and moved: stay at this place, the next ticket slides in
    const at = hold.current && hold.current === currentKey.current ? -1 : items.findIndex((t) => t.key === currentKey.current);
    hold.current = null;
    const next = at >= 0 ? at : Math.min(index, Math.max(0, items.length - 1));
    currentKey.current = items[next]?.key;
    if (next !== index) setIndex(next);
    const el = ref.current;
    if (el && Math.round(el.scrollTop / (el.clientHeight || 1)) !== next) el.scrollTop = next * el.clientHeight;
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // the browser bars or the keyboard resize the feed: keep the page aligned
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const i = items.findIndex((t) => t.key === currentKey.current);
      if (i >= 0) el.scrollTop = i * el.clientHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [items]);

  // A short swipe commits: mandatory snapping alone springs back from a slow drag under half a page,
  // so past 15% of the page the feed finishes the move to the next (or previous) ticket itself.
  const start = useRef(null);
  const onTouchStart = () => { start.current = ref.current?.scrollTop ?? null; };
  const onTouchEnd = () => {
    const el = ref.current;
    const from = start.current;
    start.current = null;
    if (!el || from == null) return;
    const h = el.clientHeight || 1;
    const moved = el.scrollTop - from;
    if (Math.abs(moved) < h * 0.15) return;
    const target = Math.max(0, Math.min(items.length - 1, Math.round(from / h) + Math.sign(moved)));
    el.scrollTo({ top: target * h, behavior: 'smooth' });
  };

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / (el.clientHeight || 1))));
      if (i !== index) {
        currentKey.current = items[i]?.key;
        setIndex(i);
      }
    });
  };

  useEffect(() => {
    phone?.report(items.length ? { index, total: items.length, items, jump } : null);
  }, [index, items, jump, phone]);
  useEffect(() => () => phone?.report(null), [phone]);

  if (!items.length) return <div className="flex flex-1 items-center justify-center p-6">{empty}</div>;
  return (
    <FeedCtx.Provider value={feedCtx}>
    <div
      ref={ref}
      data-phone-feed
      onScroll={onScroll}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-y-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((it, i) => (
        <section
          key={it.key}
          data-phone-page={it.key}
          data-page-index={i}
          data-page-active={i === index ? 'true' : undefined}
          aria-label={`Ticket ${i + 1} of ${items.length}: ${it.key}`}
          className="h-full snap-start snap-always overflow-hidden [content-visibility:auto]"
        >
          {Math.abs(i - index) <= WINDOW ? renderPage(it, i === index) : null}
        </section>
      ))}
    </div>
    </FeedCtx.Provider>
  );
}

// ---------------------------------------------------------------- page parts

/**
 * The proofs behind one button: a tap opens the full-screen viewer on the
 * first one, where a swipe or the big arrows go from proof to proof. With
 * `grow` the button takes the room the text leaves and shows the first proof
 * large in it; with no room left it is one 56px row with a small preview.
 */
export function ProofButton({ images, onOpen, eager = false, grow = false }) {
  const self = useRef(null);
  const [big, setBig] = useState(false);
  // the zone's height does not depend on the button, so measuring it never loops
  useLayoutEffect(() => {
    const zone = grow && self.current?.parentElement;
    if (!zone || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setBig(zone.clientHeight >= 170)); // room for a 96px preview over the 56px row
    ro.observe(zone);
    return () => ro.disconnect();
  }, [grow]);
  const n = images.length;
  if (!n) return null;
  const src = evidenceSrc(images[0]);
  return (
    <button
      ref={self}
      type="button"
      data-proof-button
      data-proof-big={big ? 'true' : undefined}
      aria-haspopup="dialog"
      onClick={() => onOpen(0)}
      className={`mx-4 flex w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-gray-300 bg-white text-left shadow-sm active:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${big ? 'min-h-0 flex-1' : 'shrink-0'}`}
    >
      {big && (
        <span className="relative block min-h-0 w-full flex-1 bg-gray-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
        </span>
      )}
      <span className={`flex h-14 w-full shrink-0 items-center gap-3 pr-3 ${big ? 'border-t border-gray-200 pl-4' : 'pl-1.5'}`}>
        {!big && (
          <span className="h-11 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-100 ring-1 ring-inset ring-gray-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} className="h-full w-full object-cover object-left-top" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-gray-900">
          {n === 1 ? 'See the proof image' : `See the ${n} proof images`}
        </span>
        <ArrowsPointingOutIcon className="h-5 w-5 shrink-0 text-gray-500" aria-hidden />
      </span>
    </button>
  );
}

/** The proof zone of a page: always the same place above the thumb bar. */
export function ProofZone({ grow = false, children }) {
  return <div data-proof-zone className={`pb-2 pt-1.5 ${grow ? 'flex min-h-[72px] flex-1 flex-col justify-end' : 'shrink-0'}`}>{children}</div>;
}

/**
 * Text that gets the room left over and never scrolls: only whole blocks
 * show, never a sentence cut in half; the blocks that do not fit wait in
 * Details, and the row under the text names them. Only a first block too long
 * for the whole space ends on an ellipsis at its last full line.
 */
export function FitText({ children, onMore, keepAll = false, hug = false, className = '' }) {
  const ref = useRef(null);
  const [rest, setRest] = useState(null); // null = all shown, [] = clamped, [labels] = blocks in Details
  const [moreTop, setMoreTop] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const fit = () => {
      const blocks = [...box.children];
      blocks.forEach((b) => { b.style.display = ''; });
      box.querySelectorAll('li').forEach((li) => { Object.assign(li.style, { display: '', maxHeight: '', overflow: '' }); });
      box.querySelectorAll('[data-fit-body]').forEach((b) => { Object.assign(b.style, { display: '', WebkitLineClamp: '', WebkitBoxOrient: '', overflow: '' }); });
      if (box.scrollHeight <= box.clientHeight + 1) { setRest(null); return; }
      const limit = box.clientHeight - 44; // room for the row naming what is in Details
      const top = (el) => el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      const bottom = (el) => el.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      const lineOf = (el) => parseFloat(getComputedStyle(el).lineHeight) || 20;
      if (keepAll) {
        // every block stays: the lines are shared out, short blocks whole, long ones end on an ellipsis
        const bodies = blocks.map((b) => b.querySelector('[data-fit-body]')).filter(Boolean);
        const lh = bodies.map(lineOf);
        const want = bodies.map((b, i) => Math.max(1, Math.round(b.getBoundingClientRect().height / lh[i])));
        const fixed = box.scrollHeight - bodies.reduce((a, b) => a + b.getBoundingClientRect().height, 0);
        let room = limit - fixed;
        const got = bodies.map(() => 0);
        for (let more = true; more;) {
          more = false;
          bodies.forEach((_, i) => {
            if (got[i] < want[i] && (got[i] === 0 || room >= lh[i])) { got[i] += 1; room -= lh[i]; more = true; }
          });
        }
        bodies.forEach((b, i) => {
          if (got[i] < want[i]) Object.assign(b.style, { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(got[i]), overflow: 'hidden' });
        });
        setRest([]);
        setMoreTop(Math.min(limit, Math.ceil(bottom(blocks[blocks.length - 1]))));
        return;
      }
      const hidden = [];
      let seen = false;
      let cut = false;
      blocks.forEach((b) => {
        const label = b.querySelector('[data-fit-label]')?.textContent;
        if (cut) { b.style.display = 'none'; if (label) hidden.push(label); return; }
        if (bottom(b) <= limit) { seen = true; return; }
        cut = true;
        const body = b.querySelector('[data-fit-body]');
        const items = body ? [...body.querySelectorAll('li')] : [];
        const fitting = items.filter((li) => bottom(li) <= limit);
        if (items.length && fitting.length) {
          items.forEach((li) => { if (bottom(li) > limit) li.style.display = 'none'; });
          if (label) hidden.push(`the rest of ${label.toLowerCase()}`);
          return;
        }
        if (seen || !body) { b.style.display = 'none'; if (label) hidden.push(label); return; }
        // the first block alone is longer than the space: its last full line ends on an ellipsis
        const target = items[0] || body;
        const lines = Math.max(1, Math.floor((limit - top(target)) / lineOf(target)));
        Object.assign(target.style, { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(lines), overflow: 'hidden' });
      });
      setRest(hidden);
      // the row sits right under the last line shown, not at the bottom of the space
      const shown = blocks.filter((b) => b.style.display !== 'none');
      setMoreTop(shown.length ? Math.min(limit, Math.ceil(bottom(shown[shown.length - 1]))) : 0);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let last = box.clientHeight;
    const ro = new ResizeObserver(() => { if (box.clientHeight !== last) { last = box.clientHeight; fit(); } });
    ro.observe(box);
    return () => ro.disconnect();
  }, [children, keepAll]);
  const more = rest && (rest.length ? `${rest.join(', ')} in Details` : 'Read all in Details');
  return (
    // hug: as tall as the text only, so the proof preview under it gets the room left over
    <div className={`relative flex min-h-0 flex-col ${hug ? 'flex-[0_1_auto]' : 'flex-1'} ${className}`} style={hug && more ? { minHeight: moreTop + 44 } : undefined}>
      <div ref={ref} data-fit-text data-overflowing={rest ? 'true' : undefined} className="relative min-h-0 flex-1 overflow-hidden">
        {children}
      </div>
      {more && (
        <button type="button" data-fit-more onClick={onMore} style={{ top: moreTop }} className="absolute left-4 inline-flex h-11 max-w-[calc(100%-2rem)] items-center gap-1 text-sm font-medium text-indigo-700">
          <span className="truncate first-letter:uppercase">{more}</span>
          <ChevronRightIcon className="h-4 w-4 shrink-0" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function TextBlock({ label, strong = false, children }) {
  if (!children) return null;
  return (
    <div className="mt-2.5 first:mt-0">
      <p data-fit-label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <div data-fit-body className={`mt-0.5 leading-snug text-gray-900 [overflow-wrap:anywhere] ${strong ? 'text-base font-semibold' : 'text-[15px]'}`}>{children}</div>
    </div>
  );
}

const PILL_LOOK = {
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-900 ring-amber-300',
  bad: 'bg-red-50 text-red-800 ring-red-200',
  info: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  muted: 'bg-gray-100 text-gray-600 ring-gray-200',
};

/** The top of a page: key, state, dates, the one-line summary and the flags. */
export function PageTop({ ticket, pill, dates, summary, chips, select, lines = 3 }) {
  return (
    <div className="shrink-0 px-4 pt-2.5">
      <div className="-my-2 flex items-center gap-1.5">
        {select}
        {/* the badge stays small; its link is a full 44px target */}
        <a
          href={JIRA_BROWSE + ticket.key}
          target="_blank"
          rel="noopener noreferrer"
          data-jira-key={ticket.key}
          aria-label={`Open ${ticket.key} in Jira`}
          className="flex h-11 shrink-0 items-center"
        >
          <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-gray-600">{ticket.key}</span>
        </a>
        {pill && (
          <span data-phone-pill={pill.kind} className={`inline-flex min-w-0 items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${PILL_LOOK[pill.kind]}`}>
            {pill.icon && <pill.icon className="h-3 w-3 shrink-0" aria-hidden />}
            <span className="truncate">{pill.label}</span>
          </span>
        )}
        {dates && <span data-phone-dates className="ml-auto shrink-0 text-[11px] tabular-nums text-gray-500">{dates}</span>}
      </div>
      {summary && <h3
        data-phone-summary
        className={`mt-1.5 text-[17px] font-semibold leading-snug text-gray-900 [overflow-wrap:anywhere] ${{ 3: 'line-clamp-3', 4: 'line-clamp-4', 5: 'line-clamp-5', 6: 'line-clamp-6' }[lines]}`}
      >
        {summary}
      </h3>}
      {chips}
    </div>
  );
}

/** "Filed 12 Oct · updated 22 Oct" from the Jira dates the sync carries. */
export function ticketDates(t) {
  const filed = day(t.jira_created);
  const updated = day(t.jira_updated);
  if (filed && updated && updated !== filed) return `Filed ${filed} · updated ${updated}`;
  return filed ? `Filed ${filed}` : '';
}

/** A one-line state the triage must not miss (hold, fix requested, cancel requested). */
export function Banner({ tone = 'bad', children }) {
  const look = tone === 'bad' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-950';
  return (
    <p data-phone-banner={tone} role="status" className={`mx-4 mt-2 flex shrink-0 items-center gap-1.5 truncate rounded-lg border px-2.5 py-1.5 text-[13px] ${look}`}>
      <ExclamationTriangleIcon className={`h-4 w-4 shrink-0 ${tone === 'bad' ? 'text-red-600' : 'text-amber-600'}`} aria-hidden />
      <span className="truncate">{children}</span>
    </p>
  );
}

/**
 * The actions under the thumb: up to three small ones (icon over label) and
 * the main one twice as wide on the right. Every target is at least 48px tall.
 */
export function ThumbBar({ actions = [], primary }) {
  return (
    <nav data-thumb-bar aria-label="Ticket actions" className="mt-auto shrink-0 border-t border-gray-200 bg-white px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
      <div className="grid grid-cols-5 gap-1.5">
        {actions.map((a) => {
          const Tag = a.href ? 'a' : 'button';
          return (
            <Tag
              key={a.id}
              data-thumb-action={a.id}
              {...(a.href ? { href: a.href, target: '_blank', rel: 'noopener noreferrer' } : { type: 'button', onClick: a.onClick, disabled: a.disabled })}
              className={`relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] font-medium leading-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40 ${
                a.tone === 'danger' ? 'text-red-700 hover:bg-red-50' : a.tone === 'fix' ? 'text-amber-800 hover:bg-amber-50' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <a.icon className="h-5 w-5" aria-hidden />
              <span className="max-w-full truncate">{a.label}</span>
              {a.badge > 0 && <span className="absolute right-2 top-1 min-w-[18px] rounded-full bg-indigo-600 px-1 text-[10px] font-semibold tabular-nums text-white">{a.badge}</span>}
            </Tag>
          );
        })}
        {primary && (() => {
          const Tag = primary.href ? 'a' : 'button';
          const span = 5 - actions.length;
          return (
            <Tag
              data-thumb-action={primary.id}
              data-thumb-primary
              {...(primary.href ? { href: primary.href, target: '_blank', rel: 'noopener noreferrer' } : { type: 'button', onClick: primary.onClick, disabled: primary.disabled })}
              style={{ gridColumn: `span ${span} / span ${span}` }}
              className={`flex min-h-[52px] items-center justify-center gap-1.5 rounded-xl px-2 text-[14px] font-semibold shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
                primary.muted ? 'bg-white text-gray-800 ring-1 ring-inset ring-gray-300 focus-visible:ring-gray-400' : 'bg-gray-900 text-white focus-visible:ring-gray-900'
              }`}
            >
              {/* on the narrowest phones the label keeps the room */}
              {primary.icon && <primary.icon className="h-4 w-4 shrink-0 max-[379px]:hidden" aria-hidden />}
              <span className="truncate">{primary.label}</span>
            </Tag>
          );
        })()}
      </div>
    </nav>
  );
}

export const icons = {
  details: DocumentTextIcon,
  chat: ChatBubbleLeftRightIcon,
  fix: WrenchScrewdriverIcon,
  open: ArrowTopRightOnSquareIcon,
  check: CheckIcon,
  later: ClockIcon,
  dismiss: XMarkIcon,
  bundles: RectangleStackIcon,
};

/** A page and its sheets: Details (the desktop card), Chat, Fix; one open at a time. */
export function usePageSheet() {
  const [sheet, setSheet] = useState(null);
  const close = useCallback(() => setSheet(null), []);
  return { sheet, open: setSheet, close };
}

/** Lines under the header on the Validation tab: the bundles, or the selection being merged. */
export function PhoneStrip({ children }) {
  return (
    <div data-phone-strip className="flex min-h-[48px] shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 py-1">
      {children}
    </div>
  );
}

export function StripButton({ children, primary = false, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-40 ${
        primary ? 'bg-gray-900 text-white' : 'text-gray-800 ring-1 ring-inset ring-gray-300'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/** The 44px select box of a page (merge several tickets into one). */
export function SelectToggle({ selected, disabled, onToggle, ticketKey }) {
  return (
    <label className="-my-2 -ml-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center" title="Select to merge">
      <input
        type="checkbox"
        data-select={ticketKey}
        checked={selected}
        disabled={disabled && !selected}
        onChange={onToggle}
        aria-label={`Select ${ticketKey} to merge`}
        className="h-5 w-5 rounded border-gray-300 text-gray-900 focus:ring-gray-900 disabled:opacity-40"
      />
    </label>
  );
}

/** true inside the phone cockpit: a tab component lays itself out as a feed. */
export function usePhoneLayout() {
  return !!usePhone();
}
