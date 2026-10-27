import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { AppState } from "../App";
import { get } from "../api";
import { time, timeS, until, dur, ago } from "../fmt";

const KIND: Record<string, string> = { root_cause: "Root-cause", adversarial: "Adversarial review" };

export function Usage({ s }: { s: AppState }) {
  const [u, setU] = useState<any>(null);
  useEffect(() => {
    void get("/api/usage").then(setU);
  }, [s.status?.window?.usedPct, s.run?.findings]);
  const w = u?.window ?? s.status?.window;
  if (!w) return null;
  const ceiling = 100 - w.humanReservePct;
  const readings = (u?.readings ?? []).filter((r: any) => typeof r.fiveHourPct === "number").reverse();
  const steps = u?.steps ?? [];

  return (
    <div className="stack">
      <div>
        <h1 className="h1">Usage</h1>
        <p className="lede">ultimatehuman shares your Claude subscription with you. It reads the real window before every agent step, never touches your reserve, and parks instead of failing.</p>
      </div>
      <section className="card">
        {w.usedPct === null ? (
          <div className="bigmeter">
            <div className="bm-n" style={{ fontSize: 26 }}>Window usage unavailable</div>
            <p className="note">This Claude CLI did not report a rate_limit_event, so the governor admits one small step at a time and re-reads after each.</p>
          </div>
        ) : (
          <div className="bigmeter">
            <div className="bm-top">
              <div className="bm-n">
                {w.usedPct}%<small>of your 5-hour window used</small>
              </div>
              <div style={{ textAlign: "right", color: "var(--ink-3)", fontSize: 13 }}>
                Resets <b style={{ color: "var(--ink)" }}>{time(w.resetsAt)}</b> · {until(w.resetsAt)}
              </div>
            </div>
            <div className="bar">
              <div className="used" style={{ width: `${Math.min(100, w.usedPct)}%` }} />
              <div className="reserve" style={{ width: `${w.humanReservePct}%` }} />
              <div className="tick" style={{ left: `calc(${ceiling}% - 1px)` }} title="Radar ceiling" />
            </div>
            <div className="bar-legend">
              <span>0%</span>
              <span style={{ color: "var(--warn)", fontWeight: 600 }}>Radar stops at {ceiling}%: the last {w.humanReservePct}% is yours</span>
              <span>100%</span>
            </div>
          </div>
        )}
        <div className="kv">
          <div>
            <div className="k">Radar state</div>
            <div className="v">{w.state === "admitting" ? "Admitting work" : w.state === "parked_until_reset" ? "Parked until reset" : w.state === "reserve_reached" ? "At your reserve" : w.state}</div>
          </div>
          <div>
            <div className="k">7-day window</div>
            <div className="v">{w.sevenDayPct ?? "?"}% used</div>
          </div>
          <div>
            <div className="k">Queued steps</div>
            <div className="v">{w.queued}</div>
          </div>
          <div>
            <div className="k">Next step estimate</div>
            <div className="v">~{w.estimates?.root_cause ?? 2}% of window</div>
          </div>
        </div>
      </section>
      <p className="note">
        <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
        Source: the <code>rate_limit_event</code> in the Claude CLI's stream-json output, last observed {timeS(w.observedAt)} ({ago(w.observedAt)}). Auth: your subscription via <code>{w.authSource}</code>. Readings older than 15 minutes are refreshed with a one-word probe before a large step.
        </span>
      </p>

      {readings.length > 1 && (
        <section className="card">
          <div className="card-h">
            <h3>Window over this session</h3>
            <span className="sub">{readings.length} real readings</span>
          </div>
          <Spark readings={readings} ceiling={ceiling} />
        </section>
      )}

      <section className="card">
        <div className="card-h">
          <h3>Agent steps</h3>
          <span className="sub">cost is the CLI's API-equivalent figure; on a subscription nothing is charged</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Step</th>
              <th>Model</th>
              <th>Took</th>
              <th>Window used</th>
              <th style={{ textAlign: "right" }}>API-equivalent</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((x: any, i: number) => (
              <tr key={i}>
                <td>{timeS(x.at)}</td>
                <td>{KIND[x.kind] ?? x.kind}</td>
                <td className="mono">{x.model ?? ""}</td>
                <td>{dur(x.durationMs)}</td>
                <td>{x.windowDeltaPct === null || x.windowDeltaPct === undefined ? "n/a" : `+${x.windowDeltaPct}%`}</td>
                <td style={{ textAlign: "right" }}>${x.costUsd?.toFixed(2)}</td>
              </tr>
            ))}
            {!steps.length && (
              <tr>
                <td colSpan={6} style={{ color: "var(--ink-3)" }}>
                  No agent step has run yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Spark({ readings, ceiling }: { readings: any[]; ceiling: number }) {
  const W = 860;
  const H = 120;
  const t0 = Date.parse(readings[0].at);
  const t1 = Math.max(t0 + 1, Date.parse(readings[readings.length - 1].at));
  const x = (t: string) => 20 + ((Date.parse(t) - t0) / (t1 - t0)) * (W - 40);
  const y = (p: number) => H - 14 - (p / 100) * (H - 28);
  const d = readings.map((r, i) => `${i ? "L" : "M"}${x(r.at).toFixed(1)},${y(r.fiveHourPct).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <rect x={20} y={y(100)} width={W - 40} height={y(ceiling) - y(100)} fill="#f3f1ec" />
      <line x1={20} x2={W - 20} y1={y(ceiling)} y2={y(ceiling)} stroke="#b45309" strokeDasharray="4 4" />
      <text x={W - 22} y={y(ceiling) - 5} textAnchor="end" fontSize="11" fill="#b45309">
        radar ceiling {ceiling}%
      </text>
      <path d={d} fill="none" stroke="#17171a" strokeWidth={2} />
      {readings.map((r, i) => (
        <circle key={i} cx={x(r.at)} cy={y(r.fiveHourPct)} r={2.5} fill="#17171a" />
      ))}
    </svg>
  );
}
