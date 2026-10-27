'use client';

import { BeakerIcon } from '@heroicons/react/20/solid';

const day = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null;
};

/**
 * The test strategy Vincent agreed in a Plan testing thread, as written in the
 * Jira ticket's fenced block: the pipeline caps the next fix round and exam
 * with it, runs only its scenarios and tells the cost guard its budget.
 */
export function StrategyBlock({ strategy }) {
  if (!strategy) return null;
  const agreed = day(strategy.agreed_at);
  return (
    <section data-strategy aria-label="Agreed test strategy" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <BeakerIcon className="h-4 w-4 text-emerald-700" aria-hidden />
        <h4 className="text-sm font-semibold text-emerald-900">Agreed test strategy</h4>
        <span className="text-xs text-emerald-800/80">
          {agreed ? `agreed ${agreed}, ` : ''}binding for the next fix round and exam
        </span>
      </div>
      <dl className="mt-2.5 grid grid-cols-3 gap-2 font-mono text-[13px]">
        <div data-strategy-field="max_fix_runs" className="rounded-md bg-white/80 px-2 py-1.5 ring-1 ring-inset ring-emerald-100">
          <dt className="text-[11px] text-emerald-800/80">max_fix_runs</dt>
          <dd className="font-semibold tabular-nums text-gray-900">{strategy.max_fix_runs}</dd>
        </div>
        <div data-strategy-field="max_exam_runs" className="rounded-md bg-white/80 px-2 py-1.5 ring-1 ring-inset ring-emerald-100">
          <dt className="text-[11px] text-emerald-800/80">max_exam_runs</dt>
          <dd className="font-semibold tabular-nums text-gray-900">{strategy.max_exam_runs}</dd>
        </div>
        <div data-strategy-field="budget_usd" className="rounded-md bg-white/80 px-2 py-1.5 ring-1 ring-inset ring-emerald-100">
          <dt className="text-[11px] text-emerald-800/80">budget_usd</dt>
          <dd className="font-semibold tabular-nums text-gray-900">${Number(strategy.budget_usd).toFixed(2)}</dd>
        </div>
      </dl>
      <p className="mt-2.5 font-mono text-[11px] text-emerald-800/80">scenarios</p>
      <ol data-strategy-field="scenarios" className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-snug text-gray-800">
        {(strategy.scenarios || []).map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </section>
  );
}

/** The latest agreed close of a thread (the pipeline's reply carrying plan_close), or null. */
export function latestPlanClose(chat) {
  return [...(chat || [])].filter((m) => m.role === 'assistant' && m.plan_close)
    .sort((a, b) => new Date(a.at) - new Date(b.at)).pop() || null;
}

/** One line under a closed thread: what the platform did with the agreed plan. */
export function PlanOutcome({ message }) {
  const c = message?.plan_close;
  if (!c) return null;
  const others = (c.tickets || []).filter((k) => k !== c.survivor);
  let text;
  if (c.mode === 'manual') text = `Plan recorded: ${c.survivor} goes back to the queue under this strategy.`;
  else if (c.merge_error) text = `Plan recorded on ${c.tickets.join(', ')}, but the merge failed: ${c.merge_error}`;
  else if (c.merged_at) text = `Plan recorded: ${others.join(', ')} merged into ${c.survivor}. Validate ${c.survivor} to start it.`;
  else if (others.length) text = `Plan recorded on ${c.tickets.join(', ')}; merging them…`;
  else text = `Plan recorded on ${c.survivor}. Validate it to start it.`;
  return (
    <p data-plan-outcome role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${c.merge_error ? 'bg-red-50 text-red-900' : 'bg-emerald-50 text-emerald-900'}`}>
      {text}
    </p>
  );
}
