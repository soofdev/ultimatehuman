import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Send, X } from "lucide-react";
import { get, post } from "../api";
import { time } from "../fmt";
import { Markdown } from "../Markdown";

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
export function ChatPage() {
  const [msgs, setMsgs] = useState<any[]>([]);
  const [busy, setBusy] = useState(0);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [drag, setDrag] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const last = useRef(0);

  const load = async () => {
    const r = await get("/api/chat");
    setMsgs(r.messages);
    setBusy(r.busy);
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const id = msgs[msgs.length - 1]?.id ?? 0;
    if (id !== last.current) end.current?.scrollIntoView({ block: "end" });
    last.current = id;
  }, [msgs]);
  useEffect(() => {
    if (busy) end.current?.scrollIntoView({ block: "end" });
  }, [busy]);

  const attach = (list: FileList | File[] | null) => {
    const imgs = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setFiles((cur) => [...cur, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 4));
  };

  const send = async () => {
    const t = text.trim();
    if (!t && !files.length) return;
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
    }
  };

  return (
    <div
      className={`chat-full${drag ? " dragging" : ""}`}
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
          {msgs.length === 0 && <p className="chat-empty">Your setup assistant. Ask about the config or tell it what to change. One conversation, three doors: this page, <code>ultimatehuman chat</code>, and Telegram when enabled.</p>}
          {msgs.map((m) => {
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
                  {m.role === "user" ? "You" : "Assistant"} · <span className="pill" data-source-tag>{m.source}</span> · {time(m.ts)}
                </div>
                {/* Like Telegram: your photo above its caption; the agent's files after its text. */}
                {m.role === "user" && files}
                {p.text && <div className="chat-bubble">{m.role === "assistant" ? <Markdown text={p.text} /> : p.text}</div>}
                {m.role === "assistant" && files}
              </div>
            );
          })}
          {busy > 0 && (
            <div className="chat-msg assistant" data-chat-busy>
              <div className="chat-bubble chat-busy">
                <Loader2 size={14} className="spin" /> Thinking{busy > 1 ? ` · ${busy - 1} more queued` : ""}…
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
            <button type="button" className="btn" aria-label="Attach an image" title="Attach an image" onClick={() => picker.current?.click()} data-chat-attach>
              <ImagePlus size={15} />
            </button>
            <textarea
              data-chat-input
              rows={1}
              value={text}
              placeholder="Message the setup assistant…"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  attach(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" className="btn primary" disabled={!text.trim() && !files.length} data-chat-send>
              <Send size={14} /> Send
            </button>
          </div>
          {err && <p className="chat-err">{err}</p>}
        </div>
      </form>
      {drag && <div className="chat-drop">Drop an image to attach it</div>}
      {full && (
        <div className="scrim chat-lightbox" onClick={() => setFull(null)} data-chat-lightbox>
          <img src={fileUrl(full)} alt={full.split("/").pop()} />
        </div>
      )}
    </div>
  );
}
