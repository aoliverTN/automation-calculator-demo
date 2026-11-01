import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Hub } from '../src/hub.js';
import { parseCommand } from '../src/commands.js';
import { attachNotifiers } from '../src/notify.js';
import { parseVerdict, smokeTest } from '../src/pipeline.js';
import { buildCommand } from '../src/agents/cli.js';
import { apiAdapter } from '../src/agents/api.js';
import { Dispatcher } from '../src/dispatcher.js';
import { createApp } from '../src/server.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const fakeAgent = (id, extra = {}) => ({ id, type: 'cli', preset: 'shell', command: process.execPath, args: [FAKE, '{prompt}'], resumeArgs: ['--resume', '{resume}'], ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
const once = (hub, pred) => new Promise((r) => { const f = (e) => { if (pred(e)) { hub.off('event', f); r(e); } }; hub.on('event', f); });

test('claude-code preset builds headless command with resume and model', () => {
  const c = buildCommand({ id: 'c', type: 'cli', preset: 'claude-code', model: 'opus' }, { prompt: 'hi', resumeId: 'abc' });
  assert.equal(c.command, 'claude');
  assert.deepEqual(c.args, ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--resume', 'abc', '--model', 'opus']);
  const parsed = c.parse(JSON.stringify({ type: 'result', result: 'all done', session_id: 's1' }));
  assert.equal(parsed.final, 'all done');
  assert.equal(parsed.externalId, 's1');
});

test('hub runs a CLI agent, keeps its session id, and resumes it', async () => {
  const hub = new Hub({ agents: [fakeAgent('fake')] }, new Store(null));
  const { session, done } = hub.startSession({ agentId: 'fake', prompt: 'hello' });
  const r1 = await done;
  assert.equal(r1.ok, true);
  assert.equal(r1.text, 'done: hello');
  assert.equal(session.externalId, 'fake-session-1');
  const r2 = await hub.send(session.id, 'again');
  assert.equal(r2.text, 'done: again (resumed fake-session-1)');
  assert.equal(session.status, 'done');
  assert.equal(session.messages.length, 4);
  assert.ok(session.log.some((e) => e.text === 'working on it'));
  assert.equal(session.log.at(-1).text, 'done: again (resumed fake-session-1)');
});

test('hub reports agent failures', async () => {
  const hub = new Hub({ agents: [fakeAgent('fake')] }, new Store(null));
  const notes = [];
  hub.on('notify', (n) => notes.push(n));
  const r = await hub.startSession({ agentId: 'fake', prompt: 'please fail' }).done;
  assert.equal(r.ok, false);
  assert.match(r.error, /code 3/);
  assert.equal(notes[0].level, 'error');
});

test('voice/typed commands route to the right agent', () => {
  const hub = new Hub({ agents: [
    fakeAgent('claude-main', { name: 'Claude Code', aliases: ['claude'] }),
    fakeAgent('grok', { name: 'Grok' }),
  ] }, new Store(null));
  assert.deepEqual(parseCommand('Tell Claude to add dark mode to the calculator.', hub), { action: 'tell', agentId: 'claude-main', prompt: 'add dark mode to the calculator' });
  assert.deepEqual(parseCommand('ask grok what is new in the xAI API', hub), { action: 'tell', agentId: 'grok', prompt: 'what is new in the xAI API' });
  assert.deepEqual(parseCommand('tell claude code to run the tests', hub), { action: 'tell', agentId: 'claude-main', prompt: 'run the tests' });
  assert.deepEqual(parseCommand('new chat with grok: compare databases', hub), { action: 'new', agentId: 'grok', prompt: 'compare databases' });
  assert.deepEqual(parseCommand('queue fix the footer link in automation-calculator-demo', hub), { action: 'queue', title: 'fix the footer link', repo: 'automation-calculator-demo' });
  assert.deepEqual(parseCommand('status', hub), { action: 'status' });
  assert.deepEqual(parseCommand('pause the queue', hub), { action: 'queue.enable', on: false });
  assert.deepEqual(parseCommand('also add a unit test', hub), { action: 'message', prompt: 'also add a unit test' });
});

test('notifications go to ntfy and Teams', async () => {
  const calls = [];
  const hub = new Hub({ agents: [] }, new Store(null));
  const n = attachNotifiers(hub, { ntfy: { topic: 'my-topic' }, teams: { webhookUrl: 'https://teams.example/hook' } }, async (url, opts) => { calls.push({ url, opts }); return { ok: true }; });
  assert.equal(n, 2);
  hub.notify('Claude finished', 'Built the thing', { url: 'https://github.com/x/y/pull/1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls[0].url, 'https://ntfy.sh/my-topic');
  assert.equal(calls[0].opts.headers.Click, 'https://github.com/x/y/pull/1');
  const card = JSON.parse(calls[1].opts.body).attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.content.body[0].text, 'Claude finished');
});

test('API adapter speaks OpenAI-compatible (Grok/ChatGPT/Gemini) and Anthropic', async () => {
  process.env.XAI_API_KEY = 'k';
  let seen;
  const grok = apiAdapter({ id: 'grok', type: 'api', provider: 'xai', model: 'grok-4' }, async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.authorization }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi from grok' } }] }) }; });
  const r = await grok.runTurn({ prompt: 'yo', history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] });
  assert.equal(r.text, 'hi from grok');
  assert.equal(seen.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(seen.body.messages.length, 3);
  delete process.env.ANTHROPIC_API_KEY;
  const missing = await apiAdapter({ id: 'c', type: 'api', provider: 'anthropic', model: 'm' }).runTurn({ prompt: 'x' });
  assert.match(missing.error, /ANTHROPIC_API_KEY/);
});

test('pipeline verdicts and HTTP smoke test', async () => {
  assert.equal(parseVerdict('blah\nVERDICT: approve'), 'APPROVE');
  assert.equal(parseVerdict('VERDICT: APPROVE\n...\nVERDICT: CHANGES'), 'CHANGES');
  assert.equal(parseVerdict('nothing'), null);
  const srv = http.createServer((req, res) => { res.writeHead(req.url === '/broken' ? 500 : 200); res.end('<h1>Savings Calculator</h1>'); }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const noPw = () => Promise.reject(new Error('no playwright'));
  const good = await smokeTest({ url: base, paths: ['/'], expectText: 'Savings', rounds: 3 }, tmp(), noPw);
  assert.equal(good.ok, true);
  const bad = await smokeTest({ url: base, paths: ['/', '/broken'] }, tmp(), noPw);
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /HTTP 500/);
  srv.close();
});

test('dispatcher: queued issue → agent codes in a worktree → review → PR', async () => {
  // A local "GitHub" remote with a main branch.
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', remote, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: seed, stdio: 'ignore' });
  g('add', '.'); g('commit', '-m', 'init'); g('push', 'origin', 'main');

  const calls = [];
  const issue = { repo: 'me/app', number: 7, title: 'Add a change file', body: 'Please add CHANGE.txt', url: 'https://github.com/me/app/issues/7', labels: ['sb:queued'] };
  let served = false;
  const gh = {
    listQueued: async () => (served ? [] : ((served = true), [issue])),
    moveLabel: async (...a) => calls.push(['moveLabel', ...a]),
    comment: async (...a) => calls.push(['comment', ...a]),
    createPR: async (repo, pr) => { calls.push(['createPR', repo, pr]); return { number: 99, html_url: 'https://github.com/me/app/pull/99' }; },
  };
  const hub = new Hub({ agents: [fakeAgent('coder', { roles: ['coder'] }), fakeAgent('reviewer', { roles: ['reviewer'] })] }, new Store(null));
  const notes = [];
  hub.on('notify', (n) => notes.push(n));
  const d = new Dispatcher(hub, gh, { autoStart: true, workspaceDir: path.join(root, 'ws'), repos: [{ repo: 'me/app', base: 'main', cloneUrl: remote, test: ['test -f CHANGE.txt'] }] }, root);
  const finished = new Promise((r) => hub.on('notify', (n) => n.title.startsWith('Ready') || n.title.startsWith('Failed') || n.title.startsWith('Needs') ? r(n) : null));
  await d.tick();
  const n = await finished;
  assert.equal(n.title, 'Ready to review: Add a change file', JSON.stringify(notes));
  const pr = calls.find((c) => c[0] === 'createPR')[2];
  assert.equal(pr.head, 'sb/issue-7');
  assert.equal(pr.draft, false);
  assert.match(pr.body, /Closes #7/);
  assert.match(pr.body, /✅ Build & tests/);
  assert.match(pr.body, /✅ Code review \(reviewer\)/);
  assert.deepEqual(calls.filter((c) => c[0] === 'moveLabel').map((c) => c[4]), ['sb:working', 'sb:review']);
  // The branch really landed on the remote.
  const files = execFileSync('git', ['--git-dir', remote, 'ls-tree', '--name-only', 'sb/issue-7']).toString();
  assert.match(files, /CHANGE\.txt/);
  d.stop();
});

test('HTTP API: auth, start session, command, live events', async () => {
  const dataDir = tmp();
  const app = createApp({ dataDir, authToken: 'secret', agents: [fakeAgent('fake', { name: 'Fake' })] });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (p, body, token = 'secret') => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  assert.equal((await call('/api/state', null, 'wrong')).status, 401);
  assert.equal((await fetch(base + '/')).status, 200); // dashboard shell is public; data is not

  const doneEvt = once(app.hub, (e) => e.type === 'session.updated' && e.session.status === 'done');
  const created = await (await call('/api/sessions', { agentId: 'fake', prompt: 'hi there' })).json();
  await doneEvt;
  const s = await (await call(`/api/sessions/${created.id}`)).json();
  assert.equal(s.messages.at(-1).text, 'done: hi there');

  const doneEvt2 = once(app.hub, (e) => e.type === 'session.updated' && e.session.status === 'done');
  const r = await (await call('/api/command', { text: 'tell fake to keep going' })).json();
  assert.equal(r.sessionId, created.id);
  await doneEvt2;
  const s2 = await (await call(`/api/sessions/${created.id}`)).json();
  assert.equal(s2.messages.at(-1).text, 'done: keep going (resumed fake-session-1)');

  const state = await (await call('/api/state')).json();
  assert.equal(state.agents[0].name, 'Fake');
  assert.ok(state.activity.some((a) => a.title === 'Fake finished'));
  app.close();
  assert.ok(fs.existsSync(path.join(dataDir, 'state.json')));
});
