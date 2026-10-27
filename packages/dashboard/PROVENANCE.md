# Provenance: code ported from a private app

The cockpit UI in this package is **not original to this repo**. It is the UI
code of a private application's claims/pipeline cockpit page, ported so the
radar's cockpit is pixel-identical to it. Revisit before open-sourcing: either
confirm the right to publish these files or rewrite them.

Source snapshot: the private app's `test` branch at commit `1a0aa0bc` (2026-10-27).

| File here | Ported from (private app) | What was ported | What changed |
| --- | --- | --- | --- |
| `src/ported/CockpitClient.jsx` | `app/(app)/administration/claims/CockpitClient.js` | Page frame (`bg-gray-50` page, padding, header + pill button, intro line), underline tab bar with count pills, the right-of-tabs slot (`ProofSizeToggle` frame), `Empty`, the `Development` collapsible (used for History), the Shipped list frame (used for Recent passes), the hold alert (used for decisions), the `CancelDialog` frame (used for the issue preview), the `PILL` constant | Data: `/api/cockpit` cards, runs, decisions mapped by `toItem()`; words; Next router replaced by `history.replaceState` on `?tab=` |
| `src/ported/CockpitClient.jsx` | `app/(app)/administration/claims/ClaimsClient.js` | Sticky filter bar (segmented control + search), claim card anatomy (header row, verdict pill, statement, meta line, Details toggle, context panel, ticket badges, ruling box with Change, Confirm / Wrong / Build this buttons, correction form), the "just ruled stays on screen" rule | Confirm -> File to GitHub, Wrong -> Dismiss (reason required), Build this -> Not now; Clear ruling -> Withdraw ruling; ticket badges -> evidence badges; filters -> All / Critical & high / Medium & low / Drafts |
| `src/ported/AdminSidebar.jsx` | `app/(app)/administration/components/AdminSidebar.js` | Desktop + mobile sidebar markup and classes, five of its outline icons | Next `Link`/`usePathname`/`useSession` replaced by props; nav lists the radar's pages; title is this product's name; optional footer slot |
| `src/ported/globals.css` | `app/globals.css` | Tailwind layers, `--background/--foreground`, the native system font stack | Dark-mode variable override and the app-specific utility classes left out |
| `tailwind.config.js` | `tailwind.config.mjs` | Tailwind 3.4 setup, `colors` and `transitionTimingFunction` extensions | Typography/blog theme, animations and plugins left out (unused here) |
| `postcss.config.js` | `postcss.config.mjs` | as is | none |

No product name, logo, tracker or ticket-system wording from the private app
is carried over: only the code structure and the Tailwind classes.
