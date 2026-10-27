import { useCallback, useEffect, useState } from "react";
import { Radar, Sparkles, Inbox, History, Gauge, FileCog, ShieldCheck } from "lucide-react";
import { get, setCsrf, redeemLoginFragment, connectEvents, ApiError } from "./api";
import { time } from "./fmt";
import { Setup } from "./pages/Setup";
import { Findings } from "./pages/Findings";
import { Runs } from "./pages/Runs";
import { Usage } from "./pages/Usage";
import { ConfigPage } from "./pages/Config";

export type Page = "setup" | "findings" | "runs" | "usage" | "config";
const PAGES: { id: Page; label: string; icon: typeof Radar }[] = [
  { id: "setup", label: "Setup", icon: Sparkles },
  { id: "findings", label: "Findings", icon: Inbox },
  { id: "runs", label: "Runs", icon: History },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "config", label: "Config", icon: FileCog },
];

export interface AppState {
  status: any;
  findings: any[];
  run: any;
  onboarding: any;
  refresh: () => Promise<void>;
  go: (p: Page, sub?: string) => void;
}

function pageFromPath(): Page {
  const p = location.pathname.split("/")[1] as Page;
  return PAGES.some((x) => x.id === p) ? p : "setup";
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "ok" | "out" | string>("checking");
  const [page, setPage] = useState<Page>(pageFromPath());
  const [status, setStatus] = useState<any>(null);
  const [findings, setFindings] = useState<any[]>([]);
  const [run, setRun] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);

  const refresh = useCallback(async () => {
    const s = await get("/api/status");
    setCsrf(s.csrf);
    setStatus(s);
    setRun(s.lastRun);
    setFindings((await get("/api/findings")).findings);
    setOnboarding(await get("/api/onboarding"));
  }, []);

  useEffect(() => {
    (async () => {
      if (location.pathname === "/login") {
        const r = await redeemLoginFragment();
        if (r !== "ok" && r !== "none") return setAuth(r);
        history.replaceState(null, "", "/setup");
        setPage("setup");
      }
      try {
        await refresh();
        setAuth("ok");
      } catch (e) {
        setAuth(e instanceof ApiError && e.status === 401 ? "out" : (e as Error).message);
      }
    })();
    const onPop = () => setPage(pageFromPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [refresh]);

  useEffect(() => {
    if (auth !== "ok") return;
    return connectEvents((ev) => {
      if (ev.type === "run.phase") setRun(ev.run);
      if (ev.type === "finding.new") setFindings((f) => [ev.finding, ...f.filter((x) => x.id !== ev.finding.id)]);
      if (ev.type === "finding.updated") setFindings((f) => f.map((x) => (x.id === ev.finding.id ? ev.finding : x)));
      if (ev.type === "window.updated") setStatus((s: any) => (s ? { ...s, window: ev.window } : s));
      if (ev.type === "onboarding.updated") setOnboarding(ev.onboarding);
    });
  }, [auth]);

  const go = (p: Page, sub?: string) => {
    history.pushState(null, "", `/${p}${sub ? `/${sub}` : ""}`);
    setPage(p);
    scrollTo(0, 0);
  };

  if (auth !== "ok") return <Login state={auth} />;
  const state: AppState = { status, findings, run, onboarding, refresh, go };
  const newCount = findings.filter((f) => f.status === "new").length;
  const cur = PAGES.find((p) => p.id === page)!;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">
            <Radar size={15} color="white" strokeWidth={2.4} />
          </div>
          ultimatehuman
        </div>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} aria-current={page === p.id} onClick={() => go(p.id)}>
              <p.icon size={16} strokeWidth={2} />
              {p.label}
              {p.id === "findings" && newCount > 0 && <span className="count">{newCount}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <ShieldCheck size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          <b>Read-only.</b> Your trackers are only read. Issues are previewed (dry run) until you connect a GitHub token.
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            {cur.label}
            <span> · {status?.plugins?.filter((p: any) => p.configured && p.kind === "source").map((p: any) => p.displayName).join(", ")}</span>
          </div>
          <WindowPill w={status?.window} />
        </header>
        <div className="content">
          {page === "setup" && <Setup s={state} />}
          {page === "findings" && <Findings s={state} />}
          {page === "runs" && <Runs s={state} />}
          {page === "usage" && <Usage s={state} />}
          {page === "config" && <ConfigPage />}
        </div>
      </div>
    </div>
  );
}

/** "window 78% used · resets 17:00 · 3 queued" */
export function WindowPill({ w }: { w: any }) {
  if (!w) return null;
  if (w.usedPct === null)
    return (
      <div className="meter-pill">
        <span className="dot warn" /> Window usage unavailable · one small step at a time
      </div>
    );
  const ceiling = 100 - w.humanReservePct;
  return (
    <div className="meter-pill" title="Live reading from the Claude CLI rate_limit_event">
      <span className={`dot ${w.usedPct >= ceiling ? "warn" : ""}`} />
      <span>
        <b style={{ fontWeight: 620 }}>Window {Math.round(w.usedPct)}% used</b> · resets {time(w.resetsAt)} · {w.queued} queued
      </span>
      <span className="meter-mini">
        <i style={{ width: `${Math.min(100, w.usedPct)}%` }} />
        <b style={{ width: `${w.humanReservePct}%` }} />
      </span>
    </div>
  );
}

function Login({ state }: { state: string }) {
  return (
    <div className="login">
      <div className="card">
        <div className="brand" style={{ justifyContent: "center", padding: "0 0 18px" }}>
          <div className="brand-mark">
            <Radar size={15} color="white" />
          </div>
          ultimatehuman
        </div>
        {state === "checking" ? (
          <p style={{ color: "var(--ink-3)" }} className="pulse">
            Signing you in…
          </p>
        ) : (
          <>
            <h3 style={{ margin: "0 0 8px" }}>Sign in with a fresh link</h3>
            <p style={{ color: "var(--ink-3)", margin: 0 }}>
              {state === "out" ? "Your session has ended." : state} Run <code>ultimatehuman dashboard</code> in your terminal for a new single-use link.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
