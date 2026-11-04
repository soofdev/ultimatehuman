import { Fragment, type ReactNode } from "react";

/** Tiny renderer for the issue body the engine renders from structured fields (headings, lists, quotes, links, bold, code). */
function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) {
      const href = m[2] || "";
      const safe = /^https?:\/\//i.test(href) || /^\/(?!\/)/.test(href) || href.startsWith("#");
      const label = /^`[^`]+`$/.test(m[1]) ? <code>{m[1].slice(1, -1)}</code> : m[1];
      out.push(safe ? <a key={`${key}-${m.index}`} href={href} {...(/^https?:/.test(href) ? { target: "_blank", rel: "noreferrer" } : {})}>{label}</a> : <Fragment key={`${key}-${m.index}`}>{label}</Fragment>);
    }
    else if (m[3]) out.push(<b key={`${key}-${m.index}`}>{m[3]}</b>);
    else if (m[4]) out.push(<code key={`${key}-${m.index}`}>{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (/^\s*```/.test(l)) {
      const start = i++, code: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(<pre key={start} className="md-code"><code>{code.join("\n")}</code></pre>);
    }
    else if (l.startsWith("### ")) blocks.push(<h3 key={i}>{inline(l.slice(4), i)}</h3>), i++;
    else if (l.startsWith("## ")) blocks.push(<h2 key={i}>{inline(l.slice(3), i)}</h2>), i++;
    else if (l.trim() === "---") blocks.push(<hr key={i} />), i++;
    else if (l.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) q.push(lines[i++]!.slice(2));
      blocks.push(<blockquote key={i}>{q.map((x, j) => <Fragment key={j}>{inline(x, j)}{j < q.length - 1 && <br />}</Fragment>)}</blockquote>);
    } else if (/^- /.test(l)) {
      const items: ReactNode[] = [];
      while (i < lines.length && (/^- /.test(lines[i]!) || /^  /.test(lines[i]!))) {
        const it = lines[i]!;
        if (/^  ```/.test(it)) {
          const code: string[] = [];
          i++;
          while (i < lines.length && !/^  ```/.test(lines[i]!)) code.push(lines[i++]!.slice(2));
          items.push(<pre key={i} className="md-code">{code.join("\n")}</pre>);
          i++;
          continue;
        }
        // Nested items ("  - x"): one sub-list per run of them.
        if (/^\s{2,}[-*] /.test(it)) {
          const sub: ReactNode[] = [];
          while (i < lines.length && /^\s{2,}[-*] /.test(lines[i]!)) sub.push(<li key={i}>{inline(lines[i]!.replace(/^\s+[-*] /, ""), i)}</li>), i++;
          items.push(<ul key={`s${i}`}>{sub}</ul>);
          continue;
        }
        if (/^  > /.test(it)) items.push(<blockquote key={i} style={{ margin: "4px 0 6px" }}>{inline(it.slice(4), i)}</blockquote>);
        else if (/^- /.test(it)) items.push(<li key={i}>{inline(it.slice(2), i)}</li>);
        i++;
      }
      blocks.push(<ul key={i}>{items}</ul>);
    } else if (/^\d+\. /.test(l)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i]!)) items.push(<li key={i}>{inline(lines[i]!.replace(/^\d+\. /, ""), i)}</li>), i++;
      blocks.push(<ol key={i}>{items}</ol>);
    } else if (l.trim() === "") i++;
    else blocks.push(<p key={i} style={{ margin: "6px 0" }}>{inline(l, i)}</p>), i++;
  }
  return <div className="md">{blocks}</div>;
}
