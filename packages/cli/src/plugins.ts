import type { Plugin } from "@ultimatehuman/sdk";
import posthog from "@ultimatehuman/plugin-posthog";
import sentry from "@ultimatehuman/plugin-sentry";
import github from "@ultimatehuman/plugin-github";
import telegram from "@ultimatehuman/plugin-telegram";

/** Bundled plugins, ordered by newcomer score so the wizard offers the easiest first. */
export const bundledPlugins: readonly Plugin[] = [github, sentry, posthog, telegram].sort(
  (a, b) => b.manifest.newcomerScore - a.manifest.newcomerScore,
);
