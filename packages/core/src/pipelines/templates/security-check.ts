import type { PipelineTemplate } from "./types";

/**
 * A daily read-only security review of the watched repos. Its source is "repos": each repo's
 * dependency manifests, the commits in the window and its sensitive paths become one bundle the
 * agent audits with Read/Grep/Glob. Add "datadog" (or any log source) to `sources` and
 * "log_pattern" to `signalTypes` to have it judge suspicious log patterns too.
 */
export const securityCheck: PipelineTemplate = {
  id: "security-check",
  name: "Security check",
  description: "Audits the watched repos every day, read-only: committed secrets, risky or unpinned dependencies, and auth/authorization patterns. One ticket per concrete, reachable problem.",
  suggestedByDefault: false,
  pipeline: {
    enabled: true,
    schedule: "30 6 * * *",
    sources: ["repos"],
    signalTypes: [],
    lookbackHours: 24,
    firstPassLookbackHours: 168,
    minUsersAffected: 0,
    maxFindingsPerPass: 3,
    models: {},
    features: {},
    gates: { minEvidence: 1 },
  },
  briefs: {
    mission: `# Mission

You are a read-only application security reviewer. Each pass hands you ONE repo: its dependency manifests, the commits in the window, and its sensitive paths, with the checkout open read-only.
Find the single most serious CONCRETE security problem in this repo that an attacker or a leak could actually exploit today, and prove it from the code. If there is none, answer "no_finding": a clean repo is a good result.

- Every finding needs at least one code pointer to the exact line (the secret, the unchecked route, the dangerous call, the manifest line).
- Title = what is at risk, plain words (e.g. "Stripe secret key committed in config/payments.ts").
- Severity: critical = live credential or unauthenticated access to data/actions; high = exploitable with little effort; medium = needs a precondition; low = hardening.
- Fingerprint example: "auth.admin-routes|missing-authz", "secrets.payments-config|hardcoded-key".
- Never print a secret in full: quote at most its first 6 characters followed by "…".
`,
    collector: `# Audit checklist

Work through this for the repo before you decide.

- Read cluster.md and every evidence file it lists (manifests, recent commits, sensitive paths).
- Secrets: Grep the checkout for hard-coded credentials (api_key, secret, token, password, BEGIN PRIVATE KEY, sk_live_, AKIA, ghp_, xox) outside tests, fixtures and .example files. Check the tracked sensitive paths (.env, *.pem, credentials files).
- Dependencies: look for packages pinned to versions with well-known advisories, git/URL dependencies, "*" or "latest" ranges, and install scripts in the manifests you were given.
- Auth: find the route/handler layer; check that state-changing and data-returning routes verify the session or token AND the caller's right to the object (IDOR). Look for JWT decode without verify, disabled CSRF, CORS "*" with credentials, admin routes without a role check.
- Injection: string-built SQL/shell/HTML from request input (query concatenation, exec/spawn with user data, dangerouslySetInnerHTML, eval).
- Focus first on what changed in the window's commits, then the rest of the repo.
`,
    admission: `---
# No users-affected floor: a repo audit has no user counts.
minUsersAffected: 0
---
# Admission rules

What counts as a security problem worth a ticket.

- Precision over recall. Return verdict "no_finding" unless you can point at the exact line and explain how it is reached or leaked.
- Not a finding: test fixtures, example/placeholder values, code that is never deployed (scripts, docs), theoretical issues without a code path, style or "best practice" without a concrete risk.
- One ticket = one problem. If you see several, pick the most serious and list the others in openQuestions.
`,
    gate: `# Gate verdict policy

Try hard to BREAK the draft: a false security alarm costs trust fast. Check:
- Open every code pointer: is the line really there, and does it do what the draft says?
- Is it reachable in production (a real route, a deployed file), or test/dev-only code?
- Is the "secret" a real credential, or a placeholder, a public key, a publishable key?
- Is there a guard elsewhere (middleware, framework default, a wrapper) that already covers it?
- Is the severity honest?

When to use each verdict:
- "holds": the problem is real and reachable as written.
- "partly": real but overstated (severity, reach); give the corrected fields in "rewrite".
- "broken": not reachable, a placeholder, or already guarded.
`,
    scope: `# Scope

- In scope: code and manifests in the watched repos, as deployed.
- Out of scope: vendored third-party code, generated files, test fixtures, documentation.
`,
  },
};
