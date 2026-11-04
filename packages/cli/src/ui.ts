/** Terminal UI: truecolor marks, a spinner, aligned key/value lines. No dependencies. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const rgb = (r: number, g: number, b: number) => (s: string) => (tty ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
export const c = {
  accent: rgb(91, 75, 219),
  ok: rgb(10, 143, 106),
  warn: rgb(180, 83, 9),
  err: rgb(220, 38, 38),
  muted: rgb(107, 114, 128),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  link: (s: string) => (tty ? `\x1b[4m${rgb(37, 99, 235)(s)}\x1b[24m` : s),
};

const LABEL_W = 12;
const pad = (s: string) => s + " ".repeat(Math.max(1, LABEL_W - s.length));

export function banner(version: string): void {
  console.log("");
  console.log(`  ${c.accent("◆")} ${c.bold("ultimatehuman")} ${c.muted(version)}`);
  console.log(`  ${c.muted("Engineering review. Evidence first. Your judgment, always.")}`);
}

let stage = 0;
export function section(title: string, total: number): void {
  stage++;
  console.log("");
  console.log(`  ${c.accent(c.bold(`[${stage}/${total}]`))} ${c.bold(title)}`);
}

export const line = {
  ok: (label: string, msg: string) => console.log(`  ${c.ok("✓")} ${c.bold(pad(label))}${msg}`),
  warn: (label: string, msg: string) => console.log(`  ${c.warn("!")} ${c.bold(pad(label))}${msg}`),
  err: (label: string, msg: string) => console.log(`  ${c.err("✗")} ${c.bold(pad(label))}${msg}`),
  skip: (label: string, msg: string) => console.log(`  ${c.muted("·")} ${c.muted(pad(label))}${c.muted(msg)}`),
  sub: (msg: string) => console.log(`    ${" ".repeat(LABEL_W)}${c.muted(msg)}`),
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export async function spin<T>(label: string, msg: string, fn: () => Promise<T>): Promise<T> {
  if (!tty) return fn();
  let i = 0;
  const started = Date.now();
  const draw = () => {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\r\x1b[2K  ${c.accent(FRAMES[i++ % FRAMES.length]!)} ${c.bold(pad(label))}${c.muted(`${msg} ${secs}s`)}`);
  };
  draw();
  const t = setInterval(draw, 80);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    process.stdout.write("\r\x1b[2K");
  }
}

// One line queue for the whole command. readline emits every buffered line at
// once, so answers piped or typed ahead (an agent, `printf '2\n\n' | init`)
// are queued here instead of being dropped between two questions.
let rl: import("node:readline").Interface | null = null;
const lines: string[] = [];
let waiting: ((l: string | null) => void) | null = null;
let closed = false;
export async function ask(question: string, def?: string, secret = false): Promise<string> {
  if (!rl) {
    const { createInterface } = await import("node:readline");
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
    rl.on("close", () => {
      closed = true;
      waiting?.(null);
      waiting = null;
    });
  }
  process.stdout.write(`  ${c.accent("?")} ${c.bold(question)}${def ? c.muted(` (${def})`) : ""} `);
  const a = lines.length ? lines.shift()! : closed ? null : await new Promise<string | null>((r) => (waiting = r));
  // Piped answers are echoed so a transcript reads like a session; a piped secret is shown masked.
  if (!process.stdin.isTTY || a === null) process.stdout.write(`${secret && a ? mask(a) : a ?? ""}\n`);
  return a?.trim() || def || "";
}

export function closePrompts(): void {
  rl?.close();
  rl = null;
}

export async function choose(question: string, options: string[], def = 0): Promise<number> {
  console.log(`  ${c.accent("?")} ${c.bold(question)}`);
  options.forEach((o, i) => console.log(`    ${i === def ? c.accent("❯") : " "} ${c.bold(String(i + 1))}  ${o}`));
  const a = await ask(`Choose 1-${options.length}`, String(def + 1));
  const n = Number(a) - 1;
  return n >= 0 && n < options.length ? n : def;
}

const mask = (a: string) => `${"•".repeat(Math.min(12, Math.max(4, a.length - 4)))}${a.slice(-4)}`;

/** Like ask, for a secret: on a terminal the typed line is redrawn masked once Enter is hit. */
export async function askSecret(question: string): Promise<string> {
  const a = await ask(question, undefined, true);
  if (a && process.stdin.isTTY && process.stdout.isTTY) process.stdout.write(`\x1b[1A\r\x1b[2K  ${c.accent("?")} ${c.bold(question)} ${c.muted(mask(a))}\n`);
  return a;
}
