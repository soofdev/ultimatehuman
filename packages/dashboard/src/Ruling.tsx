import { useState } from "react";
import { EyeOff, PauseCircle, CheckCircle2, XCircle, RotateCcw, Radar, User } from "lucide-react";
import { post } from "./api";
import { dayTime } from "./fmt";

export type RulingMode = "idle" | "dismissing" | "changing";

/** The ruling in force, claims-style: who ruled what, when, and what it does to later runs. */
export function RulingBox({ card, onChange }: { card: any; onChange: () => void }) {
  const r = card.ruling;
  if (!r) return null;
  const look = r.ruling === "file" ? "filed" : r.ruling === "dismiss" ? "dismissed" : "parked";
  const Icon = r.ruling === "file" ? CheckCircle2 : r.ruling === "dismiss" ? XCircle : PauseCircle;
  const head = r.ruling === "file" ? (r.dryRun ? "You filed this to GitHub (dry run)" : "You filed this to GitHub") : r.ruling === "dismiss" ? "You dismissed this" : "You parked this: not now";
  const effect =
    r.ruling === "file"
      ? r.dryRun
        ? `Nothing was sent: no GitHub token is connected. The radar tracks it for recurrence: it is re-investigated only if it happens again after this ruling.`
        : "The radar tracks it for recurrence: it is re-investigated only if it happens again after this ruling."
      : r.ruling === "dismiss"
        ? "Suppression rule: later passes skip it before any agent runs. It comes back only if twice as many people hit it."
        : "It stays here until a pass sees a new occurrence after this ruling. Then it returns to New on its own.";
  return (
    <div className={`rbox ${look}`} data-ruling={r.ruling}>
      <Icon size={16} className="rbox-i" />
      <div className="rbox-b">
        <div className="rbox-h">
          <b>{head}</b>
          <span> · {dayTime(r.at)}</span>
          <button className="linkbtn" onClick={onChange} data-action="change-ruling">
            Change
          </button>
        </div>
        {r.reason && <p className="rbox-reason">“{r.reason}”</p>}
        <p className="rbox-e">{effect}</p>
      </div>
    </div>
  );
}

/** Dismiss needs a reason, Not now is one click, Change can withdraw the ruling. Cards stay in place after a ruling. */
export function RulingActions({
  card,
  mode,
  setMode,
  onRuled,
  primary,
}: {
  card: any;
  mode: RulingMode;
  setMode: (m: RulingMode) => void;
  onRuled: () => void;
  primary?: React.ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (ruling: "dismiss" | "park" | "clear") => {
    if (ruling === "dismiss" && !reason.trim()) return setErr("Write one line on why, so the rule explains itself later.");
    setBusy(true);
    setErr(null);
    try {
      await post("/api/rulings", { clusterId: card.clusterId, ruling, reason: ruling === "dismiss" ? reason.trim() : "" });
      setMode("idle");
      setReason("");
      onRuled();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "dismissing")
    return (
      <div className="rform">
        <label htmlFor={`why-${card.clusterId}`}>Why dismiss it?</label>
        <p>Your reason is stored with the ruling and becomes a suppression rule: later passes skip this before any agent runs.</p>
        <textarea
          id={`why-${card.clusterId}`}
          autoFocus
          rows={2}
          value={reason}
          maxLength={500}
          placeholder="One line, e.g. expected behaviour, already known, not worth a fix"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && send("dismiss")}
        />
        {err && <p className="rerr">{err}</p>}
        <div className="rbtns">
          <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => send("dismiss")} data-action="confirm-dismiss">
            {busy ? "Saving…" : "Dismiss with this reason"}
          </button>
          <button className="btn ghost" onClick={() => setMode(card.ruling ? "changing" : "idle")}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="rbtns" data-rulings>
      {primary}
      {card.ruling?.ruling !== "park" && (
        <button className="btn" disabled={busy} onClick={() => send("park")} data-action="park" title="Park it. It comes back when a pass sees a new occurrence after now.">
          <PauseCircle size={14} /> Not now
        </button>
      )}
      {card.ruling?.ruling !== "dismiss" && (
        <button className="btn danger-o" disabled={busy} onClick={() => setMode("dismissing")} data-action="dismiss">
          <EyeOff size={14} /> Dismiss
        </button>
      )}
      {mode === "changing" && (
        <>
          <button className="btn ghost" disabled={busy} onClick={() => send("clear")} data-action="clear-ruling">
            <RotateCcw size={13} /> Withdraw ruling
          </button>
          <button className="btn ghost" onClick={() => setMode("idle")}>
            Cancel
          </button>
        </>
      )}
      {err && <p className="rerr">{err}</p>}
    </div>
  );
}

/** Every event on the item, oldest first: what the radar did and what you ruled. */
export function History({ items }: { items: any[] }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const LIMIT = 5;
  const shown = all || items.length <= LIMIT ? items : items.slice(-LIMIT);
  return (
    <ol className="hist" aria-label="History">
      {shown.length < items.length && (
        <li className="hist-more">
          <button className="linkbtn" onClick={() => setAll(true)}>
            Show {items.length - shown.length} earlier
          </button>
        </li>
      )}
      {shown.map((h, i) => (
        <li key={i} className={`h-${h.kind}`}>
          <span className="hist-dot">{h.by === "you" ? <User size={10} strokeWidth={2.6} /> : <Radar size={10} strokeWidth={2.6} />}</span>
          <span className="hist-l">
            {h.label}
            {h.reason ? <span className="hist-r"> · “{h.reason}”</span> : null}
          </span>
          <span className="hist-t">{dayTime(h.at)}</span>
        </li>
      ))}
    </ol>
  );
}
