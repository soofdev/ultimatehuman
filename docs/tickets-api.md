# Tickets API: enqueue a ticket from any tool

The cockpit's ticket queue is open: any tool on the machine (a script, a CI job, another agent)
can put a ticket in it. It lands in **Needs decision** (or **Awaiting validation** when the
validation gate is on for its pipeline) with a pipeline badge, and is ruled on like any other
(file, dismiss, not now).

```
POST /api/findings
x-uh-control: <the install's control key, ~/.ultimatehuman/control.key>
content-type: application/json
```

A signed-in dashboard session (cookie + CSRF header) works too.

## Body

| field | required | notes |
| --- | --- | --- |
| `title` | yes | 3–120 characters |
| `summary` | yes | what happens, a paragraph (shown as the symptom) |
| `pipelineId` | no | a configured pipeline id; default `"external"` (badge "External") |
| `severity` | no | `critical` · `high` · `medium` (default) · `low` |
| `confidence` | no | `confirmed` · `likely` (default) |
| `rootCause` | no | one sentence; default "Not established" |
| `repo` | no | a configured repo name (repo badge) |
| `fingerprint` | no | stable id of the problem; one open ticket per fingerprint (409 while it is open) |
| `evidence` | no | up to 10 `{ url, label?, excerpt? }` |
| `reproduction` | no | list of steps |
| `suggestedFix` | no | direction only |
| `source` | no | name of the reporting tool |

Unknown fields are refused (400 with the list of problems).

## Example

```sh
curl -s -X POST http://127.0.0.1:4747/api/findings \
  -H "x-uh-control: $(cat ~/.ultimatehuman/control.key)" \
  -H 'content-type: application/json' \
  -d '{"title":"Nightly export job failed 3 nights in a row","summary":"The S3 export cron exits 1 since Tuesday.","severity":"high","source":"cron-watch","evidence":[{"url":"https://ci.example.test/jobs/812","label":"job 812 log"}]}'
```

`201 { ok: true, finding }` on success. Responses: `400` invalid body / unknown pipeline / unknown
repo, `401` no session and no control key, `409` an open ticket already has this fingerprint.

Runs never write tickets directly either: every pipeline run goes through the same narrow
`TicketWriter` interface (create / refresh), `packages/core/src/pipelines/tickets.ts`.
