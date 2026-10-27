// Thin adapter for `next/navigation` (client router on the History API).
import { useMemo, useSyncExternalStore } from 'react';

const EVENT = 'uh:navigate';
const subscribe = (cb) => {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVENT, cb);
  };
};
const go = (method) => (href) => {
  window.history[method](null, '', href);
  window.dispatchEvent(new Event(EVENT));
};
const router = { push: go('pushState'), replace: go('replaceState'), back: () => window.history.back(), refresh: () => window.location.reload(), prefetch: () => {} };

export function useRouter() {
  return router;
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useSearchParams() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function redirect(href) {
  window.location.replace(href);
  throw new Error(`redirect to ${href}`);
}
