import { pipelineDraft, pipelinePatch } from "./pipeline-form";
import { AddPanel } from "./pipelines/PipelinesPanel";
import { Modal } from "./WorkspaceModal";
import { ConfigFile, FeaturesPanel, GradePanel } from "./teach/InstructionsPage";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Code2,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  Layers3,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  AlertTriangle,
} from "lucide-react";
import {
  get,
  post,
  setCsrf,
  redeemLoginFragment,
  connectEvents,
  ApiError,
} from "./api";
import PipelineLive from "./PipelineLive";
import "./workspace.css";

type Page = "pipeline-live" | "review" | "projects" | "pipelines" | "results" | "settings";
type Data = {
  workspace: any;
  cockpit: any;
  pipelines: any;
  runs: any[];
  status: any;
};
const titles: Record<Page, string> = {
  "pipeline-live": "Pipeline live",
  review: "Review",
  projects: "Projects",
  pipelines: "Pipeline settings",
  results: "Results",
  settings: "Settings",
};
const icons = {
  "pipeline-live": Activity,
  review: ShieldCheck,
  projects: FolderGit2,
  pipelines: Layers3,
  results: Activity,
  settings: Settings2,
};
const ago = (value?: string) => {
  if (!value) return "Not yet";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
};
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not recorded";
const safeUrl = (url?: string) => {
  try {
    const u = new URL(url || "");
    return ["https:", "http:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
};
const human = (value: string) => value?.replace(/_/g, " ") || "";
const activeRun = (run: any) => run && !["done", "failed"].includes(run.phase);
const findingState = (card: any) =>
  card.ruling?.ruling === "file"
    ? card.finding?.filedIssue
      ? "Issue created"
      : "Accepted"
    : card.ruling?.ruling === "dismiss"
      ? "Dismissed"
      : card.ruling?.ruling === "park"
        ? "Later"
        : "Needs decision";
const pendingCard = (card: any) => card.finding && !card.ruling;
const err = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`uh-pill ${tone}`}>{children}</span>;
}
function Empty({
  icon: Icon = Radar,
  title,
  children,
  action,
}: {
  icon?: any;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="uh-empty">
      <div className="uh-empty-icon">
        <Icon size={25} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
function ErrorNote({ message }: { message: string }) {
  return message ? (
    <div className="uh-error" role="alert">
      <AlertTriangle size={16} />
      <span>{message}</span>
    </div>
  ) : null;
}
function Button({
  children,
  onClick,
  disabled = false,
  kind = "",
  type = "button",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  type?: "button" | "submit";
  [key: string]: any;
}) {
  return (
    <button
      type={type}
      className={`uh-btn ${kind}`}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="uh-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function route(): Page | null {
  const path = location.pathname;
  if (path === "/" || path === "/login") return null;
  if (path.includes("config") && new URLSearchParams(location.search).get("tab") === "pipelines") return "pipelines";
  if (path.includes("config") || path === "/usage") return "settings";
  if (path === "/setup") return "projects";
  if (path.includes("pipeline-live") || path === "/runs") return "pipeline-live";
  if (path.includes("claims") || path.includes("cockpit")) return "review";
  return (
    (Object.keys(titles).find((p) => path === `/${p}`) as Page) || "review"
  );
}

function Workspace() {
  const [data, setData] = useState<Data | null>(null);
  const [auth, setAuth] = useState("loading");
  const [page, setPage] = useState<Page>(route() ?? "projects");
  const [project, setProject] = useState(
    () => new URLSearchParams(location.search).get("project") || "all",
  );
  const [toast, setToast] = useState("");
  const [offline, setOffline] = useState(false);
  const [adding, setAdding] = useState(false);
  const [chat, setChat] = useState(location.pathname === "/chat");
  const [settingsTab, setSettingsTab] = useState(() => {
    const selected = new URLSearchParams(location.search).get("tab");
    if (selected === "instructions") return "guidelines";
    if (selected === "operation") return "connections";
    return selected || (location.pathname === "/usage" ? "operation" : location.pathname === "/config" ? "file" : "connections");
  });
  const [guidelinesPipeline, setGuidelinesPipeline] = useState(() => new URLSearchParams(location.search).get("pipeline") || "");
  const loading = useRef(false);
  const ready = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const status = await get("/api/status");
      setCsrf(status.csrf);
      const [workspace, cockpit, pipelines, runs] = await Promise.all([
        get("/api/workspace"),
        get("/api/cockpit"),
        get("/api/pipelines"),
        get("/api/runs"),
      ]);
      setData({ workspace, cockpit, pipelines, runs: runs.runs, status });
      setOffline(false);
      if (!ready.current) {
        ready.current = true;
        const initial =
          route() ??
          (pipelines.config.length > 0 ? "pipeline-live" : cockpit.cards.some((c: any) => c.finding) ||
          workspace.completedDecisions > 0
            ? "review"
            : "projects");
        setPage(initial);
        history.replaceState(null, "", `/${initial}${location.search}`);
      }
      setAuth("ok");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth("out");
      else if (ready.current) setOffline(true);
      else setAuth(err(e));
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    void (async () => {
      if (location.pathname === "/login") {
        const result = await redeemLoginFragment();
        if (!["none", "ok"].includes(result)) {
          setAuth(result);
          return;
        }
      }
      await refresh();
    })();
    const pop = () => {
      setPage(route() ?? "review");
      setProject(new URLSearchParams(location.search).get("project") || "all");
      const query = new URLSearchParams(location.search);
      setSettingsTab(query.get("tab") || "connections");
      setGuidelinesPipeline(query.get("pipeline") || "");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [refresh]);
  useEffect(() => {
    if (auth !== "ok") return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const disconnect = connectEvents(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => void refresh(), 200);
    });
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      disconnect();
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [auth, refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 7000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const go = (next: Page, selected = project, finding?: string) => {
    setPage(next);
    setProject(selected);
    const query = new URLSearchParams();
    if (selected !== "all") query.set("project", selected);
    if (finding) query.set("finding", finding);
    history.pushState(null, "", `/${next}${query.size ? `?${query}` : ""}`);
    window.scrollTo({ top: 0 });
  };
  const settings = (tab: string, pipeline = "") => {
    setSettingsTab(tab);
    if (pipeline) setGuidelinesPipeline(pipeline);
    go("settings");
    const query = new URLSearchParams(location.search);
    if (tab !== "connections") query.set("tab", tab);
    if (pipeline) query.set("pipeline", pipeline);
    history.replaceState(null, "", `/settings${query.size ? `?${query}` : ""}`);
  };
  const act = async (path: string, body?: unknown, message?: string) => {
    const result = await post(path, body);
    await refresh();
    if (message) setToast(message);
    return result;
  };
  if (auth !== "ok" || !data)
    return (
      <div className="uh-login">
        <Brand />
        <div className="uh-panel">
          <div className="uh-empty-icon">
            {auth === "loading" ? (
              <Loader2 className="uh-spin" />
            ) : (
              <ShieldCheck />
            )}
          </div>
          <h1>
            {auth === "loading"
              ? "Opening your workspace"
              : "Sign in to the dashboard"}
          </h1>
          <p>
            {auth === "loading"
              ? "Connecting to your local engine…"
              : auth === "out"
                ? "Open a fresh login link from your terminal to continue."
                : auth}
          </p>
          {auth !== "loading" && (
            <>
              <code>ultimatehuman dashboard</code>
              <Button
                onClick={() => {
                  setAuth("loading");
                  void refresh();
                }}
                kind="primary"
              >
                Try again <ArrowRight size={15} />
              </Button>
            </>
          )}
        </div>
      </div>
    );
  const projects = data.workspace.projects;
  const selectedProjects = projects.filter(
    (p: any) => project === "all" || p.id === project,
  );
  const names = selectedProjects.flatMap((p: any) =>
    p.repos.map((r: any) => r.name),
  );
  const scopedPipes = data.pipelines.config.filter(
    (p: any) =>
      project === "all" || p.repos?.some((r: string) => names.includes(r)),
  );
  const cards = data.cockpit.cards.filter(
    (c: any) =>
      c.finding &&
      (project === "all" ||
        names.includes(c.finding.repo) ||
        scopedPipes.some((p: any) => p.id === c.pipelineId)),
  );
  const count = cards.filter(pendingCard).length;
  const currentRun = data.runs.find((r) => activeRun(r));
  return (
    <div className="uh-app">
      <aside className="uh-sidebar">
        <Brand />
        <div className="uh-project-select">
          <FolderGit2 size={17} />
          <select
            aria-label="Current project"
            value={project}
            onChange={(e) => go(page, e.target.value)}
          >
            <option value="all">All projects</option>
            {projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="Main navigation">
          {(["pipeline-live", "review", "projects", "pipelines", "results"] as Page[]).map(
            (id) => {
              const Icon = icons[id];
              return (
                <button
                  key={id}
                  onClick={() => go(id)}
                  className={`uh-nav ${page === id ? "active" : ""}`}
                  aria-current={page === id ? "page" : undefined}
                >
                  <Icon size={19} />
                  <span>{titles[id]}</span>
                  {id === "review" && count > 0 && <b>{count}</b>}
                </button>
              );
            },
          )}
        </nav>
        <div className="uh-sidebar-bottom">
          <div className="uh-engine">
            <span className={`uh-dot ${offline ? "warn" : ""}`} />
            <strong>{offline ? "Reconnecting" : "Engine online"}</strong>
            <p>
              {currentRun
                ? "Investigation in progress"
                : "Running on this machine"}
            </p>
          </div>
          <button
            className={`uh-nav ${page === "settings" ? "active" : ""}`}
            onClick={() => settings("connections")}
          >
            <Settings2 size={19} />
            Settings
          </button>
          <button className="uh-nav" onClick={() => setChat(true)}>
            <MessageSquare size={19} />
            Chat
            <ArrowUpRight size={14} />
          </button>
        </div>
      </aside>
      <div className="uh-main">
        <header className="uh-topbar">
          <div>
            <span className="uh-mobile-brand">
              uh<span>●</span>
            </span>
            <span className="uh-muted">Workspace</span>
            <span className="uh-slash">/</span>
            <span>{titles[page]}</span>
          </div>
          <div className="uh-topbar-right">
            <button
              className="uh-icon-btn uh-mobile-chat"
              aria-label="Ask your assistant"
              onClick={() => setChat(true)}
            >
              <MessageSquare size={18} />
            </button>
            <ShieldCheck size={14} />
            <span>Read-only investigations</span>
          </div>
        </header>
        <nav className="uh-mobile-nav" aria-label="Mobile navigation">
          {Object.keys(titles).map((key) => (
            <button
              key={key}
              onClick={() => key === "settings" ? settings("connections") : go(key as Page)}
              aria-current={page === key ? "page" : undefined}
            >
              {titles[key as Page]}
            </button>
          ))}
        </nav>
        {projects.length > 1 && (
          <div className="uh-mobile-project">
            <FolderGit2 size={16} />
            <select
              aria-label="Mobile current project"
              value={project}
              onChange={(e) => go(page, e.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {offline && (
          <div className="uh-offline" role="status">
            <RefreshCw size={15} />
            Reconnecting to the local engine. Your saved work is preserved.
          </div>
        )}
        <main className={`uh-content page-${page}`}>
          {page === "pipeline-live" && <PipelineLive data={data} pipelines={scopedPipes} project={project} offline={offline} act={act} />}
          {page === "projects" && (
            <Projects
              data={data}
              projects={selectedProjects}
              add={() => setAdding(true)}
              act={act}
              go={go}
              settings={settings}
            />
          )}
          {page === "review" && (
            <Review key={project} cards={cards} data={data} act={act} go={go} />
          )}
          {page === "pipelines" && (
            <Pipelines
              data={data}
              pipelines={scopedPipes}
              refresh={refresh}
              act={act}
              go={go}
              settings={settings}
            />
          )}
          {page === "results" && (
            <Results cards={cards} data={data} act={act} go={go} />
          )}
          {page === "settings" && (
            <Settings
              data={data}
              tab={settingsTab}
              setTab={settings}
              pipelineId={guidelinesPipeline}
              setPipelineId={setGuidelinesPipeline}
              act={act}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="uh-toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {adding && (
        <AddProject
          close={() => setAdding(false)}
          projects={projects}
          onAdd={async (repository, group) => {
            const result = await act(
              "/api/workspace/projects",
              { repository, project: group },
              "Project added.",
            );
            setAdding(false);
            go("projects", result.project);
          }}
        />
      )}
      {chat && (
        <Chat
          close={() => setChat(false)}
          context={`${project === "all" ? "All projects" : project} · ${titles[page]}`}
        />
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="uh-brand">
      <span className="uh-brand-mark">
        <span />
        <i />
      </span>
      ultimatehuman<span className="uh-brand-period">.</span>
    </div>
  );
}
function Heading({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="uh-heading">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
function AddProject({
  close,
  onAdd,
  projects,
}: {
  close: () => void;
  onAdd: (repo: string, group: string) => Promise<void>;
  projects: any[];
}) {
  const [repository, setRepository] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Connect a project" close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onAdd(repository, group);
          } catch (e) {
            setError(err(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Git repository"
          hint="A local checkout or an HTTPS / SSH Git URL. Existing Git authentication is used."
        >
          <input
            autoFocus
            required
            placeholder="~/code/my-project or https://github.com/team/repo"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
          />
        </Field>
        {projects.length > 0 && <Field
          label="Project"
        >
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Create a new project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>}
        <ErrorNote message={error} />
        <div className="uh-modal-actions">
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            kind="primary"
            disabled={busy || !repository.trim()}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="uh-spin" />
                Connecting repository…
              </>
            ) : (
              <>
                Connect project <ArrowRight size={16} />
              </>
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Projects({
  data,
  projects,
  add,
  act,
  go,
  settings,
}: {
  data: Data;
  projects: any[];
  add: () => void;
  act: any;
  go: any;
  settings: any;
}) {
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [activating, setActivating] = useState("");
  const project = projects.find((p) => p.id === focus) || projects[0];
  const sources = data.workspace.connections.filter(
    (c: any) => c.supported && c.configured && c.probe?.ok,
  );
  const [source, setSource] = useState("");
  const sourceId = sources.some((c: any) => c.id === source)
    ? source
    : sources[0]?.id;
  const start = (template: string) => setActivating(template);
  const discoveries = project?.repos ?? [];
  const facts = discoveries.flatMap((r: any) =>
    r.facts.map((f: any) => ({ ...f, repo: r })),
  );
  const distinctiveFacts = facts
    .filter(
      (f: any, i: number) =>
        facts.findIndex(
          (other: any) => other.kind === f.kind && other.label === f.label,
        ) === i,
    )
    .sort(
      (a: any, b: any) =>
        Number(a.label === "Node.js") - Number(b.label === "Node.js"),
    );
  const applications = facts.filter((f: any) => f.kind === "application");
  const tests = facts.filter((f: any) => f.kind === "tests");
  const trackers = discoveries.flatMap((r: any) => r.trackers);
  const canRun =
    discoveries.length > 0 && discoveries.every((r: any) => r.available);
  return (
    <>
      <Heading
        title="Projects"
        action={
          <Button onClick={add}>
            <Plus size={16} />
            Add project
          </Button>
        }
      />
      {!project ? (
        <Empty icon={FolderGit2} title="No projects" action={<Button kind="primary" onClick={add}>Add project</Button>}>
          Add a Git repository to see which pipelines can run.
        </Empty>
      ) : (
        <>
          {projects.length > 1 && (
            <div className="uh-tabs project-tabs">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={p.id === project.id ? "active" : ""}
                  onClick={() => setFocus(p.id)}
                >
                  <FolderGit2 size={15} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <section className="uh-project-hero">
            <div className="uh-project-identity">
              <div className="uh-eyebrow">
                <span className="uh-dot" />
                {canRun ? "Connected" : "Repository unavailable"}
              </div>
              <h2>{project.name}</h2>
              <p>{discoveries[0]?.issueRepo || discoveries[0]?.path}</p>
              <div className="uh-hero-meta">
                <span>
                  <GitBranch size={14} />
                  {discoveries[0]?.branch || "Unavailable"}
                </span>
                <span>
                  {discoveries.length}{" "}
                  {discoveries.length === 1 ? "repository" : "repositories"}
                </span>
                <span>
                  Scanned {ago(discoveries[0]?.scannedAt).toLowerCase()}
                </span>
              </div>
            </div>
            <div className="uh-project-map" aria-label="Discovery summary">
              <div className="map-item">
                <Code2 size={23} />
                <strong>
                  {[...new Set(applications.map((f: any) => f.label))]
                    .slice(0, 2)
                    .join(" + ") || "Source code"}
                </strong>
                <span>
                  {discoveries
                    .reduce((n: number, r: any) => n + r.trackedFiles, 0)
                    .toLocaleString()}{" "}
                  tracked files
                </span>
              </div>
              <div className="map-item">
                <CheckCircle2 size={23} />
                <strong>{tests[0]?.label || "Tests"}</strong>
                <span>
                  {tests.length ? "Tooling detected" : "Not detected"}
                </span>
              </div>
              <div className="map-item">
                <Activity size={23} />
                <strong>Signals</strong>
                <span>
                  {trackers.length
                    ? `${new Set(trackers.map((t: any) => t.provider)).size} SDKs detected`
                    : "Code available"}
                </span>
              </div>
            </div>
            <button
              className="uh-hero-refresh"
              aria-label="Rescan project"
              disabled={busy === "rescan"}
              onClick={async () => {
                setBusy("rescan");
                setError("");
                try {
                  await act(
                    `/api/workspace/projects/${encodeURIComponent(project.id)}/rescan`,
                    {},
                    "Project rescanned.",
                  );
                } catch (e) {
                  setError(err(e));
                } finally {
                  setBusy("");
                }
              }}
            >
              <RefreshCw
                size={15}
                className={busy === "rescan" ? "uh-spin" : ""}
              />
            </button>
          </section>
          <ErrorNote message={error} />
          {discoveries
            .filter((r: any) => !r.available)
            .map((r: any) => (
              <ErrorNote key={r.name} message={`${r.name}: ${r.error}`} />
            ))}
          {project.lastRun && <RunProgress run={project.lastRun} go={go} />}
          <div className="uh-discovery-grid">
            <section>
              <div className="uh-section-heading">
                <div>
                  <h2>Run a pipeline</h2>
                </div>
              </div>
              <div className="uh-recommendation">
                <h3>Security check</h3>
                <p>
                  Check authentication, exposed credentials, and dependencies.
                </p>
                <div className="uh-recommendation-bottom">
                  <span>
                    <Code2 size={13} />
                    Repository code
                  </span>
                  <Button
                    kind="primary"
                    disabled={!!busy || !canRun}
                    onClick={() => void start("security-check")}
                  >
                    {busy === "security-check" ? (
                      <Loader2 size={16} className="uh-spin" />
                    ) : (
                      "Review & run"
                    )}
                    <ArrowRight size={15} />
                  </Button>
                </div>
              </div>
              <div className="uh-recommendation">
                <h3>Bug radar</h3>
                <p>
                  Investigate errors from PostHog or Datadog against your code.
                </p>
                {sources.length > 0 && (
                  <Field label="Source for this project">
                    <select
                      value={sourceId}
                      onChange={(e) => setSource(e.target.value)}
                    >
                      {sources.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.savedOptions.projectId
                            ? ` · project ${s.savedOptions.projectId}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <div className="uh-recommendation-bottom">
                  <span>
                    {trackers.length
                      ? `${[...new Set(trackers.map((t: any) => t.provider))].join(", ")} detected`
                      : "PostHog or Datadog"}
                  </span>
                  <Button
                    disabled={!!busy || !canRun}
                    onClick={() => start("bug-radar")}
                  >
                    {sources.length
                      ? "Review & run"
                      : "Connect a source"}
                    <ArrowUpRight size={15} />
                  </Button>
                </div>
              </div>
            </section>
            <aside className="uh-discovery-aside">
              <details className="uh-panel uh-discovered">
                <summary>Detected in the repository</summary>

                {distinctiveFacts.length ? (
                  distinctiveFacts.slice(0, 6).map((f: any, i: number) => (
                    <div
                      className="uh-fact"
                      key={`${f.repo.name}-${f.path}-${i}`}
                    >
                      <span className="uh-fact-icon">
                        {f.kind === "application" ? (
                          <Code2 size={16} />
                        ) : f.kind === "tests" ? (
                          <CheckCircle2 size={16} />
                        ) : f.kind === "ci" ? (
                          <Layers3 size={16} />
                        ) : (
                          <ShieldCheck size={16} />
                        )}
                      </span>
                      <div>
                        <strong>{f.label}</strong>
                        <span title={f.detail}>{f.detail}</span>
                        {f.repo.remote && f.repo.commit ? (
                          <a
                            href={`${f.repo.remote}/blob/${f.repo.commit}/${f.path.split("/").map(encodeURIComponent).join("/")}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {f.path}
                            <ArrowUpRight size={11} />
                          </a>
                        ) : (
                          <code>{f.path}</code>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="uh-muted">
                    Tracked source files are available. No recognized
                    application manifest was found.
                  </p>
                )}
                <div className="uh-inventory-note">
                  Tests have not been run.
                </div>
              </details>

            </aside>
          </div>
          <section className="uh-repo-list">
            <div className="uh-section-heading">
              <h2>Repositories</h2>
            </div>
            {discoveries.map((repo: any) => (
              <div className="uh-repo-row" key={repo.name}>
                <FolderGit2 size={20} />
                <div>
                  <strong>{repo.name}</strong>
                  <span>{repo.path}</span>
                </div>
                <Pill tone={repo.available ? "green" : "amber"}>
                  {repo.available ? "Connected" : "Unavailable"}
                </Pill>
                <Button onClick={() => setEditing(repo)}>
                  <SlidersHorizontal size={14} />
                  Details
                </Button>
              </div>
            ))}
          </section>
        </>
      )}
      {editing && (
        <RepoDetails repo={editing} close={() => setEditing(null)} act={act} />
      )}
      {activating && project && (
        <Activation
          project={project}
          template={activating}
          connections={data.workspace.connections}
          initialSource={sourceId}
          authReady={data.workspace.provider.authenticated}
          authReason={data.workspace.provider.reason}
          close={() => setActivating("")}
          act={act}
        />
      )}
    </>
  );
}

function Activation({ project, template, connections, initialSource, authReady, authReason, close, act }: any) {
  const available = connections.filter((c: any) => c.supported);
  const detected = available.find((c: any) => c.detectedIn.some((name: string) => project.repos.some((r: any) => r.name === name)));
  const [source, setSource] = useState(initialSource || detected?.id || available[0]?.id || "");
  const [setup, setSetup] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState("");
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const payload = { project: project.id, template, sources: source ? [source] : [] };
  const check = async (verifyProvider = false) => {
    const revision = ++request.current;
    setChecking(true);
    setError("");
    try {
      const result = await post("/api/workspace/activation", { ...payload, verifyProvider });
      if (request.current === revision) setSetup(result);
    } catch (e) {
      if (request.current === revision) { setError(err(e)); setSetup(null); }
    } finally {
      if (request.current === revision) setChecking(false);
    }
  };
  useEffect(() => { void check(); return () => { request.current++; }; }, [project.id, template, source, authReady]);
  if (connecting) return (
    <Connection
      connection={connections.find((c: any) => c.id === connecting)}
      act={act}
      close={() => { setConnecting(""); void check(); }}
    />
  );
  const missing = setup?.checks.filter((c: any) => c.required && !c.ready).length ?? 0;
  return (
    <Modal title={`Run ${template === "security-check" ? "security check" : "bug radar"}`} close={() => { if (!starting) close(); }} wide>
      <div className="uh-activation-intro">
        <strong>{project.name}</strong>
        <Pill tone={setup?.ready ? "green" : "amber"}>
          {checking ? "Checking access…" : !setup ? "Setup needed" : setup.ready ? "Ready" : `${missing} ${missing === 1 ? "check" : "checks"} required`}
        </Pill>
      </div>
      {template !== "security-check" && (
        <Field label="Source for this project">
          <select value={source} disabled={checking || starting} onChange={(e) => setSource(e.target.value)}>
            {available.map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.savedOptions.projectId ? ` · project ${c.savedOptions.projectId}` : ""}</option>)}
          </select>
        </Field>
      )}
      <div className="uh-activation-checks" aria-live="polite" aria-busy={checking}>
        {!setup && checking && <p className="uh-muted">Checking your repository, AI account, and connections…</p>}
        {setup?.checks.map((c: any, index: number) => (
          <div className={`uh-activation-check ${c.ready ? "ready" : c.required ? "needed" : "optional"}`} key={c.id}>
            <span className="uh-activation-marker">{c.ready ? <Check size={17} /> : String(index + 1).padStart(2, "0")}</span>
            <div className="uh-activation-check-body">
              <div className="uh-activation-check-title"><h3>{c.label}</h3><Pill tone={c.ready ? "green" : c.required ? "amber" : "neutral"}>{c.ready ? "Ready" : c.id === "ai" && authReason === "expired" ? "Reconnect needed" : c.required ? "Action needed" : "Optional"}</Pill></div>
              <p>{c.detail}</p>
              {c.command && <div className="uh-activation-command"><code>{c.command}</code><Button onClick={async () => {
                try { await navigator.clipboard.writeText(c.command); setCopied(true); } catch { setError("Copy the command above into your terminal to continue."); }
              }}>{copied ? "Copied" : "Copy command"}</Button></div>}
              {c.sourceId && <Button onClick={() => setConnecting(c.sourceId)} disabled={starting}>{c.ready ? "Review connection" : `Connect ${c.label}`} <ArrowUpRight size={14} /></Button>}
            </div>
          </div>
        ))}
      </div>

      <ErrorNote message={error} />
      <div className="uh-modal-actions">
        <Button onClick={() => void check(true)} disabled={checking || starting}><RefreshCw size={14} className={checking ? "uh-spin" : ""} />{checking ? "Checking access…" : "Check again"}</Button>
        <Button kind="primary" disabled={checking || starting || !setup?.ready} onClick={async () => {
          setStarting(true); setError("");
          try {
            await act("/api/workspace/investigate", payload, "Investigation started. Follow its progress below.");
            close();
          } catch (e) { setError(err(e)); void check(); }
          finally { setStarting(false); }
        }}>{starting ? <><Loader2 size={15} className="uh-spin" />Starting…</> : <>Start investigation <ArrowRight size={15} /></>}</Button>
      </div>
    </Modal>
  );
}

function RepoDetails({ repo, close, act }: any) {
  const [notes, setNotes] = useState(repo.notes || "");
  const [url, setUrl] = useState(repo.testUrl || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={repo.name} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await act(
              `/api/workspace/repos/${encodeURIComponent(repo.name)}`,
              { notes, testUrl: url },
              "Repository context saved.",
            );
            close();
          } catch (e) {
            setError(err(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Project context"
          hint="Read by future investigations of this repository."
        >
          <textarea
            rows={5}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What does this product do? What matters most?"
          />
        </Field>
        <Field
          label="Test or staging URL"
          hint="Saved for context. This build does not execute browser tests."
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://staging.example.com"
          />
        </Field>
        <ErrorNote message={error} />
        <div className="uh-modal-actions">
          <Button onClick={close}>Cancel</Button>
          <Button kind="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save context"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function RunProgress({ run, go }: any) {
  const running = activeRun(run);
  const failed = run.phase === "failed";
  const parked = run.phase === "parked";
  const phase: Record<string, string> = {
    scheduled: "Preparing investigation",
    collecting: "Reading available signals",
    correlating: "Grouping related signals",
    root_causing: "Investigating code and evidence",
    ready: "Preparing findings",
    retrospective: "Learning from this investigation",
    parked: "Waiting for account capacity",
    done: "Investigation complete",
    failed: "Investigation needs attention",
  };
  return (
    <section className={`uh-run-progress ${failed ? "failed" : ""}`}>
      <span className="uh-run-symbol">
        {running && !parked ? (
          <Loader2 size={20} className="uh-spin" />
        ) : failed ? (
          <AlertTriangle size={20} />
        ) : (
          <CheckCircle2 size={20} />
        )}
      </span>
      <div>
        <strong>{phase[run.phase] || human(run.phase)}</strong>
        <p>
          {failed
            ? run.error
            : parked
              ? `Progress saved.${run.parkedUntil ? ` Resumes ${date(run.parkedUntil)}.` : " Waiting for capacity to become available."}`
              : !running && !run.findings
                ? run.emptyReason ||
                  (run.signalsCollected === 0
                    ? "No source data was available in this window. This is not a clean bill of health."
                    : "No finding met the evidence bar in the scope examined.")
                : `${run.signalsCollected ?? 0} signals examined · ${run.findings ?? 0} findings prepared`}
        </p>
        <span className="uh-subtle">
          {run.pipelineName} · Started {date(run.startedAt)}
        </span>
      </div>
      <Button onClick={() => go(run.findings ? "review" : "pipeline-live")}>
        {run.findings ? "Review findings" : "View progress"}
        <ArrowRight size={14} />
      </Button>
    </section>
  );
}

function Review({ cards, data, act, go }: any) {
  const [filter, setFilter] = useState(() =>
    new URLSearchParams(location.search).has("finding") ? "all" : "pending",
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.search).get("finding") || "",
  );
  const [tab, setTab] = useState("overview");
  const [receipt, setReceipt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismiss, setDismiss] = useState(false);
  const [reason, setReason] = useState("");
  const [mobileCase, setMobileCase] = useState(() =>
    new URLSearchParams(location.search).has("finding"),
  );
  const count = cards.filter(pendingCard).length;
  const shown = cards.filter(
    (c: any) =>
      (filter === "all" ||
        (filter === "pending"
          ? pendingCard(c)
          : findingState(c) === "Later")) &&
      `${c.title} ${c.finding.repo || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const card = cards.find((c: any) => c.finding.id === selected) || shown[0];
  const finding = card?.finding;
  const awaitingValidation = ["pending", "later"].includes(finding?.validation?.state);
  const choose = (id: string) => {
    if (busy) return;
    setSelected(id);
    setTab("overview");
    setReceipt("");
    setError("");
    setDismiss(false);
    setReason("");
    setMobileCase(true);
  };
  const decide = async (action: string) => {
    if (!finding) return;
    setBusy(true);
    setError("");
    try {
      const result = awaitingValidation ? await act(`/api/findings/${finding.id}/validate`, { action: action === "accept" ? "validate" : action, note: reason }) : action === "accept" ? await act(`/api/findings/${finding.id}/file`, {}) : await act(`/api/findings/${finding.id}/decision`, {
        action,
        reason,
        expectedRuling: card.decisionRevision ?? card.ruling?.id ?? 0,
      });
      setSelected(finding.id);
      setReceipt(awaitingValidation ? action === "accept" ? "Finding validated. It is now ready for a decision." : action === "later" ? "Validation deferred." : "Finding dismissed at validation." : result.message);
      setDismiss(false);
      setReason("");
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setError("");
    try {
      const result = await get(`/api/findings/${finding.id}`);
      const blob = new Blob(
        [`# ${result.issuePreview.title}\n\n${result.issuePreview.body}`],
        { type: "text/markdown" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${finding.id}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(err(e));
    }
  };
  return (
    <>
      <Heading
        action={<a className="uh-btn" href="/administration/claims">Open full cockpit <ArrowUpRight size={15} /></a>}
        title="Review"
      />
      <div className="uh-review-toolbar">
        <div className="uh-tabs">
          {[
            ["pending", "Needs decision", count],
            [
              "later",
              "Later",
              cards.filter((c: any) => findingState(c) === "Later").length,
            ],
            ["all", "All findings", cards.length],
          ].map(([id, label, total]) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              onClick={() => {
                setFilter(String(id));
                setSelected("");
                setReceipt("");
                setDismiss(false);
                setReason("");
                setError("");
              }}
            >
              {label}
              <span>{total}</span>
            </button>
          ))}
        </div>
        <label className="uh-search">
          <Search size={16} />
          <input
            aria-label="Search findings"
            placeholder="Search findings…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected("");
              setDismiss(false);
              setReason("");
              setReceipt("");
            }}
          />
        </label>
      </div>
      {!card ? (
        <div className="uh-panel">
          <Empty
            icon={ShieldCheck}
            title={
              query
                ? "No matching findings"
                : filter === "later"
                  ? "Nothing set aside"
                  : "No findings to review"
            }
            action={
              <Button kind="primary" onClick={() => go("projects")}>
                Open projects <ArrowRight size={15} />
              </Button>
            }
          >
            {query
              ? "Try a different search or filter."
              : "Run a pipeline to check for findings."}
          </Empty>
        </div>
      ) : (
        <div className={`uh-review-layout ${mobileCase ? "show-case" : ""}`}>
          <aside className="uh-queue">
            <div className="uh-queue-label">
              {shown.length} {shown.length === 1 ? "CASE" : "CASES"}
              <span>RECENT FIRST</span>
            </div>
            {shown.map((c: any) => (
              <button
                className={`uh-queue-card ${c.finding.id === finding.id ? "selected" : ""}`}
                key={c.finding.id}
                onClick={() => choose(c.finding.id)}
              >
                <div>
                  <Pill tone={c.finding.severity}>{c.finding.severity}</Pill>
                  <span>
                    {ago(c.finding.createdAt || c.finding.impact.lastSeen)}
                  </span>
                </div>
                <h3>{c.title}</h3>
                <p>
                  {c.finding.repo ||
                    data.pipelines.config.find(
                      (p: any) => p.id === c.pipelineId,
                    )?.name ||
                    "External finding"}
                </p>
                <div className="uh-queue-bottom">
                  <span>
                    <FileText size={12} />
                    {c.finding.evidence.length} evidence{" "}
                    {c.finding.evidence.length === 1 ? "item" : "items"}
                  </span>
                  <ArrowUpRight size={14} />
                </div>
              </button>
            ))}
            {!shown.length && (
              <p className="uh-queue-empty">No more cases in this view.</p>
            )}
            <div className="uh-queue-note">
              <ShieldCheck size={16} />
              <span>Every case keeps its evidence and decision history.</span>
            </div>
          </aside>
          <article className="uh-case">
            <button
              className="uh-case-back"
              onClick={() => setMobileCase(false)}
            >
              <ArrowLeft size={15} />
              Back to queue
            </button>
            <div className="uh-case-head">
              <div className="uh-case-meta">
                <span className="uh-case-id">{finding.id.toUpperCase()}</span>
                <Pill tone={card.ruling ? "neutral" : "lime"}>
                  {findingState(card)}
                </Pill>
                <span>{finding.repo || "Workspace"}</span>
              </div>
              <h2>{finding.title}</h2>
              <p>{finding.symptom}</p>
              <div className="uh-case-stats">
                <div>
                  <span>Severity</span>
                  <strong className={`text-${finding.severity}`}>
                    {finding.severity}
                  </strong>
                </div>
                <div>
                  <span>Observed impact</span>
                  <strong>
                    {finding.impact.usersAffected == null
                      ? "Not measured"
                      : `${finding.impact.usersAffected} users`}
                  </strong>
                </div>
                <div>
                  <span>Root-cause confidence</span>
                  <strong>{finding.confidence}</strong>
                </div>
              </div>
            </div>
            <div className="uh-tabs uh-case-tabs">
              {[
                ["overview", "Overview"],
                ["evidence", `Evidence · ${finding.evidence.length}`],
                ["history", "Decision history"],
              ].map(([id, title]) => (
                <button
                  key={id}
                  onClick={() => setTab(id!)}
                  className={tab === id ? "active" : ""}
                >
                  {title}
                </button>
              ))}
              <button
                className="uh-export"
                onClick={() => void download()}
                title="Download issue draft"
              >
                <ArrowDownToLine size={14} />
                Export issue
              </button>
            </div>
            <div className="uh-case-body">
              {tab !== "history" && (
                <div
                  className={`uh-verification ${finding.review?.verdict === "holds" ? "" : "unverified"}`}
                >
                  <ShieldCheck size={17} />
                  <div>
                    <strong>
                      {finding.review
                        ? finding.review.verdict === "holds"
                          ? "Evidence review passed"
                          : "Evidence review raised qualifications"
                        : "Independent evidence review not recorded"}
                    </strong>
                    <span>
                      {finding.review
                        ? "A separate review challenged this finding. Application tests have not been run."
                        : "Assess the attached evidence before accepting this claim."}
                    </span>
                  </div>
                </div>
              )}
              {tab === "overview" && (
                <>
                  <div className="uh-case-section">
                    <div className="uh-eyebrow">
                      <Code2 size={14} />
                      WHAT THE INVESTIGATION FOUND
                    </div>
                    <h3>{finding.rootCause.statement}</h3>
                    {finding.rootCause.codePointers?.map(
                      (p: any, i: number) => (
                        <div className="uh-code-pointer" key={i}>
                          <div>
                            <FileText size={14} />
                            <code>
                              {p.path}
                              {p.line ? `:${p.line}` : ""}
                            </code>
                            {safeUrl(p.url) && (
                              <a
                                href={safeUrl(p.url)}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${p.path}`}
                              >
                                <ExternalLink size={13} />
                              </a>
                            )}
                          </div>
                          {p.text && <pre>{p.text}</pre>}
                          {p.why && <p>{p.why}</p>}
                        </div>
                      ),
                    )}
                  </div>
                  <div className="uh-case-section">
                    <div className="uh-section-heading">
                      <div className="uh-eyebrow">
                        <FileText size={14} />
                        SUPPORTING EVIDENCE
                      </div>
                      <button
                        className="uh-link"
                        onClick={() => setTab("evidence")}
                      >
                        Inspect all <ArrowRight size={13} />
                      </button>
                    </div>
                    {finding.evidence.slice(0, 2).map((e: any) => (
                      <Evidence key={e.id} evidence={e} compact />
                    ))}
                    {!finding.evidence.length && (
                      <p className="uh-muted">
                        No source evidence was attached. Treat this as a
                        reported claim requiring investigation.
                      </p>
                    )}
                  </div>
                  {finding.suggestedFix && (
                    <div className="uh-recommendation-note">
                      <span>
                        <Sparkles size={17} />
                      </span>
                      <div>
                        <div className="uh-eyebrow">SUGGESTED DIRECTION</div>
                        <p>{finding.suggestedFix}</p>
                        <small>
                          Advice from the investigation. No code change has been
                          prepared.
                        </small>
                      </div>
                    </div>
                  )}
                  <div className="uh-case-section">
                    <div className="uh-eyebrow">
                      <AlertTriangle size={14} />
                      WHAT REMAINS UNCERTAIN
                    </div>
                    {finding.openQuestions.length ? (
                      <ul className="uh-questions">
                        {finding.openQuestions.map((q: string, i: number) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        {finding.runId === "external"
                          ? "This case was submitted by an external tool. Its claims have not been independently verified by this engine."
                          : "This read-only investigation does not establish that a proposed fix works. Application tests have not been executed."}
                      </p>
                    )}
                    {finding.reproduction.notEstablished && (
                      <p className="uh-muted">
                        Reproduction: {finding.reproduction.notEstablished}
                      </p>
                    )}
                  </div>
                </>
              )}
              {tab === "evidence" && (
                <>
                  <div className="uh-evidence-intro">
                    <ShieldCheck size={18} />
                    <p>
                      Source observations and code references. Follow the links
                      to assess what each item establishes.
                    </p>
                  </div>
                  {finding.evidence.map((e: any) => (
                    <Evidence key={e.id} evidence={e} />
                  ))}
                  {finding.review?.reasons?.length > 0 && (
                    <section className="uh-case-section">
                      <h3>Evidence reviewer’s assessment</h3>
                      <ul>
                        {finding.review.reasons.map((r: string, i: number) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {data.runs.find((r: any) => r.id === finding.runId)?.repos
                    ?.length > 0 && (
                    <section className="uh-case-section">
                      <h3>Code examined</h3>
                      {data.runs
                        .find((r: any) => r.id === finding.runId)
                        .repos.map((r: any) => (
                          <p key={r.name}>
                            {r.name} ·{" "}
                            <code>
                              {r.commit
                                ? r.commit.slice(0, 12)
                                : "Commit not recorded"}
                            </code>
                          </p>
                        ))}
                    </section>
                  )}
                  {finding.reproduction.steps && (
                    <section className="uh-case-section">
                      <h3>Reproduction described by the investigation</h3>
                      <ol>
                        {finding.reproduction.steps.map(
                          (s: string, i: number) => (
                            <li key={i}>{s}</li>
                          ),
                        )}
                      </ol>
                      <p className="uh-muted">
                        This recipe is not an executed test result.
                      </p>
                    </section>
                  )}
                  {finding.rootCause.ruledOut?.length > 0 && (
                    <section className="uh-case-section">
                      <h3>Alternative explanations considered</h3>
                      <ul>
                        {finding.rootCause.ruledOut.map(
                          (s: string, i: number) => (
                            <li key={i}>{s}</li>
                          ),
                        )}
                      </ul>
                    </section>
                  )}
                </>
              )}
              {tab === "history" && (
                <div className="uh-history">
                  {card.history.map((h: any, i: number) => (
                    <div key={i}>
                      <span>
                        <Check size={13} />
                      </span>
                      <div>
                        <strong>
                          {h.kind === "file" && !finding.filedIssue
                            ? "Accepted as a local finding"
                            : h.label}
                        </strong>
                        <p>
                          {h.reason ||
                            (h.kind === "file" && !finding.filedIssue
                              ? "No issue was published."
                              : "")}
                        </p>
                        <small>
                          {date(h.at)} ·{" "}
                          {h.by === "you" ? "You" : "Investigation"}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="uh-decision">
              <ErrorNote message={error} />
              {receipt ? (
                <>
                  <div className="uh-receipt" role="status">
                    <CheckCircle2 size={19} />
                    <p>{receipt}</p>
                  </div>
                  <div className="uh-decision-buttons">
                    <Button onClick={() => go("results")}>View results</Button>
                    <Button
                      kind="primary"
                      onClick={() => {
                        choose(
                          shown.find((c: any) => c.finding.id !== finding.id)
                            ?.finding.id || "",
                        );
                        setReceipt("");
                      }}
                    >
                      {shown.some((c: any) => c.finding.id !== finding.id)
                        ? "Next decision"
                        : "Back to queue"}
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                </>
              ) : card.ruling && card.ruling.ruling !== "park" ? (
                <div className="uh-decision-buttons">
                  <span className="uh-muted">
                    {findingState(card)} · {date(card.ruling.at)}
                  </span>
                  <Button disabled={busy} onClick={() => void decide("reopen")}>
                    Reopen finding
                  </Button>
                </div>
              ) : (
                <>
                  <div className="uh-decision-label">
                    <span className="uh-small-dot" />
                    YOUR DECISION
                  </div>
                  {dismiss ? (
                    <>
                      <Field
                        label="Why are you dismissing this finding?"
                        hint="Required. Your reason helps future investigations avoid the same mistake."
                      >
                        <textarea
                          autoFocus
                          maxLength={500}
                          rows={2}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="For example: this behavior is intentional because…"
                        />
                      </Field>
                      <div className="uh-decision-buttons">
                        <Button onClick={() => setDismiss(false)}>
                          Cancel
                        </Button>
                        <Button
                          kind="danger"
                          disabled={busy || !reason.trim()}
                          onClick={() => void decide("dismiss")}
                        >
                          Dismiss finding
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>
                        {awaitingValidation ? "Validate this finding before it proceeds to a decision." : data.cockpit.output?.repo ? `Accept using the configured issue workflow for ${data.cockpit.output.repo}. ${data.cockpit.output.dryRun ? "Dry run: the issue is previewed locally." : ""}` : "Accept this finding to keep it in Results. You can export an issue draft for your team."}
                      </p>
                      <div className="uh-decision-buttons">
                        <Button
                          kind="quiet"
                          onClick={() => setDismiss(true)}
                          disabled={busy}
                        >
                          Dismiss
                        </Button>
                        <Button
                          onClick={() => void decide("later")}
                          disabled={busy}
                        >
                          <Clock3 size={14} />
                          Review later
                        </Button>
                        <Button
                          kind="primary"
                          onClick={() => void decide("accept")}
                          disabled={busy}
                        >
                          {busy ? (
                            <Loader2 size={16} className="uh-spin" />
                          ) : (
                            <Check size={16} />
                          )}
                          {awaitingValidation ? "Validate finding" : data.cockpit.output?.repo ? "Accept & prepare issue" : "Accept finding"}
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </article>
        </div>
      )}
    </>
  );
}
function Evidence({ evidence: e, compact = false }: any) {
  const url = safeUrl(e.url);
  return (
    <div className={`uh-evidence ${compact ? "compact" : ""}`}>
      <div className="uh-evidence-head">
        <span>
          <span className="uh-evidence-id">{e.id}</span>
          {e.label || human(e.kind)}
        </span>
        <Pill>{e.sourcePluginId}</Pill>
      </div>
      <pre>
        {e.excerpt || "No excerpt attached. Inspect the source for context."}
      </pre>
      <div className="uh-evidence-foot">
        <span>Observed {date(e.observedAt)}</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            View source <ArrowUpRight size={13} />
          </a>
        ) : (
          <span>Local code reference</span>
        )}
      </div>
    </div>
  );
}

function Pipelines({ data, pipelines, act, go, settings, refresh }: any) {
  const [editing, setEditing] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const operate = async (id: string, action: string) => {
    setBusy(id);
    setError("");
    try {
      if (action === "run")
        await act("/api/runs", { pipelineId: id }, "Investigation requested.");
      else
        await act(
          `/api/pipelines/${id}`,
          { enabled: action === "resume" },
          action === "resume"
            ? "Schedule enabled."
            : "Schedule paused. Active investigations continue.",
        );
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy("");
    }
  };
  const recentRuns = data.runs.filter((r: any) =>
    pipelines.some((p: any) => p.id === r.pipelineId),
  );
  return (
    <>
      <Heading
        title="Pipelines"
        action={
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} />
            Add pipeline
          </Button>
        }
      />
      <ErrorNote message={error} />
      {!pipelines.length ? (
        <div className="uh-panel">
          <Empty
            icon={Layers3}
            title="No pipelines"
            action={
              <Button kind="primary" onClick={() => setAdding(true)}>
                Add pipeline <ArrowRight size={15} />
              </Button>
            }
          >
            Choose a template or create a custom pipeline.
          </Empty>
        </div>
      ) : (
        <div className="uh-pipeline-grid">
          {pipelines.map((p: any) => {
            const s = data.pipelines.pipelines.find((x: any) => x.id === p.id);
            return (
              <section className="uh-pipeline-card" key={p.id}>
                <div className="uh-pipeline-card-top">
                  <div
                    className={`uh-card-icon ${p.template === "bug-radar" ? "blue" : ""}`}
                  >
                    {p.template === "bug-radar" ? (
                      <Radar size={23} />
                    ) : (
                      <ShieldCheck size={23} />
                    )}
                  </div>
                  <Pill
                    tone={
                      s?.running ? "green" : s?.queued ? "amber" : "neutral"
                    }
                  >
                    {s?.running
                      ? s.lastRun?.phase === "parked"
                        ? "Waiting for capacity"
                        : "Investigating"
                      : s?.queued
                        ? "Queued"
                        : p.schedule === "manual" ? "Manual" : p.enabled ? "Scheduled" : "Paused"}
                  </Pill>
                </div>
                <h2>{p.name}</h2>
                <p>{p.description}</p>
                <div className="uh-pipeline-facts">
                  <div>
                    <FolderGit2 size={14} />
                    <span>
                      {p.repos?.join(", ") || "All connected repositories"}
                    </span>
                  </div>
                  <div>
                    <Activity size={14} />
                    <span>
                      {p.sources.includes("repos")
                        ? "Repository evidence"
                        : p.sources.join(", ")}
                    </span>
                  </div>
                  <div>
                    <Clock3 size={14} />
                    <span>
                      {p.enabled ? s?.scheduleText : "No recurring schedule"}
                      {p.timezone && p.enabled ? ` · ${p.timezone}` : ""}
                    </span>
                  </div>
                </div>
                <div className="uh-pipeline-stats">
                  <div>
                    <span>{s?.findings.total || 0}</span>findings
                  </div>
                  <div>
                    <span>{s?.lastRun ? ago(s.lastRun.startedAt) : "—"}</span>
                    last investigation
                  </div>
                </div>
                <div className="uh-pipeline-actions">
                  <Button onClick={() => setEditing(p)}>
                    <Settings2 size={14} />
                    Configure
                  </Button>
                  <button className="uh-icon-btn" aria-label={`Delete ${p.name}`} title="Delete pipeline" disabled={s?.running || busy === p.id} onClick={() => setDeleting(p)}><Trash2 size={15} /></button>
                  {(
                    <button
                      className="uh-icon-btn"
                      disabled={busy === p.id}
                      onClick={() =>
                        void operate(p.id, p.enabled ? "pause" : "resume")
                      }
                      title={p.enabled ? "Pause schedule" : "Resume schedule"}
                      aria-label={
                        p.enabled ? "Pause schedule" : "Resume schedule"
                      }
                    >
                      {p.enabled ? <Pause size={15} /> : <Play size={15} />}
                    </button>
                  )}
                  <Button
                    kind="primary"
                    onClick={() => void operate(p.id, "run")}
                    disabled={busy === p.id || s?.running || s?.queued}
                  >
                    {s?.running
                      ? "In progress"
                      : s?.queued
                        ? "Queued"
                        : "Run now"}
                    <Play size={13} />
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      {recentRuns.length > 0 && (
        <section className="uh-panel uh-runs">
          <div className="uh-section-heading">
            <div>
              <h2>Recent runs</h2>
            </div>
            <Pill>{recentRuns.length} recent</Pill>
          </div>
          {recentRuns.map((r: any) => (
            <button
              className="uh-run-row"
              key={r.id}
              onClick={() => setDetail(r)}
            >
              <span
                className={`uh-run-status ${r.phase === "failed" ? "bad" : ""}`}
              >
                {activeRun(r) ? (
                  <Loader2 size={17} className="uh-spin" />
                ) : r.phase === "failed" ? (
                  <AlertTriangle size={17} />
                ) : (
                  <CheckCircle2 size={17} />
                )}
              </span>
              <div>
                <strong>{r.pipelineName || r.pipelineId}</strong>
                <span>{date(r.startedAt)}</span>
              </div>
              <span>{r.signalsCollected} signals</span>
              <span>{r.findings} findings</span>
              <Pill tone={r.phase === "failed" ? "amber" : "neutral"}>
                {human(r.phase)}
              </Pill>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </section>
      )}
      {editing && (
        <PipelineEditor
          pipeline={editing}
          data={data}
          close={() => setEditing(null)}
          act={act}
          guidelines={() => {
            setEditing(null);
            settings("guidelines", editing.id);
          }}
        />
      )}
      {adding && <Modal title="Add pipeline" close={() => setAdding(false)} wide><AddPanel compact data={data.pipelines} onChanged={async () => { await refresh(); setAdding(false); }} /></Modal>}
      {deleting && <Modal title={`Delete ${deleting.name}?`} close={() => setDeleting(null)}><p>Its runs and findings remain in history. The engine archives its instruction versions.</p><ErrorNote message={error} /><div className="uh-modal-actions"><Button onClick={() => setDeleting(null)}>Cancel</Button><Button kind="danger" disabled={busy === deleting.id} onClick={async () => { setBusy(deleting.id); setError(""); try { await act(`/api/pipelines/${deleting.id}/delete`, {}, "Pipeline deleted. History preserved."); setDeleting(null); } catch (e) { setError(err(e)); } finally { setBusy(""); } }}>Delete pipeline</Button></div></Modal>}
      {detail && (
        <Modal title="Investigation detail" wide close={() => setDetail(null)}>
          <RunProgress
            run={data.runs.find((r: any) => r.id === detail.id) || detail}
            go={(p: Page) => {
              setDetail(null);
              go(p);
            }}
          />
          <div className="uh-history">
            {(
              data.runs.find((r: any) => r.id === detail.id) || detail
            ).phases.map((p: any, i: number) => (
              <div key={i}>
                <span>
                  <Check size={12} />
                </span>
                <div>
                  <strong>{human(p.phase || p.name)}</strong>
                  <p>{p.note || p.summary}</p>
                  <small>{date(p.startedAt || p.at)}</small>
                </div>
              </div>
            ))}
          </div>
          <details>
            <summary>Technical details</summary>
            <pre className="uh-raw">{JSON.stringify(detail, null, 2)}</pre>
          </details>
        </Modal>
      )}
    </>
  );
}
function PipelineEditor({ pipeline: p, data, close, act, guidelines }: any) {
  const [form, setForm] = useState(() => pipelineDraft(p));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }));
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(form.schedule);
  const mode = daily ? "daily" : form.schedule === "manual" ? "manual" : "custom";
  const scope = form.repos || data.workspace.projects.flatMap((x: any) => x.repos.map((r: any) => r.name));
  const availableSources = [{ id: "*", name: "All configured sources", configured: true }, ...data.pipelines.sources];
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const patch = pipelinePatch(p, form);
      if (Object.keys(patch).length) await act(`/api/pipelines/${p.id}`, patch, "Pipeline saved.");
      close();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  };
  return <Modal title="Configure pipeline" close={close} wide>
    <form onSubmit={save} data-pipeline-editor={p.id}>

      <div className="uh-form-grid">
        <Field label="Name"><input data-field="name" required maxLength={60} value={form.name} onChange={(e) => update("name", e.target.value)} /></Field>
        <Field label="Schedule enabled"><label className="uh-inline-check"><input type="checkbox" checked={form.enabled} onChange={(e) => update("enabled", e.target.checked)} />{form.enabled ? "Enabled" : "Paused"}</label></Field>
      </div>
      <Field label="Objective"><textarea rows={2} value={form.description} maxLength={500} onChange={(e) => update("description", e.target.value)} /></Field>
      <Field label="Repositories">
        <label className="uh-inline-check"><input type="checkbox" checked={form.repos === null} onChange={(e) => update("repos", e.target.checked ? null : [...scope])} />All repositories (including future additions)</label>
        <div className="uh-checkboxes">{data.workspace.projects.flatMap((x: any) => x.repos).map((r: any) => <label key={r.name}><input type="checkbox" disabled={form.repos === null} checked={scope.includes(r.name)} onChange={() => update("repos", scope.includes(r.name) ? scope.filter((name: string) => name !== r.name) : [...scope, r.name])} />{r.name}</label>)}</div>
      </Field>
      <div className="uh-form-grid">
        <Field label="Frequency"><select value={mode} onChange={(e) => update("schedule", e.target.value === "daily" ? "0 7 * * *" : e.target.value === "manual" ? "manual" : "every 6 hours")}><option value="daily">Every day</option><option value="manual">Manual only</option><option value="custom">Custom schedule</option></select></Field>
        {daily && <Field label="Time"><input type="time" required value={`${daily[2]!.padStart(2,"0")}:${daily[1]!.padStart(2,"0")}`} onChange={(e) => { const [h,m] = e.target.value.split(":"); update("schedule", `${Number(m)} ${Number(h)} * * *`); }} /></Field>}
        {mode === "custom" && <Field label="Schedule" hint="Every N hours or a five-field cron expression."><input required value={form.schedule} onChange={(e) => update("schedule", e.target.value)} /></Field>}

      </div>
      <details className="uh-advanced-settings">
        <summary>Advanced options</summary>
      <Field label="Evidence sources">
        <div className="uh-checkboxes">{availableSources.map((s: any) => <label key={s.id}><input type="checkbox" checked={form.sources.includes(s.id)} onChange={() => {
          const rest = form.sources.filter((id: string) => id !== s.id);
          update("sources", form.sources.includes(s.id) ? rest : s.id === "*" ? ["*", ...rest.filter((id: string) => id === "repos")] : [...rest.filter((id: string) => s.id === "repos" || id !== "*"), s.id]);
        }} />{s.name}{!s.configured && <small>Not connected</small>}</label>)}</div>
      </Field>
        <div className="uh-form-grid">
        <Field label="Timezone" hint={`Leave empty for the engine's local timezone (${data.workspace.timezone}).`}><input value={form.timezone} placeholder="Engine local timezone" onChange={(e) => update("timezone", e.target.value)} /></Field>
        <Field label="Maximum findings per pass"><input data-field="maxFindingsPerPass" type="number" min={1} max={20} required value={form.maxFindingsPerPass} onChange={(e) => update("maxFindingsPerPass", e.target.value)} /></Field>
        </div>
        <div className="uh-form-grid">
          <Field label="Lookback (hours)"><input data-field="lookbackHours" type="number" min={1} max={336} required value={form.lookbackHours} onChange={(e) => update("lookbackHours", e.target.value)} /></Field>
          <Field label="First pass lookback (hours)"><input type="number" min={1} max={336} required value={form.firstPassLookbackHours} onChange={(e) => update("firstPassLookbackHours", e.target.value)} /></Field>
          <Field label="Evidence items required"><input data-field="minEvidence" type="number" min={1} max={6} required value={form.minEvidence} onChange={(e) => update("minEvidence", e.target.value)} /></Field>
          <Field label="Validation gate"><select data-field="validationGate" value={form.validationGate} onChange={(e) => update("validationGate", e.target.value)}><option value="inherit">Use global feature setting</option><option value="on">Require human validation</option><option value="off">Go straight to Needs decision</option></select></Field>
        </div>
        <Field label="Signal types" hint={`Empty includes all types. Available: ${data.pipelines.signalTypes.join(", ")}`}><input data-field="signalTypes" value={form.signalTypes} onChange={(e) => update("signalTypes", e.target.value)} placeholder="All signal types" /></Field>
        <div className="uh-form-grid">{[["radar","Investigation model"],["review","Evidence review model"],["retrospective","Retrospective model"]].map(([key,label]) => <Field key={key} label={label!} hint="Leave empty to use the global model."><input value={form.models[key!] || ""} onChange={(e) => update("models", { ...form.models, [key!]: e.target.value })} placeholder="Inherit global model" /></Field>)}</div>
      </details>
      <div className="uh-editor-links"><button type="button" className="uh-link" onClick={guidelines}>Guidelines <ArrowUpRight size={14} /></button></div>
      <ErrorNote message={error} />
      <div className="uh-modal-actions"><Button onClick={close}>Cancel</Button><Button kind="primary" type="submit" disabled={busy || (form.repos !== null && !scope.length)}>{busy ? "Saving…" : "Save pipeline"}</Button></div>
    </form>
  </Modal>;
}

function Results({ cards, data, act, go }: any) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const accepted = cards.filter((c: any) => c.ruling?.ruling === "file");
  const dismissed = cards.filter((c: any) => c.ruling?.ruling === "dismiss");
  const settled = [...accepted, ...dismissed].sort((a, b) =>
    b.ruling.at.localeCompare(a.ruling.at),
  );
  return (
    <>
      <Heading title="Results" />
      <div className="uh-result-stats">
        <div>
          <span>
            <CheckCircle2 size={17} />
            Accepted findings
          </span>
          <strong>{accepted.length}</strong>
        </div>
        <div>
          <span>
            <ShieldCheck size={17} />
            Dismissed findings
          </span>
          <strong>{dismissed.length}</strong>
        </div>
        <div>
          <span>
            <Activity size={17} />
            Issues published
          </span>
          <strong>
            {cards.filter((c: any) => c.finding.filedIssue).length}
          </strong>
        </div>
      </div>
      <ErrorNote message={error} />
      <section className="uh-panel uh-results">
        <div className="uh-section-heading">
          <h2>Decision history</h2>
          <Pill>{settled.length} decisions</Pill>
        </div>
        {!settled.length ? (
          <Empty
            icon={Activity}
            title="No decisions yet"
            action={
              <Button onClick={() => go("review")}>
                Open Review <ArrowRight size={15} />
              </Button>
            }
          >
            Accepted and dismissed findings stay connected to their evidence.
          </Empty>
        ) : (
          settled.map((c: any) => (
            <div className="uh-result-row" key={c.finding.id}>
              <div
                className={`uh-result-icon ${c.ruling.ruling === "dismiss" ? "muted" : ""}`}
              >
                {c.ruling.ruling === "file" ? (
                  <Check size={19} />
                ) : (
                  <X size={19} />
                )}
              </div>
              <div>
                <strong>{c.title}</strong>
                <p>
                  {c.ruling.reason ||
                    "Accepted locally. Export the issue draft from Review when you are ready."}
                </p>
                <span>
                  {c.finding.repo || "Workspace"} · {date(c.ruling.at)}
                </span>
              </div>
              <Pill tone={c.ruling.ruling === "file" ? "green" : "neutral"}>
                {findingState(c)}
              </Pill>
              <Button onClick={() => go("review", undefined, c.finding.id)}>
                View case <ArrowUpRight size={14} />
              </Button>
              <Button
                disabled={busy === c.finding.id}
                onClick={async () => {
                  setBusy(c.finding.id);
                  setError("");
                  try {
                    await act(
                      `/api/findings/${c.finding.id}/decision`,
                      {
                        action: "reopen",
                        expectedRuling: c.decisionRevision ?? c.ruling.id,
                      },
                      "Finding returned to Review.",
                    );
                  } catch (e) {
                    setError(err(e));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Reopen
              </Button>
            </div>
          ))
        )}
      </section>

    </>
  );
}

const advancedSections = [
  ["guidelines", "Guidelines"],
  ["models", "Models"],
  ["runtime", "Usage limits & background service"],
  ["features", "Features"],
  ["grade", "Diagnostics"],
  ["file", "Config file"],
];

function Settings({ data, tab, setTab, act, pipelineId, setPipelineId }: any) {
  const [connecting, setConnecting] = useState<any>(null);
  const [account, setAccount] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [grade, setGrade] = useState<any>(null);
  const provider = data.workspace.provider;
  const advanced = advancedSections.find(([id]) => id === tab);
  useEffect(() => { if (tab === "grade") void get("/api/setup-grade").then(setGrade).catch((e) => setError(err(e))); }, [tab]);
  const checkAccount = async () => {
    setChecking(true); setError("");
    try { await act("/api/workspace/provider/check", {}); }
    catch (e) { setError(err(e)); }
    finally { setChecking(false); }
  };
  return (
    <>
      {advanced && <button className="uh-link uh-settings-back" onClick={() => setTab("connections")}><ArrowLeft size={15} /> Settings</button>}
      <Heading title={advanced?.[1] || "Settings"} />
      <ErrorNote message={error} />
      {!advanced && <div className="uh-simple-settings">
        <section aria-labelledby="account-heading" className="uh-setting-section">
          <h2 id="account-heading">AI account</h2>
          <div className="uh-setting-list">
            <div className="uh-setting-row">
              <div className="uh-setting-name"><strong>Claude Code</strong><span>Uses your local CLI login.</span></div>
              <span className={`uh-setting-status ${provider.authenticated ? "connected" : "attention"}`}><span className={`uh-dot ${provider.authenticated ? "" : "warn"}`} />{provider.authenticated ? "Connected" : provider.available ? "Sign-in required" : "Not installed"}</span>
              <Button onClick={() => { setError(""); setAccount(true); }}>{provider.authenticated ? "Details" : provider.available ? "Reconnect" : "Set up"}</Button>
            </div>
          </div>
        </section>
        <section aria-labelledby="sources-heading" className="uh-setting-section">
          <h2 id="sources-heading">Data sources</h2>
          <div className="uh-setting-list">
            {data.workspace.connections.filter((c: any) => c.supported).map((c: any) => <div className="uh-setting-row" key={c.id}>
              <span className={`uh-provider-logo ${c.id}`}>{c.name[0]}</span>
              <div className="uh-setting-name"><strong>{c.name}</strong><span>{c.id === "posthog" ? "Events and errors" : "Logs and errors"}{c.detectedIn.length ? ` · detected in ${c.detectedIn.join(", ")}` : ""}</span></div>
              <span className={`uh-setting-status ${c.configured && c.probe?.ok ? "connected" : ""}`}>{c.configured && c.probe?.ok ? "Connected" : c.configured ? "Check access" : "Not connected"}</span>
              <Button onClick={() => setConnecting(c)}>{c.configured ? "Manage" : "Connect"}</Button>
            </div>)}
          </div>
        </section>
        <details className="uh-settings-advanced">
          <summary>Advanced settings</summary>
          <div className="uh-settings-links">
            {advancedSections.map(([id, label]) => <button className="uh-link" key={id} onClick={() => setTab(id)}>{label}<ArrowRight size={14} /></button>)}
          </div>
          {data.workspace.connections.filter((c: any) => !c.supported).map((c: any) => <p className="uh-muted" key={c.id}>{c.name}: SDK detection only; data collection is not available.</p>)}
        </details>
      </div>}
      {tab === "guidelines" && <Guidelines data={data} act={act} pipelineId={pipelineId} setPipelineId={setPipelineId} />}
      {tab === "runtime" && <RuntimeSettings data={data} act={act} />}
      {tab === "models" && <Models act={act} provider={provider} />}
      {tab === "features" && <FeaturesPanel />}
      {tab === "grade" && <GradePanel grade={grade} />}
      {tab === "file" && <ConfigFile />}
      {connecting && <Connection connection={connecting} close={() => setConnecting(null)} act={act} />}
      {account && <Modal title="Claude Code" close={() => setAccount(false)}>
        <div className="uh-account-detail">
          <p>{provider.detail}</p>
          {!provider.authenticated && provider.command && <div className="uh-activation-command"><code>{provider.command}</code><Button onClick={() => navigator.clipboard.writeText(provider.command).catch(() => setError("Copy the command into your terminal."))}>Copy command</Button></div>}
          <dl><dt>CLI</dt><dd>{provider.cliVersion || "Not found"}</dd><dt>Login source</dt><dd>{provider.authMethod || "Local Claude login"}</dd>{provider.configDirectory && <><dt>Configuration</dt><dd><code>{provider.configDirectory}</code></dd></>}</dl>
          <ErrorNote message={error} />
          <div className="uh-modal-actions"><Button onClick={() => setAccount(false)}>Close</Button><Button kind="primary" onClick={() => void checkAccount()} disabled={checking}>{checking ? "Checking…" : "Check connection"}</Button></div>
        </div>
      </Modal>}
    </>
  );
}

function RuntimeSettings({ data, act }: any) {
  const [reserve, setReserve] = useState(data.workspace.reserve);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serviceRequested, setServiceRequested] = useState(false);
  return <div className="uh-simple-settings">
    <ErrorNote message={error} />
    <section className="uh-setting-section">
      <h2>Account usage</h2>
      <form className="uh-setting-list" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError("");
        try { await act("/api/workspace/preferences", { reserve }, "Usage limit saved."); }
        catch (e) { setError(err(e)); } finally { setBusy(false); }
      }}>
        <div className="uh-setting-row">
          <div className="uh-setting-name"><label htmlFor="capacity-reserve">Reserved for your work</label><span>The engine pauses before using this part of your quota.</span></div>
          <div className="uh-setting-number"><input id="capacity-reserve" type="number" min={0} max={90} step={5} value={reserve} onChange={(event) => setReserve(Number(event.target.value))} required /><span>%</span></div>
          <Button type="submit" disabled={busy || reserve === data.workspace.reserve}>Save</Button>
        </div>
        <div className="uh-setting-row"><span className="uh-setting-name">Current usage</span><span>{data.status.window?.usedPct == null ? "Unavailable" : `${Math.round(data.status.window.usedPct)}%`}</span><a className="uh-link" href="/usage">Usage details <ArrowUpRight size={14} /></a></div>
      </form>
    </section>
    <section className="uh-setting-section">
      <h2>Background service</h2>
      <div className="uh-setting-list"><div className="uh-setting-row">
        <div className="uh-setting-name"><strong>Start at login</strong><span>{data.workspace.service.installed ? "Installed" : serviceRequested ? "Installing…" : "Not installed"}</span></div>
        <Button disabled={busy || serviceRequested || data.workspace.service.installed} onClick={async () => {
          setBusy(true); setError("");
          try { await act("/api/workspace/service"); setServiceRequested(true); }
          catch (e) { setError(err(e)); } finally { setBusy(false); }
        }}>{data.workspace.service.installed ? "Enabled" : "Enable"}</Button>
      </div></div>
      {serviceRequested && !data.workspace.service.installed && <p className="uh-muted">Installation log: <code>logs/service-install.log</code></p>}
    </section>
  </div>;
}
function Connection({ connection: c, close, act }: any) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(c.fields.map((f: any) => [f.key, f.value])),
  );
  const [projectId, setProjectId] = useState(c.savedOptions.projectId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Connect ${c.name}`} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await act(
              `/api/workspace/connections/${c.id}`,
              { credentials: values, options: projectId ? { projectId } : {} },
              `${c.name} connected and verified.`,
            );
            close();
          } catch (e) {
            setError(err(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="uh-modal-intro">
          Access is checked before saving.
        </p>
        {c.probe && <details className="uh-connection-check"><summary>Last connection check · {date(c.probe.at)}</summary><p>{c.probe.summary}</p></details>}
        {c.fields.map((f: any) => (
          <Field key={f.key} label={f.label} hint={f.helpText}>
            <input
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              required={!f.optional && !c.configured && !f.default}
              placeholder={
                f.secret && c.configured
                  ? "Leave empty to keep the saved value"
                  : f.default || ""
              }
              value={values[f.key] || ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
            {f.secret && (
              <a
                className="uh-link"
                href={safeUrl(f.helpUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Get a read-only key <ExternalLink size={11} />
              </a>
            )}
          </Field>
        ))}
        {c.id === "posthog" && (
          <Field
            label="PostHog project ID"
            hint="Required when your key can access multiple projects."
          >
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="For example: 12345"
            />
          </Field>
        )}
        <details>
          <summary>Required read-only scopes</summary>
          <p className="uh-scopes">{c.scopes.join(" · ")}</p>
        </details>
        <ErrorNote message={error} />
        <div className="uh-modal-actions">
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy}>
            {busy ? (
              <>
                <Loader2 size={15} className="uh-spin" />
                Verifying access…
              </>
            ) : (
              "Verify & connect"
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function Guidelines({ data, act, pipelineId, setPipelineId }: any) {
  const pipeline = data.pipelines.config.some((p: any) => p.id === pipelineId)
    ? pipelineId
    : data.pipelines.config[0]?.id || "";
  const request = useRef(0);
  const [instructions, setInstructions] = useState<any>(null);
  const [brief, setBrief] = useState("mission");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const current = ++request.current;
    if (pipeline) {
      try {
        const result = await get(
          `/api/instructions?pipeline=${encodeURIComponent(pipeline)}`,
        );
        if (current === request.current) {
          setInstructions(result);
          setError("");
        }
      } catch (e) {
        if (current === request.current) setError(err(e));
      }
    }
  }, [pipeline]);
  useEffect(() => {
    setInstructions(null);
    void load();
    return () => {
      request.current++;
    };
  }, [load, data.cockpit.instructionsVersions[pipeline]]);
  const labels: Record<string, string> = {
    mission: "Priorities",
    scope: "Boundaries",
    collector: "Investigation checklist",
    admission: "What deserves attention",
    gate: "Review standards",
  };
  const [history, setHistory] = useState(false);
  if (!pipeline)
    return (
      <div className="uh-panel">
        <Empty icon={FileText} title="No pipeline selected">
          Add a pipeline to edit its guidelines.
        </Empty>
      </div>
    );
  return (
    <>
      <div className="uh-guideline-top">
        <Field label="Pipeline">
          <select
            value={pipeline}
            onChange={(e) => setPipelineId(e.target.value)}
          >
            {data.pipelines.config.map((p: any) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Button onClick={() => setHistory(!history)}>
          <Clock3 size={14} />
          {history ? "Back to editor" : "Version history"}
        </Button>
      </div>
      <ErrorNote message={error} />
      {instructions?.pipeline.id === pipeline && !history && (
        <div className="uh-guideline-layout">
          <aside>
            {Object.entries(labels).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setBrief(id)}
                className={brief === id ? "active" : ""}
              >
                {label}
                <ArrowRight size={13} />
              </button>
            ))}
          </aside>
          <GuidelineEditor
            key={`${pipeline}/${brief}`}
            pipeline={pipeline}
            brief={instructions.briefs.find((b: any) => b.id === brief)}
            version={instructions.version}
            title={labels[brief]!}
            saved={load}
            act={act}
          />
        </div>
      )}
      {instructions?.pipeline.id === pipeline &&
        !history &&
        data.cockpit.proposals
          .filter(
            (p: any) =>
              p.pipelineId === pipeline &&
              ["pending", "parked"].includes(p.status),
          )
          .map((p: any) => (
            <GuidelineSuggestion
              key={p.id}
              proposal={p}
              version={instructions.version}
              act={act}
              saved={load}
            />
          ))}
      {instructions && history && (
        <div className="uh-panel uh-history">
          {instructions.versions.map((v: any) => (
            <div key={v.version}>
              <span>
                <Check size={12} />
              </span>
              <div>
                <strong>
                  Version {v.version} · {v.note}
                </strong>
                <small>
                  {date(v.at)} · {v.by}
                </small>
                {v.version !== instructions.version && (
                  <Button
                    onClick={async () => {
                      try {
                        await act(
                          "/api/instructions/revert",
                          {
                            pipelineId: pipeline,
                            version: v.version,
                            expectedVersion: instructions.version,
                          },
                          `Restored version ${v.version} as a new version.`,
                        );
                        await load();
                      } catch (e) {
                        setError(err(e));
                      }
                    }}
                  >
                    Restore this version
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
function GuidelineSuggestion({ proposal: p, version, act, saved }: any) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (ruling: string) => {
    setBusy(true);
    setError("");
    try {
      await act(
        `/api/proposals/${p.id}/rule`,
        { ruling, reason, expectedVersion: p.baseVersion },
        ruling === "apply"
          ? "Suggested guideline change applied as a new version."
          : ruling === "park"
            ? "Suggestion saved for later."
            : "Suggestion declined with your feedback.",
      );
      await saved();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="uh-panel uh-suggestion">
      <div className="uh-section-heading">
        <div>
          <div className="uh-eyebrow">SUGGESTED GUIDELINE UPDATE</div>
          <h3>{p.title}</h3>
        </div>
        <Pill>{p.status === "parked" ? "Later" : "Needs your review"}</Pill>
      </div>
      <p>{p.gap}</p>
      <details>
        <summary>Review evidence and proposed change</summary>
        <ul>
          {p.evidence.map((e: any, i: number) => (
            <li key={i}>
              {e.label}: {e.what}
            </li>
          ))}
        </ul>
        <pre className="uh-diff">
          {p.diff.map((line: any, i: number) => (
            <span key={i} className={line.op === "+" ? "added" : "removed"}>
              {line.op} {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
        <p>{p.expectedEffect}</p>
        <Field label="Feedback" hint="Required when declining a suggestion.">
          <input
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorNote message={error} />
        {version !== p.baseVersion && (
          <p className="uh-muted">
            The guidelines have changed since this suggestion was prepared. Use
            the editor to reconcile this suggestion with the latest version.
          </p>
        )}
        <div className="uh-modal-actions">
          <Button
            disabled={busy || !reason.trim()}
            onClick={() => void decide("reject")}
          >
            Decline
          </Button>
          <Button
            disabled={busy || p.status === "parked"}
            onClick={() => void decide("park")}
          >
            Later
          </Button>
          <Button
            kind="primary"
            disabled={busy || version !== p.baseVersion}
            onClick={() => void decide("apply")}
          >
            Apply guideline change
          </Button>
        </div>
      </details>
    </section>
  );
}
function GuidelineEditor({ pipeline, brief, version, title, saved, act }: any) {
  const key = `uh.draft.${pipeline}.${brief.id}`;
  const readDraft = () => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const initial = useRef(readDraft());
  const [text, setText] = useState(initial.current?.text ?? brief.text);
  const [note, setNote] = useState(initial.current?.note ?? "");
  const [baseVersion, setBaseVersion] = useState(
    initial.current?.version ?? version,
  );
  const [diff, setDiff] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = text !== brief.text;
  const previousText = useRef(brief.text);
  useEffect(() => {
    if (text === previousText.current) {
      setText(brief.text);
      setBaseVersion(version);
    }
    previousText.current = brief.text;
  }, [brief.text, version]);
  useEffect(() => {
    try {
      if (dirty)
        sessionStorage.setItem(
          key,
          JSON.stringify({ text, note, version: baseVersion }),
        );
      else sessionStorage.removeItem(key);
    } catch {
      /* Editing still works when session storage is unavailable. */
    }
  }, [key, text, note, dirty, baseVersion]);
  const check = async () => {
    setError("");
    try {
      setDiff(
        await post("/api/instructions/diff", {
          pipelineId: pipeline,
          brief: brief.id,
          text,
        }),
      );
    } catch (e) {
      setError(err(e));
    }
  };
  return (
    <section className="uh-panel uh-guideline-editor">
      <div className="uh-section-heading">
        <h2>{title}</h2>
        <Pill>Version {version}</Pill>
      </div>
      <p>
        Guide what this pipeline looks for and how it judges evidence. Changes
        apply to its next investigation.
      </p>
      <textarea
        aria-label={`${title} guidelines`}
        spellCheck={false}
        rows={15}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDiff(null);
        }}
      />
      {dirty && (
        <div className="uh-draft-note">
          <span className="uh-small-dot" />
          Draft saved in this browser tab. You can switch sections.
        </div>
      )}
      {baseVersion !== version && dirty && (
        <div className="uh-error">
          A newer version exists. Your draft is preserved. Compare it with the
          current version before saving.
          <Button
            onClick={() => {
              setBaseVersion(version);
              void check();
            }}
          >
            Compare with latest
          </Button>
        </div>
      )}
      {diff && (
        <>
          <pre className="uh-diff">
            {diff.diff.map((line: any, i: number) => (
              <span
                key={i}
                className={
                  line.op === "+" ? "added" : line.op === "-" ? "removed" : ""
                }
              >
                {line.op} {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
          <Field
            label="What changes, and why?"
            hint="Required for the version history."
          >
            <input
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Explain the intent of this change"
            />
          </Field>
          <ErrorNote message={diff.error || ""} />
        </>
      )}
      <ErrorNote message={error} />
      {dirty && (
        <div className="uh-modal-actions">
          <Button
            onClick={() => {
              setText(brief.text);
              setNote("");
              setDiff(null);
              setBaseVersion(version);
            }}
          >
            Discard draft
          </Button>
          {!diff ? (
            <Button onClick={() => void check()}>Review changes</Button>
          ) : (
            <Button
              kind="primary"
              disabled={
                busy || !note.trim() || !!diff.error || baseVersion !== version
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await act(
                    "/api/instructions",
                    {
                      pipelineId: pipeline,
                      brief: brief.id,
                      text,
                      note,
                      expectedVersion: baseVersion,
                    },
                    "Guidelines saved. The next investigation will use this version.",
                  );
                  sessionStorage.removeItem(key);
                  setDiff(null);
                  setNote("");
                  setBaseVersion(version + 1);
                  await saved();
                } catch (e) {
                  setError(err(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving…" : "Save guidelines"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
function Models({ act, provider }: any) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    void get("/api/models")
      .then(setData)
      .catch((e) => setError(err(e)));
  }, []);
  return (
    <div className="uh-panel uh-models">
      <div className="uh-section-heading">
        <div>
          <h2>{provider.label}</h2>
          <p>{provider.detail}</p>
        </div>
        <Pill tone={provider.authenticated ? "green" : "amber"}>
          {provider.authenticated ? "Signed in" : provider.reason === "expired" ? "Reconnect needed" : provider.available ? "Sign-in needed" : "Install needed"}
        </Pill>
      </div>
      {!provider.authenticated && (
        <p>
          Run <code>{provider.command || "claude auth login"}</code> in your terminal, then return to your project’s activation checklist.
        </p>
      )}
      <ErrorNote message={error} />
      {data?.stages
        .map((s: any) => (
          <div className="uh-model-row" key={s.id}>
            <div>
              <strong>
                {s.label
                  .replace("Adversarial review", "Evidence review")
                  .replace(
                    "Retrospective (teach proposals)",
                    "Investigation retrospective",
                  )}
              </strong>
              {!s.used && <small className="uh-muted">Configured for a stage not run by this build yet</small>}
              <span>
                {s.id === "radar"
                  ? "Investigates the problem and its cause"
                  : s.id === "review"
                    ? "Challenges the proposed finding"
                    : s.id === "chat"
                      ? "Helps you manage the workspace"
                      : s.id === "retrospective" ? "Suggests improvements to guidelines" : "Saved model for this stage"}
              </span>
            </div>
            <select
              aria-label={`${s.label} model`}
              value={data.models[s.id]}
              disabled={busy === s.id}
              onChange={async (e) => {
                setBusy(s.id);
                try {
                  const r = await act(
                    "/api/config/models",
                    { [s.id]: e.target.value },
                    "Model preference saved.",
                  );
                  setData({ ...data, models: r.models });
                } catch (e) {
                  setError(err(e));
                } finally {
                  setBusy("");
                }
              }}
            >
              {[
                ...new Set([
                  data.models[s.id],
                  ...data.choices.map((c: any) => c.id),
                ]),
              ].map((id: any) => (
                <option value={id} key={id}>
                  {data.choices.find((c: any) => c.id === id)?.label || id}
                </option>
              ))}
            </select>
          </div>
        ))}
    </div>
  );
}
function Chat({ close, context }: { close: () => void; context: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      get("/api/chat")
        .then((r) => {
          if (active) {
            setMessages(r.messages);
            setBusy(!!r.busy);
          }
        })
        .catch((e) => {
          if (active) setError(err(e));
        });
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  return (
    <Modal title="Chat" close={close} wide>
      <a className="uh-link" href="/chat">Open full chat with attachments <ArrowUpRight size={14} /></a>
      <div className="uh-chat-context">
        <FolderGit2 size={14} />
        {context}
      </div>
      <div className="uh-chat-messages">
        {!messages.length && (
          <Empty icon={MessageSquare} title="No messages yet">
            Ask about a finding, pipeline, or project.
          </Empty>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`uh-chat-message ${m.role}`}>
            <strong>{m.role === "user" ? "You" : "Assistant"}</strong>
            <p>{m.text.replace(/^\[Workspace context:.*\]\n/, "")}</p>
            <small>{date(m.ts)}</small>
          </div>
        ))}
        {busy && (
          <div className="uh-chat-thinking">
            <Loader2 size={14} className="uh-spin" />
            Working on your question…
          </div>
        )}
        <div ref={end} />
      </div>
      <ErrorNote message={error} />
      <form
        className="uh-chat-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          setError("");
          const draft = text;
          try {
            await post("/api/chat", {
              text: `[Workspace context: ${context}]\n${draft}`,
            });
            setText("");
          } catch (e) {
            setError(err(e));
            setBusy(false);
          }
        }}
      >
        <input
          aria-label="Message your assistant"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about your project…"
        />
        <Button kind="primary" type="submit" disabled={busy || !text.trim()}>
          <ArrowRight size={17} />
        </Button>
      </form>
    </Modal>
  );
}

export function mount(root: HTMLElement) {
  createRoot(root).render(<Workspace />);
}
