#!/usr/bin/env node
// Switchboard: one place to see and drive all of your AI agents.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { GitHub, LABELS } from './github.js';
import { Dispatcher } from './dispatcher.js';
import { attachNotifiers } from './notify.js';
import { parseCommand } from './commands.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function createApp(cfg, { store, github } = {}) {
  store ??= new Store(path.join(cfg.dataDir, 'state.json'));
  const hub = new Hub(cfg, store);
  github ??= cfg.github?.token ? new GitHub(cfg.github.token) : null;
  const dispatcher = new Dispatcher(hub, github, cfg.queue || {}, cfg.dataDir);
  attachNotifiers(hub, cfg.notify || {});
  const clients = new Set();
  hub.on('event', (e) => { const data = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(data); });

  const authorized = (req, url) => {
    if (!cfg.authToken) return true;
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(given), b = Buffer.from(cfg.authToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const body = (req) => new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });

  const defaultRepo = () => cfg.queue?.repos?.[0]?.repo;
  const resolveRepo = (name) => {
    if (!name) return defaultRepo();
    if (name.includes('/')) return name;
    return cfg.queue?.repos?.find((r) => r.repo.split('/')[1].toLowerCase() === name.toLowerCase())?.repo || defaultRepo();
  };

  async function queueTask({ title, body: text, repo, agentId }) {
    if (!github) throw Object.assign(new Error('GitHub is not configured (github.token)'), { status: 400 });
    const target = resolveRepo(repo);
    if (!target) throw Object.assign(new Error('No repo given and no queue.repos configured'), { status: 400 });
    const issue = await github.createIssue(target, {
      title, body: text || 'Queued from Switchboard.',
      labels: [cfg.queue?.label || LABELS.queued, ...(agentId ? [`agent:${agentId}`] : [])],
    });
    hub.notify('Queued', `${target}#${issue.number}: ${title}`, { url: issue.html_url });
    dispatcher.tick();
    return { repo: target, number: issue.number, url: issue.html_url };
  }

  async function runCommand({ text, sessionId }) {
    const cmd = parseCommand(text, hub);
    switch (cmd.action) {
      case 'status': {
        const running = store.sessions().filter((s) => s.status === 'running');
        const q = dispatcher.state();
        return { cmd, reply: `${running.length} session(s) working${running.length ? ': ' + running.map((s) => `${s.agentId} on "${s.title}"`).join('; ') : ''}. Queue: ${q.queued.length} waiting, ${q.active.length} in progress, ${q.enabled ? 'running' : 'paused'}.` };
      }
      case 'queue.enable': dispatcher.setEnabled(cmd.on); return { cmd, reply: `Queue ${cmd.on ? 'started' : 'paused'}.` };
      case 'queue': { const r = await queueTask({ title: cmd.title, repo: cmd.repo }); return { cmd, reply: `Queued ${r.repo}#${r.number}.`, issue: r }; }
      case 'new': {
        const { session } = hub.startSession({ agentId: cmd.agentId, prompt: cmd.prompt });
        return { cmd, reply: `Started a new ${cmd.agentId} session.`, sessionId: session.id };
      }
      case 'tell': {
        // Continue that agent's most recent idle chat; otherwise start one.
        const prev = store.sessions().find((s) => s.agentId === cmd.agentId && !s.issue && s.status !== 'running');
        if (prev) { hub.send(prev.id, cmd.prompt).catch(() => {}); return { cmd, reply: `Sent to ${cmd.agentId}.`, sessionId: prev.id }; }
        const { session } = hub.startSession({ agentId: cmd.agentId, prompt: cmd.prompt });
        return { cmd, reply: `Started ${cmd.agentId} on it.`, sessionId: session.id };
      }
      case 'message': {
        if (!sessionId) throw Object.assign(new Error('Pick a session first, or say "tell <agent> to …"'), { status: 400 });
        hub.send(sessionId, cmd.prompt).catch(() => {});
        return { cmd, reply: 'Sent.', sessionId };
      }
      default: return { cmd, reply: 'Nothing to do.' };
    }
  }

  const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (!p.startsWith('/api/')) {
        const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      if (!authorized(req, url)) return json(res, 401, { error: 'Unauthorized' });

      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && p === '/api/state') {
        return json(res, 200, {
          agents: hub.agentList(), sessions: store.sessions().slice(0, 200).map((s) => hub.sessionSummary(s)),
          queue: dispatcher.state(), activity: store.data.activity.slice(0, 50),
          repos: (cfg.queue?.repos || []).map((r) => r.repo), githubConfigured: Boolean(github),
        });
      }
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
        const s = store.session(m[1]);
        return s ? json(res, 200, s) : json(res, 404, { error: 'No such session' });
      }
      if (req.method === 'POST' && p === '/api/sessions') {
        const b = await body(req);
        if (!b.agentId || !b.prompt) return json(res, 400, { error: 'agentId and prompt are required' });
        const { session } = hub.startSession(b);
        return json(res, 201, hub.sessionSummary(session));
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/message$/))) {
        const b = await body(req);
        if (!b.prompt) return json(res, 400, { error: 'prompt is required' });
        const s = store.session(m[1]);
        if (!s) return json(res, 404, { error: 'No such session' });
        if (s.status === 'running') return json(res, 409, { error: 'Session is already working' });
        hub.send(m[1], b.prompt).catch(() => {});
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/cancel$/))) return json(res, 200, { cancelled: hub.cancel(m[1]) });
      if (req.method === 'POST' && p === '/api/queue') {
        const b = await body(req);
        if (!b.title) return json(res, 400, { error: 'title is required' });
        return json(res, 201, await queueTask(b));
      }
      if (req.method === 'POST' && p === '/api/queue/enabled') { const b = await body(req); dispatcher.setEnabled(Boolean(b.enabled)); return json(res, 200, dispatcher.state()); }
      if (req.method === 'POST' && p === '/api/queue/refresh') { await dispatcher.tick(); return json(res, 200, dispatcher.state()); }
      if (req.method === 'POST' && p === '/api/command') return json(res, 200, await runCommand(await body(req)));
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message });
    }
  });

  return { server, hub, store, dispatcher, close: () => { dispatcher.stop(); store.flush(); for (const c of clients) c.end(); server.close(); } };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cfg = loadConfig();
  const local = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
  if (!local && !cfg.authToken) {
    console.error('Refusing to listen on a network address without authToken / SWITCHBOARD_TOKEN set.');
    process.exit(1);
  }
  const app = createApp(cfg);
  app.server.listen(cfg.port, cfg.host, () => {
    console.log(`Switchboard on http://${cfg.host}:${cfg.port}  (${app.hub.agents.size} agents, GitHub ${cfg.github?.token ? 'on' : 'off'})`);
    if (cfg.queue?.repos?.length) app.dispatcher.start();
  });
  const shutdown = () => { app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
