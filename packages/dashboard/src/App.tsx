import { useCallback, useEffect, useState } from "react";
import { Radar, CheckCircle2, X } from "lucide-react";
import { get, setCsrf, redeemLoginFragment, connectEvents, ApiError } from "./api";
import { time } from "./fmt";
import { Setup } from "./pages/Setup";
import CockpitClient from "./ported/CockpitClient";
import AdminSidebar from "./ported/AdminSidebar";
import { Runs } from "./pages/Runs";
import { Usage } from "./pages/Usage";
import { ConfigPage } from "./pages/Config";
import { ChatPage } from "./pages/Chat";

export type Page = "cockpit" | "setup" | "runs" | "usage" | "config" | "chat";
const PAGES: { id: Page; label: string }[] = [
  { id: "cockpit", label: "Cockpit" },
  { id: "runs", label: "Runs" },
  { id: "usage", label: "Usage" },
  { id: "config", label: "Config" },
  { id: "chat", label: "Chat" },
  { id: "setup", label: "Setup" },
];

export interface AppState {
  status: any;
  findings: any[];
  run: any;
  onboarding: any;
  /** Bumped on every ruling event, so open views reload. */
  rev: number;
  /** Set when Setup handed over to the cockpit (shows the one-time welcome strip). */
  landed: boolean;
  refresh: () => Promise<void>;
  go: (p: Page, sub?: string) => void;
}

/** The cockpit is the vendored reference page at /administration/claims; the previous one stays at /legacy-cockpit. Setup is home only until the first pass has finished. */
const COCKPIT_URL = "/administration/claims";
function pageFromPath(): Page | null {
  const p = location.pathname.split("/")[1];
  if (p === "legacy-cockpit") return "cockpit";
  return p !== "cockpit" && PAGES.some((x) => x.id === p) ? (p as Page) : null;
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "ok" | "out" | string>("checking");
  const [page, setPage] = useState<Page>(pageFromPath() ?? "cockpit");
  const [rev, setRev] = useState(0);
  const [landed, setLanded] = useState(false);
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
        history.replaceState(null, "", "/");
      }
      try {
        await refresh();
        if (!pageFromPath()) {
          const runs = (await get("/api/runs")).runs as any[];
          if (runs.some((r) => r.phase === "done")) return location.replace(COCKPIT_URL);
          history.replaceState(null, "", "/setup");
          setPage("setup");
        }
        setAuth("ok");
      } catch (e) {
        setAuth(e instanceof ApiError && e.status === 401 ? "out" : (e as Error).message);
      }
    })();
    const onPop = () => setPage(pageFromPath() ?? "cockpit");
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
      if (ev.type === "ruling") setRev((x) => x + 1);
    });
  }, [auth]);

  const go = (p: Page, sub?: string) => {
    if ((p as string) === COCKPIT_URL.slice(1)) return location.assign(COCKPIT_URL);
    history.pushState(null, "", `/${p === "cockpit" ? "legacy-cockpit" : p}${sub ? `/${sub}` : ""}`);
    setPage(p);
    if (p !== "cockpit") setLanded(false);
    document.querySelector("main")?.scrollTo(0, 0);
  };
  const land = () => location.assign(COCKPIT_URL);

  if (auth !== "ok") return <Login state={auth} />;
  const state: AppState = { status, findings, run, onboarding, rev, landed, refresh, go };
  const cur = PAGES.find((p) => p.id === page)!;
  const sources = status?.plugins?.filter((p: any) => p.configured && p.kind === "source").map((p: any) => p.displayName).join(", ");

  // The shell is the ported admin layout (see src/ported/PROVENANCE.md); pages other than the cockpit keep their own look inside .legacy.
  return (
    <div data-shell className="flex h-screen bg-gray-100">
      <AdminSidebar
        page={page}
        onNavigate={(p: Page) => go(p)}
        footer={
          <p className="px-4 pb-4 pt-3 text-xs leading-snug text-gray-500">
            <span className="font-semibold text-gray-700">Read-only.</span> Your trackers are only read. Issues are previewed (dry run) until you connect a GitHub token.
          </p>
        }
      />
      <main className="flex-1 overflow-x-hidden overflow-y-auto bg-white">
        {page === "cockpit" ? (
          <>
            {landed && (
              <div className="bg-gray-50 px-4 pt-16 sm:px-8 md:pt-6">
                <div data-landed className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold">Setup is complete.</span> This is your cockpit: everything the radar needs from you lands here. Setup stays in the sidebar.
                  </p>
                  <button type="button" aria-label="Close" onClick={() => setLanded(false)} className="shrink-0 opacity-70 hover:opacity-100">
                    <X size={15} />
                  </button>
                </div>
              </div>
            )}
            <CockpitClient s={state} />
          </>
        ) : (
          <div className="legacy">
            <header className="topbar">
              <div className="crumb">
                {cur.label}
                {sources && <span> · {sources}</span>}
              </div>
              <WindowPill w={status?.window} />
            </header>
            <div className="content">
              {page === "setup" && <Setup s={state} land={land} />}
              {page === "runs" && <Runs s={state} />}
              {page === "usage" && <Usage s={state} />}
              {page === "config" && <ConfigPage />}
              {page === "chat" && <ChatPage />}
            </div>
          </div>
        )}
      </main>
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
