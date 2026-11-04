import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState, useRef, type ReactNode } from "react";
import { Activity, ArrowUpRight, Loader2, MessageSquare, RefreshCw, Send, ShieldCheck, Terminal, ChevronRight, GitBranch, LockKeyhole, ListChecks } from "lucide-react";
import { ApiError, connectEvents, get, post, redeemLoginFragment, setCsrf } from "./api";
import { ChatPage } from "./pages/Chat";
import SetupPage from "./pages/SetupOverview";
import { HumanMark } from "./Identity";
import PipelineLive from "./PipelineLive";
import { Modal } from "./WorkspaceModal";
import "../app/globals.css";
import "./workspace.css";
import "./conversation.css";

type Page = "chat" | "setup" | "pipeline-live" | "review";
function pageFromPath(): Page {
  if (/\/setup$|\/projects$/.test(location.pathname)) return "setup";
  if (/pipeline-live|\/runs$/.test(location.pathname)) return "pipeline-live";
  if (/\/review$|\/results$|\/claims$|cockpit/.test(location.pathname)) return "review";
  return "chat";
}
const navigation = [
  { id: "chat", name: "Chat", href: "/chat", icon: MessageSquare },
  { id: "setup", name: "Setup", href: "/setup", icon: ListChecks },
  { id: "pipeline-live", name: "Pipeline live", href: "/pipeline-live", icon: Activity },
  { id: "review", name: "Review", href: "/review?tab=decide", icon: ShieldCheck },
];

function OriginalReview() {
  const [view, setView] = useState<ReactNode>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      const [{ init }, { default: Page }] = await Promise.all([import("./verbatim/data-provider"), import("../app/(app)/administration/claims/page")]);
      const url = new URL(location.href);
      if (!url.searchParams.has("tab") && /\/review$|\/results$/.test(url.pathname)) {
        url.searchParams.set("tab", url.pathname === "/results" ? "shipped" : "decide");
        history.replaceState(null, "", url);
      }
      await init();
      const tree = await Page();
      if (active) setView(tree);
    })().catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  if (error) return <p role="alert" className="uh-error">{error}</p>;
  return <div className="conversation-review">{view || <p className="conversation-loading"><Loader2 size={16} className="uh-spin" /> Loading review…</p>}</div>;
}

function TelegramConnection({ status, close, refresh }: any) {
  const [token, setToken] = useState("");
  const [current, setCurrent] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replaceToken, setReplaceToken] = useState(false);
  const connect = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await post("/api/chat/telegram/connect", token ? { token } : {});
      setToken(""); setCurrent(result); await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    const timer = setInterval(() => void get("/api/chat/telegram").then((r) => { setCurrent(r); if (r.paired) void refresh(); }).catch(() => {}), 1500);
    return () => clearInterval(timer);
  }, []);
  return <Modal title={current?.paired ? "Telegram connected" : "Connect Telegram"} close={close}>
    {current?.paired ? <p className="conversation-modal-copy">Messages here, in Telegram, and in the CLI use the same conversation.</p> : current?.link ? <p className="conversation-modal-copy">Open your bot and press Start to connect this conversation.</p> : <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
      {(!current?.hasToken || replaceToken) && <><p className="conversation-modal-copy">Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, then enter its token here.</p><label className="uh-field"><span>Bot token</span><input autoFocus type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required placeholder="123456:…" /></label><p className="conversation-secret-note">Saved locally. Never sent to Claude or stored in chat.</p></>}
      {current?.hasToken && !replaceToken && <p className="conversation-modal-copy">Use the bot token already saved on this machine. <button className="uh-link" type="button" onClick={() => setReplaceToken(true)}>Use another token</button></p>}
      <div className="uh-modal-actions"><button className="uh-btn" type="button" onClick={close}>Cancel</button><button className="uh-btn primary" type="submit" disabled={busy || ((!current?.hasToken || replaceToken) && !token.trim())}>{busy ? "Checking…" : "Connect"}</button></div>
    </form>}
    {current?.link && <div className="uh-modal-actions"><button className="uh-btn" onClick={close}>Close</button><a className="uh-btn primary" href={current.link} target="_blank" rel="noreferrer">Open Telegram <ArrowUpRight size={15} /></a></div>}
    {current?.link && !current.paired && <p className="conversation-secret-note" role="status">Waiting for you to press Start in Telegram. The link expires after 10 minutes.</p>}
    {error && <p role="alert" className="uh-error">{error}</p>}
  </Modal>;
}

