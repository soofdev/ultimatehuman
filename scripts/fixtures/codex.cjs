#!/usr/bin/env node
// Deterministic app-server peer. No real account, model, shell command or network.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const send = (m) => console.log(JSON.stringify(m));
const state = () => { try { return JSON.parse(fs.readFileSync(process.env.UH_CODEX_STATE, 'utf8')); } catch { return {}; } };
const log = (m) => fs.appendFileSync(process.env.UH_CODEX_LOG, JSON.stringify(m) + '\n');
log({ args: process.argv.slice(2), apiKeyPresent: !!process.env.OPENAI_API_KEY, claudeKeyPresent: !!process.env.ANTHROPIC_API_KEY });
let thread, params, pending;
function complete(text, status = 'completed', error) {
  send({ method: 'item/completed', params: { threadId: thread, item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn', status, error } } });
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (!m.method) {
    if (pending && m.id === 999) {
      const allowed = m.result?.decision === 'accept';
      if (allowed) fs.writeFileSync(process.env.UH_CODEX_LOG + '.approved', 'executed');
      complete(allowed ? 'Command completed.' : 'Command declined.'); pending = false;
    }
    return;
  }
  const reply = (result) => send({ id: m.id, result });
  const p = m.params || {};
  if (m.method === 'initialize') reply({});
  else if (m.method === 'initialized') return;
  else if (m.method === 'account/read') reply({ account: state().signedOut ? null : { type: state().apiKey ? 'apiKey' : 'chatgpt', planType: 'plus' } });
  else if (m.method === 'model/list') reply({ data: [
    { id: 'catalog-a', model: 'gpt-fixture', displayName: 'GPT Fixture', isDefault: true },
    { id: 'catalog-b', model: 'gpt-second', displayName: 'GPT Second' },
  ], nextCursor: null });
  else if (m.method === 'config/read') reply({ config: { model: 'gpt-fixture', mcp_servers: { untrusted_external: { enabled: true } } } });
  else if (m.method === 'account/rateLimits/read') reply({ rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: state().exhausted ? 100 : 11, windowDurationMins: 10080, resetsAt: 2000500000 } } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.method === 'thread/resume' && !p.threadId.startsWith('codex-')) { send({ id: m.id, error: { message: 'Unknown thread' } }); return; }
    thread = p.threadId || 'codex-' + randomUUID(); params = p;
    reply({ thread: { id: thread }, model: p.model || 'gpt-fixture' });
  } else if (m.method === 'turn/start') {
    reply({ turn: { id: 'turn', status: 'inProgress' } });
    const prompt = p.input[0].text;
    const text = prompt.split('User request: ').at(-1);
    if (text === 'HANG') return;
    if (text === 'EXIT') { process.exit(1); }
    if (text === 'FAIL') { complete('Partial output', 'failed', { message: 'Fixture turn failed' }); return; }
    if (text === 'PERMISSION') {
      pending = true;
      send({ method: 'item/started', params: { threadId: thread, item: { id: 'shell', type: 'commandExecution', command: 'printf approved', cwd: params.cwd } } });
      send({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId: thread, itemId: 'shell', command: 'printf approved', cwd: params.cwd, reason: 'Fixture command' } });
      return;
    }
    const isChat = params.developerInstructions.includes('local ultimatehuman installation');
    if (isChat) complete('Codex reply: ' + text);
    else if (prompt.includes('single word')) complete('ok');
    else if (prompt.includes('proposals')) complete(JSON.stringify({ proposals: [] }));
    else complete(JSON.stringify({ verdict: 'no_finding', reason: 'No supported finding in this fixture.' }));
  } else reply({});
});
