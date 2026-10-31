// Config > Pipelines: every pipeline is the user's data. The templates are only suggestions:
// "Add from template" copies one in, "Add blank" starts empty; edit, disable or delete any of them.
// Same Tailwind vocabulary as the other Config tabs (src/teach/InstructionsPage.jsx).
import { useCallback, useEffect, useState } from 'react';
import { CheckCircleIcon, PlayIcon, PlusIcon, TrashIcon, PencilSquareIcon } from '@heroicons/react/20/solid';
import { engineCall } from '../verbatim/data-provider';

const PILL = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset';
const CARD = 'rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6';
const BTN = 'inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:opacity-40';
const BTN_SOFT = 'inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-40';
const INPUT = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const SCHEDULE_PRESETS = [
  { label: 'Daily 07:00', value: '0 7 * * *' },
  { label: 'Every 6 hours', value: 'every 6 hours' },
  { label: 'Manual only', value: 'manual' },
];

function Toggle({ on, label, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-emerald-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-800">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

/** The edit form: every field of the entry. Saves only what changed. */
function EditForm({ p, data, onDone, onCancel }) {
  const cfg = data.config.find((x) => x.id === p.id);
  const [orig] = useState(() => ({
    name: cfg.name,
    description: cfg.description || '',
    schedule: cfg.schedule,
    sources: cfg.sources,
    signalTypes: (cfg.signalTypes || []).join(', '),
    lookbackHours: cfg.lookbackHours,
    maxFindingsPerPass: cfg.maxFindingsPerPass,
    minEvidence: cfg.gates?.minEvidence ?? 2,
    validationGate: cfg.features?.validationGate === undefined ? 'inherit' : cfg.features.validationGate ? 'on' : 'off',
  }));
  const [f, setF] = useState(orig);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const toggleSource = (id) => setF((x) => {
    let s = x.sources.filter((v) => v !== id);
    if (!x.sources.includes(id)) s = id === '*' ? ['*', ...s.filter((v) => v === 'repos')] : [...s.filter((v) => v !== '*'), id];
    return { ...x, sources: s };
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    const fields = (x) => ({
      name: x.name.trim(),
      description: x.description.trim(),
      schedule: x.schedule.trim(),
      sources: x.sources,
      signalTypes: x.signalTypes.split(',').map((v) => v.trim()).filter(Boolean),
      lookbackHours: Number(x.lookbackHours),
      maxFindingsPerPass: Number(x.maxFindingsPerPass),
      gates: { minEvidence: Number(x.minEvidence) },
      features: { validationGate: x.validationGate === 'inherit' ? null : x.validationGate === 'on' },
    });
    const out = fields(f);
    const before = fields(orig);
    const changed = Object.fromEntries(Object.entries(out).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
    if (!Object.keys(changed).length) return onCancel();
    try {
      await engineCall(`/api/pipelines/${encodeURIComponent(p.id)}`, changed);
      onDone(`${out.name}: saved (${Object.keys(changed).join(', ')}). The next pass reads it.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-edit-form={p.id} className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name"><input data-field="name" className={`mt-1 ${INPUT}`} value={f.name} onChange={set('name')} /></Field>
        <Field label="Schedule" hint={'"M H * * *" daily (local time), "every N hours", any 5-field cron, or "manual".'}>
          <input data-field="schedule" className={`mt-1 font-mono ${INPUT}`} value={f.schedule} onChange={set('schedule')} />
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {SCHEDULE_PRESETS.map((x) => (
              <button key={x.value} type="button" data-preset={x.value} onClick={() => set('schedule')(x.value)} className="rounded-md bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-gray-300 hover:bg-gray-100">{x.label}</button>
            ))}
          </span>
        </Field>
      </div>
      <Field label="Description"><input data-field="description" className={`mt-1 ${INPUT}`} value={f.description} onChange={set('description')} /></Field>
      <Field label="Sources" hint='"All configured sources" reads every tracker you connect; "Watched repos" audits the repos themselves.'>
        <span className="mt-1.5 flex flex-wrap gap-2">
          {[{ id: '*', name: 'All configured sources', configured: true }, ...data.sources].map((s) => (
            <label key={s.id} data-source={s.id} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 ring-inset ${f.sources.includes(s.id) ? 'bg-indigo-50 text-indigo-900 ring-indigo-300' : 'bg-white text-gray-700 ring-gray-300'}`}>
              <input type="checkbox" checked={f.sources.includes(s.id)} onChange={() => toggleSource(s.id)} />
              {s.name}
              {!s.configured && <span className="text-xs text-gray-400">not connected</span>}
            </label>
          ))}
        </span>
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Field label="Signal types" hint={`Empty = all. e.g. ${data.signalTypes.slice(0, 3).join(', ')}`}><input data-field="signalTypes" className={`mt-1 font-mono ${INPUT}`} value={f.signalTypes} onChange={set('signalTypes')} /></Field>
        <Field label="Look back (hours)"><input data-field="lookbackHours" type="number" min="1" className={`mt-1 ${INPUT}`} value={f.lookbackHours} onChange={set('lookbackHours')} /></Field>
        <Field label="Max tickets per pass"><input data-field="maxFindingsPerPass" type="number" min="1" max="20" className={`mt-1 ${INPUT}`} value={f.maxFindingsPerPass} onChange={set('maxFindingsPerPass')} /></Field>
        <Field label="Evidence items required"><input data-field="minEvidence" type="number" min="1" max="6" className={`mt-1 ${INPUT}`} value={f.minEvidence} onChange={set('minEvidence')} /></Field>
      </div>
      <Field label="Validation gate for this pipeline's tickets">
        <select data-field="validationGate" className={`mt-1 max-w-xs ${INPUT}`} value={f.validationGate} onChange={set('validationGate')}>
          <option value="inherit">Same as Features (global)</option>
          <option value="on">On: tickets wait for validation</option>
          <option value="off">Off: straight to Needs decision</option>
        </select>
      </Field>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-2 text-sm text-gray-500 hover:text-gray-800">Cancel</button>
        <button type="button" data-save-pipeline disabled={busy} onClick={save} className={BTN}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function PipelineCard({ p, data, onChanged, onOpenInstructions }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const act = async (what, fn) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const last = p.lastRun;
  return (
    <li data-pipeline={p.id} data-enabled={p.enabled ? '1' : '0'} className={`${CARD} ${p.enabled ? '' : 'bg-gray-50/60'}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`text-base font-semibold ${p.enabled ? 'text-gray-900' : 'text-gray-500'}`}>{p.name}</h3>
            <span className="font-mono text-xs text-gray-500">{p.id}</span>
            {p.template && <span className={`${PILL} bg-gray-50 text-gray-600 ring-gray-200`}>from template {p.template}</span>}
            {!p.enabled && <span data-disabled-pill className={`${PILL} bg-gray-100 text-gray-600 ring-gray-300`}>Disabled</span>}
            {p.running && <span className={`${PILL} bg-emerald-50 text-emerald-800 ring-emerald-200`}>Running now</span>}
            {p.queued && <span className={`${PILL} bg-amber-50 text-amber-800 ring-amber-200`}>Queued</span>}
          </div>
          {p.description && <p className="mt-1 text-sm text-gray-600">{p.description}</p>}
        </div>
        <Toggle on={p.enabled} label={`${p.name} enabled`} disabled={busy === 'toggle'} onChange={(on) => act('toggle', async () => {
          await engineCall(`/api/pipelines/${encodeURIComponent(p.id)}`, { enabled: on });
          onChanged(`${p.name} ${on ? 'enabled: it runs on its schedule' : 'disabled: it is no longer scheduled (Run now still works)'}.`);
        })} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-gray-500">Schedule</dt><dd data-schedule className="text-gray-900">{p.scheduleText} <span className="font-mono text-xs text-gray-400">{p.schedule}</span></dd></div>
        <div><dt className="text-xs text-gray-500">Sources</dt><dd className="text-gray-900">{p.sources.map((s) => (s === '*' ? 'all configured' : s === 'repos' ? 'watched repos' : s)).join(', ')}{p.signalTypes.length ? ` · ${p.signalTypes.join(', ')}` : ''}</dd></div>
        <div><dt className="text-xs text-gray-500">Last run</dt><dd data-last-run className="text-gray-900">{last ? `${when(last.startedAt)} · ${last.phase === 'done' ? `${last.findings} ticket${last.findings === 1 ? '' : 's'}` : last.phase}` : 'never'}</dd></div>
        <div><dt className="text-xs text-gray-500">Tickets</dt><dd data-findings className="text-gray-900">{p.findings.open} open · {p.findings.total} total</dd></div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" data-edit={p.id} onClick={() => setEditing((x) => !x)} className={BTN_SOFT}><PencilSquareIcon className="h-4 w-4" aria-hidden />Edit</button>
        <button type="button" data-run={p.id} disabled={busy === 'run'} onClick={() => act('run', async () => {
          const r = await engineCall('/api/runs', { trigger: 'run_now', pipelineId: p.id });
          onChanged(r.queued ? `${p.name}: queued (position ${r.position}); one pass runs at a time.` : `${p.name}: pass started.`);
        })} className={BTN_SOFT}><PlayIcon className="h-4 w-4" aria-hidden />Run now</button>
        <button type="button" data-open-instructions={p.id} onClick={() => onOpenInstructions(p.id)} className={BTN_SOFT}>Instructions</button>
        <button type="button" data-delete={p.id} onClick={() => setConfirm(true)} className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50"><TrashIcon className="h-4 w-4" aria-hidden />Delete</button>
      </div>
      {confirm && (
        <div role="alertdialog" data-confirm-delete={p.id} className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="flex-1 text-sm text-red-900">Delete <b>{p.name}</b>? It stops running and its instructions are archived. Its tickets stay in the cockpit.</p>
          <button type="button" onClick={() => setConfirm(false)} className="px-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="button" data-confirm={p.id} disabled={busy === 'delete'} onClick={() => act('delete', async () => {
            await engineCall(`/api/pipelines/${encodeURIComponent(p.id)}/delete`, {});
            onChanged(`${p.name} deleted.`);
          })} className="inline-flex min-h-[36px] items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800">Delete pipeline</button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
      {editing && <EditForm p={p} data={data} onCancel={() => setEditing(false)} onDone={(m) => { setEditing(false); onChanged(m); }} />}
    </li>
  );
}

function AddPanel({ data, onChanged }) {
  const [blank, setBlank] = useState({ id: '', name: '' });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const taken = new Set(data.config.map((p) => p.id));
  const freeId = (base) => { let id = base; for (let i = 2; taken.has(id); i++) id = `${base}-${i}`; return id; };
  const add = async (key, body, msg) => {
    setBusy(key);
    setError(null);
    try {
      await engineCall('/api/pipelines', body);
      onChanged(msg);
      setBlank({ id: '', name: '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section data-add-pipeline className={CARD}>
      <h2 className="text-base font-semibold text-gray-900">Add a pipeline</h2>
      <p className="mt-1 text-sm text-gray-600">Templates are suggestions: adding one copies its settings and briefs into your config, and from then on every word is yours to change.</p>
      <ul className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data.templates.map((t) => {
          const id = freeId(t.id);
          return (
            <li key={t.id} data-template={t.id} className="flex flex-col rounded-lg border border-gray-200 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{t.name}</span>
                <span className="font-mono text-xs text-gray-500">{t.id}</span>
                {taken.has(t.id) && <span className={`${PILL} bg-gray-50 text-gray-500 ring-gray-200`}>in use</span>}
              </div>
              <p className="mt-1 flex-1 text-sm text-gray-600">{t.description}</p>
              <div className="mt-2">
                <button type="button" data-add-template={t.id} disabled={busy !== null} onClick={() => add(t.id, { template: t.id, id, name: id === t.id ? t.name : `${t.name} ${id.split('-').pop()}` }, `${t.name} added as "${id}" from its template. Its briefs are in Config > Instructions.`)} className={BTN_SOFT}>
                  <PlusIcon className="h-4 w-4" aria-hidden />{busy === t.id ? 'Adding…' : `Add from template${id !== t.id ? ` as ${id}` : ''}`}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
        <Field label="Blank pipeline id"><input data-blank-id className={`mt-1 w-48 font-mono ${INPUT}`} placeholder="e.g. perf-watch" value={blank.id} onChange={(e) => setBlank((b) => ({ ...b, id: e.target.value }))} /></Field>
        <Field label="Name"><input data-blank-name className={`mt-1 w-56 ${INPUT}`} placeholder="e.g. Performance watch" value={blank.name} onChange={(e) => setBlank((b) => ({ ...b, name: e.target.value }))} /></Field>
        <button type="button" data-add-blank disabled={busy !== null || !blank.id.trim()} onClick={() => add('blank', { blank: true, id: blank.id.trim(), name: blank.name.trim() || blank.id.trim() }, `${blank.name.trim() || blank.id.trim()} added (blank, disabled, manual). Write its briefs in Config > Instructions, then enable it.`)} className={BTN}>
          <PlusIcon className="h-4 w-4" aria-hidden />Add blank
        </button>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
    </section>
  );
}

export default function PipelinesPanel({ onOpenInstructions, onChanged }) {
  const [data, setData] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(async () => setData(await engineCall('/api/pipelines')), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return null;
  const changed = async (msg) => {
    setFlash(msg);
    await load();
    onChanged?.();
  };
  return (
    <div data-pipelines className="space-y-4">
      {flash && (
        <div role="status" data-flash className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          <p>{flash}</p>
        </div>
      )}
      <p className="text-sm text-gray-600">
        {data.pipelines.length} pipeline{data.pipelines.length === 1 ? '' : 's'}, {data.pipelines.filter((p) => p.enabled).length} enabled. One pass runs at a time; the others wait in order.
        {data.running && ` Running now: ${data.pipelines.find((p) => p.id === data.running.pipelineId)?.name ?? data.running.pipelineId}.`}
      </p>
      <ul className="space-y-3">
        {data.pipelines.map((p) => <PipelineCard key={p.id} p={p} data={data} onChanged={changed} onOpenInstructions={onOpenInstructions} />)}
        {!data.pipelines.length && <li className={`${CARD} text-sm text-gray-600`}>No pipeline: nothing runs until you add one below.</li>}
      </ul>
      <AddPanel data={data} onChanged={changed} />
    </div>
  );
}
