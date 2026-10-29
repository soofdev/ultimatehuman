export interface GlobalFlags {
  nonInteractive: boolean;
  json: boolean;
  fix: boolean;
  /** PostHog project id to watch (skips the picker). */
  project?: string;
  /** GitHub repo owner/name for issues (skips the question). */
  repo?: string;
  /** Text put before every notification (options.prefix), e.g. "[test]". */
  notifyPrefix?: string;
  /** A self-hosted server for the notifier (Telegram: your own Bot API server). */
  notifyServer?: string;
}
