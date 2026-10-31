// Pipeline badges + filter on the vendored Pipeline pages (app/, verbatim-locked): like
// src/teach/proposal-cards.jsx, this layer works on the rendered DOM and never edits app/.
// - every ticket key badge (a[data-jira-key]) gets the name of the pipeline that produced it;
// - the cockpit header gets one chip per pipeline; a chip sets ?pipeline=<id> and reloads, and
//   the data provider then serves that pipeline's tickets only.

// A stable hue per pipeline id (the badge color tells pipelines apart at a glance).
const TONES = [
  'border-violet-200 bg-violet-50 text-violet-800',
  'border-rose-200 bg-rose-50 text-rose-800',
  'border-emerald-200 bg-emerald-50 text-emerald-800',
  'border-sky-200 bg-sky-50 text-sky-800',
  'border-amber-200 bg-amber-50 text-amber-800',
];
const tone = (id) => (id === 'external' ? 'border-gray-300 bg-gray-100 text-gray-700' : TONES[[...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % TONES.length]);
const CHIP = 'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors';

/** `pipelineOf(key)` = pipeline id of a ticket key; `pipelines()` = [{ id, name }]; `counts()` = tickets per pipeline id. */
export function enhancePipelineBadges({ pipelineOf, pipelines, counts }) {
  const nameOf = (id) => pipelines().find((p) => p.id === id)?.name || id;
  const sweep = () => {
    for (const a of document.querySelectorAll('a[data-jira-key]')) {
      const key = a.getAttribute('data-jira-key');
      const id = pipelineOf(key);
      const next = a.nextElementSibling;
      if (!id) continue;
      if (next?.hasAttribute('data-pipeline-badge')) {
        if (next.getAttribute('data-pipeline-badge') === id) continue;
        next.remove();
      }
      const b = document.createElement('span');
      b.setAttribute('data-pipeline-badge', id);
      b.title = `Pipeline: ${nameOf(id)}`;
      b.className = `shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold ${tone(id)}`;
      b.textContent = nameOf(id);
      a.after(b);
    }
    filterBar();
  };
  const filterBar = () => {
    const h1 = [...document.querySelectorAll('header h1')].find((h) => h.textContent.trim() === 'Pipeline');
    const header = h1?.closest('header');
    if (!header || header.querySelector('[data-pipeline-filter]') || !pipelines().length) return;
    const current = new URLSearchParams(window.location.search).get('pipeline') || '';
    const n = counts();
    const bar = document.createElement('div');
    bar.setAttribute('data-pipeline-filter', current || 'all');
    bar.className = 'mt-3 flex flex-wrap items-center gap-2';
    const label = document.createElement('span');
    label.className = 'text-xs font-medium text-gray-500';
    label.textContent = 'Pipeline:';
    bar.append(label);
    for (const p of [{ id: '', name: 'All' }, ...pipelines().filter((x) => x.id !== 'external' || n.external)]) {
      const on = p.id === current;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pipeline-chip', p.id || 'all');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.className = `${CHIP} ${on ? 'bg-gray-900 text-white ring-gray-900' : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'}`;
      btn.textContent = p.id ? `${p.name} · ${n[p.id] || 0}` : 'All';
      btn.onclick = () => {
        const u = new URL(window.location.href);
        if (p.id) u.searchParams.set('pipeline', p.id);
        else u.searchParams.delete('pipeline');
        window.location.assign(u);
      };
      bar.append(btn);
    }
    header.append(bar);
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sweep();
    });
  };
  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true });
  later();
}
