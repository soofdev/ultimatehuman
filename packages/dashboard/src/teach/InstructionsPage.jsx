// Config > Instructions ("Teach your radar", SPEC 7b). The radar's own page,
// mounted inside the vendored admin layout. It is not a vendored file: it
// reuses the vendored pages' Tailwind vocabulary (page frame, underline tabs,
// card, pill, dark primary button) so it reads as the same product.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUturnLeftIcon, CheckCircleIcon, ChevronRightIcon, LockClosedIcon } from '@heroicons/react/20/solid';
import { engineCall } from '../verbatim/data-provider';

const PILL = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset';
const CARD = 'rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6';
const BTN = 'inline-flex min-h-[40px] items-center rounded-lg bg-gray-900 px-5 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-40';
const BTN_SOFT = 'inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:opacity-40';

const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const BY = { defaults: 'engine defaults', disk: 'hand edit on disk', you: 'you', proposal: 'agent proposal, applied by you' };
const passName = (r) => {
  const span = r.lookbackHours % 24 === 0 ? `${r.lookbackHours / 24}-day` : `${r.lookbackHours}-hour`;
  return r.trigger === 'onboarding' ? `First pass (${span})` : r.trigger === 'schedule' ? `Daily ${span} pass` : `${span[0].toUpperCase()}${span.slice(1)} pass`;
};

