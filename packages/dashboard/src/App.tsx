import { useEffect, useState } from "react";
import type { WindowStatus } from "@ultimatehuman/sdk";
import { redeemLoginFragment } from "./api";

type Page = "onboarding" | "findings" | "usage" | "config";

const PAGES: readonly { id: Page; label: string }[] = [
  { id: "onboarding", label: "Setup" },
  { id: "findings", label: "Findings" },
  { id: "usage", label: "Usage" },
  { id: "config", label: "Config" },
];

export function App() {
  const [page, setPage] = useState<Page>("findings");
  useEffect(() => {
    void redeemLoginFragment();
  }, []);
  return (
    <main>
      <nav>
        {PAGES.map((p) => (
          <button key={p.id} aria-current={page === p.id} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      <WindowMeter status={null} />
      <p>Skeleton: the {page} page is built in the dashboard leg.</p>
    </main>
  );
}

/** "window 78% used · resets 17:00 · 3 items queued" */
export function WindowMeter({ status }: { status: WindowStatus | null }) {
  if (!status) return <p>Window: unknown</p>;
  const used = status.usedPct === null ? "usage unknown" : `window ${status.usedPct}% used`;
  const resets = status.resetsAt ? ` · resets ${new Date(status.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  return <p>{`${used}${resets} · ${status.queued} items queued`}</p>;
}
