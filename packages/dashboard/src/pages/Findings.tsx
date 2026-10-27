import { useState } from "react";
import { SearchCheck } from "lucide-react";
import type { AppState } from "../App";
import { FindingCard } from "../FindingCard";

export function Findings({ s }: { s: AppState }) {
  const [tab, setTab] = useState<"new" | "filed" | "dismissed">("new");
  const by = {
    new: s.findings.filter((f) => f.status === "new" && !f.dryRunPreview),
    filed: s.findings.filter((f) => f.status === "filed" || (f.dryRunPreview && f.status !== "dismissed")),
    dismissed: s.findings.filter((f) => f.status === "dismissed"),
  };
  const list = by[tab];
  return (
    <div>
      <h1 className="h1">Findings</h1>
      <p className="lede">Real problems your users hit, each with a committed root cause and links to the raw data. Precision over recall: if it is here, it survived a gate and an adversarial review.</p>
      <div className="tabs" role="tablist">
        {(["new", "filed", "dismissed"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "new" ? "New" : t === "filed" ? "Filed (dry run)" : "Dismissed"}
            <span>{by[t].length}</span>
          </button>
        ))}
      </div>
      <div className="stack">
        {list.map((f, i) => (
          <FindingCard key={f.id} f={f} defaultOpen={false} onChanged={s.refresh} />
        ))}
        {!list.length && (
          <div className="card empty">
            <SearchCheck size={26} color="var(--ink-3)" />
            <h3>{tab === "new" ? (s.run && s.run.phase !== "done" ? "The radar is still working" : "Nothing new") : "Nothing here yet"}</h3>
            <p>{tab === "new" && s.run?.phase === "done" && s.run.emptyReason ? s.run.emptyReason : "Findings appear here the moment they pass the gate."}</p>
          </div>
        )}
      </div>
    </div>
  );
}
