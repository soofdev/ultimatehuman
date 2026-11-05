// Real CLI/HTTP/store with local model and Telegram fixtures. No external account or messages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const WebSocket = createRequire(resolve('packages/core/package.json'))('ws');

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'uh-chat-check-')));
const home = join(root, 'home');
const repo = join(root, 'sample-app');
const cli = resolve('packages/cli/dist/cli.mjs');
const fixture = join(root, 'claude-fixture.cjs');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, ULTIMATEHUMAN_HOME: home, ULTIMATEHUMAN_CONFIG: join(home, 'config.json5'), ULTIMATEHUMAN_CLAUDE_BIN: fixture, UH_FIXTURE_LOG: join(root, 'calls.jsonl') };
const pause = (ms=30) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, label, timeout=15000) => { const until=Date.now()+timeout; while(Date.now()<until) { const value=await fn(); if(value)return value; await pause(); } throw Error('Timed out: '+label); };
let pid, key, base, checks=0;
const pass = (text) => { console.log('✓ '+text); checks++; };
const api = async (path, body, expected=200) => {
 const r = await fetch(base+path, { method: body===undefined?'GET':'POST', headers:{'x-uh-control':key,'content-type':'application/json'}, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
 const json = await r.json(); assert.equal(r.status,expected,JSON.stringify(json)); return json;
};
const chat = async (text, source='dashboard') => (await api('/api/chat',{text,source,wait:true})).reply;
const updates=[],sent=[]; let polls=0;
const telegram = createServer(async (req,res) => {
 let raw='';for await (const part of req) raw+=part;
 const body=JSON.parse(raw||'{}');
 let result;
 if(req.url.endsWith('/getMe')) result={id:req.url.includes('456:')?456:123,is_bot:true,username:req.url.includes('456:')?'replacement_fixture_bot':'ultimatehuman_fixture_bot'};
 else if(req.url.endsWith('/getUpdates')) { polls++; result=updates.filter(u=>u.update_id>=(body.offset||0)); await pause(100); }
 else if(req.url.endsWith('/sendMessage')) {sent.push(body);result={message_id:sent.length};}
 else {res.writeHead(404);res.end(JSON.stringify({ok:false,description:'Unknown fixture method'}));return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}));
});
await new Promise(r=>telegram.listen(0,'127.0.0.1',r));
const telegramBase=`http://127.0.0.1:${telegram.address().port}`;
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;
try {
 await mkdir(repo,{recursive:true});
 await writeFile(join(repo,'package.json'),JSON.stringify({name:'sample-app',dependencies:{next:'15.0.0'},devDependencies:{vitest:'3.0.0'}}));
 await exec('git',['init','-q',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Chat test','-c','user.email=chat@example.invalid','commit','-qm','Fixture']);
 await writeFile(fixture,`#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture-1.0');process.exit(0);}
if(process.argv.includes('auth')&&process.argv.includes('status')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
let prompt='',buffer='',pendingPermission=null;
const interactive=process.argv.includes('--input-format');
process.stdin.on('data',d=>{
 if(!interactive){prompt+=d;return;}
 buffer+=d;
 let n;while((n=buffer.indexOf('\\n'))>=0){
  const raw=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!raw)continue;
  const event=JSON.parse(raw);
  if(event.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response:fs.existsSync(process.env.UH_FIXTURE_LOG+'.no-catalog')?{}:{models:[{value:'default',resolvedModel:'claude-opus-5-5',displayName:'Default (recommended)'},{value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus 5.5'},{value:'sonnet',resolvedModel:'claude-sonnet-5-5',displayName:'Sonnet 5.5'}]}}}));
  if(event.type==='user'){prompt=event.message.content;respond();}
  if(event.type==='control_response'&&pendingPermission){
   const allowed=event.response.response?.behavior==='allow';
   if(allowed)fs.writeFileSync(process.env.ULTIMATEHUMAN_HOME+'/approved-command.txt','executed');
   finish(allowed?'Command completed.':'Command declined.');pendingPermission=null;
  }
 }
});
process.stdin.on('end',()=>{if(!interactive)respond();});
function finish(result){
 console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:0.01},seven_day:{utilization:0.01}}}}));
 console.log(JSON.stringify({type:'result',subtype:'success',result,total_cost_usd:0,num_turns:1,session_id:'shared-fixture-session',usage:{input_tokens:1,output_tokens:1}}));
}
function respond(){
 fs.appendFileSync(process.env.UH_FIXTURE_LOG,JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
 const isChat=process.argv.includes('--append-system-prompt');
 let result='ok';
 if(isChat){
   const text=prompt.split('User request: ').at(-1);
   const match=/Engine operation results[^\\n]*:\\n([^\\n]+)/.exec(prompt);
   if(text.startsWith('NATIVE_PERMISSION')){
     pendingPermission='fixture-permission';
     console.log(JSON.stringify({type:'control_request',request_id:pendingPermission,request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'printf approved > approved-command.txt',description:'Write a fixture marker'}}}));return;
   } else if(match){
     const results=JSON.parse(match[1]);
     result=results.some(r=>!r.ok)?'Operation refused: '+results.filter(r=>!r.ok).map(r=>r.error).join('; '):'Done. '+JSON.stringify(results.map(r=>r.result||r.message));
   } else if(text.startsWith('I entered my ')) {
     result='DIAGNOSIS '+(/read-access check FAILED/.test(prompt)?'failed':'unknown');
   } else if(text.startsWith('[engine] ')) {
     result='REPORT '+(/Engine result \\(authoritative\\)/.test(prompt)?'with result':'missing');
   } else if(text.startsWith('ACTION_FILE ')) result='\`\`\`workspace-action\\n'+fs.readFileSync(text.slice(12).trim(),'utf8')+'\\n\`\`\`';
   else if(text.startsWith('ACTION ')) result='\`\`\`workspace-action\\n'+text.slice(7)+'\\n\`\`\`';
   else if(text.startsWith('PATCH ')) result='\`\`\`config-patch\\n'+text.slice(6)+'\\n\`\`\`';
   else result='Which repository should I use? Send a local path or Git URL.';
 }else if(!prompt.includes('single word'))result=prompt.includes('proposals')?JSON.stringify({proposals:[]}):JSON.stringify({verdict:'no_finding',reason:'No supported finding in this fixture.'});
 finish(result);
}
`,{mode:0o700});
 const installed=await exec(process.execPath,[cli,'--non-interactive','--no-open','--port',String(port)],{cwd:repo,env,timeout:20000});
 pid=Number(await readFile(join(home,'engine.pid'),'utf8'));key=(await readFile(join(home,'control.key'),'utf8')).trim();
 assert.match(installed.stdout,/existing Claude account/);
 assert.match(installed.stdout,/CONTINUE IN YOUR BROWSER/);
 assert.match(installed.stdout,/Claude Code subscription/);
 await waitFor(async()=>!(await api('/api/chat')).busy,'initial Claude prompt');
 let history=(await api('/api/chat')).messages;
 assert.equal(history.length,1);assert.equal(history[0].role,'assistant');assert.equal(history[0].text,'Which project do you want to start with?');
 let cfg=(await api('/api/config')).config;
 assert.deepEqual(cfg.repos,[]);assert.deepEqual(cfg.pipelines,[]);
 const calls=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse);
 assert(calls[0].prompt.includes('single word'));assert(!calls.some(c=>c.args.includes('--append-system-prompt')),'The opening question needs no model call');
 pass('Fresh installation verifies Claude first and opens the shared conversation with one question, without a model call');

 const beforeCatalog=await readFile(env.UH_FIXTURE_LOG,'utf8');
 assert.equal((await fetch(base+'/api/chat/models')).status,401);
 const catalogs=await Promise.all(Array.from({length:4},()=>api('/api/chat/models')));
 const catalog=catalogs[0];
 assert.equal(catalog.default,'claude-opus-5-5');assert.equal(catalog.current,catalog.default);
 assert.deepEqual(catalog.models.map(m=>[m.id,m.label]),[['claude-opus-5-5','Opus 5.5'],['claude-sonnet-5-5','Sonnet 5.5']]);
 assert(catalog.models[0].aliases.includes('opus'));assert(catalog.models[0].aliases.includes('default'));
 assert(catalogs.every(c=>JSON.stringify(c)===JSON.stringify(catalog)));
 assert.equal(await readFile(env.UH_FIXTURE_LOG,'utf8'),beforeCatalog,'Reading model metadata must not send an inference prompt');
 assert.equal((await api('/api/chat')).messages.length,1);
 const firstAnswer=await chat('sample-app');
 assert.equal(firstAnswer.provider,'claude');assert.equal(firstAnswer.model,'claude-opus-5-5');
 const firstCall=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
 assert(firstCall.prompt.includes('Installation directory'),'The first answer knows where ultimatehuman was started');
 assert(firstCall.prompt.includes('assistant [dashboard]: Which project do you want to start with?'),'The model sees the question it is answering');
 await api('/api/chat/model',{model:'invented-model'},400);
 const beforeModel=(await api('/api/config')).config;
 await api('/api/chat/model',{model:'claude-sonnet-5-5'});
 assert.deepEqual((await api('/api/config')).config,{...beforeModel,models:{...beforeModel.models,chat:'claude-sonnet-5-5'}},'Only chat changes; pipeline models and every other setting stay intact');
 const labelled=await chat('Check the selected chat model');
 assert.equal(labelled.provider,'claude');assert.equal(labelled.model,'claude-sonnet-5-5');
 assert.equal((await api('/api/chat')).messages.at(-1).model,'claude-sonnet-5-5','Replies keep the CLI and model that wrote them');
 const selectedCall=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
 assert.equal(selectedCall.args[selectedCall.args.indexOf('--model')+1],'claude-sonnet-5-5');
 assert(selectedCall.args.some(a=>a.startsWith('--resume=')),'Changing models preserves the conversation');
 await writeFile(env.UH_FIXTURE_LOG+'.no-catalog','1');
 const unavailable=await api('/api/chat/models?refresh=1');
 assert.match(unavailable.error,/model list/);assert.equal(unavailable.models.length,0);assert.equal(unavailable.current,'claude-sonnet-5-5');
 await api('/api/chat/model',{model:'claude-opus-5-5'},503);
 await rm(env.UH_FIXTURE_LOG+'.no-catalog');
 await api('/api/chat/models?refresh=1');
 await api('/api/chat/model',{model:'claude-opus-5-5'});
 pass('Model picker uses the native CLI catalog without inference, preserves sessions and pipeline models, and recovers from catalog failure');

 await chat('ACTION '+JSON.stringify({action:'inspect_project',repository:repo}));
 const workspace=await api('/api/workspace');
 assert.equal(workspace.projects.length,1);assert(workspace.projects[0].repos[0].facts.some(f=>f.label==='Next.js'));
 assert.equal(workspace.projects[0].repos[0].trackers.length,0);
 assert.equal((await exec('git',['-C',repo,'status','--porcelain'])).stdout,'');
 const template=(await api('/api/pipelines')).templates.find(t=>t.id==='security-check');
 await chat('PATCH '+JSON.stringify({pipelines:{'chat-security':{template:'security-check',repos:['sample-app']}}}));
 const created=(await api('/api/pipelines')).config[0];
 assert.equal(created.schedule,template.pipeline.schedule);assert.equal(created.maxFindingsPerPass,template.pipeline.maxFindingsPerPass);assert.deepEqual(created.gates,template.pipeline.gates);
 assert.equal((await api('/api/runs')).runs.length,0);
 pass('Chat inspects actual tracked code and creates a scoped pipeline with the original template defaults');

 const cliReply=await exec(process.execPath,[cli,'chat','PATCH '+JSON.stringify({pipelines:{'chat-security':{enabled:false}}})],{env,timeout:20000});
 assert.match(cliReply.stdout,/Done/);
 const paused=(await api('/api/pipelines')).config[0];assert.deepEqual(paused,{...created,enabled:false});
 history=(await api('/api/chat')).messages;
 assert(history.some(m=>m.source==='cli'&&m.text.includes('PATCH')));assert(!history.at(-1).text.includes('config-patch'));
 const modelCalls=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.args.includes('--append-system-prompt'));
 assert(modelCalls.slice(1).some(c=>c.args.some(a=>a.startsWith('--resume='))));
 pass('CLI and browser resume the same Claude session; a chat edit changes only the requested field');

 await chat('ACTION '+JSON.stringify({action:'run_pipeline',pipelineId:'chat-security'}));
 await waitFor(async()=>{const runs=(await api('/api/runs')).runs;return runs.length&&runs[0].phase==='done';},'pipeline completion');
 assert.equal((await api('/api/runs')).runs[0].findings,0);
 assert.equal((await api('/api/pipelines')).config[0].enabled,false);
 const report=await waitFor(async()=>(await api('/api/chat')).messages.find(m=>m.role==='assistant'&&m.text.startsWith('REPORT')),'run report in chat');
 assert.equal(report.text,'REPORT with result','When a run the chat started finishes, the agent reports its result unprompted');
 const afterReport=(await api('/api/chat')).messages;
 assert(!afterReport.some(m=>m.role==='user'&&m.text.startsWith('[engine]')),'The engine follow-up is not shown as something the user said');
 const chatRun=(await api('/api/chat')).run;
 assert.equal(chatRun.id,(await api('/api/runs')).runs[0].id,'The chat shows the run it started');
 assert.equal(chatRun.phase,'done');assert.equal(chatRun.pipelineId,'chat-security');assert(chatRun.pipelineName);
 assert(Array.isArray(chatRun.phases)&&chatRun.phases.length>0&&Array.isArray(chatRun.pipelineSources));assert.equal(chatRun.signals,undefined,'Raw signals never travel with the chat');
 pass('A chat run request reaches the real runtime without changing the schedule or inventing findings; the chat shows that run and reports its result when it ends');

 const guidelines=await api('/api/instructions?pipeline=chat-security');
 const mission=guidelines.briefs.find(b=>b.id==='mission');
 await chat('ACTION '+JSON.stringify({action:'update_guidelines',pipelineId:'chat-security',brief:'mission',text:mission.text+'\nPrioritize authentication regressions.',note:'Focus the next pass.',expectedVersion:guidelines.version}));
 assert.equal((await api('/api/instructions?pipeline=chat-security')).version,guidelines.version+1);
 const stale=await chat('ACTION '+JSON.stringify({action:'update_guidelines',pipelineId:'chat-security',brief:'mission',text:'stale',note:'stale edit',expectedVersion:guidelines.version}));
 assert.match(stale.text,/Guidelines changed/);
 const before=(await api('/api/config')).raw;
 const refused=await chat('ACTION '+JSON.stringify({action:'shell',command:'touch /tmp/should-not-exist'}));assert.match(refused.text,/Unknown workspace operation/);
 const secretRefused=await chat('PATCH '+JSON.stringify({plugins:{posthog:{credentials:{apiKey:'raw-fixture-secret'}}}}));
 assert.match(secretRefused.text,/secret reference|connection form/);
 assert.equal((await api('/api/config')).raw,before);
 pass('Guideline edits retain version checks; unknown operations and inline source secrets are refused');

 const unprompted=await chat('NATIVE_PERMISSION allow');
 assert.equal(unprompted.text,'Command completed.');
 assert.equal(await readFile(join(home,'approved-command.txt'),'utf8'),'executed');
 assert.equal((await api('/api/chat')).permissions.length,0);
 await rm(join(home,'approved-command.txt'));
 pass('By default the chat runs commands like the user’s own Claude Code session, without approval prompts');
 await api('/api/config/features',{chatApprovals:true});
 await api('/api/chat',{text:'NATIVE_PERMISSION deny'},202);
 let permission=await waitFor(async()=>(await api('/api/chat')).permissions[0],'native permission');
 assert.equal(permission.tool,'Bash');
 assert.equal(await readFile(join(home,'approved-command.txt'),'utf8').catch(()=>null),null);
 await api('/api/chat/permissions/'+permission.id,{allow:false});
 await waitFor(async()=>!(await api('/api/chat')).busy,'denied tool');
 assert.match((await api('/api/chat')).messages.at(-1).text,/declined/);
 assert.equal(await readFile(join(home,'approved-command.txt'),'utf8').catch(()=>null),null);
 await api('/api/chat/permissions/'+permission.id,{allow:true},409);
 await api('/api/chat',{text:'NATIVE_PERMISSION allow'},202);
 permission=await waitFor(async()=>(await api('/api/chat')).permissions[0],'second native permission');
 await api('/api/chat/model',{model:'claude-sonnet-5-5'});
 await api('/api/chat',{text:'Queued while a different model is running'},202);
 await api('/api/chat/model',{model:'claude-opus-5-5'});
 await api('/api/chat/permissions/'+permission.id,{allow:'yes'},400);
 await api('/api/chat/permissions/'+permission.id,{allow:true});
 await waitFor(async()=>!(await api('/api/chat')).busy,'approved tool');
 assert.equal(await readFile(join(home,'approved-command.txt'),'utf8'),'executed');
 const queuedCalls=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse);
 const queuedCall=queuedCalls.findLast(c=>c.prompt.endsWith('User request: Queued while a different model is running'));
 const runningCall=queuedCalls.findLast(c=>c.prompt.endsWith('User request: NATIVE_PERMISSION allow'));
 assert.equal(queuedCall.args[queuedCall.args.indexOf('--model')+1],'claude-sonnet-5-5','Queued messages retain the model selected when sent');
 assert.equal(runningCall.args[runningCall.args.indexOf('--model')+1],'claude-opus-5-5','Changing the selection must not interrupt an active turn');
 await api('/api/config/features',{chatApprovals:false});
 pass('With approvals switched on, Claude shell requests pause, decline without execution, and run only after approval');

 const secret='phx_ChatConnectionFixture0123456789';
 const sourceStub=createServer(async(req,res)=>{
  for await(const chunk of req){}
  res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end('{}');return;}
  res.end(JSON.stringify(req.url==='/api/projects/'?{results:[{id:11,name:'Fixture A'},{id:22,name:'Fixture B'}]}:req.url.includes('/query/')?{results:[[25,4]]}:{scopes:['query:read','project:read']}));
 });
 await new Promise(r=>sourceStub.listen(0,'127.0.0.1',r));
 try{
  const reply=await chat('ACTION '+JSON.stringify({action:'request_connection',source:'posthog',project:'sample-app'}));
  assert.match(reply.text,/Connect PostHog below/);
  const request=(await api('/api/chat')).connections.find(r=>r.source==='posthog');
  assert.equal(request.status,'pending');
  const repeated=await api('/api/chat/connections/request',{source:'posthog',project:'sample-app'});
  assert.equal(repeated.request.id,request.id);
  assert.equal((await fetch(base+'/api/chat/connections')).status,401);
  await api('/api/chat/connections/request',{source:'sentry'},400);
  const credentials={apiKey:secret,host:'http://127.0.0.1:'+sourceStub.address().port};
  const endpoint='/api/chat/connections/'+request.id;
  const rejected=await api(endpoint,{credentials:{...credentials,apiKey:'phx_InvalidChatFixture0123456789'}});
  assert.deepEqual(rejected,{ok:false,saved:true});
  await waitFor(async()=>!(await api('/api/chat')).busy,'failed-key explanation');
  const afterReject=await api('/api/chat');
  const open=afterReject.connections.find(r=>r.id===request.id);
  assert.equal(open.status,'pending');assert.equal(open.lastAttempt.verified,false);
  assert.equal(afterReject.messages.at(-2).text,'I entered my PostHog keys.');assert.equal(afterReject.messages.at(-1).text,'DIAGNOSIS failed');
  const explained=(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.args.includes('--append-system-prompt')).at(-1).prompt;
  assert.match(explained,/PostHog rejected the key/);assert(explained.includes('UH_PENDING_POSTHOG_APIKEY'));
  assert(!explained.includes('phx_InvalidChatFixture'),'The explanation turn sees references, never the key');
  assert((await readFile(join(home,'engine.env'),'utf8')).includes('UH_PENDING_POSTHOG_APIKEY='));
  assert.equal((await api('/api/config')).config.plugins.posthog,undefined,'Keys that failed never become the configured connection');
  const selection=await api(endpoint,{credentials},409);assert.equal(selection.projects.length,2);
  assert(!(await readFile(join(home,'engine.env'),'utf8').catch(()=>'' )).includes(secret));
  await api(endpoint,{credentials,options:{projectId:'22'}});
  await waitFor(async()=>!(await api('/api/chat')).busy,'connection continuation');
  const connected=await api('/api/chat');
  assert.equal(connected.connections.find(r=>r.id===request.id).status,'connected');
  assert(connected.messages.some(m=>m.text.includes('PostHog is connected')));
  assert.equal((await stat(join(home,'engine.env'))).mode&0o777,0o600);
  assert((await readFile(join(home,'engine.env'),'utf8')).includes(secret));
  assert(!(await readFile(join(home,'engine.env'),'utf8')).includes('UH_PENDING_POSTHOG'),'A verified connection removes the failed attempt');
  assert(!JSON.stringify(connected).includes(secret));
  assert(!(await api('/api/config')).raw.includes(secret));
  const metadata=await api('/api/chat/connections');assert(!JSON.stringify(metadata).includes(secret));
  assert.equal(metadata.sources.find(s=>s.id==='posthog').fields.find(f=>f.key==='apiKey').value,'');
  await chat('I pasted '+secret);
  assert(!JSON.stringify(await api('/api/chat')).includes(secret));
  assert(!(await readFile(env.UH_FIXTURE_LOG,'utf8')).includes(secret));
  pass('The key form always accepts: a rejected key is saved apart, the chat explains it, and a verified key connects without leaking');
 }finally{sourceStub.closeAllConnections();await new Promise(r=>sourceStub.close(r));}

 // Datadog, the user's real mistake: a key ID (UUID) in the API key field. Then keys pasted into the chat, in the wrong fields.
 const ddApi='0123456789abcdef0123456789abcdef',ddApp='ddapp_FixtureApplicationKey012345678901',keyId='c0ffee00-1234-4abc-9def-0123456789ab';
 const datadog=createServer(async(req,res)=>{
  for await(const chunk of req){}
  res.setHeader('content-type','application/json');
  if(req.headers['dd-api-key']!==ddApi){res.writeHead(403);res.end('{"errors":["Forbidden"]}');return;}
  if(req.url.startsWith('/api/v1/validate')){res.end('{"valid":true}');return;}
  if(req.headers['dd-application-key']!==ddApp){res.writeHead(403);res.end('{"errors":["Forbidden"]}');return;}
  res.end(req.url.startsWith('/api/v2/logs/events')?'{"data":[]}':'{"events":[]}');
 });
 await new Promise(r=>datadog.listen(0,'127.0.0.1',r));
 try{
  const apiBase='http://127.0.0.1:'+datadog.address().port;
  await chat('ACTION '+JSON.stringify({action:'request_connection',source:'datadog',project:'sample-app'}));
  const ddRequest=(await api('/api/chat')).connections.find(r=>r.source==='datadog'&&r.status==='pending');
  const modelPrompts=async()=>(await readFile(env.UH_FIXTURE_LOG,'utf8')).trim().split('\n').map(JSON.parse).filter(c=>c.args.includes('--append-system-prompt')).map(c=>c.prompt);
  // Exactly what happened in the VM run: the ddapp_ Application key in the API key box, its key ID (UUID) in the Application key box, EU site.
  assert.deepEqual(await api('/api/chat/connections/'+ddRequest.id,{credentials:{apiKey:ddApp,appKey:keyId,site:'datadoghq.eu',apiBase}}),{ok:false,saved:true});
  await waitFor(async()=>!(await api('/api/chat')).busy,'Datadog explanation');
  const ddPrompt=(await modelPrompts()).at(-1);
  assert.match(ddPrompt,/Application key \(ddapp_…\) was in the API key field\. It was moved/);
  assert.match(ddPrompt,/held a key ID \(a UUID\)/);assert.match(ddPrompt,/"missing":\["API key"\]/);
  assert.match(ddPrompt,/at most three short lines/);assert(!/step by step/.test(ddPrompt),'A failed check no longer asks for a step-by-step walkthrough');
  assert(ddPrompt.includes('datadoghq.eu'),'The site is not a secret and stays readable');assert(!ddPrompt.includes('[redacted]'));
  assert(!ddPrompt.includes(keyId)&&!ddPrompt.includes(ddApp));
  let envFile=await readFile(join(home,'engine.env'),'utf8');
  assert(envFile.includes('UH_PENDING_DATADOG_APPKEY='+ddApp)&&!envFile.includes('UH_PENDING_DATADOG_APIKEY='),'The moved key is kept in its right field only');
  const card=(await api('/api/chat')).connections.find(r=>r.id===ddRequest.id);
  assert.deepEqual(card.missing,['API key']);
  const form=(await api('/api/chat/connections')).sources.find(s=>s.id==='datadog');
  assert.equal(form.fields.find(f=>f.key==='site').value,'datadoghq.eu','The form reopens on the site the user chose');
  assert.equal(form.fields.find(f=>f.key==='appKey').saved,true);assert.equal(form.fields.find(f=>f.key==='apiKey').saved,undefined);
  assert(!JSON.stringify(form).includes(ddApp));
  pass('A key in the wrong box is moved, a key ID is set aside, and the card and form ask only for the missing API key');

  // The user then pastes only the missing key into the chat: it is saved before storage, checked with the saved key, and never reaches the model.
  const beforePaste=(await modelPrompts()).length;
  const reply=await chat('here is the API key '+ddApi);
  const ddConfig=(await api('/api/config')).config.plugins.datadog;
  assert.equal(ddConfig.enabled,true);assert.equal(ddConfig.credentials.apiKey,'${UH_WORKSPACE_DATADOG_APIKEY}');assert.equal(ddConfig.credentials.site,'datadoghq.eu');
  envFile=await readFile(join(home,'engine.env'),'utf8');
  assert(envFile.includes('UH_WORKSPACE_DATADOG_APIKEY='+ddApi)&&envFile.includes('UH_WORKSPACE_DATADOG_APPKEY='+ddApp));
  assert(!envFile.includes('UH_PENDING_DATADOG'));
  assert.equal((await api('/api/chat')).connections.find(r=>r.id===ddRequest.id).status,'connected');
  const pastePrompts=(await modelPrompts()).slice(beforePaste);
  assert.equal(pastePrompts.length,1);assert.match(pastePrompts[0],/checked automatically/);assert.match(pastePrompts[0],/"ok":true/);
  assert(pastePrompts.every(p=>!p.includes(ddApi)&&!p.includes(ddApp)),'A pasted key never reaches the model');
  assert.match(reply.text,/^Done\./);
  let db=new DatabaseSync(join(home,'state.db'),{readOnly:true});
  let stored=db.prepare('SELECT text FROM chat').all().map(r=>r.text).join('\n');db.close();
  assert(!stored.includes(ddApi)&&!stored.includes(ddApp),'Pasted keys never reach the stored conversation');
  assert(stored.includes('here is the API key [Datadog API key saved outside the chat]'));
  assert(!JSON.stringify(await api('/api/chat')).includes(ddApi));
  pass('A key pasted in chat is saved before the message is stored, checked with the saved key, and the connection works without the model seeing it');

  // Raw values an agent passes itself (e.g. found in a .env file) are still sorted by format.
  const agentAction=join(root,'agent-action.json');
  await writeFile(agentAction,JSON.stringify({action:'connect_source',source:'datadog',credentials:{apiKey:ddApp,appKey:ddApi,apiBase}}));
  const fixed=await chat('ACTION_FILE '+agentAction);
  assert.match(fixed.text,/in each other's fields/);
  db=new DatabaseSync(join(home,'state.db'),{readOnly:true});
  stored=db.prepare('SELECT text FROM chat').all().map(r=>r.text).join('\n');db.close();
  assert(!stored.includes(ddApi)&&!stored.includes(ddApp));
  pass('Keys an agent passes in swapped fields are corrected and scrubbed from history');

  const before=(await api('/api/config')).config.plugins.datadog;
  await writeFile(agentAction,JSON.stringify({action:'connect_source',source:'datadog',credentials:{apiKey:'ffffffffffffffffffffffffffffffff',appKey:ddApp,apiBase}}));
  await chat('ACTION_FILE '+agentAction);
  assert.deepEqual((await api('/api/config')).config.plugins.datadog,before,'A failed replacement never breaks a working connection');
  assert((await readFile(join(home,'engine.env'),'utf8')).includes('UH_WORKSPACE_DATADOG_APIKEY='+ddApi));
  pass('Failed replacement keys are kept apart and never overwrite a working connection');
 }finally{datadog.closeAllConnections();await new Promise(r=>datadog.close(r));}

 await chat('PATCH '+JSON.stringify({chat:{telegram:{apiBase:telegramBase}}}));
 assert.equal((await fetch(base+'/api/chat/telegram')).status,401);
 const token='123:local_fixture_token';
 const paired=await api('/api/chat/telegram/connect',{token});
 assert.equal(paired.paired,false);assert.match(paired.link,/https:\/\/t.me\/ultimatehuman_fixture_bot\?start=/);assert.equal(sent.length,0);
 assert.equal((await stat(join(home,'engine.env'))).mode&0o777,0o600);
 assert(!(await api('/api/config')).raw.includes(token));assert(!JSON.stringify((await api('/api/chat')).messages).includes(token));
 const code=new URL(paired.link).searchParams.get('start');
 updates.push({update_id:1,message:{chat:{id:111,type:'private'},text:'hello'}},{update_id:2,message:{chat:{id:222,type:'group'},text:'/start '+code}},{update_id:3,message:{chat:{id:333,type:'private'},text:'/start wrong'}});
 const startPoll=polls;await waitFor(()=>polls>=startPoll+2,'unpaired messages processed');
 assert.equal((await api('/api/chat/telegram')).paired,false);
 updates.push({update_id:4,message:{chat:{id:444,type:'private'},text:'/start '+code}});
 await waitFor(async()=>(await api('/api/chat/telegram')).paired,'Telegram pairing');
 const count=(await api('/api/chat')).messages.length;
 updates.push({update_id:5,message:{chat:{id:555,type:'private'},text:'Unauthorised request'}},{update_id:6,message:{chat:{id:444,type:'private'},text:'Hello from Telegram'}});
 await waitFor(async()=>(await api('/api/chat')).messages.length>=count+2,'Telegram reply');
 history=(await api('/api/chat')).messages;
 assert.equal(history.filter(m=>m.text==='Hello from Telegram').length,1);assert(!history.some(m=>m.text==='Unauthorised request'));assert.equal(history.at(-1).source,'telegram');
 assert(sent.every(m=>m.chat_id===444));
 assert.equal((await api('/api/chat/telegram/connect',{})).paired,true);
 await writeFile(join(home,'engine.env'),'UH_CHAT_BOT_TOKEN=456:replacement_fixture_token\n',{mode:0o600});
 const replaced=await api('/api/chat/telegram/connect',{});
 assert.equal(replaced.paired,false);assert.equal(replaced.username,'replacement_fixture_bot');assert.match(replaced.link,/\?start=/);
 pass('Telegram tokens stay outside chat; private expiring pairing rejects other chats and shares the conversation');

 await api('/api/chat/start',{directory:'/should-not-reinitialize'});
 assert.equal((await api('/api/chat')).messages.length,history.length);
 pass('Reopening setup preserves conversation history instead of restarting onboarding');
 if(process.env.UH_KEEP_FIXTURE!=='1'){
  const login=await api('/api/auth/link',{});
  const code=new URL(login.url).hash.slice('#code='.length);
  const redeemed=await fetch(base+'/api/auth/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
  const cookie=redeemed.headers.get('set-cookie').split(';')[0];
  const socket=new WebSocket(base.replace('http:','ws:')+'/api/events',{headers:{cookie}});
  await new Promise((ok,fail)=>{socket.once('open',ok);socket.once('error',fail);});
  process.kill(pid,'SIGTERM');
  await waitFor(()=>{try{process.kill(pid,0);return false;}catch{return true;}},'engine exits with an open dashboard',5000);
  pid=undefined;
  assert.equal(socket.readyState,WebSocket.CLOSED);
  pass('The engine exits cleanly while a live dashboard socket is connected');
 }
 console.log(`${checks} chat integration checks passed.`);
 if(process.env.UH_KEEP_FIXTURE==='1'){
  await writeFile(join(root,'preview.json'),JSON.stringify({home,base,pid,repo}));
  console.log('Fixture retained: '+join(root,'preview.json'));pid=undefined;
 }
} finally {
 if(pid){try{process.kill(pid,'SIGTERM');}catch{}}
 telegram.closeAllConnections();await new Promise(r=>telegram.close(r));
 if(process.env.UH_KEEP_FIXTURE!=='1')await rm(root,{recursive:true,force:true});
}
