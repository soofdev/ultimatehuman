import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { get } from "../api";

function highlight(src: string): ReactNode[] {
  return src.split("\n").map((line, i) => {
    if (/^\s*\/\//.test(line)) return <div key={i} className="c">{line}</div>;
    const parts: ReactNode[] = [];
    const re = /("\$\{[A-Z0-9_]+\}")|("(?:[^"\\]|\\.)*")|(^\s*[A-Za-z_$][\w$]*(?=:))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      parts.push(line.slice(last, m.index));
      parts.push(<span key={m.index} className={m[1] ? "r" : m[2] ? "s" : "k"}>{m[0]}</span>);
      last = m.index + m[0].length;
    }
    parts.push(line.slice(last));
    return <div key={i}>{parts}</div>;
  });
}

export function ConfigPage() {
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    void get("/api/config").then(setC);
  }, []);
  if (!c) return null;
  return (
    <div className="stack">
      <div>
        <h1 className="h1">Config</h1>
        <p className="lede">One JSON5 file, validated before every write. Secrets appear only as environment references, highlighted below; their values never touch disk or this page.</p>
      </div>
      <section className="card">
        <div className="card-h">
          <h3 className="mono">{c.path}</h3>
          <span className="sub">
            <Lock size={12} style={{ verticalAlign: -1 }} /> read-only view in this build
          </span>
        </div>
        <pre className="code">{highlight(c.raw)}</pre>
      </section>
    </div>
  );
}
