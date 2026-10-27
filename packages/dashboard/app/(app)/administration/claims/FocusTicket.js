'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

// Every element that is one ticket's card or row on the cockpit tabs.
const CARD_ATTRS = ['data-ticket-card', 'data-gate-card', 'data-building-row', 'data-manual-card', 'data-shipped', 'data-validated', 'data-auto', 'data-dismissed'];
const WAIT_MS = 6000;

/**
 * ?focus=SCRUM-1 (a link from the live pipeline page): once the tab has
 * rendered, scroll the ticket's card into view and ring it for a moment.
 * Renders nothing; a key with no card on the tab does nothing.
 */
export default function FocusTicket() {
  const params = useSearchParams();
  const key = params.get('focus');
  const tab = params.get('tab');
  useEffect(() => {
    if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return undefined;
    const selector = CARD_ATTRS.map((a) => `[${a}="${key}"]`).join(',');
    const started = Date.now();
    let timer = null;
    let raf = null;
    const find = () => {
      const el = [...document.querySelectorAll(selector)].find((x) => x.offsetParent !== null);
      if (!el) {
        if (Date.now() - started < WAIT_MS) raf = requestAnimationFrame(find);
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.setAttribute('data-focused', 'true');
      const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
      el.style.outline = '2px solid rgb(245 158 11)';
      el.style.outlineOffset = '3px';
      timer = setTimeout(() => {
        el.style.outline = prev.outline;
        el.style.outlineOffset = prev.offset;
        el.removeAttribute('data-focused');
      }, 4000);
    };
    raf = requestAnimationFrame(find);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [key, tab]);
  return null;
}
