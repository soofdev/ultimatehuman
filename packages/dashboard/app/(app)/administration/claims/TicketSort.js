'use client';

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowsUpDownIcon, ChevronDownIcon } from '@heroicons/react/20/solid';
import { TICKET_SORTS, ticketSort } from '@/app/lib/pipeline-cockpit';

/**
 * The order of the cards within a cockpit tab (Default, by Jira created, by
 * Jira last updated), remembered in this browser, and the dates each card
 * shows. The sort reaches the cards through a context so the date shown
 * follows it ("Updated …" appears while an updated sort is on).
 */

const SORT_KEY = 'cockpit.ticketSort';
const TicketSortContext = createContext('default');

export const TicketSortProvider = TicketSortContext.Provider;

/** [sort, setSort]: read after mount so the server render (default) matches the first client render. */
export function useStoredTicketSort() {
  const [sort, setSort] = useState('default');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      if (saved) setSort(ticketSort(saved).key);
    } catch {}
  }, []);
  const change = useCallback((key) => {
    const next = ticketSort(key).key;
    setSort(next);
    try {
      if (next === 'default') localStorage.removeItem(SORT_KEY); else localStorage.setItem(SORT_KEY, next);
    } catch {}
  }, []);
  return [sort, change];
}

function formatDay(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function formatFull(value) {
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const noSubscribe = () => () => {};

/**
 * "Created 22 Oct" (and "Updated 23 Oct" while an updated sort is on), from
 * the Jira ticket, in the viewer's time zone: rendered in the browser only,
 * so the server's time zone never shows nor mismatches. Nothing for a card
 * that has no date yet.
 */
export function TicketDates({ ticket, className = '' }) {
  const sort = useContext(TicketSortContext);
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!inBrowser) return null;
  const created = formatDay(ticket.jira_created);
  const updated = ticketSort(sort).field === 'jira_updated' ? formatDay(ticket.jira_updated) : null;
  if (!created && !updated) return null;
  return (
    <span data-ticket-dates className={`shrink-0 whitespace-nowrap text-xs tabular-nums text-gray-500 ${className}`}>
      {created && <span data-created title={`Created in Jira ${formatFull(ticket.jira_created)}`}>Created {created}</span>}
      {created && updated && ' · '}
      {updated && <span data-updated title={`Last updated in Jira ${formatFull(ticket.jira_updated)}`}>Updated {updated}</span>}
    </span>
  );
}

/** The sort picker, next to the Flags row. Dark while a sort other than Default is on. */
export function SortControl({ value, onChange, className = '' }) {
  const active = value !== 'default';
  return (
    <div data-sort-control className={`flex shrink-0 items-center gap-1.5 ${className}`}>
      <label htmlFor="cockpit-ticket-sort" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500">
        <ArrowsUpDownIcon className="h-3.5 w-3.5" aria-hidden />
        Sort
      </label>
      <div className="relative">
        <select
          id="cockpit-ticket-sort"
          data-ticket-sort={value}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`min-h-[30px] cursor-pointer appearance-none rounded-full py-0 pl-3 pr-7 text-xs font-medium ring-1 ring-inset transition-colors focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-1 ${
            active ? 'bg-gray-900 text-white ring-gray-900' : 'bg-white text-gray-700 ring-gray-300 hover:ring-gray-400'
          }`}
        >
          {TICKET_SORTS.map((s) => (
            <option key={s.key} value={s.key} className="bg-white text-gray-900">{s.label}</option>
          ))}
        </select>
        <ChevronDownIcon
          className={`pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${active ? 'text-white/80' : 'text-gray-400'}`}
          aria-hidden
        />
      </div>
    </div>
  );
}
