# Provenance: code vendored from a private app

The cockpit in this package is **not original to this repo**. Revisit before
open-sourcing: either confirm the right to publish these files or rewrite them.

## The cockpit: `app/` (vendored verbatim, 2026-10-27)

`app/` and `tailwind.config.mjs` are byte-for-byte copies of the private app's
files at its `test` branch, commit `1a0aa0bc`, kept at the SAME relative paths
so their own imports (`./X`, `@/app/lib/...`) resolve unchanged. Served at
`/administration/claims` and `/administration/pipeline-live` (same paths as the original).

| File here | Changed vs the original |
| --- | --- |
| `app/(app)/administration/claims/page.js` | none (byte-identical) |
| `app/(app)/administration/claims/CockpitClient.js` | none |
| `app/(app)/administration/claims/ClaimsClient.js` | none |
| `app/(app)/administration/claims/FocusTicket.js`, `GateClient.js`, `MobileCockpit.js`, `PhoneTickets.js`, `PhoneViewer.js`, `PlanModal.js`, `PlanTesting.js`, `SuggestedBundles.js`, `TicketSort.js` | none |
| `app/(app)/administration/layout.js` | none |
| `app/(app)/administration/components/AdminSidebar.js` | brand: +1 import of `BRAND`, the two `Admin Panel` titles read `{BRAND.appName}`; Vincent order (2026-10-27): the nav lists only Pipeline and Pipeline live (`RADAR_PAGES`), no Super Admin divider |
| `app/(app)/administration/pipeline-live/page.js`, `LiveClient.js`, `app/lib/pipeline-live.js`, `app/lib/pipeline-live-data.js` | none (byte-identical, added 2026-10-27, same commit `1a0aa0bc`) |
| `app/lib/pipeline-cockpit.js`, `app/lib/pipeline-gate.js` | none |
| `app/globals.css`, `tailwind.config.mjs` | none |

Proof: `diffs/verify.sh` in the task folder diffs every file above against the
original repo's git object directly.

What makes them run outside Next.js (none of it inside `app/`):
- `vite.config.ts` aliases `next/navigation`, `next/link`, `next-auth`,
  `next-auth/react`, `@/app/api/auth/[...nextauth]/route`, `@/lib/db/db` and the
  four `@/app/models/*` imports to thin adapters in `src/verbatim/shims/`, and
  `@/` to this package root. A tiny plugin compiles JSX in `app/**/*.js`.
- `src/verbatim/data-provider.js` is the ONE data mapping: engine `/api/cockpit`
  -> the TICKET rows both pages read through the model stand-ins (findings and
  dropped drafts are tickets; claims stay empty: no agent is connected), and the
  pages' own `/api/admin/pipeline/*` calls -> engine rulings.
- `src/verbatim/main.jsx` runs `layout.js` and `page.js` (the server components)
  once in the browser and mounts their output.
- `src/verbatim/brand.js` is the brand constant (app name; the original has no logo).
- `tailwind.config.js` reuses the vendored config and only adds `./src` to its content.

## The previous cockpit (attempt 2): `src/ported/`, served at `/legacy-cockpit`

| File here | Ported from (private app) | What was ported | What changed |
| --- | --- | --- | --- |
| `src/ported/CockpitClient.jsx` | `app/(app)/administration/claims/CockpitClient.js` | Page frame (`bg-gray-50` page, padding, header + pill button, intro line), underline tab bar with count pills, the right-of-tabs slot (`ProofSizeToggle` frame), `Empty`, the `Development` collapsible (used for History), the Shipped list frame (used for Recent passes), the hold alert (used for decisions), the `CancelDialog` frame (used for the issue preview), the `PILL` constant | Data: `/api/cockpit` cards, runs, decisions mapped by `toItem()`; words; Next router replaced by `history.replaceState` on `?tab=` |
| `src/ported/CockpitClient.jsx` | `app/(app)/administration/claims/ClaimsClient.js` | Sticky filter bar (segmented control + search), claim card anatomy (header row, verdict pill, statement, meta line, Details toggle, context panel, ticket badges, ruling box with Change, Confirm / Wrong / Build this buttons, correction form), the "just ruled stays on screen" rule | Confirm -> File to GitHub, Wrong -> Dismiss (reason required), Build this -> Not now; Clear ruling -> Withdraw ruling; ticket badges -> evidence badges; filters -> All / Critical & high / Medium & low / Drafts |
| `src/ported/AdminSidebar.jsx` | `app/(app)/administration/components/AdminSidebar.js` | Desktop + mobile sidebar markup and classes, five of its outline icons | Next `Link`/`usePathname`/`useSession` replaced by props; nav lists the radar's pages; title is this product's name; optional footer slot |
| `src/ported/globals.css` | `app/globals.css` | Tailwind layers, `--background/--foreground`, the native system font stack | Dark-mode variable override and the app-specific utility classes left out |
| `postcss.config.js` | `postcss.config.mjs` | as is | none |

The legacy cockpit carries no wording from the private app. The vendored one
carries its wording verbatim, except the app name (brand constant). Its copy
still names the private app's assistant ("MAX") and its JS holds the private
Jira base URL (`JIRA_BROWSE`, never rendered: the radar maps no tickets).
