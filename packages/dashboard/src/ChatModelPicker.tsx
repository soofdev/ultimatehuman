import { useEffect, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { get, post } from "./api";

type Model = { id: string; label: string; description: string; aliases: string[] };
export function ChatModelPicker({ current, accountKind, disabled, onChange }: { current: string; accountKind: string; disabled: boolean; onChange: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<{ models: Model[]; default: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = async (refresh = false) => {
    setLoading(true); setError("");
    try { const result = await get(`/api/chat/models${refresh ? "?refresh=1" : ""}`); setCatalog(result); setError(result.error || ""); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const model = catalog?.models.find((m) => m.id === current || m.aliases.includes(current));
  const label = current === "claude-opus-5-5" ? "Opus 5.5" : current;
  const change = async (id: string) => {
    setSaving(true); setError("");
    try { await post("/api/chat/model", { model: id }); await onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <div className="chat-model-control">
    <div className="chat-model-select" title={`${accountKind === "api" ? "Your Claude API account" : "Your Claude Code subscription"} · Applies to new messages`}>
      {(loading || saving) && <Loader2 size={12} className="uh-spin" />}
      <select aria-label="Chat model" aria-describedby={error ? "chat-model-error" : undefined} value={model?.id || current} onChange={(e) => void change(e.target.value)} disabled={disabled || loading || saving || !catalog?.models.length}>
        {!model && <option value={current}>{label}{catalog?.models.length ? " (current)" : ""}</option>}
        {catalog?.models.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.label}{m.id === catalog.default ? " · Default" : ""}</option>)}
      </select><ChevronDown size={12} />
    </div>
    {error && <div className="chat-model-error" id="chat-model-error" role="status"><span>{error}</span><button type="button" disabled={loading} onClick={() => void load(true)}><RefreshCw size={11} />Retry</button></div>}
  </div>;
}
