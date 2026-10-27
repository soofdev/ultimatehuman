export interface GlobalFlags {
  nonInteractive: boolean;
  json: boolean;
  fix: boolean;
  /** PostHog project id to watch (skips the picker). */
  project?: string;
  /** GitHub repo owner/name for issues (skips the question). */
  repo?: string;
}
