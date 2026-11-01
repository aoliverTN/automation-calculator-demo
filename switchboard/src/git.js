import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function run(cmd, args, { cwd, env, timeoutMs = 30 * 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err?.message });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

export const sh = (command, opts) => run('sh', ['-c', command], opts);

async function git(args, cwd) {
  const r = await run('git', args, { cwd });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.error}`);
  return r.stdout.trim();
}

/** Make sure a clone of owner/repo exists under workspaceDir and is fetched. */
export async function ensureRepo(workspaceDir, repo, cloneUrl) {
  const dir = path.join(workspaceDir, repo.replace('/', '__'));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    await git(['clone', cloneUrl || `git@github.com:${repo}.git`, dir], workspaceDir);
  }
  await git(['fetch', 'origin', '--prune'], dir);
  return dir;
}

/** A fresh worktree on `branch`, starting from origin/base. Agents never touch your main checkout. */
export async function createWorktree(repoDir, branch, base) {
  const wt = path.join(repoDir, '..', '.worktrees', `${path.basename(repoDir)}--${branch.replace(/[^\w.-]/g, '_')}`);
  if (fs.existsSync(wt)) await run('git', ['worktree', 'remove', '--force', wt], { cwd: repoDir });
  await run('git', ['worktree', 'prune'], { cwd: repoDir });
  await git(['worktree', 'add', '-B', branch, wt, `origin/${base}`], repoDir);
  return wt;
}

export async function commitAllIfDirty(dir, message) {
  const status = await git(['status', '--porcelain'], dir);
  if (!status) return false;
  await git(['add', '-A'], dir);
  await git(['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost', 'commit', '-m', message], dir);
  return true;
}

export const commitsAhead = async (dir, base) => Number(await git(['rev-list', '--count', `origin/${base}..HEAD`], dir));
export const diffAgainst = (dir, base) => git(['diff', `origin/${base}...HEAD`], dir);
export const logAgainst = (dir, base) => git(['log', '--oneline', `origin/${base}..HEAD`], dir);
export const push = (dir, branch) => git(['push', '-u', '--force-with-lease', 'origin', branch], dir);
