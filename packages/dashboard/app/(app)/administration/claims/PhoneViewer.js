'use client';

import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, XMarkIcon,
} from '@heroicons/react/20/solid';

/**
 * The full-screen proof viewer on a phone (below lg; desktop keeps its Lightbox).
 *
 * ONE gesture layer: native Pointer Events on the viewer, `touch-action: none`,
 * so the browser never pans or zooms the page underneath and no other handler
 * competes. Every coordinate is read inside the event and kept as plain
 * numbers; nothing reads an event later (the old viewer read
 * `e.currentTarget` inside a state updater, after React had nulled it).
 *
 * The gestures, decided once per touch:
 * - two fingers: pinch, the image scales about the finger midpoint. A touch
 *   that ever had two fingers never becomes a tap or a swipe.
 * - one finger while zoomed: pan, held inside the image's edges. Pushing on
 *   past an edge the image was already at moves to the next/previous image.
 * - one finger, not zoomed: past the 8px slop, horizontal = swipe to the
 *   neighbour, downward = drag to close.
 * - tap: left third = previous, right third = next, zoom level and position
 *   kept (Instagram stories). Double-tap toggles fit / 2.5x at the tap point,
 *   so a single tap waits the double-tap window before it acts.
 * While open, the ticket feed and the sheet behind are locked in place.
 */

const evidenceSrc = (e) => `/api/admin/pipeline/evidence?k=${encodeURIComponent(e.s3_key)}`;

