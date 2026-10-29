import { createRoot } from "react-dom/client";
import "./ported/globals.css";
import "./styles.css";
import { FindingCard } from "./FindingCard";

/**
 * /render/finding-card#f=<base64url JSON>: the dashboard's finding card alone,
 * for the engine's headless browser to photograph (notifications). The
 * finding travels in the fragment, so this page needs no session and makes
 * no API call; the fragment never reaches the server or its access log.
 */
export function mount(root: HTMLElement) {
  const raw = new URLSearchParams(location.hash.slice(1)).get("f") ?? "";
  const json = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));
  const f = JSON.parse(json);
  root.style.padding = "16px";
  // A photo: settled at first paint (no fade-in), and no buttons nobody can press.
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; } .fcard .btns { display: none !important; }";
  document.head.appendChild(style);
  createRoot(root).render(<FindingCard f={f} />);
  document.fonts.ready.then(() => requestAnimationFrame(() => document.body.setAttribute("data-render-ready", "true")));
}
