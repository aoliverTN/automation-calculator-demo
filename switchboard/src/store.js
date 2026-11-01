// Tiny JSON-file persistence. Good enough for one user and a few thousand sessions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_LOG = 2000;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { sessions: {}, activity: [] };
    if (file && fs.existsSync(file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* start fresh */ }
    }
    // Anything that was running when we stopped is no longer running.
    for (const s of Object.values(this.data.sessions)) if (s.status === 'running') s.status = 'interrupted';
    this._timer = null;
  }

  save() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  createSession({ agentId, title, cwd, issue }) {
    const now = new Date().toISOString();
    const s = {
      id: randomUUID(), agentId, title: title || 'Untitled', cwd: cwd || null, issue: issue || null,
      status: 'idle', externalId: null, messages: [], log: [], createdAt: now, updatedAt: now,
    };
    this.data.sessions[s.id] = s;
    this.save();
    return s;
  }

  session(id) { return this.data.sessions[id]; }

  sessions() {
    return Object.values(this.data.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  touch(s, patch = {}) {
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    this.save();
  }

  appendLog(s, entry) {
    s.log.push({ ts: new Date().toISOString(), ...entry });
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    this.save();
  }

  addActivity(item) {
    const a = { ts: new Date().toISOString(), ...item };
    this.data.activity.unshift(a);
    this.data.activity.length = Math.min(this.data.activity.length, 300);
    this.save();
    return a;
  }
}
