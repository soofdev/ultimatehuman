# Pipelines

Everything ultimatehuman runs is a **pipeline**, and every pipeline is data in your config. The ones
we ship are **templates**: suggestions that are copied into your config when you add them. After
that the copy is yours. Edit any field, disable it, delete it, or start a blank one. Nothing reads a
template again once it has been copied.

## What a pipeline is

```json5
pipelines: [
  {
    id: "security-check",            // stable: names its instruction set, tags its runs and tickets
    name: "Security check",          // ticket badge, Runs list
    description: "…",
    enabled: true,                   // off = never scheduled (Run now still works)
    template: "security-check",      // informational: where it was copied from
    schedule: "30 6 * * *",          // "M H * * *" daily (local time) · "every 6 hours" · any 5-field cron · "manual"
    sources: ["repos"],              // plugin ids · "*" = every configured source · "repos" = audit the watched repos
    signalTypes: [],                 // keep only these types; empty = all (open strings)
    lookbackHours: 24, firstPassLookbackHours: 168,
    minUsersAffected: 0,             // seeds the floor knob of its admission brief, once (0 = no floor)
    maxFindingsPerPass: 3,           // tickets per pass (twice as many clusters are investigated)
    models: { review: "claude-sonnet-5" },  // per-stage overrides: radar, review, retrospective; others use `models`
    features: { validationGate: true },     // overrides the global flag for this pipeline's tickets
    gates: { minEvidence: 1 },       // evidence items a finding must cite (each re-found verbatim)
    briefs: { mission: "…" },        // optional seed for its briefs, read once when its v1 is written
  },
]
```

An entry may be as short as `{ id: "bug-radar", template: "bug-radar" }`: the template's values are
copied in on load, and written to the file on the next edit. Explicit values always win.

**Migration.** A config file with the old single `radar` block and no `pipelines` key becomes one
`bug-radar` pipeline carrying the old knobs (`maxFindingsPerRun` → `maxFindingsPerPass`). The old
instruction set moves, history intact, from `instructions/` to `instructions/bug-radar/`; runs,
tickets and proposals stored before pipelines belong to `bug-radar`; and `legacyClusterIds: true`
keeps the old cluster ids, so every earlier ruling still applies. An explicit `pipelines: []` means
no pipeline at all.

## Briefs: each pipeline's own instructions

Each pipeline has five versioned briefs under `instructions/<id>/`, edited in **Config >
Instructions** (pick the pipeline at the top): `mission` (what it looks for and what one ticket is),
`collector` (investigation checklist), `admission` (what counts; its front matter holds the
users-affected floor), `gate` (the adversarial reviewer's policy), `scope`. Every save is a version
of that pipeline's set; the retrospective proposes amendments per pipeline; revert is per pipeline.
Deleting a pipeline archives its set under `instructions/.deleted/`.

What stays in code for every pipeline (the rails): read-only tools, the verbatim evidence and
code-pointer checks, the JSON contracts, the caps.

## The runtime

`packages/core/src/pipelines/`:

- `schema.ts`: the pipeline entry (zod).
- `registry.ts`: config → pipelines, `instantiate`/`materialize` (template copies), each
  pipeline's instruction set.
- `runtime.ts`: one generic runtime. One pass at a time across every pipeline; a trigger that
  arrives while a pass runs (or is parked on the usage window) waits in a FIFO queue, one entry per
  pipeline. The 30 s tick fires each enabled pipeline whose schedule names the current minute.
- `schedule.ts`: `M H * * *`, cron with lists/ranges/`*/N`, `every N hours`, `manual`.
- `tickets.ts`: the narrow `TicketWriter` (create / refresh a ticket) every run writes through,
  and the external ticket schema.
- `repo-source.ts`: the built-in `repos` source (manifests, commits in the window, sensitive
  paths per watched repo; read-only git).
- `templates/`: the suggestions, data only.

`packages/core/src/pass/executor.ts` runs one pass of any pipeline: collect from its sources →
keep its signal types → correlate → floor → investigate → deterministic gate → adversarial review
→ dedupe → ticket → retrospective.

## Managing pipelines

- **Config > Pipelines**: enable toggle, schedule, last run and ticket counts; Edit, Run now,
  Instructions, Delete (with a confirm); Add from template or Add blank (a blank starts disabled
  and manual-only).
- **Setup chat**: "add a daily security check", "run the security check every 12 hours", "remove
  perf-watch". The chat patches by id: `{ "pipelines": { "<id>": { … } } }` merges into that
  entry (or adds it), `"<id>": null` removes it.
- **API**: `GET /api/pipelines`, `POST /api/pipelines` (`{ template }` or `{ blank: true, id, name }`),
  `POST /api/pipelines/:id` (fields to change), `POST /api/pipelines/:id/delete`,
  `POST /api/runs { pipelineId }` (run now; queued if one is running).
- **Wizard**: after the repos, one `[Y/n]` per template (bug-radar on, security-check off);
  `--pipelines bug-radar,security-check` for non-interactive installs.
