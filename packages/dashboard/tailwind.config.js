/**
 * Ported from the private reference app's tailwind.config.mjs (Tailwind 3.4):
 * the cockpit UI is that app's claims-page code, so it needs the same theme.
 * Only the parts the ported components use are kept (see PROVENANCE.md).
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.16, 1, 0.3, 1)",
        "ease-in-smooth": "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
      },
    },
  },
  plugins: [],
};
