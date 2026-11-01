// Minimal GitHub REST client. Uses a fine-grained personal access token with
// Issues + Pull requests + Contents read/write on the repos you want worked.
export const LABELS = { queued: 'sb:queued', working: 'sb:working', review: 'sb:review', failed: 'sb:failed' };

export class GitHub {
  constructor(token, fetchImpl = globalThis.fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async req(method, path, body) {
    const res = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'switchboard',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${j?.message || ''}`.trim());
    return j;
  }

  /** Open issues with the queue label, oldest first, `priority:high` first. */
  async listQueued(repo, label = LABELS.queued) {
    const items = await this.req('GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=50`);
    const issues = items.filter((i) => !i.pull_request).map((i) => ({
      repo, number: i.number, title: i.title, body: i.body || '', url: i.html_url,
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    }));
    const pri = (i) => (i.labels.includes('priority:high') ? 0 : i.labels.includes('priority:low') ? 2 : 1);
    return issues.sort((a, b) => pri(a) - pri(b));
  }

  addLabels(repo, n, labels) { return this.req('POST', `/repos/${repo}/issues/${n}/labels`, { labels }); }
  removeLabel(repo, n, label) { return this.req('DELETE', `/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`).catch(() => null); }
  async moveLabel(repo, n, from, to) { await this.removeLabel(repo, n, from); await this.addLabels(repo, n, [to]); }
  comment(repo, n, body) { return this.req('POST', `/repos/${repo}/issues/${n}/comments`, { body }); }
  createIssue(repo, { title, body, labels }) { return this.req('POST', `/repos/${repo}/issues`, { title, body, labels }); }
  createPR(repo, { title, body, head, base, draft = false }) { return this.req('POST', `/repos/${repo}/pulls`, { title, body, head, base, draft }); }
}
