import { useEffect, useRef, useState } from "react";
import { ChatModelPicker } from "../ChatModelPicker";
import { ImagePlus, Loader2, ArrowUp, ArrowUpRight, Cable, Check, Terminal, X } from "lucide-react";
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
  useEffect(() => { sessionStorage.setItem("uh.chat.draft", cleanDraft(text)); }, [text]);
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [connection, setConnection] = useState<ConnectionRequest | null>(null);
  const [connectionKey, setConnectionKey] = useState("");
  const [permissions, setPermissions] = useState<any[]>([]);
  const [deciding, setDeciding] = useState("");
  const [accountKind, setAccountKind] = useState("subscription");
  const [provider, setProvider] = useState("claude");
  const agentName = provider === "codex" ? "Codex" : "Claude";
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
  const intro = msgs.length === 0 || (msgs.length <= 2 && /^Help me (set up ultimatehuman|manage this workspace)\./.test(msgs[0]?.text));
  const visibleMessages = msgs.filter((m) => !(m.role === "user" && /^Help me (set up ultimatehuman|manage this workspace)\.$/.test(m.text)));

  const load = async () => {
    const r = await get("/api/chat");
    setMsgs(r.messages);
    setBusy(r.busy);
    setActivity(r.activity || `${r.provider === "codex" ? "Codex" : "Claude"} is working…`);
    setRequests(r.connections || []);
    setPermissions(r.permissions || []);
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
          {intro && <div className="chat-welcome"><HumanMark /><h2>{configured ? "What’s next?" : "Set up your first pipeline."}</h2><p>{configured ? projectNames.join(" · ") : "Start with one project. Include all of its repositories."}</p></div>}
          {visibleMessages.map((m) => {
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
                  {m.role === "assistant" && <HumanMark className="chat-avatar" />}<strong>{m.role === "user" ? "You" : "ultimatehuman"}</strong><span className="chat-message-time">{time(m.ts)}</span>{m.source !== "dashboard" && <span className="pill" data-source-tag>{m.source === "cli" ? "CLI" : m.source}</span>}
                </div>
                {/* Like Telegram: your photo above its caption; the agent's files after its text. */}
                {m.role === "user" && files}
                {p.text && <div className="chat-bubble">{m.role === "assistant" ? <Markdown text={p.text} /> : p.text}</div>}
                {m.role === "assistant" && files}
              </div>
            );
          })}
          {requests.filter((r) => r.status === "pending").map((r) => <div className="chat-action-card" key={r.id} data-connection-request={r.source}>
            <Cable size={20} /><div><strong>Connect {r.source === "posthog" ? "PostHog" : "Datadog"}</strong><p>Use your existing {r.source === "posthog" ? "events and errors" : "error logs"}{r.project ? ` for ${r.project}` : ""}.</p></div><button className="uh-btn primary" onClick={() => openConnection(r)}>Connect <ArrowUpRight size={14} /></button>
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
              placeholder={intro ? configured ? "What should we investigate?" : "Repository paths or Git URLs…" : `Message ${agentName}…`}
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
              <ChatModelPicker current={model} provider={provider} accountKind={accountKind} disabled={busy > 0} onChange={load} />
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