function ConversationWorkspace() {
  const page = pageFromPath();
  const [data, setData] = useState<any>(null);
  const [telegram, setTelegram] = useState<any>(null);
  const [connectingTelegram, setConnectingTelegram] = useState(false);
  const [auth, setAuth] = useState("");
  const [offline, setOffline] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [accountError, setAccountError] = useState("");
  const fetching = useRef(false);
  const [project, setProject] = useState(new URLSearchParams(location.search).get("project") || "all");
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const status = await get("/api/status"); setCsrf(status.csrf);
      const [workspace, pipelines, cockpit, runs, channel] = await Promise.all([get("/api/workspace"), get("/api/pipelines"), get("/api/cockpit"), get("/api/runs"), get("/api/chat/telegram")]);
      setData({ status, workspace, pipelines, cockpit, runs: runs.runs }); setTelegram(channel); setOffline(false); setAuth("");
    } catch (e) { if (e instanceof ApiError && e.status === 401) setAuth("Open a login link from ultimatehuman dashboard."); else setOffline(true); }
    finally { fetching.current = false; }
  }, []);
  useEffect(() => {
    void (async () => { const result = await redeemLoginFragment(); if (result !== "none" && result !== "ok") { setAuth(result); return; } await refresh(); })();
    const timer = setInterval(() => void refresh(), 5000);
    const disconnect = connectEvents(() => void refresh());
    return () => { clearInterval(timer); disconnect(); };
  }, [refresh]);
  useEffect(() => {
    if (page === "chat" && data?.workspace.provider.authenticated) void post("/api/chat/start").catch(() => {});
  }, [page, data?.workspace.provider.authenticated]);
  const act = async (path: string, body?: unknown) => { const result = await post(path, body); await refresh(); return result; };
  if (auth || !data) return <div className="conversation-access"><a href="/chat" className="conversation-access-brand"><HumanMark />ultimatehuman<span>.</span></a><div className="conversation-access-card"><span className="eyebrow">YOUR LOCAL WORKSPACE</span><h1>{auth ? "Let’s get you in." : offline ? "Reconnect your workspace." : "Opening your workspace."}</h1><p>{auth || (offline ? "Start the local engine to continue." : "Connecting to the engine on this machine…")}</p>{(auth || offline) ? <><div className="conversation-command"><Terminal size={16} /><code>ultimatehuman dashboard</code></div><button className="uh-btn primary" onClick={() => void refresh()}>Try again <ArrowUpRight size={16} /></button></> : <Loader2 size={22} className="uh-spin" />}</div><span className="conversation-access-foot">AUTONOMOUS ENGINEERING. HUMAN JUDGMENT.</span></div>;
  const provider = data.workspace.provider;
  const repos = data.workspace.projects.filter((p: any) => project === "all" || p.id === project).flatMap((p: any) => p.repos.map((r: any) => r.name));
  const pipelines = data.pipelines.config.filter((p: any) => project === "all" || !p.repos || p.repos.some((r: string) => repos.includes(r)));
  const projectNames = data.workspace.projects.map((p: any) => p.name);
  const reviewCount = data.cockpit.cards.filter((c: any) => c.finding && (!c.ruling || ["clear", "resurfaced"].includes(c.ruling.ruling))).length + (data.cockpit.proposals || []).filter((p: any) => p.status === "pending").length;
  const runCount = data.runs.filter((r: any) => !["done", "failed"].includes(r.phase)).length;
  return <div className={`uh-app conversation-app conversation-page-${page}`}>
    <aside className="conversation-sidebar">
      <a href="/chat" className="conversation-brand" aria-label="ultimatehuman home"><HumanMark /><span>ultimatehuman<b>.</b></span></a>
      <nav aria-label="Main navigation">{navigation.map(({ id, name, href, icon: Icon }) => {
        const count = id === "review" ? reviewCount : id === "pipeline-live" ? runCount : 0;
        return <a href={href} key={id} aria-current={id === page ? "page" : undefined}><Icon size={18} strokeWidth={1.65} /><span>{name}</span>{count > 0 && <b className="conversation-nav-count">{count}</b>}{id === page && <ChevronRight size={14} className="conversation-nav-arrow" />}</a>;
      })}</nav>
      <div className="conversation-sidebar-bottom">
        <div className="conversation-engine-status"><span className={`uh-dot ${offline ? "warn" : ""}`} />{offline ? "Engine offline" : "Local engine running"}</div>
      </div>
    </aside>
    <div className="conversation-main">
      <header className="conversation-header"><div className="conversation-breadcrumb"><HumanMark className="conversation-mobile-mark" /><span className="conversation-breadcrumb-root">Workspace</span><span className="conversation-breadcrumb-slash">/</span><h1>{navigation.find((p) => p.id === page)?.name}</h1></div><div className="conversation-header-actions">
        <span className="conversation-local-status"><span className={`uh-dot ${offline ? "warn" : ""}`} />Local workspace</span>
        {page === "chat" && <><button className="uh-btn conversation-cli" onClick={() => { void get("/api/chat").then(async (r) => { const command = `${r.cliCommand || "ultimatehuman"} chat`; try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setAccountError(`Terminal command: ${command}`); } }).catch((e) => setAccountError(e.message)); }} title="Copy terminal command"><Terminal size={14} />{copied ? "Copied" : "Use CLI"}</button><button className="uh-btn conversation-telegram" onClick={() => setConnectingTelegram(true)}><Send size={14} />{telegram?.paired ? "Telegram" : "Connect Telegram"}<ArrowUpRight size={13} /></button></>}
        {["pipeline-live", "setup"].includes(page) && data.workspace.projects.length > 1 && <div className="conversation-project-filter"><GitBranch size={14} /><select aria-label="Project filter" value={page === "setup" && !data.workspace.projects.some((p: any) => p.id === project) ? data.workspace.projects[0].id : project} onChange={(e) => setProject(e.target.value)}>{page !== "setup" && <option value="all">All projects</option>}{data.workspace.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
      </div></header>
      <nav className="conversation-mobile-nav" aria-label="Mobile navigation">{navigation.map(({ id, name, href, icon: Icon }) => <a key={id} href={href} aria-current={id === page ? "page" : undefined}><Icon size={15} />{name}</a>)}</nav>
      {offline && <div className="conversation-warning" role="status">Reconnecting to the engine…</div>}
      {page === "chat" && provider.authenticated && accountError && <div className="conversation-warning" role="status">{accountError}</div>}
      {page === "chat" && !provider.authenticated && <div className="conversation-warning conversation-account-warning"><LockKeyhole size={15} /><div><strong>{accountError || (provider.available ? "Claude needs to reconnect." : "Claude Code is not installed.")}</strong><span>Run <code>{provider.command || "claude auth login"}</code> in your terminal.</span></div><button className="uh-btn" disabled={checking} onClick={async () => { setChecking(true); setAccountError(""); try { await act("/api/workspace/provider/check", {}); } catch (e) { setAccountError((e as Error).message); } finally { setChecking(false); } }}><RefreshCw size={14} className={checking ? "uh-spin" : ""} />{checking ? "Checking…" : "Check connection"}</button></div>}
      <main className={`conversation-content ${page === "chat" ? "conversation-chat" : ""}`}>
        {page === "chat" && <ChatPage projectNames={projectNames} configured={data.workspace.projects.length > 0} disabled={!provider.authenticated || offline} initialPrompt={new URLSearchParams(location.search).get("message") || (/config|settings|pipelines|projects/.test(location.pathname) ? "Help me configure this workspace." : "")} />}
        {page === "pipeline-live" && <PipelineLive data={data} pipelines={pipelines} project={project} offline={offline} act={act} chatFirst />}
        {page === "setup" && <SetupPage data={data} project={project} />}
        {page === "review" && <OriginalReview />}
      </main>
    </div>
    {connectingTelegram && <TelegramConnection status={telegram} close={() => setConnectingTelegram(false)} refresh={refresh} />}
  </div>;
}
export function mount(root: HTMLElement) { createRoot(root).render(<ConversationWorkspace />); }
