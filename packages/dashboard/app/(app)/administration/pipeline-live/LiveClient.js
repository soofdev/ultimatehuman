'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRightIcon, ArrowDownIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/20/solid';
import {
  livePicture, lastSyncOf, ago, cockpitHref, LIVE_REFRESH_MS, SHIPPED_TAB_DAYS, CHART_DAYS,
} from '@/app/lib/pipeline-live';

// A sync older than this reads as "quiet": the feeder runs every 15 min.
const QUIET_MS = 45 * 60 * 1000;
const SHIPPED_NODES = 18;

// Whose move a ticket is -> how its node looks. Colour is never alone: the
// column header names the owner and the detail says it in words.
const TURN_LOOK = {
  you: 'bg-amber-100 text-amber-950 ring-amber-300 hover:bg-amber-200',
  held: 'bg-white text-amber-900 ring-transparent outline-dashed outline-[1.5px] -outline-offset-[1.5px] outline-amber-500 hover:bg-amber-50',
  pipeline: 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50',
  building: 'bg-sky-50 text-sky-900 ring-sky-300 hover:bg-sky-100',
  parked: 'bg-gray-100 text-gray-500 ring-gray-200 hover:bg-gray-200',
  done: 'bg-emerald-50 text-emerald-900 ring-emerald-200 hover:bg-emerald-100',
};
const OWNER = {
  you: { label: 'You', cls: 'bg-amber-100 text-amber-900' },
  pipeline: { label: 'Pipeline', cls: 'bg-gray-100 text-gray-600' },
  done: { label: 'Done', cls: 'bg-emerald-50 text-emerald-800' },
};
// left to right; Needs decision and Manual share a column (both wait on a choice of his)
const COLUMNS = [['validate'], ['queued'], ['building'], ['decide', 'manual'], ['merge'], ['shipped']];

const lookOf = (n) => (n.held ? 'held' : (n.stage === 'building' || n.round ? 'building' : n.turn));
const DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };

