// Chat owns setup and configuration; the original cockpit owns human review.
const root = document.getElementById("root")!;
if (location.pathname === "/render/finding-card") import("./render-card").then((m) => m.mount(root));
else import("./ConversationWorkspace").then((m) => m.mount(root));
