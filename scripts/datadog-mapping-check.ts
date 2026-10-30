// Unit check: Datadog error logs/events -> radar signals -> correlate() clusters. Run: node scripts/build.mjs-style esbuild bundle, see docs.
import { logsToSignals, eventsToSignals, normalizeMessage, type DatadogLog } from "../packages/plugins/datadog/src/index";
import { correlate } from "../packages/core/src/radar/engine";

let fails = 0;
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) fails++;
};
const at = (m: number) => new Date(Date.UTC(2026, 9, 30, 12, m)).toISOString();
const log = (id: string, m: number, user: string, msg: string, path: string, kind = "TypeError"): DatadogLog => ({
  id,
  attributes: { timestamp: at(m), status: "error", service: "checkout-api", message: msg, attributes: { error: { kind, message: msg }, usr: { id: user }, http: { url_details: { path } }, version: "1.8.3" } },
});
const logs = [
  log("a", 1, "u1", "Cannot read properties of undefined (reading 'last4') for order 88123", "/api/orders/88123/pay"),
  log("b", 2, "u2", "Cannot read properties of undefined (reading 'last4') for order 88124", "/api/orders/88124/pay"),
  log("c", 3, "u1", "Cannot read properties of undefined (reading 'last4') for order 88123", "/api/orders/88123/pay"),
  log("d", 4, "u9", "Timeout after 30000ms calling inventory-svc", "/api/cart", "TimeoutError"),
];
const sig = logsToSignals(logs, "datadoghq.eu");
ok(normalizeMessage("order 88123 id 3f2a9c1e-1111-2222-3333-444455556666") === "order # id <id>", "normalizeMessage strips numbers and uuids");
ok(sig.length === 2, `4 logs -> 2 error groups (got ${sig.length})`);
const card = sig.find((s) => String(s.title).startsWith("TypeError"))!;
ok(card.type === "error_group" && card.pluginId === "datadog", "type error_group, pluginId datadog");
ok(card.count === 3 && card.usersAffected === 2, `count 3, 2 distinct users (got ${card.count}, ${card.usersAffected})`);
ok(card.keys.route === "/api/orders/:id/pay", `route normalized (got ${card.keys.route})`);
ok(card.firstSeen === at(1) && card.lastSeen === at(3), "first/last seen from the log timestamps");
ok(String(card.keys.fingerprint).startsWith("datadog|checkout-api|TypeError|"), "fingerprint = service|kind|normalized message");
ok(card.url.startsWith("https://app.datadoghq.eu/logs?query="), "deep link to the EU logs explorer");
const ev = eventsToSignals([
  { id: 1, title: "[Triggered] error rate > 5%", date_happened: 1793361600, alert_type: "error" },
  { id: 2, title: "Deploy", date_happened: 1793361600, alert_type: "info" },
], "datadoghq.com");
ok(ev.length === 1 && ev[0]!.type === "event_anomaly", "only error events become signals");
const clusters = correlate([...sig, ...ev]);
const top = clusters[0]!;
ok(clusters.length === 3, `correlate -> 3 clusters (got ${clusters.length})`);
ok(top.usersAffected === 2 && top.occurrences === 3 && top.route === "/api/orders/:id/pay", `top cluster: 2 users, 3 occurrences on /api/orders/:id/pay (got ${top.usersAffected}, ${top.occurrences}, ${top.route})`);
console.log(`\n${fails ? `${fails} FAILED` : "all passed"}`);
process.exit(fails ? 1 : 0);
