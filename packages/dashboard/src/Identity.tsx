import { ArrowUpRight, Braces, ScanLine } from "lucide-react";

/** The human mark from the deck, drawn as UI geometry. */
export function HumanMark({ className = "" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <rect width="40" height="40" rx="12" fill="currentColor" />
    <circle cx="20" cy="14" r="5" fill="var(--mark-ink, #121a14)" />
    <path d="M10.5 29a9.5 9.5 0 0 1 19 0v2h-19v-2Z" fill="var(--mark-ink, #121a14)" />
  </svg>;
}

/** A labeled process illustration, never a simulated run or a fabricated result. */
export function DecisionDiagram() {
  return <figure className="decision-diagram" aria-label="How it works: AI investigates, checks the evidence, and brings the decision to you.">
    <figcaption><span>THE OPERATING MODEL</span><span>01 — 03</span></figcaption>
    <div className="decision-diagram-grid" aria-hidden="true" />
    <svg className="decision-diagram-path" viewBox="0 0 380 330" fill="none" aria-hidden="true">
      <path d="M103 92v35q0 18 18 18h143q18 0 18 18v31" stroke="currentColor" strokeWidth="1.2" />
      <path d="M282 187v36q0 19-19 19H115" stroke="currentColor" strokeWidth="1.2" />
      <path d="m119 238-4 4 4 4" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="103" cy="92" r="3" fill="currentColor" />
    </svg>
    <div className="diagram-step diagram-investigate"><Braces size={20} strokeWidth={1.5} /><div><span>01 / AI</span><strong>Investigate</strong></div><i /></div>
    <div className="diagram-step diagram-evidence"><ScanLine size={20} strokeWidth={1.5} /><div><span>02 / EVIDENCE</span><strong>Verify</strong></div><i /></div>
    <div className="diagram-human"><div className="diagram-human-top"><span>03 / HUMAN</span><ArrowUpRight size={17} /></div><HumanMark /><strong>You decide.</strong><span className="diagram-human-note">The final call stays yours.</span></div>
    <div className="diagram-caption"><span /><span>Evidence before action.</span></div>
  </figure>;
}
