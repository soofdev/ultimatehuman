import { Fragment, type ReactNode } from "react";

/** Tiny renderer for the issue body the engine renders from structured fields (headings, lists, quotes, links, bold, code). */
function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<a key={`${key}-${m.index}`} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>);
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
    if (l.startsWith("## ")) blocks.push(<h2 key={i}>{l.slice(3)}</h2>), i++;
    else if (l.trim() === "---") blocks.push(<hr key={i} />), i++;
    else if (l.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) q.push(lines[i++]!.slice(2));
      blocks.push(<blockquote key={i}>{q.map((x, j) => <Fragment key={j}>{inline(x, j)}{j < q.length - 1 && <br />}</Fragment>)}</blockquote>);
    } else if (/^- /.test(l)) {
      const items: ReactNode[] = [];
      while (i < lines.length && (/^- /.test(lines[i]!) || /^  /.test(lines[i]!))) {
        const it = lines[i]!;
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
