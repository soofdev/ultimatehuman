import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink, Users, TrendingUp, Crosshair, ShieldCheck, CircleHelp, EyeOff, X, CheckCircle2, FlaskConical, Repeat } from "lucide-react";
import { get, post } from "./api";

function Github({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
import { Markdown } from "./Markdown";
import { day, dayTime, plural } from "./fmt";

const TREND: Record<string, string> = { new: "New this week", rising: "Rising", steady: "Steady", falling: "Falling" };
const KIND: Record<string, string> = { recording: "Session replay", event_series: "Event data", error_group: "Error group", funnel: "Funnel" };

export function FindingCard({ f, defaultOpen = false, onChanged }: { f: any; defaultOpen?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const [preview, setPreview] = useState<any>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const ev = new Map<string, any>(f.evidence.map((e: any) => [e.id, e]));
  const sources = [...new Set(f.evidence.map((e: any) => e.sourcePluginId))].map((s: any) => (s === "posthog" ? "PostHog" : s));
  const users = f.impact.usersAffected;

  const openPreview = async () => setPreview(await get(`/api/findings/${f.id}`));
  const dismiss = async () => {
    if (!reason.trim()) return;
    await post(`/api/findings/${f.id}/dismiss`, { reason });
    setDismissing(false);
    onChanged?.();
  };

  return (
    <article className={`fcard fade-in ${open ? "open" : ""}`} data-finding={f.id}>
      <div className="fcard-top" onClick={() => setOpen(!open)}>
        <div className="fmeta">
          <span className={`sev ${f.severity}`}>{f.severity}</span>
          <span className="chip">
            {f.confidence === "confirmed" ? <ShieldCheck size={12} /> : <CircleHelp size={12} />}
            {f.confidence === "confirmed" ? "Confirmed" : "Likely"}
          </span>
          {f.route && <span className="chip route">{f.route}</span>}
          <span className="chip">{sources.join(" + ")}</span>
          {f.recurredFrom && (
            <span className="chip">
              <Repeat size={12} /> Recurred
            </span>
          )}
          {f.status === "dismissed" && <span className="chip">Dismissed</span>}
          <span style={{ marginLeft: "auto", color: "var(--ink-4)" }}>{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
        </div>
        <div className="fbody">
          <div>
            <h2 className="ftitle">{f.title}</h2>
            <p className="fsym">{f.symptom}</p>
          </div>
          <div className="impact">
            <div className="n">{users ?? "?"}</div>
            <div className="l">people affected</div>
            <div className="l">{plural(f.impact.occurrences, "occurrence")}</div>
            <div className="t">
              <TrendingUp size={12} style={{ verticalAlign: -1 }} /> {TREND[f.impact.trend] ?? f.impact.trend}
            </div>
          </div>
        </div>
        <div className="cause">
          <Crosshair size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            <b>Root cause. </b>
            {f.rootCause.statement}
          </span>
        </div>
      </div>

      {open && (
        <div className="fdetail">
          <div className="sect">
            <h4>How we know</h4>
            <ol className="chain">
              {f.rootCause.reasoning.map((r: any, i: number) => (
                <li key={i}>
                  <span>
                    {r.claim}
                    {r.evidenceIds.map((id: string) => (
                      <a key={id} className="eid" href={ev.get(id)?.url} target="_blank" rel="noreferrer">
                        {id}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="sect">
            <h4>Evidence · {plural(f.evidence.length, "item")}, every one clickable</h4>
            <div className="evs">
              {f.evidence.map((e: any) => (
                <div className="ev" key={e.id} id={`ev-${f.id}-${e.id}`}>
                  <div className="ev-h">
                    <span>
                      <b>{e.id}</b> · {KIND[e.kind] ?? e.kind}
                    </span>
                    <span>read {day(e.observedAt)}</span>
                  </div>
                  {e.label && <div className="ev-l">{e.label}</div>}
                  <pre>{e.excerpt}</pre>
                  <a href={e.url} target="_blank" rel="noreferrer">
                    {e.kind === "recording" ? "Watch the replay in PostHog" : "Open the data in PostHog"} <ExternalLink size={12} />
                  </a>
                </div>
              ))}
            </div>
          </div>
          <div className="sect">
            <h4>Reproduction</h4>
            {"steps" in f.reproduction ? (
              <ol className="repro">
                {f.reproduction.steps.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : (
              <p style={{ margin: 0, color: "var(--ink-2)" }}>Not established: {f.reproduction.notEstablished}</p>
            )}
          </div>
          {f.suggestedFix && (
            <div className="sect">
              <h4>Suggested direction</h4>
              <p style={{ margin: 0, color: "var(--ink-2)" }}>{f.suggestedFix}</p>
            </div>
          )}
          <div className="sect">
            <h4>Not established</h4>
            <div className="ne">
              {f.openQuestions.length ? (
                <ul>
                  {f.openQuestions.map((q: string, i: number) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              ) : (
                <span style={{ color: "var(--ink-2)" }}>Nothing open.</span>
              )}
            </div>
          </div>
          {f.rootCause.ruledOut?.length > 0 && (
            <div className="sect">
              <h4>Ruled out</h4>
              <ul className="plain">
                {f.rootCause.ruledOut.map((q: string, i: number) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {f.review && (
            <div className="sect">
              <div className="review">
                <FlaskConical size={16} style={{ flexShrink: 0, marginTop: 1, color: "var(--ok)" }} />
                <span>
                  <b>Adversarial review: {f.review.verdict === "holds" ? "holds" : "partly holds, corrected"}.</b> {f.review.reasons[0]}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {dismissing ? (
        <div className="dismiss">
          <input autoFocus placeholder="One line: why is this not worth fixing? (suppresses this fingerprint)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dismiss()} />
          <button className="btn" disabled={!reason.trim()} onClick={dismiss}>
            Dismiss
          </button>
          <button className="btn ghost" onClick={() => setDismissing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="ffoot">
          <div className="left">
            <span>
              <Users size={13} /> {users} people
            </span>
            <span>
              First seen {day(f.impact.firstSeen)} · last {dayTime(f.impact.lastSeen)}
            </span>
            {f.dryRunPreview && (
              <span style={{ color: "var(--ok)" }}>
                <CheckCircle2 size={13} /> Previewed for {f.dryRunPreview.repo}
              </span>
            )}
          </div>
          <div className="btns">
            {f.status !== "dismissed" && (
              <button className="btn ghost" onClick={() => setDismissing(true)}>
                <EyeOff size={14} /> Dismiss
              </button>
            )}
            <button className="btn primary" onClick={openPreview} data-action="file">
              <Github size={14} /> File to GitHub
            </button>
          </div>
        </div>
      )}
      {preview && createPortal(<IssueModal p={preview} onClose={() => setPreview(null)} onDone={onChanged} />, document.body)}
    </article>
  );
}

function IssueModal({ p, onClose, onDone }: { p: any; onClose: () => void; onDone?: (() => void) | undefined }) {
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const file = async () => {
    setBusy(true);
    setResult(await post(`/api/findings/${p.finding.id}/file`));
    setBusy(false);
    onDone?.();
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <h3>
            <Github size={17} /> New issue in {p.repo}
          </h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {result ? (
          <div className="dry done">
            <CheckCircle2 size={16} />
            <span>
              <b>{result.message}.</b> Nothing was sent to GitHub. Connect a fine-grained token to file for real.
            </span>
          </div>
        ) : (
          <div className="dry">
            <FlaskConical size={16} />
            <span>
              <b>Dry run</b> · would create issue in <code>{p.repo}</code>. No GitHub token is connected, so nothing leaves this machine.
            </span>
          </div>
        )}
        <div className="gh">
          <h1 className="gh-title">{p.issuePreview.title}</h1>
          <div className="gh-meta">
            {p.issuePreview.labels.map((l: string) => (
              <span key={l} className="gh-label">
                {l}
              </span>
            ))}
            <span>rendered from the finding's structured fields</span>
          </div>
          <Markdown text={p.issuePreview.body} />
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button className="btn primary" disabled={busy} onClick={file} data-action="confirm-file">
              <Github size={14} /> Create issue (dry run)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
