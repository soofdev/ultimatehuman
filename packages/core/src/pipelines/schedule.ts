/**
 * Pipeline schedules: "manual", "every N hours" (= "0 *\/N * * *"), or a 5-field cron
 * (minute hour day-of-month month day-of-week) with numbers, lists, ranges and step values,
 * local time. The runtime asks `due()` on its 30 s tick.
 */
export type Schedule = { kind: "manual" } | { kind: "cron"; fields: Set<number>[] };

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function field(src: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    let a: number;
    let b: number;
    if (m[1] === "*") [a, b] = [lo, hi];
    else if (m[1]!.includes("-")) [a, b] = m[1]!.split("-").map(Number) as [number, number];
    else [a, b] = [Number(m[1]), m[2] ? hi : Number(m[1])];
    if (step < 1 || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseSchedule(src: string): Schedule | { error: string } {
  const s = src.trim().toLowerCase();
  if (s === "manual" || s === "off" || s === "") return { kind: "manual" };
  const every = /^every\s+(\d+)\s*(?:h|hours?)$/.exec(s);
  if (every) {
    const n = Number(every[1]);
    if (n < 1 || n > 24) return { error: "every N hours: N from 1 to 24" };
    return parseSchedule(`0 */${n} * * *`);
  }
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return { error: `"${src}" is not a schedule: use "M H * * *", "every N hours" or "manual"` };
  const fields = parts.map((p, i) => field(p, RANGES[i]!));
  if (fields.some((f) => !f)) return { error: `"${src}": a cron field is out of range or malformed` };
  return { kind: "cron", fields: fields as Set<number>[] };
}

/** True when `d` falls in a minute the schedule names. */
export function due(s: Schedule, d: Date, timezone?: string): boolean {
  if (s.kind !== "cron") return false;
  const [mi, h, dom, mon, dow] = s.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", hourCycle: "h23", day: "numeric", month: "numeric", weekday: "short" }).formatToParts(d);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return mi.has(Number(p.minute)) && h.has(Number(p.hour)) && dom.has(Number(p.day)) && mon.has(Number(p.month)) && dow.has(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!));
  }
  return mi.has(d.getMinutes()) && h.has(d.getHours()) && dom.has(d.getDate()) && mon.has(d.getMonth() + 1) && dow.has(d.getDay());
}

/** Plain words for the common forms; the raw string otherwise. */
export function describeSchedule(src: string): string {
  const p = parseSchedule(src);
  if ("error" in p) return `invalid: ${p.error}`;
  if (p.kind === "manual") return "manual only";
  const daily = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(src.trim());
  if (daily) return `daily at ${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`;
  const weekdays = /^(\d+)\s+(\d+)\s+\*\s+\*\s+1-5$/.exec(src.trim());
  if (weekdays) return `weekdays at ${weekdays[2]!.padStart(2, "0")}:${weekdays[1]!.padStart(2, "0")}`;
  const every = /^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/.exec(src.trim()) ?? /^every\s+(\d+)/i.exec(src.trim());
  if (every) return every[1] === "1" ? "every hour" : `every ${every[1]} hours`;
  return `cron ${src.trim()}`;
}
