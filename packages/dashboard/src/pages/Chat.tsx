import { useEffect, useRef, useState } from "react";
import { ChatModelPicker } from "../ChatModelPicker";
import { ImagePlus, Loader2, ArrowUp, ArrowUpRight, Cable, Check, CheckCircle2, AlertTriangle, Terminal, X } from "lucide-react";
import { RUN_STEPS, ago, duration, isActive, runNow, runOutcome, runStepIndex } from "../run-story";
import { get, post } from "../api";
import { time } from "../fmt";
import { Markdown } from "../Markdown";
import { HumanMark } from "../Identity";
import { SourceConnection, type ConnectionRequest } from "../SourceConnection";

// Bridge conventions (see core/src/chat/files.ts): attachments are "[user sent a photo, saved at /path]" lines, agent files are [[send:/path]] tags.
const SENT_NOTE = /^\[user sent an? ([a-z ]+), saved at (\/.+)\]$/;
const SEND_TAG = /\[\[send:([^\]]+)\]\]/g;
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const fileUrl = (p: string) => `/api/chat/file?path=${encodeURIComponent(p)}`;
/** Same text the engine stores as the opening message; shown at once so the screen never waits for it. */
const FIRST_QUESTION = "Which project do you want to start with?";
const KICKOFF = /^Help me (set up ultimatehuman|manage this workspace)\.$/;
const cliName = (provider?: string) => provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : "";
/** "claude-opus-5-5" → "Opus 5.5"; other ids use the CLI's own label when known. */
function modelName(id: string | undefined, labels: Record<string, string>): string {
  if (!id) return "";
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(id);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  return labels[id] || id.replace(/^gpt-/i, "GPT-");
}

/** Splits a stored message into the text to show and the files it carries. */
function parts(m: { role: string; text: string }): { text: string; files: string[] } {
  if (m.role === "assistant") {
    const files = [...m.text.matchAll(SEND_TAG)].map((x) => x[1]!.trim());
    return { text: m.text.replace(SEND_TAG, "").replace(/\n{3,}/g, "\n\n").trim(), files };
  }
  const files: string[] = [];
  const text = m.text
    .split("\n")
    .filter((l) => {
      const x = SENT_NOTE.exec(l.trim());
      if (x) files.push(x[2]!);
      return !x;
    })
    .join("\n")
    .trim();
  return { text, files };
}

function Attachment({ path, open }: { path: string; open: (p: string) => void }) {
  const [broken, setBroken] = useState(false);
  const name = path.split("/").pop();
  if (!IMAGE.test(path) || broken)
    return (
      <span className="chat-file" title={path}>
        {broken ? "Unavailable: " : "File: "}
        {name}
      </span>
    );
  return (
    <button type="button" className="chat-thumb" onClick={() => open(path)} title={path} data-chat-image>
      <img src={fileUrl(path)} alt={name} onError={() => setBroken(true)} />
    </button>
  );
}

/** The pipeline run Claude started, live in the conversation: what it is doing now, then what it found. */
function RunCard({ run }: { run: any }) {
  const [now, setNow] = useState(Date.now());
  const active = isActive(run);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), active ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [active]);
  const current = runStepIndex(run);
  const outcome = active ? null : runOutcome(run);
  return <div className="chat-run-card" data-chat-run={active ? "running" : run.phase}>
    {active ? <Loader2 size={19} className="uh-spin" /> : run.phase === "failed" ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}
    <div>
      <strong>{run.pipelineName}</strong><span>{active ? ` · running for ${duration(run.startedAt, now)}` : ` · finished ${ago(run.finishedAt, now)}, took ${duration(run.startedAt, run.finishedAt)}`}</span>
      <p>{active ? runNow(run, run.pipelineSources) : `${outcome!.read} ${outcome!.result}`}</p>
      <ol aria-label="Progress">{RUN_STEPS.map((label, i) => <li key={label} title={label} data-state={i < current ? "done" : i === current ? "current" : "next"} />)}</ol>
    </div>
    <a className="uh-btn" href={!active && run.findings ? "/review" : `/pipeline-live#run-${run.id}`}>{active ? "Watch live" : run.findings ? "Open Review" : "See what happened"} <ArrowUpRight size={14} /></a>
  </div>;
}

const toBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

/** The setup chat: the same conversation as `ultimatehuman chat` and the Telegram bot. Polls the engine; one turn runs at a time. */
export function ChatPage({ disabled = false, initialPrompt = "", configured = false, projectNames = [] }: { disabled?: boolean; initialPrompt?: string; configured?: boolean; projectNames?: string[] } = {}) {
  const [msgs, setMsgs] = useState<any[]>([]);
  const [busy, setBusy] = useState(0);
  const cleanDraft = (s: string) => s.replace(/\bphx_[A-Za-z0-9]+\b/g, "");
  const [text, setText] = useState(() => cleanDraft(initialPrompt || sessionStorage.getItem("uh.chat.draft") || ""));
  useEffect(() => { const url = new URL(location.href); if (url.searchParams.has("message")) { url.searchParams.delete("message"); history.replaceState(null, "", url); } }, []);
  const [activity, setActivity] = useState("");
  const sendingRef = useRef(false);
  // An unsent draft is kept across page switches, but never a key pasted into it.
  useEffect(() => { sessionStorage.setItem("uh.chat.draft", cleanDraft(text).replace(/\bddapp_[A-Za-z0-9]+\b|(?<![0-9a-f-])[0-9a-f]{32}(?:[0-9a-f]{8})?(?![0-9a-f-])/gi, "")); }, [text]);
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [connection, setConnection] = useState<ConnectionRequest | null>(null);
  const [connectionKey, setConnectionKey] = useState("");
  const [permissions, setPermissions] = useState<any[]>([]);
  const [run, setRun] = useState<any>(null);
  const [deciding, setDeciding] = useState("");
  const [accountKind, setAccountKind] = useState("subscription");
  const [provider, setProvider] = useState("claude");
  const agentName = cliName(provider);
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  const [model, setModel] = useState("claude-opus-5-5");
  const seenRequests = useRef(new Set<string>());
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [drag, setDrag] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const last = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const visibleMessages = msgs.filter((m) => !(m.role === "user" && KICKOFF.test(m.text)));
  // Until the user answers, a fresh workspace shows one thing: the question.
  const intro = !visibleMessages.some((m) => m.role === "user");
  const opening = visibleMessages.length === 1 && visibleMessages[0].role === "assistant" ? visibleMessages[0].text.trim() : "";
  const question = intro && !configured && (!visibleMessages.length || (opening.length <= 140 && !opening.includes("\n"))) ? opening || FIRST_QUESTION : "";

  const load = async () => {
    const r = await get("/api/chat");
    setMsgs(r.messages);
    setBusy(r.busy);
    setActivity(r.activity || `${cliName(r.provider) || "Claude Code"} is working…`);
    setRequests(r.connections || []);
    setPermissions(r.permissions || []);
    setRun(r.run || null);
    setAccountKind(r.accountKind || "subscription");
    setProvider(r.provider || "claude");
    setModel(r.model ?? "claude-opus-5-5");
  };
  const openConnection = (request: ConnectionRequest, key = "") => {
    seenRequests.current.add(request.id);
    sessionStorage.setItem(`uh.connection.seen.${request.id}`, "1");
    setConnectionKey(key); setConnection(request);
  };
  const closeConnection = () => { setConnection(null); setConnectionKey(""); composer.current?.focus(); };
  useEffect(() => {
    if (connection) return;
    const next = requests.find((r) => r.status === "pending" && !seenRequests.current.has(r.id) && !sessionStorage.getItem(`uh.connection.seen.${r.id}`));
    if (next) openConnection(next);
  }, [requests, connection]);
  const changeText = (value: string) => {
    const key = value.match(/\bphx_[A-Za-z0-9]{16,}\b/)?.[0];
    setText(cleanDraft(value));
    if (key) void post("/api/chat/connections/request", { source: "posthog" }).then((r) => openConnection(r.request, key)).catch((e) => setErr(e.message));
  };
  const decide = async (id: string, allow: boolean) => {
    setDeciding(id); setErr("");
    try { await post(`/api/chat/permissions/${id}`, { allow }); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setDeciding(""); }
  };
  useEffect(() => {
    void load().catch((e) => setErr(e.message));
    const t = setInterval(() => void load().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const id = msgs[msgs.length - 1]?.id ?? 0;
    if (!intro && id !== last.current) end.current?.scrollIntoView({ block: "end" });
    last.current = id;
  }, [msgs]);
  useEffect(() => {
    if (busy && !intro) end.current?.scrollIntoView({ block: "end" });
  }, [busy, permissions.length, requests.length]);
  // A run Claude just started appears under its reply: bring it into view.
  useEffect(() => { if (run?.id && !intro) end.current?.scrollIntoView({ block: "end" }); }, [run?.id]);

  const attach = (list: FileList | File[] | null) => {
    const imgs = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setFiles((cur) => [...cur, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 4));
  };

  const send = async () => {
    const t = text.trim();
    if (disabled || sendingRef.current || (!t && !files.length)) return;
    sendingRef.current = true;
    setErr("");
    const sending = files;
    setText("");
    setFiles([]);
    try {
      const payload = await Promise.all(sending.map(async ({ file }) => ({ name: file.name || "pasted.png", data: await toBase64(file) })));
      await post("/api/chat", { text: t, files: payload });
      sending.forEach((f) => URL.revokeObjectURL(f.url));
      await load();
    } catch (e) {
      setErr((e as Error).message);
      setText(t);
      setFiles(sending);
    } finally { sendingRef.current = false; }
  };

  return (
    <div
      className={`chat-full${intro ? " chat-intro-mode" : ""}${drag ? " dragging" : ""}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        attach(e.dataTransfer.files);
      }}
    >
      <div className="chat-log" data-chat-log>
        <div className="chat-col">
          {question ? <div className="chat-welcome chat-question"><HumanMark /><h2 data-first-question>{question}</h2></div>
            : intro && configured && <div className="chat-welcome"><HumanMark /><h2>What’s next?</h2><p>{projectNames.join(" · ")}</p></div>}
          {(question ? [] : visibleMessages).map((m) => {
            const p = parts(m);
            const files = p.files.length > 0 && (
              <div className="chat-files">
                {p.files.map((f, i) => (
                  <Attachment key={i} path={f} open={setFull} />
                ))}
              </div>
            );
            return (
              <div key={m.id} className={`chat-msg ${m.role}`} data-chat-msg={m.role} data-source={m.source}>
                <div className="chat-meta">
                  {m.role === "assistant" && <HumanMark className="chat-avatar" />}<strong data-chat-author>{m.role === "user" ? "You" : m.provider ? [cliName(m.provider), modelName(m.model, modelLabels)].filter(Boolean).join(" · ") : "ultimatehuman"}</strong><span className="chat-message-time">{time(m.ts)}</span>{m.role === "user" && m.source !== "dashboard" && <span className="pill" data-source-tag>{m.source === "cli" ? "Terminal" : "Telegram"}</span>}
                </div>
                {/* Like Telegram: your photo above its caption; the agent's files after its text. */}
                {m.role === "user" && files}
                {p.text && <div className="chat-bubble">{m.role === "assistant" ? <Markdown text={p.text} /> : p.text}</div>}
                {m.role === "assistant" && files}
              </div>
            );
          })}
          {run && !question && <RunCard run={run} />}
          {requests.filter((r) => r.status === "pending").map((r) => <div className="chat-action-card" key={r.id} data-connection-request={r.source}>
            <Cable size={20} /><div><strong>Connect {r.source === "posthog" ? "PostHog" : "Datadog"}</strong><p>{r.lastAttempt ? r.missing?.length ? `Still needed: ${r.missing.join(" and ")}. The rest is saved.` : "Those keys did not pass the access check. Enter the corrected ones here." : `Use your existing ${r.source === "posthog" ? "events and errors" : "error logs"}${r.project ? ` for ${r.project}` : ""}.`}</p></div><button className="uh-btn primary" onClick={() => openConnection(r)}>{r.lastAttempt ? r.missing?.length ? `Add ${r.missing[0]}` : "Enter keys" : "Connect"} <ArrowUpRight size={14} /></button>
          </div>)}
          {permissions.map((p) => <div className="chat-permission" key={p.id} data-chat-permission={p.tool}>
            <div><Terminal size={17} /><strong>{p.tool === "Bash" ? "Run this command?" : `Allow ${agentName} to ${p.tool === "Edit" ? "edit this file" : p.tool === "Write" ? "write this file" : "use " + p.tool}?`}</strong></div>
            {p.input.description && <p>{p.input.description}</p>}
            <pre>{p.tool === "Bash" ? p.input.command : p.input.file_path || p.input.path || JSON.stringify(p.input, null, 2)}</pre>
            {(p.input.new_string !== undefined || p.input.content !== undefined) && <details><summary>View change</summary>{p.input.old_string && <pre className="permission-before">{p.input.old_string}</pre>}<pre>{p.input.new_string ?? p.input.content}</pre></details>}
            <div className="chat-permission-actions"><button className="uh-btn" disabled={deciding === p.id} onClick={() => void decide(p.id, false)}>Decline</button><button className="uh-btn primary" disabled={deciding === p.id} onClick={() => void decide(p.id, true)}>{deciding === p.id ? "Continuing…" : p.tool === "Bash" ? "Run command" : "Allow"}</button></div>
          </div>)}
          {busy > 0 && (
            <div className="chat-msg assistant" data-chat-busy>
              <div className="chat-bubble chat-busy">
                <Loader2 size={14} className="uh-spin" /> {activity}{busy > 1 ? ` · ${busy - 1} queued` : ""}
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="chat-col">
          {files.length > 0 && (
            <div className="chat-pending" data-chat-pending>
              {files.map((f, i) => (
                <span key={f.url} className="chat-pending-item">
                  <img src={f.url} alt={f.file.name} />
                  <button type="button" aria-label="Remove" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-row">
            <input ref={picker} type="file" accept="image/*" multiple hidden data-chat-file onChange={(e) => (attach(e.target.files), (e.target.value = ""))} />
            <textarea
              ref={composer}
              aria-label={`Message ${agentName}`}
              data-chat-input
              rows={intro ? 2 : 1}
              value={text}
              placeholder={intro ? configured ? "What should we investigate?" : "Project name, folder or Git URL" : `Message ${agentName}…`}
              onChange={(e) => changeText(e.target.value)}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  attach(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="chat-composer-bar">
              <button type="button" className="btn chat-attach" aria-label="Attach an image" title="Attach an image" onClick={() => picker.current?.click()} data-chat-attach><ImagePlus size={16} /><span>Add context</span></button>
              <ChatModelPicker current={model} provider={provider} accountKind={accountKind} disabled={busy > 0} onChange={load} onCatalog={(models) => setModelLabels((known) => ({ ...known, ...Object.fromEntries(models.map((m) => [m.id, m.label])) }))} />
              <button type="submit" className="btn primary chat-send" aria-label="Send message" title={disabled ? `Reconnect ${agentName} to send` : "Send message"} disabled={disabled || (!text.trim() && !files.length)} data-chat-send><ArrowUp size={19} strokeWidth={2} /></button>
            </div>
          </div>
          <div className="chat-composer-hint"><span>{provider === "codex" ? "Your Codex ChatGPT subscription" : accountKind === "api" ? "Your Claude API account" : "Your Claude Code subscription"}</span><span>Enter to send · Shift+Enter for a new line</span></div>
          {err && <p className="chat-err" role="alert">{err}</p>}
        </div>
      </form>
      {connection && <SourceConnection request={connection} initialKey={connectionKey} close={closeConnection} connected={() => { closeConnection(); void load(); }} />}
      {drag && <div className="chat-drop">Drop an image to attach it</div>}
      {full && (
        <div className="scrim chat-lightbox" onClick={() => setFull(null)} data-chat-lightbox>
          <img src={fileUrl(full)} alt={full.split("/").pop()} />
        </div>
      )}
    </div>
  );
}