export function Diff({ lines, file }) {
  const changed = lines.filter((l) => l.op !== '=');
  if (!changed.length) return <p className="text-sm text-gray-500">No change yet.</p>;
  return (
    <div data-diff className="overflow-hidden rounded-lg ring-1 ring-gray-200">
      {file && <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-xs text-gray-600">{file}</div>}
      <pre className="max-h-[420px] overflow-auto bg-white py-1 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            data-op={l.op}
            className={`whitespace-pre-wrap px-3 [overflow-wrap:anywhere] ${l.op === '+' ? 'bg-emerald-50 text-emerald-900' : l.op === '-' ? 'bg-red-50 text-red-900 line-through decoration-red-300' : 'text-gray-500'}`}
          >
            <span className="mr-2 select-none opacity-60">{l.op === '=' ? ' ' : l.op}</span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

function Editor({ brief, version, onSaved }) {
  const [text, setText] = useState(brief.text);
  const [note, setNote] = useState('');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setText(brief.text);
    setReview(null);
    setNote('');
    setError(null);
  }, [brief.id, brief.text]);
  const dirty = text !== brief.text;

  const check = useCallback(async () => {
    setError(null);
    const r = await engineCall('/api/instructions/diff', { brief: brief.id, text });
    setReview(r);
    if (r.error) setError(r.error);
  }, [brief.id, text]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await engineCall('/api/instructions', { brief: brief.id, text, note });
      onSaved(`Saved as v${r.version}. The next pass reads it.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article data-editor={brief.id} className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">{brief.title}</h2>
        <span className="font-mono text-xs text-gray-500">instructions/{brief.file}</span>
        <span className="ml-auto text-xs tabular-nums text-gray-500">about {brief.tokens} tokens</span>
      </div>
      <p className="mt-1 text-sm text-gray-600">{brief.feeds}</p>
      <textarea
        data-brief-text
        aria-label={`${brief.file} contents`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setReview(null);
        }}
        rows={Math.min(30, Math.max(10, text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 64)), 1)))}
        spellCheck={false}
        className="mt-4 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      {dirty && (
        <div className="mt-4 space-y-3">
          {!review ? (
            <button type="button" data-review onClick={check} className={BTN_SOFT}>
              Review changes
            </button>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs text-gray-600">
                <span className="font-medium text-gray-800">Your change</span>
                <span className="tabular-nums">
                  about {review.tokensBefore} to {review.tokensAfter} tokens ({signed(review.tokensAfter - review.tokensBefore)}), read on every agent step
                </span>
              </div>
              <Diff lines={review.diff} file={brief.file} />
              <label htmlFor="version-note" className="block text-sm font-medium text-gray-800">
                What this version changes, and why (required)
              </label>
              <input
                id="version-note"
                data-note
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                placeholder="e.g. Floor 2 to 1: single-player purchase failures are real on this product"
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setText(brief.text)} className="inline-flex min-h-[40px] items-center px-2 text-sm text-gray-500 hover:text-gray-800">
              Discard
            </button>
            <button type="button" data-save disabled={busy || !review || !!review.error || !note.trim()} onClick={save} className={BTN}>
              {busy ? 'Saving…' : `Save as v${version + 1}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function History({ versions, current, onReverted }) {
  const [open, setOpen] = useState(() => new Set([current]));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const revert = async (to, note) => {
    setBusy(to);
    setError(null);
    try {
      const r = await engineCall('/api/instructions/revert', { version: to, note });
      onReverted(`Reverted: v${r.version} restores v${to}. The next pass reads it.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section data-history aria-label="Version history" className={CARD}>
      <h2 className="text-base font-semibold text-gray-900">History</h2>
      <p className="mt-1 text-sm text-gray-600">Every save is a version of all four briefs. A pass names the version it ran with. Reverting adds a version; nothing is rewritten.</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <ol className="mt-4 divide-y divide-gray-100">
        {versions.map((v, i) => {
          const isOpen = open.has(v.version);
          const prev = versions[i + 1];
          return (
            <li key={v.version} data-version={v.version} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${PILL} ${v.version === current ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-gray-50 text-gray-700 ring-gray-200'}`}>
                  v{v.version}
                  {v.version === current && ' · in force'}
                </span>
                <span className="text-sm font-medium text-gray-900">{v.note}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {when(v.at)} · {BY[v.by] || v.by}
                {v.changed?.length > 0 && v.diffs.length > 0 && ` · ${v.changed.map((c) => `${c}.md`).join(', ')}`} · about {v.tokens} tokens
                {v.usedBy.length > 0 && ` · ran ${v.usedBy.length} pass${v.usedBy.length === 1 ? '' : 'es'}: ${v.usedBy.slice(0, 3).map((r) => `${passName(r)} ${when(r.startedAt)}`).join(', ')}`}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                {v.diffs.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((s) => {
                      const n = new Set(s);
                      n.has(v.version) ? n.delete(v.version) : n.add(v.version);
                      return n;
                    })}
                    className="inline-flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                  >
                    What changed
                    <ChevronRightIcon className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
                  </button>
                )}
                {v.version === current && prev && (
                  <button type="button" data-revert={prev.version} disabled={busy !== null} onClick={() => revert(prev.version, `Reverted v${v.version} ("${v.note}")`)} className={BTN_SOFT}>
                    <ArrowUturnLeftIcon className="h-4 w-4" aria-hidden />
                    {busy === prev.version ? 'Reverting…' : `Revert this change (back to v${prev.version})`}
                  </button>
                )}
                {v.version !== current && (
                  <button type="button" data-restore={v.version} disabled={busy !== null} onClick={() => revert(v.version)} className="text-xs font-medium text-gray-500 underline underline-offset-2 hover:text-gray-800 disabled:opacity-40">
                    {busy === v.version ? 'Restoring…' : `Restore v${v.version}`}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2">
                  {v.diffs.map((d) => <Diff key={d.brief} lines={d.diff} file={`${d.brief}.md`} />)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Rails({ rails }) {
  return (
    <section data-rails aria-label="Rails" className="rounded-xl bg-gray-100/80 p-4 ring-1 ring-inset ring-gray-200 sm:p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
        <LockClosedIcon className="h-4 w-4 text-gray-500" aria-hidden />
        Stays in code, not editable here
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-gray-600">
        {rails.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </section>
  );
}

function ConfigFile() {
  const [c, setC] = useState(null);
  useEffect(() => {
    void engineCall('/api/config').then(setC);
  }, []);
  if (!c) return null;
  return (
    <article className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-gray-800">{c.path}</span>
        <span className={`${PILL} ml-auto bg-gray-50 text-gray-600 ring-gray-200`}>
          <LockClosedIcon className="h-3.5 w-3.5" aria-hidden /> read-only here
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-600">Secrets appear only as environment references; their values never touch disk or this page.</p>
      <pre className="mt-4 max-h-[560px] overflow-auto rounded-lg bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-800 ring-1 ring-gray-200">{c.raw}</pre>
    </article>
  );
}

// One model per leg type, written to the config file's `models` block.
function ModelsPanel() {
  const [m, setM] = useState(null);
  const [saving, setSaving] = useState(null);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => setM(await engineCall('/api/models')), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!m) return null;
  const change = async (stage, model) => {
    setSaving(stage);
    setError(null);
    setFlash(null);
    try {
      await engineCall('/api/config/models', { [stage]: model });
      setFlash(`${m.stages.find((st) => st.id === stage).label} now uses ${model}. The next leg reads it.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  };
  return (
    <article data-models className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">Models</h2>
        <span className={`${PILL} ml-auto bg-gray-50 text-gray-600 ring-gray-200`}>default {m.default}</span>
      </div>
      <p className="mt-1 text-sm text-gray-600">Which Claude model each leg runs on. Opus 5.5 is advised everywhere; a lighter model trades depth for speed and usage.</p>
      {m.envOverride && (
        <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          ULTIMATEHUMAN_MODEL={m.envOverride} is set in the engine's environment and overrides every choice below.
        </p>
      )}
      {flash && (
        <div role="status" data-flash className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          <p>{flash}</p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">{error}</p>}
      <ul className="mt-4 divide-y divide-gray-100">
        {m.stages.map((st) => {
          const cur = m.models[st.id];
          const known = m.choices.some((c) => c.id === cur);
          return (
            <li key={st.id} data-model-stage={st.id} className="flex flex-wrap items-center gap-3 py-3">
              <label htmlFor={`model-${st.id}`} className="min-w-[220px] flex-1 text-sm font-medium text-gray-900">
                {st.label}
                {!st.used && <span className="ml-2 text-xs font-normal text-gray-400">not run by this build yet</span>}
              </label>
              <select
                id={`model-${st.id}`}
                value={cur}
                disabled={saving === st.id}
                onChange={(e) => void change(st.id, e.target.value)}
                className="min-h-[40px] w-64 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              >
                {m.choices.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}{c.note ? ` (${c.note})` : ''}</option>
                ))}
                {!known && <option value={cur}>{cur} (from the file)</option>}
              </select>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

// Optional behaviour: every flag defaults off, and off = behaviour identical.
const FEATURE_LABEL = { validationGate: 'Validation gate', fixLoop: 'Fix loop', ledger: 'Ledger' };
function FeaturesPanel() {
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(async () => setF(await engineCall('/api/features')), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!f) return null;
  const toggle = async (id, on) => {
    setBusy(id);
    setError(null);
    try {
      await engineCall('/api/config/features', { [id]: on });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <article data-features className={CARD}>
      <h2 className="text-base font-semibold text-gray-900">Features</h2>
      <p className="mt-1 text-sm text-gray-600">Everything is optional. Each flag starts off, and off behaves exactly like a build without the feature.</p>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">{error}</p>}
      <ul className="mt-4 divide-y divide-gray-100">
        {f.features.map((x) => (
          <li key={x.id} data-feature={x.id} data-on={x.on ? '1' : '0'} className="flex items-start gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900">
                {FEATURE_LABEL[x.id] || x.id}
                {x.reserved && <span className="ml-2 text-xs font-normal text-gray-400">reserved</span>}
              </p>
              <p className="mt-0.5 text-sm text-gray-600">{x.description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={x.on}
              aria-label={FEATURE_LABEL[x.id] || x.id}
              disabled={busy === x.id}
              onClick={() => void toggle(x.id, !x.on)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${x.on ? 'bg-emerald-600' : 'bg-gray-300'}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${x.on ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

const TABS = [
  { key: 'instructions', label: 'Instructions' },
  { key: 'models', label: 'Models' },
  { key: 'features', label: 'Features' },
  { key: 'file', label: 'Config file' },
];

export default function InstructionsPage() {
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(location.search).get('tab');
    return TABS.some((x) => x.key === t) ? t : 'instructions';
  });
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new URLSearchParams(location.search).get('brief') || 'admission');
  const [flash, setFlash] = useState(null);
  const load = useCallback(async () => setData(await engineCall('/api/instructions')), []);
  useEffect(() => {
    void load();
  }, [load]);
  const go = (t) => {
    setTab(t);
    const u = new URL(location.href);
    u.searchParams.set('tab', t);
    history.replaceState(null, '', u);
  };
  const pick = (id) => {
    setSel(id);
    const u = new URL(location.href);
    u.searchParams.set('brief', id);
    history.replaceState(null, '', u);
  };
  const done = async (msg) => {
    setFlash(msg);
    await load();
  };
  const brief = useMemo(() => data?.briefs.find((b) => b.id === sel) || data?.briefs[0], [data, sel]);
  const lastPass = data?.versions.flatMap((v) => v.usedBy.map((r) => ({ ...r, version: v.version }))).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return (
    <div className="min-h-full bg-gray-50">
      <div className="px-4 pb-10 pt-16 sm:px-8 md:pt-8">
        <header>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Config</h1>
            {data && (
              <span data-in-force className={`${PILL} bg-white text-gray-700 ring-gray-200`}>
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
                Instructions v{data.version} in force
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-600">
            Teach your radar: the judgment it applies on every pass lives in four short briefs you can edit. Each save is a version; the next pass reads it and names it in its run detail.
            {lastPass && ` The last pass (${passName(lastPass)}, ${when(lastPass.startedAt)}) ran with v${lastPass.version}.`}
          </p>
        </header>

        <div className="mt-5 flex">
          <nav role="tablist" aria-label="Config" className="flex min-w-0 flex-1 gap-1 overflow-x-auto border-b border-gray-200">
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
                  {t.key === 'instructions' && data && (
                    <span className={`rounded-full px-1.5 text-xs tabular-nums ${active ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-600'}`}>v{data.version}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="mt-5">
          {tab === 'file' && <ConfigFile />}
          {tab === 'models' && <ModelsPanel />}
          {tab === 'features' && <FeaturesPanel />}
          {tab === 'instructions' && data && (
            <div className="space-y-4">
              {flash && (
                <div role="status" data-flash className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                  <p>{flash}</p>
                </div>
              )}
              {data.warning && (
                <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">{data.warning}</p>
              )}
              <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-4">
                  <div role="tablist" aria-label="Briefs" className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
                    {data.briefs.map((b) => {
                      const active = b.id === brief.id;
                      return (
                        <button
                          key={b.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          data-brief={b.id}
                          onClick={() => pick(b.id)}
                          className={`rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500' : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'}`}
                        >
                          <span className="block text-sm font-semibold text-gray-900">{b.title}</span>
                          <span className="block font-mono text-[11px] text-gray-500">{b.file} · {b.tokens} tok</span>
                        </button>
                      );
                    })}
                  </div>
                  <Editor brief={brief} version={data.version} onSaved={done} />
                  <Rails rails={data.rails} />
                </div>
                <History key={data.version} versions={data.versions} current={data.version} onReverted={done} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
