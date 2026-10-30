import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { get, post } from "../api";
import { time } from "../fmt";
import { Markdown } from "../Markdown";

/** The setup chat: the same conversation as `ultimatehuman chat` and the Telegram bot. Polls the engine; one turn runs at a time. */
export function ChatPage() {
  const [msgs, setMsgs] = useState<any[]>([]);
  const [busy, setBusy] = useState(0);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
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

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setErr("");
    setText("");
    try {
      await post("/api/chat", { text: t });
      await load();
    } catch (e) {
      setErr((e as Error).message);
      setText(t);
    }
  };

  return (
    <div className="stack">
      <div>
        <h1 className="h1">Chat</h1>
        <p className="lede">Your setup assistant. Ask about the config or tell it what to change; it edits the file through the same validated path as the Config page. One conversation, three doors: this page, <code>ultimatehuman chat</code>, and Telegram when enabled.</p>
      </div>
      <section className="card chat">
        <div className="chat-log" data-chat-log>
          {msgs.length === 0 && <p className="chat-empty">No messages yet. Try “turn on the validation gate”.</p>}
          {msgs.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`} data-chat-msg={m.role} data-source={m.source}>
              <div className="chat-meta">
                {m.role === "user" ? "You" : "Assistant"} · <span className="pill" data-source-tag>{m.source}</span> · {time(m.ts)}
              </div>
              <div className="chat-bubble">{m.role === "assistant" ? <Markdown text={m.text} /> : m.text}</div>
            </div>
          ))}
          {busy > 0 && (
            <div className="chat-msg assistant" data-chat-busy>
              <div className="chat-bubble chat-busy">
                <Loader2 size={14} className="spin" /> Thinking{busy > 1 ? ` · ${busy - 1} more queued` : ""}…
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            data-chat-input
            rows={2}
            value={text}
            placeholder="Message the setup assistant…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={!text.trim()} data-chat-send>
            <Send size={14} /> Send
          </button>
        </form>
        {err && <p className="chat-err">{err}</p>}
      </section>
    </div>
  );
}
