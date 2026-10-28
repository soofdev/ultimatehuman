// Two worlds, two stylesheets: /administration/* is the vendored reference
// cockpit (app/, its own globals.css only); everything else is the radar's own
// pages. Loading one never pulls the other's CSS.
const root = document.getElementById("root")!;
if (location.pathname.startsWith("/administration")) import("./verbatim/main").then((m) => m.mount(root));
else if (location.pathname === "/render/finding-card") import("./render-card").then((m) => m.mount(root));
else import("./legacy-main").then((m) => m.mount(root));