/** Refetch the picture every 30s while the tab is visible, and on focus. Keeps the last one on failure. */
function useLiveSnapshot(initial) {
  const [snap, setSnap] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [checkedAt, setCheckedAt] = useState(() => Date.parse(initial.read_at));
  useEffect(() => {
    let stop = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/admin/pipeline/live', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = await res.json();
        if (stop) return;
        setSnap(next);
        setFailed(false);
        setCheckedAt(Date.parse(next.read_at) || Date.now());
      } catch {
        if (!stop) setFailed(true);
      }
    };
    const id = setInterval(refresh, LIVE_REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stop = true;
      clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return { snap, failed, checkedAt };
}

/** The keys that were not on the page at the previous refresh (empty on the first render). */
function useArrivals(nodes) {
  const prev = useRef(null);
  const [arrived, setArrived] = useState(() => new Set());
  const sig = nodes.map((n) => `${n.key}:${n.stage}`).join(',');
  useEffect(() => {
    const now = new Set(sig ? sig.split(',') : []);
    if (prev.current) setArrived(new Set([...now].filter((k) => !prev.current.has(k)).map((k) => k.split(':')[0])));
    prev.current = now;
  }, [sig]);
  return arrived;
}

export default function LiveClient({ initial }) {
  const { snap, failed, checkedAt } = useLiveSnapshot(initial);
  // the clock the relative times read: server time on the first render (no mismatch), then a 15s tick
  const [now, setNow] = useState(() => Date.parse(initial.read_at));
  // day boundaries are the viewer's: the parts that depend on them render after mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setNow(Date.now()); }, [checkedAt]);

  const pic = useMemo(() => livePicture(snap.tickets, now), [snap.tickets, now]);
  const prefix = useMemo(() => commonPrefix(pic.nodes.map((n) => n.key)), [pic.nodes]);
  const arrived = useArrivals(pic.nodes);
  const sync = lastSyncOf(snap.sync, snap.tickets);
  const stage = (k) => pic.stages.find((s) => s.key === k);

  const [detail, setDetail] = useState(null); // { node, rect, pinned }
  const show = useCallback((node, el, pinned = false) => setDetail({ node, rect: el.getBoundingClientRect(), pinned }), []);
  const hide = useCallback(() => setDetail((d) => (d?.pinned ? d : null)), []);
  const close = useCallback(() => setDetail(null), []);
  useEffect(() => {
    if (!detail) return undefined;
    const onScroll = () => setDetail(null);
    const onKey = (e) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [detail]);
  // a refresh moved or removed the ticket: the open detail follows the new data
  const detailNode = detail && pic.nodes.find((n) => n.key === detail.node.key);

  const nodeProps = { prefix, arrived, mounted, onShow: show, onHide: hide, pinnedKey: detail?.pinned ? detail.node.key : null };
  const w = pic.waiting;
  const building = stage('building').count + pic.nodes.filter((n) => n.stage !== 'building' && n.round).length;

  return (
    <div className="min-h-full bg-gray-50" data-live-page>
      <style>{LIVE_CSS}</style>
      <div className="mx-auto max-w-[1600px] px-4 pb-12 pt-16 sm:px-8 md:pt-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pipeline live</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              Every ticket of the bug pipeline on its stage, from intake to shipped. Amber is your move.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SyncPill sync={sync} now={now} failed={failed} mounted={mounted} />
            <Link
              href="/administration/claims"
              className="inline-flex min-h-[36px] items-center gap-1 rounded-full bg-white px-3.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              Open the cockpit
              <ChevronRightIcon className="h-4 w-4 text-gray-400" aria-hidden />
            </Link>
          </div>
        </header>

        <section aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div data-waiting-on-you className="col-span-2 rounded-2xl lg:col-span-1 bg-amber-50 p-5 ring-1 ring-amber-300">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="sm:w-48 sm:shrink-0">
                <p className="text-sm font-semibold text-amber-900">Waiting on you</p>
                <p data-waiting-total className="mt-1 text-5xl font-semibold leading-none tracking-tight text-amber-950 tabular-nums">
                  <Num value={w.total} />
                </p>
                <p className="mt-2 text-xs text-amber-800">
                  {w.oldest ? (
                    <>Longest wait:{' '}
                      <Link href={cockpitHref(w.oldest.stage, w.oldest.key)} data-oldest className="font-semibold underline decoration-amber-400 underline-offset-2 hover:decoration-amber-700">{w.oldest.key}</Link>
                      , filed {ago(w.oldest.created, now)}
                    </>
                  ) : 'tickets on your tabs'}
                </p>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <WaitTile tab="validate" label="To validate" value={w.validate} />
                <WaitTile tab="decide" label="Needs decision" value={w.decide} />
                <WaitTile tab="manual" label="Manual" value={w.manual} />
                <WaitTile tab="merge" label="Ready to merge" value={w.merge} note={w.held ? `${w.held} held` : null} />
              </div>
            </div>
          </div>
          <StatTile
            label="Pipeline working"
            value={building + stage('queued').count}
            lines={[`${building} building now`, `${stage('queued').count} in the fix queue`]}
          />
          <StatTile
            label={`Shipped, ${SHIPPED_TAB_DAYS} days`}
            value={stage('shipped').count}
            tone="done"
            lines={mounted
              ? [`${pic.today.shipped.length} today`, `${pic.today.filed.length} new ticket${pic.today.filed.length === 1 ? '' : 's'} filed today`]
              : [' ', ' ']}
          />
        </section>

        <section aria-labelledby="flow-title" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="flow-title" className="text-sm font-semibold text-gray-900">Flow</h2>
            <Legend looks={new Set(pic.nodes.map(lookOf))} filedToday={mounted && pic.today.filed.length > 0} />
          </div>
          <div data-flow className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6 xl:gap-5">
            {COLUMNS.map((keys, i) => (
              <div key={keys.join('+')} className="relative flex min-w-0 flex-col gap-3">
                {i > 0 && <Connector />}
                {keys.map((k) => <StageColumn key={k} stage={stage(k)} nodeProps={nodeProps} now={now} />)}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ShippedChart days={pic.shipped} mounted={mounted} />
          <TodayPanel today={pic.today} mounted={mounted} nodeProps={nodeProps} />
        </section>
      </div>

      {detail && detailNode && (
        <NodeDetail node={detailNode} rect={detail.rect} pinned={detail.pinned} now={now} onClose={close} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- header + summary

function SyncPill({ sync, now, failed, mounted }) {
  const quiet = !sync || now - sync.at > QUIET_MS;
  const text = !sync
    ? 'No sync received yet'
    : `${sync.kind === 'push' ? 'Synced' : 'Last change'} ${ago(sync.at, now)}`;
  return (
    <p
      data-sync-pill
      title={sync && mounted ? new Date(sync.at).toLocaleString() : undefined}
      className={`inline-flex min-h-[36px] items-center gap-2 rounded-full px-3.5 text-sm ring-1 ${
        quiet || failed ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-white text-gray-700 ring-gray-200'
      }`}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {!quiet && !failed && <span className="live-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${quiet || failed ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      </span>
      <span>
        {failed ? 'Could not refresh, retrying. ' : ''}
        {text}
        {quiet && sync ? ': the pipeline may be stopped' : ''}
      </span>
    </p>
  );
}

function WaitTile({ tab, label, value, note }) {
  return (
    <Link
      href={cockpitHref(tab)}
      data-wait-tile={tab}
      className="flex min-h-[48px] items-center gap-2.5 rounded-xl bg-white/80 px-3 py-2 ring-1 ring-amber-200 transition-colors hover:bg-white hover:ring-amber-400"
    >
      <span data-wait-count className="w-9 shrink-0 text-2xl font-semibold leading-none text-amber-950 tabular-nums"><Num value={value} /></span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[13px] font-medium text-amber-950">{label}</span>
        {note && <span className="block text-xs text-amber-800">{note}</span>}
      </span>
      <ChevronRightIcon className="ml-auto h-4 w-4 shrink-0 text-amber-400" aria-hidden />
    </Link>
  );
}

function StatTile({ label, value, lines, tone }) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-gray-200 sm:p-5">
      <p className="text-sm font-semibold text-gray-900">{label}</p>
      <p className={`mt-1 text-4xl font-semibold leading-none tracking-tight tabular-nums ${!value ? 'text-gray-400' : tone === 'done' ? 'text-emerald-800' : 'text-gray-900'}`}>
        <Num value={value} />
      </p>
      <ul className="mt-3 space-y-0.5 text-xs text-gray-600">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

/** A number that fades in when it changes (a refresh moved it). */
function Num({ value }) {
  return <span key={value} className="live-num inline-block">{value}</span>;
}

function Legend({ looks, filedToday }) {
  const all = [
    ['you', 'Your move'],
    ['held', 'Held, your call'],
    ['pipeline', "Pipeline's move"],
    ['building', 'Building'],
    ['parked', 'Parked'],
    ['done', 'Shipped'],
  ];
  const items = all.filter(([look]) => look === 'you' || looks.has(look));
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
      {items.map(([look, label]) => (
        <li key={look} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-3 w-4 rounded ring-1 ring-inset ${TURN_LOOK[look]}`} aria-hidden />
          {label}
        </li>
      ))}
      {filedToday && (
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden />
          Filed today
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------- flow

function Connector() {
  return (
    <>
      <span aria-hidden className="absolute -left-[18px] top-[22px] hidden h-5 w-5 items-center justify-center text-gray-300 xl:flex">
        <ArrowRightIcon className="h-4 w-4" />
      </span>
      <span aria-hidden className="-mb-1 -mt-1 flex justify-center text-gray-300 md:hidden">
        <ArrowDownIcon className="h-4 w-4" />
      </span>
    </>
  );
}

function StageColumn({ stage, nodeProps, now }) {
  const owner = OWNER[stage.owner];
  const mine = stage.owner === 'you';
  let nodes = stage.nodes;
  let more = 0;
  if (stage.key === 'shipped' && nodes.length > SHIPPED_NODES) {
    more = nodes.length - SHIPPED_NODES;
    nodes = nodes.slice(0, SHIPPED_NODES);
  }
  const parked = stage.key === 'validate' ? nodes.filter((n) => n.turn === 'parked') : [];
  const answered = stage.key === 'decide' ? nodes.filter((n) => n.turn === 'pipeline') : [];
  const main = nodes.filter((n) => !parked.includes(n) && !answered.includes(n));
  const latest = stage.key === 'shipped' && stage.nodes[0]?.at;

  return (
    <div
      data-stage={stage.key}
      className={`flex min-w-0 flex-col rounded-2xl bg-white ring-1 ${mine && stage.count ? 'ring-amber-300' : 'ring-gray-200'}`}
    >
      <div className="flex items-start justify-between gap-2 px-3 pb-2 pt-3">
        <div className="min-w-0">
          <span className={`inline-block rounded-full px-1.5 py-px text-[11px] font-medium ${owner.cls}`}>{owner.label}</span>
          <h3 className="mt-1 truncate text-[13px] font-semibold text-gray-900">{stage.label}</h3>
        </div>
        <span data-stage-count className={`text-2xl font-semibold leading-none tabular-nums ${mine && stage.count ? 'text-amber-950' : 'text-gray-900'}`}>
          <Num value={stage.count} />
        </span>
      </div>
      <p className="px-3 text-xs leading-snug text-gray-500">
        {latest ? `Latest ${ago(latest, now)}` : stage.hint}
      </p>
      <div className="flex flex-1 flex-col gap-2 px-3 pb-3 pt-2.5">
        {main.length > 0 && <NodeGrid nodes={main} phoneCap={stage.key === 'shipped' ? 9 : null} {...nodeProps} />}
        {answered.length > 0 && <SubGroup label={`${answered.length} answered, pipeline's move`}><NodeGrid nodes={answered} {...nodeProps} /></SubGroup>}
        {parked.length > 0 && <SubGroup label={`${parked.length} parked with Later`}><NodeGrid nodes={parked} {...nodeProps} /></SubGroup>}
        {!nodes.length && <p className="text-xs text-gray-500">Nothing here right now.</p>}
      </div>
      <Link
        href={cockpitHref(stage.key)}
        className="mt-auto flex min-h-[36px] items-center justify-between border-t border-gray-100 px-3 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
      >
        {more ? `${more} more on the cockpit` : 'Open on the cockpit'}
        <ChevronRightIcon className="h-4 w-4 text-gray-300" aria-hidden />
      </Link>
    </div>
  );
}

function SubGroup({ label, children }) {
  return (
    <div className="border-t border-dashed border-gray-200 pt-2">
      <p className="mb-1.5 text-xs text-gray-500">{label}</p>
      {children}
    </div>
  );
}

function NodeGrid({ nodes, phoneCap = null, ...props }) {
  return (
    <ul className="flex flex-wrap gap-2 sm:gap-[5px]">
      {nodes.map((n, i) => <Node key={n.key} node={n} hideOnPhone={phoneCap != null && i >= phoneCap} {...props} />)}
    </ul>
  );
}

/**
 * One ticket. Hover or focus shows its detail; a click opens its card on the
 * cockpit. On a touch screen the first tap shows the detail (with the link),
 * the second opens the card.
 */
function Node({ node, prefix, arrived, mounted, onShow, onHide, pinnedKey, hideOnPhone }) {
  const touch = useRef(false);
  const label = prefix && node.key.startsWith(prefix) ? node.key.slice(prefix.length) : node.key;
  return (
    <li className={hideOnPhone ? 'hidden sm:block' : undefined}>
      <Link
        href={cockpitHref(node.stage, node.key)}
        data-live-node={node.key}
        data-turn={node.turn}
        aria-label={`${node.key}${node.held ? ' (held)' : ''}: ${node.status}`}
        onPointerDown={(e) => { touch.current = e.pointerType === 'touch'; }}
        onMouseEnter={(e) => onShow(node, e.currentTarget)}
        onMouseLeave={onHide}
        onFocus={(e) => onShow(node, e.currentTarget)}
        onBlur={onHide}
        onClick={(e) => {
          if (touch.current && pinnedKey !== node.key) {
            e.preventDefault();
            onShow(node, e.currentTarget, true);
          }
        }}
        className={`relative inline-flex h-9 min-w-[48px] items-center justify-center rounded-md px-1 font-mono text-[13px] sm:h-7 sm:min-w-[42px] sm:text-[12px] tabular-nums ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 ${TURN_LOOK[lookOf(node)]} ${node.turn === 'you' ? 'font-semibold' : ''} ${arrived.has(node.key) ? 'live-arrive' : ''}`}
      >
        {label}
        {(node.stage === 'building' || node.round) && (
          <span className="live-pulse absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-sky-500 ring-2 ring-white" aria-hidden />
        )}
        {mounted && node.newToday && !(node.stage === 'building' || node.round) && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-indigo-500 ring-2 ring-white" aria-hidden />
        )}
      </Link>
    </li>
  );
}

function NodeDetail({ node, rect, pinned, now, onClose }) {
  const W = 288;
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - W / 2, vw - W - 8));
  const below = rect.bottom + 8;
  const style = below + 170 > vh ? { left, bottom: vh - rect.top + 8, width: W } : { left, top: below, width: W };
  const when = node.stage === 'shipped' ? (node.at ? `Merged ${ago(node.at, now)}` : null)
    : node.stage === 'manual' ? (node.at ? `Stopped ${ago(node.at, now)}` : null)
      : (node.created ? `Filed ${ago(node.created, now)}` : null);
  return (
    <>
      {pinned && <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-transparent" />}
      <div
        role={pinned ? 'dialog' : 'tooltip'}
        data-node-detail={node.key}
        style={style}
        className={`fixed z-50 rounded-xl bg-white p-3.5 text-left shadow-lg ring-1 ring-gray-200 ${pinned ? '' : 'pointer-events-none'}`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-xs font-semibold text-gray-900">{node.key}</p>
          {pinned && (
            <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded p-1 text-gray-400 hover:text-gray-700">
              <XMarkIcon className="h-4 w-4" />
            </button>
          )}
        </div>
        {node.title && <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-gray-900">{node.title}</p>}
        <p className={`mt-1.5 line-clamp-3 text-xs leading-relaxed ${node.turn === 'you' ? 'text-amber-900' : 'text-gray-600'}`}>{node.status}</p>
        {(when || node.flags.length > 0) && (
          <p className="mt-1.5 text-[11px] text-gray-500">
            {[when, node.newToday ? 'new today' : null, ...node.flags].filter(Boolean).join(' · ')}
          </p>
        )}
        {pinned ? (
          <Link href={cockpitHref(node.stage, node.key)} className="mt-3 flex min-h-[40px] items-center justify-center gap-1 rounded-lg bg-gray-900 text-sm font-medium text-white">
            Open the card <ChevronRightIcon className="h-4 w-4" aria-hidden />
          </Link>
        ) : (
          <p className="mt-2 text-[11px] text-gray-500">Click to open the card</p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shipped chart + today

function niceMax(v) {
  if (v <= 4) return 4;
  const step = v <= 10 ? 2 : v <= 25 ? 5 : v <= 50 ? 10 : 20;
  return Math.ceil(v / step) * step;
}

/** Shipped tickets per day (merge date on GitHub), one bar a day, today last. Days before the stored history are hatched. */
function ShippedChart({ days, mounted }) {
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(0, ...days.map((d) => d.count)));
  const total = days.reduce((s, d) => s + d.count, 0);
  const peak = days.reduce((p, d, i) => (d.count > (days[p]?.count || 0) ? i : p), 0);
  const unknown = days.filter((d) => !d.known).length;
  const H = 160;
  return (
    <figure data-shipped-chart className="rounded-2xl bg-white p-5 ring-1 ring-gray-200">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">Shipped per day</span>
        <span className="text-xs text-gray-500">{mounted ? `${total} in the last ${CHART_DAYS} days` : '\u00a0'}</span>
      </figcaption>
      <div className="relative mt-4" style={{ height: H + 24 }}>
        {/* recessive grid: baseline, half, top */}
        {[0, 0.5, 1].map((f) => (
          <div key={f} className="absolute left-7 right-0 flex items-center" style={{ bottom: 24 + f * H }}>
            <span className="absolute -left-7 w-6 -translate-y-px text-right text-[11px] tabular-nums text-gray-500">{mounted ? Math.round(max * f) : ''}</span>
            <span className={`h-px w-full ${f === 0 ? 'bg-gray-300' : 'bg-gray-100'}`} />
          </div>
        ))}
        {mounted && (
          <div className="absolute bottom-0 left-7 right-0 top-0 flex items-stretch gap-[2px]">
            {days.map((d, i) => {
              const last = i === days.length - 1;
              const h = d.count ? Math.max(3, (d.count / max) * H) : 0;
              const date = new Date(d.start);
              const showTick = last || i % 2 === (days.length - 1) % 2;
              const firstTick = showTick && days.findIndex((x, j) => j % 2 === (days.length - 1) % 2) === i;
              const label = `${date.toLocaleDateString(undefined, DAY_FMT)}: ${d.known ? `${d.count} shipped` : 'no record'}`;
              return (
                <div
                  key={d.start}
                  data-day={`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`}
                  data-count={d.count}
                  data-known={d.known ? 'yes' : 'no'}
                  tabIndex={0}
                  aria-label={label}
                  className="relative flex min-w-0 flex-1 flex-col justify-end rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => setHover(hover === i ? null : i)}
                >
                  <div className={`relative mx-auto flex w-full flex-col justify-end ${last ? 'rounded-t-md bg-gray-50' : ''}`} style={{ height: H }}>
                    {!d.known && (
                      <div aria-hidden className="absolute inset-x-0 bottom-0 top-0 [background-image:repeating-linear-gradient(135deg,rgb(243_244_246)_0_2px,transparent_2px_7px)]" />
                    )}
                    {(i === peak || last) && d.known && (d.count > 0 || last) && (
                      <span className="relative mb-1 text-center text-[11px] font-medium tabular-nums text-gray-700">{d.count}</span>
                    )}
                    <div
                      className={`relative mx-auto w-full max-w-[28px] rounded-t-[4px] ${last ? 'bg-emerald-700' : 'bg-emerald-500'} ${hover === i ? 'opacity-80' : ''}`}
                      style={{ height: h }}
                    />
                  </div>
                  <span className={`block h-6 whitespace-nowrap pt-1.5 text-center text-[11px] leading-none tabular-nums ${last ? 'font-semibold text-gray-800' : 'text-gray-500'}`}>
                    {showTick && (last
                      ? <><span className="sm:hidden">{date.getDate()}</span><span className="hidden sm:inline">Today</span></>
                      : firstTick
                        ? <><span className="sm:hidden">{date.getDate()}</span><span className="hidden sm:inline">{date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span></>
                        : date.getDate())}
                  </span>
                  {hover === i && (
                    <div role="tooltip" className={`pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[220px] rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg ${i > days.length / 2 ? 'right-0' : 'left-0'}`}>
                      <p className="font-medium">{date.toLocaleDateString(undefined, DAY_FMT)}</p>
                      <p className="text-gray-300">
                        {!d.known ? 'Before this page\'s records' : `${d.count} shipped${d.count ? `: ${d.keys.slice(0, 4).join(', ')}${d.keys.length > 4 ? ` and ${d.keys.length - 4} more` : ''}` : ''}`}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="mt-3 max-w-prose text-xs leading-relaxed text-gray-500">
        Counted from each ticket&apos;s merge date on GitHub.
        {mounted && unknown > 0 ? ' Hatched days come before this page\'s records: no data, not zero.' : ''}
      </p>
    </figure>
  );
}

function TodayPanel({ today, mounted, nodeProps }) {
  return (
    <div data-today className="self-start rounded-2xl bg-white p-5 ring-1 ring-gray-200">
      <p className="text-sm font-semibold text-gray-900">Today</p>
      <div className="mt-3 space-y-4">
        <div>
          <p className="mb-1.5 text-xs text-gray-600">
            <span className="font-semibold tabular-nums text-gray-900">{mounted ? today.filed.length : ''}</span> filed on Jira today, still open
          </p>
          {mounted && (today.filed.length ? <NodeGrid nodes={today.filed} {...nodeProps} /> : <p className="text-xs text-gray-500">None yet</p>)}
        </div>
        <div>
          <p className="mb-1.5 text-xs text-gray-600">
            <span className="font-semibold tabular-nums text-gray-900">{mounted ? today.shipped.length : ''}</span> shipped today
          </p>
          {mounted && (today.shipped.length ? <NodeGrid nodes={today.shipped} {...nodeProps} /> : <p className="text-xs text-gray-500">None yet</p>)}
        </div>
      </div>
    </div>
  );
}

/** "SCRUM-" when every key shares it (nodes then show the number only), else ''. */
function commonPrefix(keys) {
  if (!keys.length) return '';
  const p = /^[A-Z][A-Z0-9]+-/.exec(keys[0])?.[0] || '';
  return p && keys.every((k) => k.startsWith(p)) ? p : '';
}

const LIVE_CSS = `
@keyframes live-ping { 75%, 100% { transform: scale(2.2); opacity: 0; } }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes live-arrive { from { box-shadow: 0 0 0 3px rgb(99 102 241 / .45); } to { box-shadow: 0 0 0 0 rgb(99 102 241 / 0); } }
@keyframes live-num { from { opacity: .25; } to { opacity: 1; } }
.live-ping { animation: live-ping 2s cubic-bezier(0, 0, .2, 1) infinite; }
.live-pulse { animation: live-pulse 1.6s ease-in-out infinite; }
.live-arrive { animation: live-arrive 2.4s ease-out 1; }
.live-num { animation: live-num .6s ease-out 1; }
@media (prefers-reduced-motion: reduce) { .live-ping, .live-pulse, .live-arrive, .live-num { animation: none; } }
`;
