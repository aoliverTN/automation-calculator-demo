// The hub owns agents and sessions, runs turns, and publishes everything on one event stream
// that the dashboard, VS Code extension and notifiers all listen to.
import { EventEmitter } from 'node:events';
import { makeAdapter } from './agents/index.js';

const summary = (s) => ({
  id: s.id, agentId: s.agentId, title: s.title, status: s.status, issue: s.issue, cwd: s.cwd,
  createdAt: s.createdAt, updatedAt: s.updatedAt,
  last: s.messages.at(-1)?.text?.slice(0, 280) || '',
});

function withTranscript(history, prompt) {
  if (!history.length) return prompt;
  let t = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n');
  if (t.length > 20000) t = '…' + t.slice(-20000);
  return `Conversation so far:\n\n${t}\n\n---\nNew request:\n${prompt}`;
}

export class Hub extends EventEmitter {
  constructor(config, store) {
    super();
    this.config = config;
    this.store = store;
    this.agents = new Map();
    this.running = new Map(); // sessionId -> AbortController
    for (const a of config.agents || []) {
      try {
        this.agents.set(a.id, { config: a, adapter: makeAdapter(a) });
      } catch (e) {
        console.error(`[switchboard] skipping agent ${a.id}: ${e.message}`);
      }
    }
  }

  publish(event) { this.emit('event', event); }

  notify(title, body, { level = 'info', url, sessionId } = {}) {
    const a = this.store.addActivity({ kind: 'notify', title, body, level, url, sessionId });
    this.publish({ type: 'activity', activity: a });
    this.emit('notify', { title, body, level, url, sessionId });
  }

  activeCount(agentId) {
    let n = 0;
    for (const id of this.running.keys()) if (this.store.session(id)?.agentId === agentId) n++;
    return n;
  }

  isIdle(agentId) {
    const a = this.agents.get(agentId);
    return a && this.activeCount(agentId) < (a.config.maxParallel || 1);
  }

  agentList() {
    return [...this.agents.values()].map(({ config: c, adapter }) => ({
      id: c.id, name: c.name || c.id, type: c.type, preset: c.preset, provider: c.provider, model: c.model,
      roles: c.roles || ['chat'], canResume: adapter.canResume, running: this.activeCount(c.id), maxParallel: c.maxParallel || 1,
    }));
  }

  findAgent(nameOrId) {
    const q = String(nameOrId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!q) return null;
    for (const { config: c } of this.agents.values()) {
      const names = [c.id, c.name, ...(c.aliases || [])].filter(Boolean).map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (names.some((n) => n === q)) return c;
    }
    for (const { config: c } of this.agents.values()) {
      const names = [c.id, c.name, ...(c.aliases || [])].filter(Boolean).map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (names.some((n) => n.includes(q) || q.includes(n))) return c;
    }
    return null;
  }

  sessionSummary(s) { return summary(s); }

  startSession({ agentId, prompt, title, cwd, issue, quiet = false }) {
    if (!this.agents.has(agentId)) throw Object.assign(new Error(`No agent "${agentId}"`), { status: 404 });
    const s = this.store.createSession({ agentId, title: title || prompt.slice(0, 80), cwd, issue });
    this.publish({ type: 'session.updated', session: summary(s) });
    const done = this.send(s.id, prompt, { quiet });
    return { session: s, done };
  }

  /** Runs one turn. Resolves with { ok, text, error } when the agent finishes. */
  async send(sessionId, prompt, { quiet = false } = {}) {
    const s = this.store.session(sessionId);
    if (!s) throw Object.assign(new Error('No such session'), { status: 404 });
    if (this.running.has(sessionId)) throw Object.assign(new Error('Session is already working'), { status: 409 });
    const agent = this.agents.get(s.agentId);
    if (!agent) throw Object.assign(new Error(`Agent "${s.agentId}" is not configured`), { status: 404 });

    const history = s.messages.slice();
    s.messages.push({ role: 'user', text: prompt, ts: new Date().toISOString() });
    const ac = new AbortController();
    this.running.set(sessionId, ac);
    this.store.touch(s, { status: 'running' });
    this.publish({ type: 'session.updated', session: summary(s) });
    this.publish({ type: 'agents', agents: this.agentList() });

    const log = (entry) => {
      this.store.appendLog(s, entry);
      this.publish({ type: 'session.log', sessionId, entry: s.log.at(-1) });
    };
    log({ kind: 'user', text: prompt });

    const { adapter, config } = agent;
    const effectivePrompt = adapter.kind === 'cli' && !(adapter.canResume && s.externalId) ? withTranscript(history, prompt) : prompt;
    const result = await adapter.runTurn({
      prompt: effectivePrompt,
      resumeId: adapter.canResume ? s.externalId : null,
      history,
      cwd: s.cwd || config.cwd,
      signal: ac.signal,
      timeoutMs: (config.timeoutMinutes || this.config.timeoutMinutes || 60) * 60000,
      onEvent: log,
    });

    this.running.delete(sessionId);
    if (result.externalId) s.externalId = result.externalId;
    if (result.text) s.messages.push({ role: 'assistant', text: result.text, ts: new Date().toISOString() });
    // Make sure the final answer is visible in the log even if the agent didn't stream it.
    if (result.text && s.log.filter((e) => e.kind === 'output').at(-1)?.text !== result.text) log({ kind: 'output', text: result.text });
    if (result.error) log({ kind: 'error', text: result.error });
    this.store.touch(s, { status: result.ok ? 'done' : 'error' });
    this.publish({ type: 'session.updated', session: summary(s) });
    this.publish({ type: 'agents', agents: this.agentList() });
    if (!quiet) {
      const name = config.name || config.id;
      if (result.ok) this.notify(`${name} finished`, `${s.title}\n${(result.text || '').slice(0, 300)}`, { sessionId });
      else if (result.error !== 'Cancelled') this.notify(`${name} hit a problem`, `${s.title}\n${result.error}`, { level: 'error', sessionId });
    }
    return result;
  }

  cancel(sessionId) {
    const ac = this.running.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }
}
