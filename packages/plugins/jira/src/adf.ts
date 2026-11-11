import type { Finding } from "@ultimatehuman/sdk";

/**
 * Atlassian Document Format (ADF): the JSON document Jira Cloud's v3 API takes
 * for descriptions and comments. Built straight from the finding's fields
 * rather than converted from Markdown, so every node is valid by construction
 * (Jira rejects empty text nodes and unknown marks).
 */

type Mark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };
type Inline = { type: "text"; text: string; marks?: Mark[] } | { type: "hardBreak" };
type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "heading"; attrs: { level: number }; content: Inline[] }
  | { type: "bulletList" | "orderedList"; content: { type: "listItem"; content: Block[] }[] }
  | { type: "codeBlock"; content: Inline[] }
  | { type: "blockquote"; content: Block[] }
  | { type: "rule" };
export interface AdfDoc {
  type: "doc";
  version: 1;
  content: Block[];
}

const isHttp = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);

export const text = (t: string, ...marks: Mark[]): Inline[] => (t ? [{ type: "text", text: t, ...(marks.length ? { marks } : {}) }] : []);
export const link = (t: string, href: string | undefined): Inline[] => (isHttp(href) ? text(t, { type: "link", attrs: { href } }) : text(t));
const para = (...parts: Inline[][]): Block[] => {
  const content = parts.flat();
  return content.length ? [{ type: "paragraph", content }] : [];
};
const heading = (t: string): Block => ({ type: "heading", attrs: { level: 2 }, content: text(t) });
const list = (kind: "bulletList" | "orderedList", items: Block[][]): Block[] => {
  const content = items.filter((b) => b.length).map((b) => ({ type: "listItem" as const, content: b }));
  return content.length ? [{ type: kind, content }] : [];
};

/** Plain text (comments, recurrence notes) as paragraphs, one per blank-line-separated block. */
export function plainDoc(body: string): AdfDoc {
  const blocks = body
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => para(chunk.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" } as Inline] : []), ...text(line)])));
  return { type: "doc", version: 1, content: blocks.length ? blocks : para(text("(empty)")) };
}

const utc = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/** The Jira description for one finding: the same sections as the GitHub issue body. */
export function findingDoc(f: Finding): AdfDoc {
  const ev = new Map(f.evidence.map((e) => [e.id, e]));
  const sources = [...new Set(f.evidence.map((e) => e.sourcePluginId))].join(", ") || "repository";
  const users = f.impact.usersAffected !== undefined ? `${f.impact.usersAffected} users` : "unknown number of users";
  const c: Block[] = [];

  c.push(...para(text(`Found by ultimatehuman from ${sources} data. Confidence: `), text(f.confidence, { type: "strong" }), text(". Severity: "), text(f.severity, { type: "strong" }), text(".")));

  c.push(heading("Impact"));
  c.push(...list("bulletList", [
    para(text(`${users}, ${f.impact.occurrences} occurrences, trend: ${f.impact.trend}`)),
    para(text(`First seen ${utc(f.impact.firstSeen)}, last seen ${utc(f.impact.lastSeen)}`)),
  ]));

  c.push(heading("What happens"), ...para(text(f.symptom)));

  c.push(heading("Root cause"), ...para(text(f.rootCause.statement)));
  c.push(...list("bulletList", f.rootCause.reasoning.map((r) => para(
    text(`${r.claim} (`),
    r.evidenceIds.flatMap((id, i) => [...(i ? text(", ") : []), ...link(id, ev.get(id)?.url)]),
    text(")"),
  ))));

  if (f.rootCause.codePointers?.length) {
    c.push(...para(text("Code pointers", { type: "strong" })));
    c.push(...list("bulletList", f.rootCause.codePointers.map((p) => {
      const loc = `${p.repo ? `${p.repo}: ` : ""}${p.path}${p.line ? `:${p.line}` : ""}`;
      const head = para(isHttp(p.url) ? text(loc, { type: "code" }, { type: "link", attrs: { href: p.url } }) : text(loc, { type: "code" }), p.why ? text(`: ${p.why}`) : []);
      return p.text ? [...head, { type: "codeBlock", content: text(p.text) } as Block] : head;
    })));
  }
  if (f.rootCause.ruledOut?.length) {
    c.push(...para(text("Ruled out", { type: "strong" })));
    c.push(...list("bulletList", f.rootCause.ruledOut.map((x) => para(text(x)))));
  }

  c.push(heading("Evidence"));
  c.push(...list("bulletList", f.evidence.map((e) => {
    const label = (e as { label?: string }).label ?? e.kind;
    const head = para(text(e.id, { type: "strong" }), text(` · ${label} · `), link(`open in ${e.sourcePluginId}`, e.url));
    const quote = e.excerpt?.trim() ? [{ type: "blockquote", content: para(text(e.excerpt.trim())) } as Block] : [];
    return [...head, ...quote];
  })));

  c.push(heading("Reproduction"));
  if ("steps" in f.reproduction && f.reproduction.steps.length) c.push(...list("orderedList", f.reproduction.steps.map((s) => para(text(s)))));
  else c.push(...para(text(`Not established: ${"notEstablished" in f.reproduction ? f.reproduction.notEstablished : "no steps recorded"}`)));

  if (f.suggestedFix) c.push(heading("Suggested direction"), ...para(text(f.suggestedFix)));

  c.push(heading("Not established"));
  c.push(...(f.openQuestions.length ? list("bulletList", f.openQuestions.map((q) => para(text(q)))) : para(text("Nothing open."))));

  c.push({ type: "rule" }, ...para(text("Fingerprint: "), text(f.dedupe.fingerprint, { type: "code" })));
  return { type: "doc", version: 1, content: c };
}

/** ADF (descriptions, comments) to plain text for chat: block nodes become lines, lists get bullets. */
export function adfToText(node: unknown, max = 2000): string {
  const out: string[] = [];
  const walk = (n: any, prefix = ""): void => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text") return void out.push(String(n.text ?? ""));
    if (n.type === "hardBreak") return void out.push("\n");
    if (n.type === "mention") return void out.push(String(n.attrs?.text ?? "@someone"));
    if (n.type === "emoji") return void out.push(String(n.attrs?.text ?? n.attrs?.shortName ?? ""));
    if (n.type === "inlineCard" || n.type === "blockCard") return void out.push(String(n.attrs?.url ?? ""));
    if (n.type === "bulletList" || n.type === "orderedList") {
      (n.content ?? []).forEach((item: any, i: number) => {
        out.push(`\n${prefix}${n.type === "orderedList" ? `${i + 1}.` : "-"} `);
        (item.content ?? []).forEach((c: any) => walk(c, `${prefix}  `));
      });
      return void out.push("\n");
    }
    const block = ["paragraph", "heading", "codeBlock", "blockquote", "rule", "panel", "table", "tableRow", "mediaSingle"].includes(n.type);
    (n.content ?? []).forEach((c: any) => walk(c, prefix));
    if (n.type === "tableCell" || n.type === "tableHeader") out.push(" | ");
    if (block && n.type !== "blockquote") out.push("\n");
  };
  walk(node);
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}
