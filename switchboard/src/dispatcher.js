// Keeps your agents fed. GitHub Issues labelled `sb:queued` are the to-do list (add them from
// GitHub, the dashboard, by voice, or from Teams). Each idle coding agent takes the next one,
// works on it in its own git worktree, goes through the quality gate, and opens a PR.
// It never merges: you stay the one who ships.
import fs from 'node:fs';
import path from 'node:path';
import { LABELS } from './github.js';
import { ensureRepo, createWorktree, commitAllIfDirty, commitsAhead, logAgainst, push } from './git.js';
import { runPipeline } from './pipeline.js';

export class Dispatcher {
  constructor(hub, github, cfg, dataDir) {
    this.hub = hub;
    this.gh = github;
    this.cfg = { pollSeconds: 60, maxFixRounds: 2, ...cfg };
    this.workspaceDir = cfg.workspaceDir || path.join(dataDir, 'workspaces');
    this.artifactsDir = path.join(dataDir, 'artifacts');
    this.enabled = Boolean(cfg.autoStart);
    this.active = new Map(); // "owner/repo#12" -> { agentId, step, sessionId, startedAt }
    this.queued = [];
    this.lastError = null;
  }

  state() {
    return {
      enabled: this.enabled,
      repos: (this.cfg.repos || []).map((r) => r.repo),
      active: [...this.active.entries()].map(([key, v]) => ({ key, ...v })),
      queued: this.queued,
      lastError: this.lastError,
    };
  }

  publish() { this.hub.publish({ type: 'queue', queue: this.state() }); }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.cfg.pollSeconds * 1000);
    this.tick();
  }

  stop() { clearInterval(this.timer); }

  setEnabled(on) { this.enabled = on; this.publish(); if (on) this.tick(); }

  coderFor(repoCfg, issue) {
    const pinned = issue.labels.find((l) => l.startsWith('agent:'))?.slice(6);
    const candidates = pinned ? [pinned] : repoCfg.coders || [...this.hub.agents.values()].filter((a) => (a.config.roles || []).includes('coder')).map((a) => a.config.id);
    return candidates.find((id) => this.hub.isIdle(id) && ![...this.active.values()].some((w) => w.agentId === id));
  }

  async tick() {
    if (this.ticking || !this.gh) return;
    this.ticking = true;
    try {
      const all = [];
      for (const repoCfg of this.cfg.repos || []) {
        const issues = await this.gh.listQueued(repoCfg.repo, this.cfg.label || LABELS.queued);
        all.push(...issues.map((i) => ({ number: i.number, repo: i.repo, title: i.title, url: i.url })));
        if (!this.enabled) continue;
        for (const issue of issues) {
          const key = `${issue.repo}#${issue.number}`;
          if (this.active.has(key)) continue;
          const agentId = this.coderFor(repoCfg, issue);
          if (!agentId) break;
          this.work(repoCfg, issue, agentId);
        }
      }
      this.queued = all.filter((i) => !this.active.has(`${i.repo}#${i.number}`));
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      console.error('[dispatcher]', e.message);
    } finally {
      this.ticking = false;
      this.publish();
    }
  }

  async work(repoCfg, issue, agentId) {
    const key = `${issue.repo}#${issue.number}`;
    const job = { agentId, step: 'preparing', title: issue.title, url: issue.url, startedAt: new Date().toISOString() };
    this.active.set(key, job);
    const step = (s) => { job.step = s; this.publish(); };
    const base = repoCfg.base || 'main';
    const branch = `sb/issue-${issue.number}`;
    try {
      await this.gh.moveLabel(issue.repo, issue.number, LABELS.queued, LABELS.working);
      await this.gh.comment(issue.repo, issue.number, `🤖 Switchboard picked this up. **${agentId}** is working on it on branch \`${branch}\`.`);

      const repoDir = await ensureRepo(this.workspaceDir, issue.repo, repoCfg.cloneUrl);
      const dir = await createWorktree(repoDir, branch, base);
      // Per-repo settings can live in the repo itself, in .switchboard.json
      const inRepo = path.join(dir, '.switchboard.json');
      const cfg = { ...repoCfg, ...(fs.existsSync(inRepo) ? JSON.parse(fs.readFileSync(inRepo, 'utf8')) : {}) };

      step('coding');
      const { session, done } = this.hub.startSession({
        agentId, cwd: dir, issue: { repo: issue.repo, number: issue.number, url: issue.url },
        title: `#${issue.number} ${issue.title}`, quiet: true,
        prompt: [
          `You are working on GitHub issue #${issue.number} in ${issue.repo}: "${issue.title}"`,
          issue.body ? `Issue description:\n${issue.body}` : '',
          cfg.instructions || '',
          `You are in a git worktree on branch ${branch}. Make the change, run the project's tests if it has any, and commit your work with clear messages. Do not push and do not open a PR: Switchboard will review, test, push and open the PR. Finish with a short summary of what you changed.`,
        ].filter(Boolean).join('\n\n'),
      });
      job.sessionId = session.id;
      let result = await done;

      let passed = false, report = '', round = 0;
      while (true) {
        if (!result.ok) throw new Error(`${agentId} failed: ${result.error}`);
        await commitAllIfDirty(dir, `#${issue.number}: ${issue.title}`);
        if ((await commitsAhead(dir, base)) === 0) throw new Error(`${agentId} finished without changing anything.\n\n${result.text || ''}`);
        step(round ? `re-checking (round ${round + 1})` : 'checking');
        const p = await runPipeline({ hub: this.hub, dir, base, cfg, issue, artifactsDir: path.join(this.artifactsDir, `${issue.repo.replace('/', '__')}-${issue.number}`) });
        passed = p.passed; report = p.report;
        if (passed || round >= this.cfg.maxFixRounds) break;
        round++;
        step(`fixing (round ${round})`);
        result = await this.hub.send(session.id, `Your change did not pass review/testing yet. Fix these problems, then commit:\n\n${p.feedback}`, { quiet: true });
      }

      step('opening PR');
      await push(dir, branch);
      const commits = await logAgainst(dir, base);
      const pr = await this.gh.createPR(issue.repo, {
        title: `${passed ? '' : '[needs attention] '}${issue.title}`,
        head: branch, base, draft: !passed,
        body: `Closes #${issue.number}\n\nWritten by **${agentId}** through Switchboard.\n\n**Commits**\n\`\`\`\n${commits}\n\`\`\`\n\n## Checks\n\n${report}`,
      });
      await this.gh.moveLabel(issue.repo, issue.number, LABELS.working, passed ? LABELS.review : LABELS.failed);
      this.hub.notify(
        passed ? `Ready to review: ${issue.title}` : `Needs your eyes: ${issue.title}`,
        `${issue.repo} PR #${pr.number} by ${agentId}${passed ? ' passed all checks.' : ` still failing after ${round} fix round(s).`}`,
        { level: passed ? 'info' : 'warn', url: pr.html_url, sessionId: session.id },
      );
    } catch (e) {
      await this.gh.moveLabel(issue.repo, issue.number, LABELS.working, LABELS.failed).catch(() => {});
      await this.gh.comment(issue.repo, issue.number, `⚠️ Switchboard could not finish this:\n\n\`\`\`\n${String(e.message).slice(0, 3000)}\n\`\`\``).catch(() => {});
      this.hub.notify(`Failed: ${issue.title}`, `${key}: ${String(e.message).slice(0, 300)}`, { level: 'error', url: issue.url });
    } finally {
      this.active.delete(key);
      this.publish();
      if (this.enabled) setTimeout(() => this.tick(), 1000);
    }
  }
}
