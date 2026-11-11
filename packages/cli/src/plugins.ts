import type { Plugin } from "@ultimatehuman/sdk";
import posthog from "@ultimatehuman/plugin-posthog";
import sentry from "@ultimatehuman/plugin-sentry";
import datadog from "@ultimatehuman/plugin-datadog";
import github from "@ultimatehuman/plugin-github";
import jira from "@ultimatehuman/plugin-jira";
import telegram from "@ultimatehuman/plugin-telegram";

/** Bundled plugins, ordered by newcomer score so the wizard offers the easiest first. */
export const bundledPlugins: readonly Plugin[] = [github, jira, sentry, posthog, datadog, telegram].sort(
  (a, b) => b.manifest.newcomerScore - a.manifest.newcomerScore,
);
