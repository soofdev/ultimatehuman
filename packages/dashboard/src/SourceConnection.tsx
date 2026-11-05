import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, LockKeyhole } from "lucide-react";
import { ApiError, get, post } from "./api";
import { Modal } from "./WorkspaceModal";

export interface ConnectionRequest { id: string; source: string; project?: string; status: string; lastAttempt?: { at: string; verified: boolean }; missing?: string[]; }

/** Always accepts what was entered: the engine saves it, and the chat explains any failed check. */
export function SourceConnection({ request, initialKey = "", close, connected }: {
  request: ConnectionRequest; initialKey?: string; close: () => void; connected: () => void;
}) {
  const [source, setSource] = useState<any>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
  const [customHost, setCustomHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void get("/api/chat/connections").then((r) => {
      if (!active) return;
      const found = r.sources.find((s: any) => s.id === request.source);
      if (!found) throw new Error("This source is not available.");
      setSource(found);
      setCredentials(Object.fromEntries(found.fields.map((f: any) => [f.key, f.key === "apiKey" && initialKey ? initialKey : f.value || ""])));
      setProjectId(String(found.savedOptions.projectId || ""));
      setCustomHost(request.source === "posthog" && found.fields.some((f: any) => f.key === "host" && !["https://us.posthog.com", "https://eu.posthog.com"].includes(f.value)));
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [request.id]);
  const update = (key: string, value: string) => setCredentials((c) => ({ ...c, [key]: value }));
  let accountUrl = "";
  try {
    const url = new URL(request.source === "posthog" ? credentials.host || "https://us.posthog.com" : `https://app.${credentials.site || "datadoghq.com"}`);
    if (["http:", "https:"].includes(url.protocol)) accountUrl = url.origin;
  } catch { /* The form validates incomplete hosts before submission. */ }
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await post(`/api/chat/connections/${request.id}`, { credentials, options: projectId ? { projectId } : {} });
      setCredentials({}); connected();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.detail?.projects) {
        setProjects(e.detail.projects); setProjectId("");
        if (e.detail.host) { setCustomHost(false); update("host", e.detail.host); }
        setError("");
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  const guide = (key: string) => source?.guide.fields?.[key];
  const hint = (key: string) => {
    const g = guide(key);
    if (!g) return null;
    return <span className="source-field-hint">{g.hint}{g.scopes && <span className="source-scopes"><span>Read scopes:</span>{source.scopes.map((scope: string) => <code key={scope}>{scope}</code>)}</span>}</span>;
  };
  const fieldLink = (key: string) => {
    const link = guide(key)?.link;
    return link ? <a className="source-field-link" href={accountUrl ? accountUrl + link.path : source.guide.docsUrl} target="_blank" rel="noreferrer">{link.label}<ArrowUpRight size={12} /></a> : null;
  };
  return <Modal title={source?.guide.title || "Connect source"} close={() => { if (!busy) close(); }}>
    {!source ? <p role="status">{error || "Loading connection…"}</p> : <form className="source-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label className="uh-field"><span>{request.source === "posthog" ? "PostHog region" : "Datadog site"}</span>
        {request.source === "posthog" ? <select disabled={busy} value={customHost ? "custom" : credentials.host || "https://us.posthog.com"} onChange={(e) => { setCustomHost(e.target.value === "custom"); update("host", e.target.value === "custom" ? "" : e.target.value); setProjects([]); setProjectId(""); }}>
          <option value="https://us.posthog.com">US Cloud</option><option value="https://eu.posthog.com">EU Cloud</option><option value="custom">Self-hosted</option>
        </select> : <select disabled={busy} value={credentials.site || "datadoghq.com"} onChange={(e) => update("site", e.target.value)}>{["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com", "ddog-gov.com"].map((site) => <option key={site}>{site}</option>)}</select>}
        {hint(request.source === "posthog" ? "host" : "site")}
      </label>
      {customHost && <label className="uh-field"><span>PostHog URL</span><input disabled={busy} type="url" required value={credentials.host || ""} placeholder="https://posthog.example.com" onChange={(e) => update("host", e.target.value)} /></label>}
      {source.fields.filter((field: any) => field.secret).map((field: any, i: number) => <div className="uh-field source-key-field" key={field.key}>
        <div className="source-field-head"><label htmlFor={`source-${field.key}`}>{field.label}</label>{fieldLink(field.key)}</div>
        <input id={`source-${field.key}`} disabled={busy} autoFocus={i === source.fields.filter((f: any) => f.secret).findIndex((f: any) => !f.saved)} type="text" className="source-secret" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" required={!source.configured && !field.saved} value={credentials[field.key] || ""} placeholder={source.configured ? "Use saved key, or paste a replacement" : field.saved ? "Saved. Leave empty to keep it" : guide(field.key)?.placeholder || `Paste your ${field.label.toLowerCase()}`} onChange={(e) => { update(field.key, e.target.value); setProjects([]); setProjectId(""); }} />
        {hint(field.key)}
      </div>)}
      {projects.length > 0 && <label className="uh-field"><span>Which PostHog project belongs to {request.project || "this project"}?</span><select disabled={busy} required value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="" disabled>Choose a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label>}
      <p className="source-private"><LockKeyhole size={13} />Saved on this machine, outside the conversation. <a className="source-docs" href={source.guide.docsUrl} target="_blank" rel="noreferrer">Official instructions <ArrowUpRight size={12} /></a></p>
      {error && <p role="alert" className="uh-error">{error}</p>}
      <div className="uh-modal-actions"><button type="button" className="uh-btn" disabled={busy} onClick={close}>Cancel</button><button className="uh-btn primary" type="submit" disabled={busy || (projects.length > 0 && !projectId)}>{busy ? <><Loader2 size={15} className="uh-spin" />Checking access…</> : projects.length ? "Use this project" : "Connect"}</button></div>
    </form>}
  </Modal>;
}
