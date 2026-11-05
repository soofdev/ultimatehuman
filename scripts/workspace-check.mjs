// Exercises the shipped CLI and real HTTP/store/runtime, with a deterministic local model fixture.
// No model account, tracker, GitHub write, or OS service is used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "uh-workspace-check-")),
);
const home = join(root, "home");
const cli = resolve("packages/cli/dist/cli.mjs");
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
  ULTIMATEHUMAN_HOME: home,
  ULTIMATEHUMAN_CONFIG: join(home, "config.json5"),
  ULTIMATEHUMAN_CLAUDE_BIN: join(root, "model-fixture.cjs"),
  UH_FIXTURE_LOG: join(root, "model-calls.jsonl"),
};
delete env.CLAUDE_CODE_OAUTH_TOKEN;
delete env.ANTHROPIC_API_KEY;
const port = await new Promise((ok) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const port = s.address().port;
    s.close(() => ok(port));
  });
});
const base = `http://127.0.0.1:${port}`;
let pid;
let key;
let checks = 0;
const pass = (message) => {
  checks++;
  console.log(`✓ ${message}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body, status = 200) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-uh-control": key, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  assert.equal(res.status, status, `${path}: ${JSON.stringify(json)}`);
  return json;
}
async function repository(name) {
  const path = join(root, name);
  await mkdir(join(path, "src/auth"), { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name,
      dependencies: { next: "15.0.0", "@sentry/nextjs": "9.0.0" },
      devDependencies: { vitest: "3.0.0" },
    }),
  );
  await writeFile(
    join(path, "src/auth/session.ts"),
    "export const fixture = true;\n",
  );
  await exec("git", ["init", "-q", path]);
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", [
    "-C",
    path,
    "-c",
    "user.name=Workspace test",
    "-c",
    "user.email=workspace@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  ]);
  return path;
}
try {
  const [repoA, repoB] = await Promise.all([
    repository("checkout-fixture"),
    repository("billing-fixture"),
  ]);
  await writeFile(
    env.ULTIMATEHUMAN_CLAUDE_BIN,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fixture-1.0'); process.exit(0); }
if (process.argv.includes('auth') && process.argv.includes('status')) {
  const loggedIn = !fs.existsSync(process.env.UH_FIXTURE_LOG + '.signed-out');
  console.log(JSON.stringify({loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none'}));
  process.exit(loggedIn ? 0 : 1);
}
if (fs.existsSync(process.env.UH_FIXTURE_LOG + '.signed-out')) {
  const result = fs.existsSync(process.env.UH_FIXTURE_LOG + '.expired') ? 'Failed to authenticate: OAuth session expired and could not be refreshed' : 'Not logged in. Please run /login.';
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result,total_cost_usd:0}));
  process.exit(1);
}
let prompt = '', buffer = '';
const interactive = process.argv.includes('--input-format');
process.stdin.on('data', d => {
  if (!interactive) { prompt += d; return; }
  buffer += d;
  let n; while ((n = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0,n); buffer = buffer.slice(n+1); if (!raw) continue;
    const event = JSON.parse(raw);
    if (event.type === 'control_request') console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response:{}}}));
    if (event.type === 'user') { prompt = event.message.content; respond(); }
  }
});
process.stdin.on('end', () => { if (!interactive) respond(); });
function respond() {
  fs.appendFileSync(process.env.UH_FIXTURE_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
  const text = prompt.includes('single word') ? 'ok' : prompt.includes('proposals') ? JSON.stringify({proposals: []}) : JSON.stringify({verdict:'no_finding', reason:'Fixture investigation completed without a supported finding.'});
  setTimeout(() => {
    console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:0.01},seven_day:{utilization:0.01}}}}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:text,total_cost_usd:0,num_turns:1,usage:{input_tokens:1,output_tokens:1}}));
  }, 150);
}
`,
    { mode: 0o700 },
  );
  const installed = await exec(
    process.execPath,
    [
      cli,
      "--non-interactive",
      "--no-open",
      "--pipelines", "none",
      "--repos",
      `${repoA},${repoB}`,
      "--port",
      String(port),
    ],
    { env, timeout: 20000 },
  ).catch((e) => { assert.equal(e.code, 2, "The original installer returns 2 when no enabled pipeline was selected"); return { stdout: e.stdout }; });
  assert(installed.stdout.includes('answered in'));
  assert(installed.stdout.indexOf('answered in') < installed.stdout.indexOf('read-only: agents'), 'Claude access is verified before repository setup');
  pid = Number(await readFile(join(home, "engine.pid"), "utf8"));
  key = (await readFile(join(home, "control.key"), "utf8")).trim();
  const first = await api("/api/workspace");
  assert.equal(first.projects.length, 2);
  assert(first.projects.every((p) => p.repos[0].available));
  assert(first.projects[0].repos[0].facts.some((f) => /Next/.test(f.label)));
  assert.equal(
    first.connections.find((c) => c.id === "sentry").supported,
    false,
  );
  assert.equal((await api("/api/pipelines")).config.length, 0);
  assert.equal((await api("/api/runs")).runs.length, 0);
  assert.equal((await fetch(base + "/api/workspace")).status, 401);
  pass(
    "Fresh CLI uses the original installer, verifies Claude first, and honors the requested pipeline selection",
  );

  const project = first.projects.find((p) => p.repos[0].path === repoA);
  await writeFile(env.UH_FIXTURE_LOG + '.signed-out', '');
  const blocked = await api('/api/workspace/activation', { project: project.id, template: 'security-check' });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.checks.find(c => c.id === 'ai').ready, false);
  assert.equal(blocked.checks.find(c => c.id === 'repository').ready, true);
  await api('/api/workspace/investigate', { project: project.id, template: 'security-check' }, 400);
  assert.equal((await api('/api/pipelines')).config.length, 0);
  assert.equal((await api('/api/runs')).runs.length, 0);
  assert.equal((await api('/api/workspace')).provider.authenticated, false);
  const signedOut = await api('/api/workspace/provider/check', {});
  assert.equal(signedOut.provider.reason, 'login');
  assert.match(signedOut.provider.detail, /installed but not signed in/);
  pass('An installed but signed-out CLI blocks activation without creating a run or pipeline');
  await writeFile(env.UH_FIXTURE_LOG + '.expired', '');
  const expired = await api('/api/workspace/provider/check', {});
  assert.equal(expired.provider.reason, 'expired');
  assert.match(expired.provider.detail, /existing Claude login has expired/);
  const stale = await api('/api/workspace/activation', { project: project.id, template: 'security-check' });
  assert.match(stale.checks.find(c => c.id === 'ai').detail, /expired/);
  const beforeLoginCheck = await readFile(join(home, 'config.json5'), 'utf8');
  const resumed = await exec(process.execPath, [cli, '--non-interactive', '--no-open'], { env, timeout: 20000 });
  assert.match(resumed.stdout, /existing Claude login has expired/);
  assert.equal(await readFile(join(home, 'config.json5'), 'utf8'), beforeLoginCheck);
  await rm(env.UH_FIXTURE_LOG + '.expired');
  pass('CLI verifies existing access before the browser and preserves completed setup when its OAuth session expires');
  await rm(env.UH_FIXTURE_LOG + '.signed-out');
  const activated = await api('/api/workspace/activation', { project: project.id, template: 'security-check' });
  assert.equal(activated.ready, true);
  assert.equal(activated.checks.find(c => c.id === 'ai').ready, true);
  assert.equal((await api('/api/workspace')).provider.authenticated, true);
  const needsSignals = await api('/api/workspace/activation', { project: project.id, template: 'bug-radar', sources: ['posthog'] });
  assert.equal(needsSignals.ready, false);
  assert.equal(needsSignals.checks.find(c => c.id === 'posthog').required, true);
  pass('Activation recognizes a new login immediately and checks the selected pipeline’s required source');
  const start = await api("/api/workspace/investigate", {
    project: project.id,
    template: "security-check",
  });
  const repeat = await api("/api/workspace/investigate", {
    project: project.id,
    template: "security-check",
  });
  assert.equal(start.run.id, repeat.run.id);
  let run;
  for (let n = 0; n < 120; n++) {
    run = (await api(`/api/runs/${start.run.id}`)).run;
    if (["done", "failed", "parked"].includes(run.phase)) break;
    await sleep(100);
  }
  assert.equal(run.phase, "done", JSON.stringify(run));
  assert.deepEqual(
    run.repos.map((r) => r.path),
    [repoA],
  );
  const pipeline = (await api("/api/pipelines")).config[0];
  assert.equal(pipeline.enabled, true);
  assert.equal(pipeline.schedule, "30 6 * * *");
  assert.equal(pipeline.maxFindingsPerPass, 3);
  assert.equal(pipeline.gates.minEvidence, 1);
  assert.deepEqual(pipeline.repos, [project.repos[0].name]);
  const calls = await readFile(env.UH_FIXTURE_LOG, "utf8");
  assert(calls.includes(repoA));
  assert(!calls.includes(repoB));
  pass(
    "First investigation is deduplicated, scoped to its project, and finishes without invented findings",
  );

  await api(`/api/pipelines/${pipeline.id}`, { repos: ["missing-repo"] }, 400);
  await api(`/api/pipelines/${pipeline.id}`, {
    schedule: "0 7 * * *",
    timezone: "America/New_York",
    enabled: false,
  });
  const patched = (await api("/api/pipelines")).config[0];
  assert.deepEqual(patched.repos, pipeline.repos);
  assert.equal(patched.timezone, "America/New_York");
  await Promise.all([
    api("/api/workspace/preferences", { reserve: 30 }),
    api(`/api/workspace/repos/${project.repos[0].name}`, {
      notes: "Fixture project context",
    }),
  ]);
  const updated = await api("/api/workspace");
  assert.equal(updated.reserve, 30);
  assert.equal(
    updated.projects.find((p) => p.id === project.id).repos[0].notes,
    "Fixture project context",
  );
  pass(
    "Scope validation, schedule settings, and concurrent management edits persist correctly",
  );

  const ticket = await api(
    "/api/findings",
    {
      title: "Review fixture: checkout fails after a session expires",
      summary:
        "Synthetic UI verification case. An expired session returns an error instead of allowing the checkout to recover.",
      rootCause:
        "The fixture represents a missing recovery path after a session expires.",
      severity: "high",
      confidence: "likely",
      repo: project.repos[0].name,
      pipelineId: pipeline.id,
      evidence: [
        {
          url: "https://example.com/fixture-trace",
          label: "Synthetic trace for UI verification",
          excerpt:
            "UI TEST FIXTURE — SessionExpiredError at checkout/confirm. No production event was inspected.",
        },
      ],
      reproduction: [
        "Open the synthetic checkout fixture.",
        "Expire its test session.",
        "Attempt to confirm checkout.",
      ],
      suggestedFix:
        "Investigate restoring the session before retrying checkout.",
      source: "UI verification fixture",
    },
    201,
  );
  const id = ticket.finding.id;
  const card = (await api("/api/cockpit")).cards.find(
    (c) => c.finding?.id === id,
  );
  assert.equal(
    card.finding.evidence[0].url,
    "https://example.com/fixture-trace",
  );
  await api(
    `/api/findings/${id}/decision`,
    { action: "dismiss", expectedRuling: 0 },
    400,
  );
  const accept = await api(`/api/findings/${id}/decision`, {
    action: "accept",
    expectedRuling: 0,
  });
  assert.equal(accept.ruling.dryRun, true);
  assert.match(accept.message, /No issue was published/);
  await api(
    `/api/findings/${id}/decision`,
    { action: "dismiss", reason: "Stale browser", expectedRuling: 0 },
    409,
  );
  const reopened = await api(`/api/findings/${id}/decision`, {
    action: "reopen",
    expectedRuling: accept.ruling.id,
  });
  await api(
    `/api/findings/${id}/decision`,
    { action: "accept", expectedRuling: 0 },
    409,
  );
  const dismiss = await api(`/api/findings/${id}/decision`, {
    action: "dismiss",
    reason: "Synthetic verification case",
    expectedRuling: reopened.ruling.id,
  });
  const reopenedAgain = await api(`/api/findings/${id}/decision`, {
    action: "reopen",
    expectedRuling: dismiss.ruling.id,
  });
  const later = await api(`/api/findings/${id}/decision`, {
    action: "later",
    expectedRuling: reopenedAgain.ruling.id,
  });
  await api(`/api/findings/${id}/decision`, {
    action: "reopen",
    expectedRuling: later.ruling.id,
  });
  assert.equal(
    (await api(`/api/findings/${id}`)).finding.filedIssue,
    undefined,
  );
  pass(
    "Evidence survives; decisions require valid input, reject stale writes, and never pretend to publish an issue",
  );

  const ins = await api(`/api/instructions?pipeline=${pipeline.id}`);
  const mission = ins.briefs.find((b) => b.id === "mission");
  const edit = {
    pipelineId: pipeline.id,
    brief: "mission",
    text: mission.text + "\nPrioritize evidence from this connected project.\n",
    note: "Verify versioned guideline editing.",
    expectedVersion: ins.version,
  };
  const saved = await api("/api/instructions", edit);
  assert.equal(saved.version, ins.version + 1);
  await api("/api/instructions", edit, 409);
  await api("/api/instructions/revert", {
    pipelineId: pipeline.id,
    version: ins.version,
  });
  pass("Guideline updates keep versions and reject stale drafts");

  await exec(process.execPath, [cli, "--non-interactive", "--no-open"], {
    env,
    timeout: 10000,
  });
  assert.equal(Number(await readFile(join(home, "engine.pid"), "utf8")), pid);
  assert.equal((await api("/api/pipelines")).config.length, 1);
  assert.equal((await api("/api/runs")).runs.length, 1);
  const index = await (await fetch(base + "/projects")).text();
  const asset = index.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(base + asset)).status, 200);
  assert.equal(
    await (await fetch(base + "/administration/claims")).text(),
    index,
  );
  pass(
    "Repeat CLI invocation resumes the same engine and bundled dashboard without resetting work",
  );

  const connectorRequests = [];
  const sourceStub = createHttpServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume the read-only query body. */
    }
    connectorRequests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer phx_ConnectorFixture") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const result =
      req.url === "/api/projects/"
        ? {
            results: [
              { id: 11, name: "Connector fixture A" },
              { id: 22, name: "Connector fixture B" },
            ],
          }
        : req.url.includes("/query/")
          ? { results: [[25, 4]] }
          : { scopes: ["query:read", "project:read"] };
    res.end(JSON.stringify(result));
  });
  await new Promise((ok) => sourceStub.listen(0, "127.0.0.1", ok));
  try {
    const credentials = {
      apiKey: "phx_ConnectorFixture",
      host: `http://127.0.0.1:${sourceStub.address().port}`,
    };
    await api(
      "/api/workspace/connections/posthog",
      { credentials: { ...credentials, apiKey: "phx_InvalidFixture" } },
      400,
    );
    await api("/api/workspace/connections/posthog", { credentials }, 409);
    assert(
      !(
        await readFile(join(home, "engine.env"), "utf8").catch(() => "")
      ).includes(credentials.apiKey),
    );
    await api("/api/workspace/connections/posthog", {
      credentials,
      options: { projectId: "22" },
    });
    const connection = (await api("/api/workspace")).connections.find(
      (c) => c.id === "posthog",
    );
    assert.equal(connection.probe.ok, true);
    assert.equal(String(connection.savedOptions.projectId), "22");
    assert.equal(connection.fields.find((f) => f.key === "apiKey").value, "");
    assert(
      !(await readFile(join(home, "config.json5"), "utf8")).includes(
        credentials.apiKey,
      ),
    );
    assert(
      connectorRequests.every(
        (r) => r.startsWith("GET ") || /^POST .*\/query\/$/.test(r),
      ),
    );
    await api("/api/workspace/connections/sentry", {}, 400);
    pass(
      "Connector probes verify project selection, keep credentials out of config and responses, and reject unsupported sources",
    );
  } finally {
    await new Promise((ok) => sourceStub.close(ok));
  }

  await api(
    "/api/workspace/projects",
    { repository: repoA, project: "x".repeat(81) },
    400,
  );
  assert.equal(
    (await api("/api/workspace")).projects.length,
    2,
    "An invalid grouping must not mutate the running configuration",
  );
  await api(
    "/api/workspace/projects",
    { repository: repoB, project: project.id },
    201,
  );
  assert.equal((await api("/api/workspace")).projects.length, 1);
  const beforeRegroupRun = (await api("/api/pipelines")).config.find(p => p.id === pipeline.id);
  assert.deepEqual(beforeRegroupRun.repos, [project.repos[0].name]);
  await api(`/api/pipelines/${pipeline.id}`, { repos: first.projects.flatMap(p => p.repos.map(r => r.name)) });
  const regrouped = await api("/api/workspace/investigate", {
    project: project.id,
    template: "security-check",
  });
  assert.deepEqual(
    regrouped.run.repos.map((r) => r.path).sort(),
    [repoA, repoB].sort(),
  );
  for (let n = 0; n < 120; n++) {
    const r = (await api(`/api/runs/${regrouped.run.id}`)).run;
    if (["done", "failed"].includes(r.phase)) break;
    await sleep(100);
  }
  // Put the browser fixture back into two projects; the completed run keeps its original scope snapshot.
  await api(
    "/api/workspace/projects",
    {
      repository: repoB,
      project: first.projects.find((p) => p.id !== project.id).id,
    },
    201,
  );
  await api(`/api/pipelines/${pipeline.id}`, {
    repos: [project.repos[0].name],
  });
  pass(
    "Related repositories group correctly; scope changes only through an explicit pipeline edit",
  );

  const formModule = join(root, "pipeline-form.mjs");
  await build({entryPoints:["packages/dashboard/src/pipeline-form.ts"],outfile:formModule,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const {pipelineDraft, pipelinePatch} = await import(formModule);
  const existingConfig = {...pipeline, enabled:false, repos:undefined, timezone:undefined, sources:["*", "repos"], models:{radar:"custom-model"}, features:{validationGate:true}};
  assert.deepEqual(pipelinePatch(existingConfig, pipelineDraft(existingConfig)), {}, "Opening and saving must not overwrite saved values");
  const draft = pipelineDraft(existingConfig); draft.name = "Renamed";
  assert.deepEqual(pipelinePatch(existingConfig, draft), {name:"Renamed"}, "A name change must preserve schedule, pause state, scope, sources, model and validation overrides");
  draft.models.radar = "";
  assert.deepEqual(pipelinePatch(existingConfig, draft).models, {radar:null}, "Explicitly clearing an override restores inheritance");
  pass("Pipeline editing preserves all saved defaults and overrides, including paused schedules and inherited scope");

  const scheduleModule = join(root, "schedule.mjs");
  const liveModule = join(root, "live.mjs");
  await build({ entryPoints: ["packages/dashboard/src/workspace-live.ts"], outfile: liveModule, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { workspaceLive } = await import(liveModule);
  const { livePicture } = await import(resolve("packages/dashboard/app/lib/pipeline-live.js"));
  const at = new Date().toISOString();
  const livePipes = ["alpha", "beta"].map(id => ({ id, name: id, repos: [id], sources: ["repos"], enabled: false, schedule: "manual" }));
  const liveData = {
    workspace: { projects: ["alpha", "beta"].map(id => ({ id, repos: [{ name: id, available: true }] })), provider: { authenticated: true }, connections: [], reserve: 30 },
    pipelines: { queued: [{ pipelineId: "beta", at }] },
    runs: [{ id: "real-run-shape", pipelineId: "alpha", phase: "root_causing", startedAt: at, costUsd: 0.12, steps: [{ step: "adversarial", status: "running", model: "haiku", clusterTitle: "Evidence review" }] }],
    cockpit: { cards: [
      { pipelineId: "alpha", title: "Decision", finding: { id: "decision", repo: "alpha", createdAt: at }, ruling: null },
      { pipelineId: "alpha", title: "Validate", finding: { id: "validation", repo: "alpha", createdAt: at, validation: { state: "pending" } }, ruling: null },
      { pipelineId: "alpha", title: "Later", finding: { id: "later", repo: "alpha", createdAt: at }, ruling: { ruling: "park", at } },
      { pipelineId: "alpha", title: "Accepted", finding: { id: "accepted", repo: "alpha", createdAt: at }, ruling: { ruling: "file", at } },
      { pipelineId: "beta", title: "Other project", finding: { id: "other", repo: "beta", createdAt: at }, ruling: null },
    ], proposals: [] },
  };
  const snapshot = workspaceLive(liveData, livePipes, "all");
  const picture = livePicture(snapshot.tickets, Date.now(), snapshot.stages);
  assert.equal(picture.stages.find(s => s.key === "merge").count, 1, "A running evidence review belongs to Verifying");
  assert.equal(picture.stages.find(s => s.key === "building").count, 0);
  assert.equal(picture.stages.find(s => s.key === "queued").count, 1);
  assert.equal(picture.waiting.total, 3, "Machine verification and queued work are not human decisions");
  assert.equal(snapshot.agents.length, 1);
  assert.equal(picture.stages.find(s => s.key === "shipped").label, "Accepted");
  assert.equal(picture.shipped.reduce((sum, day) => sum + day.count, 0), 1);
  const scopedLive = workspaceLive(liveData, [livePipes[0]], "alpha");
  assert.equal(scopedLive.queued.length, 0);
  assert(!scopedLive.tickets.some(t => t.title === "Other project"));
  assert(scopedLive.tickets.find(t => t.title === "Decision").live_href.includes("finding=decision"));
  assert.equal(new URL(scopedLive.stages.find(s => s.key === "validate").href, "http://local").searchParams.get("tab"), "validate");
  assert.equal(new URL(scopedLive.stages.find(s => s.key === "decide").href, "http://local").searchParams.get("tab"), "decide");
  assert.equal(new URL(scopedLive.stages.find(s => s.key === "shipped").href, "http://local").pathname, "/review");
  assert.equal(new URL(scopedLive.stages.find(s => s.key === "shipped").href, "http://local").searchParams.get("tab"), "shipped");
  const pausedData = structuredClone(liveData);
  pausedData.runs[0].phase = "parked";
  pausedData.runs[0].steps[0].status = "parked";
  const pausedLive = workspaceLive(pausedData, livePipes, "all");
  assert.equal(pausedLive.agents.length, 0);
  assert.equal(pausedLive.tickets.find(t => t.key.startsWith("RUN-")).live_stage, "manual");
  const blankLive = workspaceLive({ ...liveData, pipelines: { queued: [] }, runs: [], cockpit: { cards: [], proposals: [] } }, livePipes, "all");
  assert.equal(blankLive.tickets.length, 0, "An idle system must not invent queued investigations");
  const original = livePicture([{ key: "OLD-1", queue: "merge", jira_created: at, createdAt: at }]);
  assert.equal(original.stages.find(s => s.key === "merge").label, "Ready to merge");
  pass("Live overview retains the original flow, scopes projects, separates human and agent work, and links to real findings");

  const setupModule = join(root, "setup-overview.mjs");
  await build({entryPoints:["packages/dashboard/src/setup-overview.ts"],outfile:setupModule,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const {setupOverview} = await import(setupModule);
  const setupData = {
    workspace:{provider:{authenticated:true},projects:[
      {id:"alpha",repos:[{name:"web",available:true,trackers:[{provider:"posthog"}]}]},
      {id:"beta",repos:[{name:"api",available:true,trackers:[]}]}
    ],connections:[{id:"posthog",name:"PostHog",supported:true,configured:false,probe:null},{id:"datadog",name:"Datadog",supported:true,configured:false,probe:null}]},
    pipelines:{config:[{id:"radar",name:"Bug radar",template:"bug-radar",sources:["*"],repos:["web"],enabled:true},{id:"audit",name:"Security check",template:"security-check",sources:["repos"],repos:["api"],enabled:false}],templates:[{id:"bug-radar",name:"Bug radar"},{id:"security-check",name:"Security check"}],queued:[]},
    runs:[]
  };
  let setup = setupOverview(setupData,"alpha");
  assert.equal(setup.pipelines.length,1);assert.equal(setup.tracked.length,1);assert.equal(setup.available.length,0);
  assert.equal(setup.steps.find(s=>s.id==="pipeline").done,false);
  assert.match(setup.next.title,/Connect PostHog/);
  assert.equal(setup.suggestions[0].id,"bug-radar");
  assert.equal(setup.suggestions[0].status,"Connection needed");
  assert.equal(setup.suggestions[0].existing.length,1,'The existing blocked radar must not become an unconfigured suggestion');
  const quiet = setupOverview(setupData,"beta");
  assert.equal(quiet.tracked.length,0);assert.equal(quiet.suggestions[0].id,"security-check");assert.equal(quiet.suggestions[0].status,"Paused");
  assert.equal(quiet.steps.find(s=>s.id==="pipeline").done,true,'A code review does not require a tracker');
  assert.match(decodeURIComponent(quiet.next.href),/"audit"/);
  setupData.runs.push({id:"empty",pipelineId:"radar",phase:"done",sources:[],findings:0});
  assert.equal(setupOverview(setupData,"alpha").completed,undefined,'A run with no readable source is not a completed first investigation');
  setupData.workspace.connections[0]={...setupData.workspace.connections[0],configured:true,probe:{ok:true}};
  setupData.runs[0].sources=[{ok:true,pluginId:"posthog"}];
  setup=setupOverview(setupData,"alpha");
  assert.equal(setup.steps.filter(s=>s.done).length,4);assert.equal(setup.next.label,"View run");
  assert.equal(setupOverview(setupData,"beta").completed,undefined,'Another project’s run must not complete this project’s setup');
  setupData.workspace.connections[0].probe.ok=false;
  assert.equal(setupOverview(setupData,"alpha").steps.find(s=>s.id==="pipeline").done,false,'A failed source recheck must revoke readiness');
  setupData.workspace.projects[0].repos[0].available=false;
  assert.match(setupOverview(setupData,"alpha").next.title,/Reconnect a repository/);
  const emptySetup=setupOverview({...setupData,workspace:{...setupData.workspace,projects:[]}},"all");
  assert.equal(emptySetup.pipelines.length,0);assert.match(emptySetup.next.title,/first project/);
  pass("Setup scopes repository wiring, preserves saved pipelines, prioritizes installed trackers, and only completes after a real readable run");
  await build({
    entryPoints: ["packages/core/src/pipelines/schedule.ts"],
    outfile: scheduleModule,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { parseSchedule, due } = await import(scheduleModule);
  const daily = parseSchedule("0 7 * * *");
  assert(due(daily, new Date("2026-07-01T11:00:00Z"), "America/New_York"));
  assert(due(daily, new Date("2026-12-01T12:00:00Z"), "America/New_York"));
  assert(!due(daily, new Date("2026-12-01T11:00:00Z"), "America/New_York"));
  pass(
    "Daily schedule honors the selected timezone across daylight saving changes",
  );

  if (process.env.UH_KEEP_FIXTURE === "1") {
    await writeFile(
      join(root, "preview.json"),
      JSON.stringify({
        home,
        base,
        pid,
        repoA,
        repoB,
        pipelineId: pipeline.id,
        findingId: id,
      }),
    );
    console.log(`Fixture retained: ${join(root, "preview.json")}`);
    pid = undefined;
  }
  console.log(`${checks} integration checks passed.`);
} finally {
  if (!pid && process.env.UH_KEEP_FIXTURE !== "1") {
    try { pid = Number(await readFile(join(home, "engine.pid"), "utf8")); } catch {}
  }
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (process.env.UH_KEEP_FIXTURE !== "1")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