const SLOP = 8; // px a finger moves before a touch stops being a tap (Android TOUCH_SLOP)
const TAP_MS = 300; // longest press that still counts as a tap
const DOUBLE_MS = 280; // second tap within this, and DOUBLE_PX of the first = double-tap
const DOUBLE_PX = 40;
const ZOOM = 2.5; // double-tap / zoom button level
const MAX = 5;
const MIN_PINCH = 0.8; // a pinch may go a little under fit, it springs back on release
const SWIPE_FRAC = 0.22; // of the width, or a flick
const FLICK = 0.45; // px/ms
const EDGE_PUSH = 0.28; // of the width, pushed past an edge while zoomed
const CLOSE_PX = 110;
const SETTLE = 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function PhoneViewer({ images, index, onIndex, onClose }) {
  const n = images.length;
  const image = images[index];
  const root = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);
  const closeRef = useRef(null);
  const [zoomed, setZoomed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [broken, setBroken] = useState(null); // the image that failed to load
  const zoomedRef = useRef(false);
  // the one transform: scale + translation of the image from its fitted, centred place
  const tf = useRef({ s: 1, tx: 0, ty: 0 });
  const geo = useRef(null); // { W, H, cx, cy, w, h } measured, never read from an event later
  const carry = useRef(null); // { s, u, v }: zoom kept across a switch, as a point of the image
  const live = useRef({ index, n, onIndex, onClose });
  live.current = { index, n, onIndex, onClose };
  // an error in a native listener (load, resize, a gesture) is rethrown in render, so the boundary catches it too
  const [, setCrash] = useState(null);
  const escalate = useCallback((err) => setCrash(() => { throw err; }), []);

  const measure = useCallback(() => {
    const st = stage.current; const im = img.current;
    if (!st || !im) return null;
    const r = st.getBoundingClientRect();
    geo.current = {
      W: window.innerWidth, H: window.innerHeight,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      w: im.offsetWidth || 1, h: im.offsetHeight || 1,
    };
    return geo.current;
  }, []);

  // how far the image may travel at scale s: it covers the screen or stays centred
  const bounds = (s) => {
    const g = geo.current;
    if (!g) return { x0: 0, x1: 0, y0: 0, y1: 0 };
    const sw = s * g.w; const sh = s * g.h;
    const x0 = sw > g.W ? g.W - g.cx - sw / 2 : 0; const x1 = sw > g.W ? sw / 2 - g.cx : 0;
    const y0 = sh > g.H ? g.H - g.cy - sh / 2 : 0; const y1 = sh > g.H ? sh / 2 - g.cy : 0;
    return { x0: Math.min(x0, 0), x1: Math.max(x1, 0), y0: Math.min(y0, 0), y1: Math.max(y1, 0) };
  };
  const clampT = (t) => {
    const b = bounds(t.s);
    return { s: t.s, tx: clamp(t.tx, b.x0, b.x1), ty: clamp(t.ty, b.y0, b.y1) };
  };

  const apply = (t, { animate = false, fade = null } = {}) => {
    tf.current = t;
    const im = img.current; const el = root.current;
    if (im) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      im.style.transition = animate && !reduce ? SETTLE : 'none';
      im.style.transform = `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.s})`;
    }
    if (el) {
      el.dataset.viewerScale = t.s.toFixed(3);
      el.dataset.viewerTx = Math.round(t.tx);
      el.dataset.viewerTy = Math.round(t.ty);
      el.style.backgroundColor = fade == null ? '' : `rgba(3, 7, 18, ${fade})`;
      if (fade == null) delete el.dataset.closing; else el.dataset.closing = '';
    }
    const z = t.s > 1.01;
    if (z !== zoomedRef.current) { zoomedRef.current = z; setZoomed(z); }
  };

  // a switch: the new image opens at the same zoom, on the same point of the image
  const go = useCallback((d, keep = true) => {
    const { index: i, n: count, onIndex: set } = live.current;
    if (count < 2) return;
    const t = tf.current; const g = geo.current;
    carry.current = keep && t.s > 1.01 && g
      ? { s: t.s, u: (g.W / 2 - g.cx - t.tx) / t.s / g.w, v: (g.H / 2 - g.cy - t.ty) / t.s / g.h }
      : null;
    set((i + d + count) % count);
  }, []);

  const place = useCallback(() => {
    if (!measure()) return;
    const c = carry.current; const g = geo.current;
    if (!c) { apply({ s: 1, tx: 0, ty: 0 }); return; }
    apply(clampT({ s: c.s, tx: g.W / 2 - g.cx - c.s * c.u * g.w, ty: g.H / 2 - g.cy - c.s * c.v * g.h }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // each image: placed before paint (fit, or the carried zoom), again once its size is known
  useLayoutEffect(() => {
    const im = img.current;
    if (!im) return undefined;
    if (im.complete && im.naturalWidth) place();
    else apply({ s: carry.current?.s || 1, tx: 0, ty: 0 });
    const onLoad = () => { try { place(); } catch (err) { escalate(err); } };
    im.addEventListener('load', onLoad);
    return () => im.removeEventListener('load', onLoad);
  }, [index, retry, place, escalate]); // eslint-disable-line react-hooks/exhaustive-deps

  // the neighbours load ahead so a switch is instant
  useEffect(() => {
    if (n < 2) return;
    [images[(index + 1) % n], images[(index - 1 + n) % n]].forEach((e) => { new window.Image().src = evidenceSrc(e); });
  }, [images, index, n]);

  // focus in, back to the opener on close; Esc and the arrow keys
  useEffect(() => {
    const back = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') live.current.onClose();
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      back?.focus?.({ preventScroll: true });
    };
  }, [go]);

  // the feed and any sheet behind stay exactly where they were
  useEffect(() => {
    const locked = [...document.querySelectorAll('[data-phone-feed], [data-sheet-body]')].map((el) => ({
      el, overflow: el.style.overflow, top: el.scrollTop,
    }));
    locked.forEach(({ el }) => { el.style.overflow = 'hidden'; });
    return () => locked.forEach(({ el, overflow, top }) => { el.style.overflow = overflow; el.scrollTop = top; });
  }, []);

  useEffect(() => {
    const onResize = () => { try { if (measure()) apply(clampT(tf.current)); } catch (err) { escalate(err); } };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure, escalate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the gesture layer
  useEffect(() => {
    const el = root.current;
    const pts = new Map(); // pointerId -> { x, y }
    let mode = 'idle'; // idle | pending | pinch | pan | swipe | dismiss | none
    let multi = false; // this touch had two fingers at some point
    let start = null; // { x, y, t }
    let base = null; // transform at the start of the current phase
    let pinch0 = null; // { d, qx, qy }
    let edge = null; // { left, right }: image already at that edge when the pan began
    let samples = []; // recent { t, x, y } for the release velocity
    let lastTap = null; let tapTimer = 0; let exitTimer = 0;
    const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // the image leaves the way the finger sent it, then the switch or the close happens
    const leave = (t, fade, then) => {
      if (reduce()) { then(); return; }
      apply(t, { animate: true, fade });
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { try { then(); } catch (err) { escalate(err); } }, 180);
    };
    const cancelTap = () => { clearTimeout(tapTimer); tapTimer = 0; };

    const velocity = () => {
      const now = performance.now();
      const recent = samples.filter((p) => now - p.t < 100);
      if (recent.length < 2) return { vx: 0, vy: 0 };
      const a = recent[0]; const b = recent[recent.length - 1];
      const dt = Math.max(1, b.t - a.t);
      return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
    };
    const two = () => { const [a, b] = [...pts.values()]; return { a, b, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    const beginPinch = () => {
      measure();
      const { d, mx, my } = two(); const t = tf.current; const g = geo.current;
      base = { ...t };
      // the image point under the midpoint, in fitted pixels from the image centre
      pinch0 = { d, qx: (mx - g.cx - t.tx) / t.s, qy: (my - g.cy - t.ty) / t.s };
      mode = 'pinch'; multi = true; cancelTap();
    };
    const beginPan = (p) => {
      measure();
      base = { ...tf.current }; start = { x: p.x, y: p.y, t: performance.now() };
      const b = bounds(base.s);
      edge = { left: base.tx >= b.x1 - 1, right: base.tx <= b.x0 + 1 };
      mode = 'pan';
    };
    const settle = () => apply(clampT({ ...tf.current, s: clamp(tf.current.s, 1, MAX) }), { animate: true });
    const toFit = () => apply({ s: 1, tx: 0, ty: 0 }, { animate: true });

    const toggleZoom = (x, y) => {
      if (!measure()) return;
      if (tf.current.s > 1.01) { toFit(); return; }
      const g = geo.current;
      apply(clampT({ s: ZOOM, tx: (1 - ZOOM) * (x - g.cx), ty: (1 - ZOOM) * (y - g.cy) }), { animate: true });
    };
    const onTap = (x, y, t) => {
      if (lastTap && t - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_PX) {
        cancelTap(); lastTap = null; toggleZoom(x, y);
        return;
      }
      lastTap = { x, y, t };
      cancelTap();
      tapTimer = setTimeout(() => {
        tapTimer = 0; lastTap = null;
        const W = window.innerWidth;
        try {
          if (x < W / 3) go(-1);
          else if (x > (W * 2) / 3) go(1);
          // the middle shows or hides the controls, to see all of a zoomed image (native photo viewers)
          else if ('chromeHidden' in el.dataset) delete el.dataset.chromeHidden;
          else el.dataset.chromeHidden = '';
        } catch (err) { escalate(err); }
      }, DOUBLE_MS);
    };

    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest?.('[data-viewer-control]')) return;
      if (pts.size >= 2) return; // a third finger changes nothing
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerType === 'mouse') el.setPointerCapture?.(e.pointerId);
      if (pts.size === 1) {
        measure();
        multi = false; mode = 'pending';
        start = { x: e.clientX, y: e.clientY, t: performance.now() };
        base = { ...tf.current };
        samples = [{ t: start.t, x: e.clientX, y: e.clientY }];
        apply(tf.current); // stops a settle animation where it is
      } else beginPinch();
    };

    const move = (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (mode === 'pinch' && pts.size === 2) {
        const { d, mx, my } = two(); const g = geo.current;
        const s = clamp(base.s * (d / pinch0.d), MIN_PINCH, MAX);
        apply({ s, tx: mx - g.cx - s * pinch0.qx, ty: my - g.cy - s * pinch0.qy });
        return;
      }
      if (pts.size !== 1) return;
      samples.push({ t: performance.now(), x: p.x, y: p.y });
      if (samples.length > 12) samples.shift();
      const dx = p.x - start.x; const dy = p.y - start.y;
      if (mode === 'pending') {
        if (Math.hypot(dx, dy) < SLOP) return;
        cancelTap(); lastTap = null;
        if (tf.current.s > 1.01) beginPan(start);
        else if (multi) mode = 'none';
        else if (Math.abs(dx) > Math.abs(dy)) mode = live.current.n > 1 ? 'swipe' : 'none';
        else mode = dy > 0 ? 'dismiss' : 'none';
      }
      const g = geo.current;
      if (mode === 'pan') {
        const b = bounds(base.s);
        const rubber = (v, lo, hi) => (v < lo ? lo + (v - lo) * 0.35 : v > hi ? hi + (v - hi) * 0.35 : v);
        apply({ s: base.s, tx: rubber(base.tx + dx, b.x0, b.x1), ty: rubber(base.ty + dy, b.y0, b.y1) });
      } else if (mode === 'swipe') {
        apply({ s: 1, tx: dx, ty: 0 });
      } else if (mode === 'dismiss') {
        const k = Math.max(0, dy);
        apply({ s: 1 - Math.min(k / g.H, 1) * 0.25, tx: dx * 0.3, ty: k }, { fade: Math.max(0.2, 1 - k / 400) });
      }
    };

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      const cancelled = e.type === 'pointercancel';
      if (mode === 'pinch') {
        if (pts.size === 1) {
          // one finger stays: it pans a zoomed image, it never swipes
          const [rest] = [...pts.values()];
          if (tf.current.s > 1.01) beginPan(rest); else mode = 'none';
          samples = [];
          return;
        }
        if (pts.size === 0) { settle(); mode = 'idle'; }
        return;
      }
      if (pts.size > 0) return;
      const W = window.innerWidth;
      const dx = p.x - start.x; const dy = p.y - start.y;
      const { vx, vy } = velocity();
      const was = mode; mode = 'idle';
      if (cancelled) { if (was !== 'pending') settle(); return; }
      if (was === 'pending') {
        if (!multi && performance.now() - start.t < TAP_MS) onTap(p.x, p.y, performance.now());
      } else if (was === 'pan') {
        const pushedPast = (side) => {
          const b = bounds(base.s);
          return side === 'left' ? base.tx + dx - b.x1 : b.x0 - (base.tx + dx);
        };
        const far = W * EDGE_PUSH;
        // never right after a pinch: a pinch never switches image
        if (multi) settle();
        else if (edge.left && dx > 0 && Math.abs(dx) > Math.abs(dy) && pushedPast('left') > far) go(-1);
        else if (edge.right && dx < 0 && Math.abs(dx) > Math.abs(dy) && pushedPast('right') > far) go(1);
        else settle();
      } else if (was === 'swipe') {
        const commit = Math.abs(dx) > W * SWIPE_FRAC || (Math.abs(vx) > FLICK && Math.abs(dx) > 40 && Math.sign(vx) === Math.sign(dx));
        if (commit) leave({ s: 1, tx: dx < 0 ? -W : W, ty: 0 }, null, () => go(dx < 0 ? 1 : -1, false));
        else toFit();
      } else if (was === 'dismiss') {
        if (dy > CLOSE_PX || (vy > FLICK && dy > 40)) leave({ s: 0.8, tx: dx * 0.3, ty: geo.current.H }, 0, () => live.current.onClose());
        else apply({ s: 1, tx: 0, ty: 0 }, { animate: true });
      } else settle();
    };

    // belt and braces for iOS: no native pinch / scroll ever starts from the viewer
    const noNative = (e) => e.preventDefault();
    const noMultiStart = (e) => { if (e.touches.length > 1) e.preventDefault(); };
    const guard = (fn) => (e) => {
      try { fn(e); } catch (err) {
        pts.clear(); mode = 'idle'; cancelTap();
        escalate(err);
      }
    };
    const onDown = guard(down); const onMove = guard(move); const onUp = guard(up);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('touchmove', noNative, { passive: false });
    el.addEventListener('touchstart', noMultiStart, { passive: false });
    el.addEventListener('gesturestart', noNative, { passive: false });
    el.addEventListener('gesturechange', noNative, { passive: false });
    return () => {
      cancelTap(); clearTimeout(exitTimer);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('touchmove', noNative);
      el.removeEventListener('touchstart', noMultiStart);
      el.removeEventListener('gesturestart', noNative);
      el.removeEventListener('gesturechange', noNative);
    };
  }, [go, measure, escalate]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomButton = () => {
    if (!measure()) return;
    if (tf.current.s > 1.01) apply({ s: 1, tx: 0, ty: 0 }, { animate: true });
    else { const g = geo.current; apply(clampT({ s: ZOOM, tx: (1 - ZOOM) * (g.W / 2 - g.cx), ty: (1 - ZOOM) * (g.H / 2 - g.cy) }), { animate: true }); }
  };
  // React events from the portal still bubble to the page's React tree (the feed): stop them here
  const stop = (e) => e.stopPropagation();
  const control = 'flex items-center justify-center rounded-full bg-gray-900/75 text-white shadow-lg ring-1 ring-white/20 active:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-white';
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={image.caption || image.name}
      data-lightbox
      data-lightbox-phone
      data-lightbox-index={index}
      data-lightbox-kind={image.chat ? 'chat' : 'proof'}
      onClick={stop} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}
      onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop}
      className="group fixed inset-0 z-50 select-none overflow-hidden overscroll-none bg-gray-950 text-white [-webkit-touch-callout:none] [touch-action:none]"
    >
      <div ref={stage} data-viewer-stage className={`absolute inset-x-0 ${n > 1 ? 'bottom-[calc(9.5rem+env(safe-area-inset-bottom))]' : 'bottom-[calc(5rem+env(safe-area-inset-bottom))]'} top-[calc(4rem+env(safe-area-inset-top))] flex items-center justify-center px-3`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={img}
          key={`${image.sha256}-${retry}`}
          data-viewer-img
          onError={() => setBroken(image.sha256)}
          src={evidenceSrc(image)}
          alt={image.caption || image.name}
          draggable={false}
          className="block max-h-full max-w-full origin-center rounded-lg bg-white object-contain shadow-2xl will-change-transform"
        />
      </div>

      {/* the controls sit on a dark scrim, readable over a zoomed white screenshot; they fade while dragging to close */}
      {broken === image.sha256 && (
        <div data-viewer-broken className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-gray-300">This image did not load.</p>
          <button type="button" data-viewer-control onClick={() => { setBroken(null); setRetry((r) => r + 1); }} className="h-11 rounded-lg bg-white/15 px-4 text-sm font-semibold text-white active:bg-white/25">Try again</button>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-gray-950/90 to-transparent px-3 pb-6 pt-[max(0.75rem,env(safe-area-inset-top))] transition-[opacity,visibility] duration-150 group-data-[closing]:opacity-0 group-data-[chrome-hidden]:invisible group-data-[chrome-hidden]:opacity-0">
        <button type="button" data-viewer-control data-lightbox-zoom onClick={zoomButton} aria-label={zoomed ? 'Zoom out' : 'Zoom in'} className={`pointer-events-auto h-11 w-11 ${control}`}>
          {zoomed ? <MagnifyingGlassMinusIcon className="h-5 w-5" aria-hidden /> : <MagnifyingGlassPlusIcon className="h-5 w-5" aria-hidden />}
        </button>
        <p data-viewer-hint className="min-w-0 truncate rounded-full bg-gray-900/75 px-3 py-1.5 text-xs text-gray-200">
          {zoomed ? (n > 1 ? 'Tap a side to switch · double-tap to fit' : 'Double-tap to fit') : 'Pinch or double-tap to zoom'}
        </p>
        <button ref={closeRef} type="button" data-viewer-control onClick={onClose} aria-label="Close" className={`pointer-events-auto h-11 w-11 ${control}`}>
          <XMarkIcon className="h-6 w-6" aria-hidden />
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950 via-gray-950/90 to-transparent px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8 transition-[opacity,visibility] duration-150 group-data-[closing]:opacity-0 group-data-[chrome-hidden]:invisible group-data-[chrome-hidden]:opacity-0">
        <p data-lightbox-caption className="mx-auto mb-3 line-clamp-2 max-w-xl text-center text-sm text-gray-200">{image.caption || image.name}</p>
        {n > 1 && (
          <div className="flex items-center justify-between">
            <button type="button" data-viewer-control data-lightbox-prev aria-label="Previous image" onClick={() => go(-1)} className={`pointer-events-auto h-14 w-14 ${control}`}>
              <ChevronLeftIcon className="h-7 w-7" aria-hidden />
            </button>
            <p data-lightbox-position aria-live="polite" className="rounded-full bg-gray-900/75 px-3.5 py-2 text-base font-semibold tabular-nums">
              {index + 1} / {n}
            </p>
            <button type="button" data-viewer-control data-lightbox-next aria-label="Next image" onClick={() => go(1)} className={`pointer-events-auto h-14 w-14 ${control}`}>
              <ChevronRightIcon className="h-7 w-7" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A viewer bug never takes the page down: the viewer closes, a short note says
 * so, and the ticket stays exactly where it was.
 */
export class ViewerBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('[cockpit viewer] closed after an error', error, info?.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" data-viewer-failed className="fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex items-center gap-3 rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-2xl">
        <span className="min-w-0 flex-1">The image viewer hit a problem and closed. Your ticket is still here.</span>
        <button type="button" onClick={this.props.onClose} className="h-11 shrink-0 rounded-lg bg-white/15 px-4 font-semibold active:bg-white/25">OK</button>
      </div>
    );
  }
}
