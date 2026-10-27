/**
 * Credential layer: N auth sources, tried in configured order. When one is
 * exhausted (subscription window at reserve, API key at daily cap) the pool
 * switches to the next if `switchOnExhaustion` is set, otherwise the governor
 * parks work until the window resets. Public docs market only two shapes:
 * "your Claude subscription first, an API key when you need more".
 */

export type AuthSourceKind = "claude_login" | "claude_oauth_token" | "anthropic_api_key";

export interface AuthSource {
  id: string;
  kind: AuthSourceKind;
  /** Env vars to inject into the agent runner for this source (resolved in memory). */
  runnerEnv(): Promise<Record<string, string>>;
}

export interface AuthSourceState {
  id: string;
  kind: AuthSourceKind;
  available: boolean;
  /** 0-100 when the provider reports it, null when unknown. */
  usedPct: number | null;
  resetsAt: string | null;
  spendTodayUsd?: number;
  dailyCapUsd?: number;
  exhaustedReason?: "reserve_reached" | "window_exhausted" | "cap_reached" | "auth_invalid";
}

export class AuthPool {
  constructor(
    private readonly sources: readonly AuthSource[],
    private readonly switchOnExhaustion: boolean,
  ) {}

  /** First source that is not exhausted, honoring order; null means "park". */
  pick(states: readonly AuthSourceState[]): AuthSource | null {
    for (const source of this.sources) {
      const state = states.find((s) => s.id === source.id);
      if (state?.available && !state.exhaustedReason) return source;
      if (!this.switchOnExhaustion) return null;
    }
    return null;
  }

  list(): readonly AuthSource[] {
    return this.sources;
  }
}
