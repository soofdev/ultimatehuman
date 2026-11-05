// Exercises the real installer, daemon, chat, pipeline and app-server adapter.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { build } from 'esbuild';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'uh-codex-check-')));
const home = join(root, 'home');
const cli = resolve('packages/cli/dist/cli.mjs');
const fixture = join(root, 'codex.cjs');
const calls = join(root, 'codex.jsonl');
const state = join(root, 'state.json');
const claude = join(root, 'claude.cjs');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
  ULTIMATEHUMAN_HOME: home, ULTIMATEHUMAN_CONFIG: join(home, 'config.json5'), ULTIMATEHUMAN_CODEX_BIN: fixture, ULTIMATEHUMAN_CLAUDE_BIN: claude,
  UH_CODEX_LOG: calls, UH_CODEX_STATE: state, OPENAI_API_KEY: 'test-sentinel-not-a-key', ANTHROPIC_API_KEY: 'test-sentinel-not-a-key' };
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i=0;i<300;i++) { const v=await fn(); if(v)return v; await pause(); } throw Error('Timed out: '+label); };
const freePort = () => new Promise((resolve) => { const s=createServer(); s.listen(0,'127.0.0.1',()=>{ const p=s.address().port; s.close(()=>resolve(p)); }); });
let pid, key, base;
const extraPids = [];
let checks=0;
const pass = (s) => { checks++; console.log('✓ '+s); };
const api = async (path, body, status=200) => {
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'x-uh-control':key,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;
};
const messages = async () => (await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
try {
  await mkdir(home);
  await copyFile('scripts/fixtures/codex.cjs',fixture); await chmod(fixture,0o700);
  await writeFile(state,'{}');
  await writeFile(claude,`#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('claude fixture');process.exit(0)}
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const e=JSON.parse(l);if(e.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:e.request_id,response:{models:[{value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus 5.5'}]}}}));if(e.type==='user')console.log(JSON.stringify({type:'result',subtype:'success',result:'Claude reply',session_id:'claude-fixture-session',usage:{input_tokens:1,output_tokens:1}}))});
`,{mode:0o700});
  // Pure protocol checks exercise failure, cancellation, limits and approvals.
  const bundle=join(root,'adapter.mjs');
  await build({entryPoints:['packages/core/src/runner/codex.ts'],bundle:true,platform:'node',format:'esm',outfile:bundle});
  const {runCodex,readCodexModels,parseCodexLimits}=await import(bundle);
  for (const name of ['ULTIMATEHUMAN_CODEX_BIN','UH_CODEX_LOG','UH_CODEX_STATE']) process.env[name]=env[name];
  const options={cwd:root,model:'gpt-fixture',maxTurns:2,env,timeoutMs:2000};
  const catalog=await readCodexModels(root,env);
  assert.deepEqual(catalog.map(m=>m.id),['gpt-fixture','gpt-second']);
  assert.equal(parseCodexLimits({primary:{usedPercent:100,windowDurationMins:10080,resetsAt:123}}).rateLimitType,'seven_day');
  assert.equal((await runCodex({...options,prompt:'FAIL'})).ok,false);
  assert.equal((await runCodex({...options,prompt:'EXIT'})).ok,false);
  assert.equal((await runCodex({...options,prompt:'HANG',timeoutMs:150})).ok,false);
  assert.equal((await runCodex({...options,prompt:'cancelled',signal:AbortSignal.abort()})).ok,false);
  const denied=await runCodex({...options,prompt:'PERMISSION'});assert.equal(denied.text,'Command declined.');
  assert(!await readFile(calls+'.approved','utf8').catch(()=>''));
  await writeFile(state,JSON.stringify({apiKey:true}));
  assert.match((await runCodex({...options,prompt:'ok'})).error,/ChatGPT/);
  await writeFile(state,'{}');
  pass('App-server handles failure, exit, cancellation, timeouts, model IDs and usage windows; unattended requests cannot grant write access or use API credentials');

  const serverPort=await freePort();base=`http://127.0.0.1:${serverPort}`;
  const install=await exec(process.execPath,[cli,'--non-interactive','--no-open','--provider','codex','--port',String(serverPort)],{cwd:root,env,timeout:20000});
  pid=Number(await readFile(join(home,'engine.pid'),'utf8'));key=(await readFile(join(home,'control.key'),'utf8')).trim();
  assert.match(install.stdout,/existing Codex account/);assert.match(install.stdout,/CONTINUE IN YOUR BROWSER/);
  await until(async()=>!(await api('/api/chat')).busy,'opening chat');
  const initial=(await api('/api/config')).config;
  assert.equal(initial.auth.sources[0].kind,'codex_login');assert.deepEqual(initial.repos,[]);
  assert.equal((await api('/api/chat')).provider,'codex');
  assert.equal((await api('/api/workspace')).provider.label,'Codex');
  assert.equal((await api('/api/chat/models')).default,'gpt-fixture');
  assert.equal((await api('/api/models')).provider,'codex');
  pass('Fresh Codex installation verifies the existing account, opens shared chat, and exposes native models');

  await api('/api/chat/model',{model:'gpt-second'});
  await api('/api/config/models',{radar:'gpt-second'});
  assert.equal((await api('/api/config')).config.models.radar,'claude-opus-5-5');
  assert.equal((await api('/api/config')).config.codexModels.radar,'gpt-second');
  await api('/api/chat',{text:'CODEX_CONTEXT_MARKER',wait:true});
  const beforeSwitch=(await api('/api/config')).config;
  await api('/api/chat/provider',{provider:'claude'});
  assert.equal((await api('/api/chat')).model,'claude-opus-5-5');
  await api('/api/chat',{text:'CLAUDE_CONTEXT_MARKER',wait:true});
  await api('/api/chat/provider',{provider:'codex'});
  assert.equal((await api('/api/chat')).model,'gpt-second');
  const afterSwitch=(await api('/api/config')).config;
  assert.deepEqual(afterSwitch.models,beforeSwitch.models);assert.deepEqual(afterSwitch.codexModels,beforeSwitch.codexModels);assert.deepEqual(afterSwitch.pipelines,beforeSwitch.pipelines);
  await api('/api/chat',{text:'Continue after switching',wait:true});
  const turns=(await messages()).filter(m=>m.method==='turn/start');
  assert(turns.at(-1).params.input[0].text.includes('CLAUDE_CONTEXT_MARKER'));
  assert((await messages()).some(m=>m.method==='thread/resume'&&m.params.threadId.startsWith('codex-')));
  await api('/api/chat/model',{model:'claude-opus-5-5'},400);
  await writeFile(state,JSON.stringify({signedOut:true}));
  await api('/api/chat/provider',{provider:'codex'},400);
  await writeFile(state,'{}');
  pass('Provider switching preserves both model sets, pipeline settings and shared history without mixing CLI session IDs');

  // Default: the chat works like the user's own Codex session, without approval prompts.
  const fullReply=(await api('/api/chat',{text:'PERMISSION',wait:true})).reply;
  assert.equal(fullReply.text,'Command completed.');assert.equal(fullReply.provider,'codex');assert.equal(fullReply.model,'gpt-second');
  assert.equal(await readFile(calls+'.approved','utf8'),'executed');
  const chatThreads=(await messages()).filter(m=>['thread/start','thread/resume'].includes(m.method)&&m.params.developerInstructions?.includes('local ultimatehuman installation'));
  assert(chatThreads.length&&chatThreads.every(m=>m.params.sandbox==='danger-full-access'&&m.params.approvalPolicy==='never'));
  assert((await messages()).filter(m=>m.method==='turn/start').at(-1).params.sandboxPolicy.type==='dangerFullAccess');
  await rm(calls+'.approved');
  pass('Codex chat runs commands with the user’s own session rights, without approval prompts, and labels replies with CLI and model');
  await api('/api/config/features',{chatApprovals:true});
  await api('/api/chat',{text:'PERMISSION'},202);
  const request=await until(async()=>(await api('/api/chat')).permissions[0],'permission');
  await api('/api/chat/provider',{provider:'claude'},409);
  await api('/api/chat/permissions/'+request.id,{allow:false});
  await until(async()=>!(await api('/api/chat')).busy,'declined command');
  assert(!await readFile(calls+'.approved','utf8').catch(()=>''));
  await api('/api/chat',{text:'PERMISSION'},202);
  const approved=await until(async()=>(await api('/api/chat')).permissions[0],'second permission');
  await api('/api/chat/permissions/'+approved.id,{allow:true});
  await until(async()=>!(await api('/api/chat')).busy,'approved command');
  assert.equal(await readFile(calls+'.approved','utf8'),'executed');
  await api('/api/config/features',{chatApprovals:false});
  pass('With approvals switched on, Codex commands use the in-chat approval flow; provider switching waits for active work');

  const repo=join(root,'repo');await mkdir(repo);await writeFile(join(repo,'package.json'),'{"name":"codex-test"}');
  await exec('git',['init','-q',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture']);
  await api('/api/workspace/projects',{repository:repo},201);
  const project=(await api('/api/workspace')).projects[0].id;
  const started=await api('/api/workspace/investigate',{project,template:'security-check'});
  await until(async()=>{const r=(await api('/api/runs')).runs[0];return r&&['done','failed'].includes(r.phase)?r:false;},'pipeline');
  const run=(await api('/api/runs')).runs[0];assert.equal(run.phase,'done');
  assert.equal(run.provider,'codex');
  assert(run.steps.some(s=>s.step==='root_cause'&&s.model==='gpt-second'));
  const all=await messages();
  const investigations=all.filter(m=>m.method==='thread/start'&&!m.params.developerInstructions.includes('local ultimatehuman installation'));
  assert(investigations.length>=2);
  assert(investigations.every(m=>m.params.sandbox==='read-only'&&m.params.approvalPolicy==='never'));
  assert(investigations.every(m=>m.params.config.mcp_servers.untrusted_external.enabled===false));
  assert(all.filter(m=>m.args).every(m=>!m.apiKeyPresent&&!m.claudeKeyPresent));
  assert.equal((await api('/api/status')).window.usedPct,7);
  await api('/api/chat/provider',{provider:'claude'});
  assert.equal((await api('/api/status')).window.usedPct,null);
  await api('/api/chat/provider',{provider:'codex'});
  assert.equal((await api('/api/status')).window.usedPct,7);
  pass('A real pipeline run reaches completion through Codex with read-only isolation, no inherited MCP tools, and account usage reporting');
  for (const advanced of [false, true]) {
    const otherHome=join(root,advanced?'advanced-home':'codex-only-home');
    const otherEnv={...env,ULTIMATEHUMAN_HOME:otherHome,ULTIMATEHUMAN_CONFIG:join(otherHome,'config.json5'),ULTIMATEHUMAN_CLAUDE_BIN:join(root,'missing-claude')};
    const args=advanced?['init','--advanced','--provider','codex','--pipelines','none','--repos',repo]:[];
    const installed=await exec(process.execPath,[cli,...args,'--non-interactive','--no-open','--port',String(await freePort())],{cwd:repo,env:otherEnv,timeout:20000}).catch((error) => {
      // Original wizard exits 2 when no pipeline was selected (below Bronze).
      if (advanced && error.code === 2) return error;
      throw error;
    });
    extraPids.push(Number(await readFile(join(otherHome,'engine.pid'),'utf8')));
    assert.match(installed.stdout,/Codex/);
    assert.match(await readFile(join(otherHome,'config.json5'),'utf8'),/codex_login/);
  }
  pass('Codex-only machines are detected without a provider flag; the original advanced installer also supports Codex');
  console.log(`${checks} Codex integration checks passed.`);
} finally {
  for (const name of ['advanced-home','codex-only-home']) {
    const child=Number(await readFile(join(root,name,'engine.pid'),'utf8').catch(()=>''));
    if (child && !extraPids.includes(child)) extraPids.push(child);
  }
  for (const child of extraPids) { try { process.kill(child,'SIGTERM'); } catch {} }
  if (pid) { try { process.kill(pid,'SIGTERM'); } catch {} await pause(300); }
  if (process.env.UH_KEEP_CODEX_CHECK) console.log('Fixture kept at '+root);
  else await rm(root,{recursive:true,force:true});
}
