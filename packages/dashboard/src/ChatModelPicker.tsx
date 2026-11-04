import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { get, post } from "./api";

type Model = { id: string; label: string; description: string; aliases: string[] };
export function ChatModelPicker({ current, provider, accountKind, disabled, onChange }: { current: string; provider: string; accountKind: string; disabled: boolean; onChange: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<{ models: Model[]; default: string; current: string } | null>(null);
  const [providers, setProviders] = useState<{ id: string; label: string; available: boolean; authenticated: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = async (refresh = false) => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try { const result = await get(`/api/chat/models${refresh ? "?refresh=1" : ""}`); if (request === generation.current) { setCatalog(result); setError(result.error || ""); } }
    catch (e) { if (request === generation.current) setError((e as Error).message); }
    finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => { setCatalog(null); void load(); return () => { generation.current++; }; }, [provider]);
  useEffect(() => { void get("/api/chat/providers").then((r) => setProviders(r.providers)).catch(() => {}); }, [provider]);
  const selected = current || catalog?.current || "";
  const model = catalog?.models.find((m) => m.id === selected || m.aliases.includes(selected));
  const label = selected === "claude-opus-5-5" ? "Opus 5.5" : selected || "CLI default";
  const switchProvider = async (id: string) => {
    setSaving(true); setError("");
    try { await post("/api/chat/provider", { provider: id }); await onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const change = async (id: string) => {
    setSaving(true); setError("");
    try { await post("/api/chat/model", { model: id }); await onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <div className="chat-model-control">
    <div className="chat-model-select" title="AI account for chat and pipeline runs">
      <select aria-label="AI provider" value={provider} disabled={disabled || saving} onChange={(e) => void switchProvider(e.target.value)}>
        {[{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }].map((p) => {
          const detected = providers.find((d) => d.id === p.id);
          return <option key={p.id} value={p.id}>{p.label}{detected && !detected.available ? " · Not installed" : detected && !detected.authenticated ? " · Sign in" : ""}</option>;
        })}
      </select><ChevronDown size={12} />
    </div>
    <div className="chat-model-select" title={`${provider === "codex" ? "Your Codex ChatGPT subscription" : accountKind === "api" ? "Your Claude API account" : "Your Claude Code subscription"} · Model applies to new chat messages`}>
      {(loading || saving) && <Loader2 size={12} className="uh-spin" />}
      <select aria-label="Chat model" aria-describedby={error ? "chat-model-error" : undefined} value={model?.id || selected} onChange={(e) => void change(e.target.value)} disabled={disabled || loading || saving || !catalog?.models.length}>
        {!model && <option value={selected}>{label}{catalog?.models.length ? " (current)" : ""}</option>}
        {catalog?.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.label}{m.id === catalog.default ? " · Default" : ""}</option>)}
      </select><ChevronDown size={12} />
    </div>
    {error && <div className="chat-model-error" id="chat-model-error" role="status"><span>{error}</span><button type="button" disabled={loading} onClick={() => void load(true)}><RefreshCw size={11} />Retry</button></div>}
  </div>;
}
