// The quality gate every change goes through before you see a PR:
//   1. build & tests (locally, or on your Linux test box over SSH)
//   2. deploy to the test box and smoke/burn test it in a real browser (Playwright, screenshots)
//   3. code review by a reviewer agent
//   4. UI review by a UI-reviewer agent looking at the screenshots
import fs from 'node:fs';
import path from 'node:path';
import { sh, run, diffAgainst } from './git.js';

const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

export function parseVerdict(text = '') {
  const m = [...text.matchAll(/VERDICT:\s*(APPROVE|CHANGES)/gi)].at(-1);
  return m ? m[1].toUpperCase() : null;
}

async function runTests(cfg, dir) {
  const out = [];
  const box = cfg.testBox; // { host: "tester@10.0.0.50", dir: "/srv/switchboard/<repo>" }
  if (box) {
    const r = await run('rsync', ['-az', '--delete', '--exclude', '.git', '--exclude', 'node_modules', './', `${box.host}:${box.dir}/`], { cwd: dir });
    if (!r.ok) return { ok: false, output: `rsync to ${box.host} failed:\n${r.stderr}` };
  }
  for (const cmd of cfg.test || []) {
    const r = box
      ? await run('ssh', ['-o', 'BatchMode=yes', box.host, `cd ${JSON.stringify(box.dir)} && ${cmd}`], { timeoutMs: (cfg.testTimeoutMinutes || 20) * 60000 })
      : await sh(cmd, { cwd: dir, timeoutMs: (cfg.testTimeoutMinutes || 20) * 60000 });
    out.push(`$ ${cmd}${box ? `   (on ${box.host})` : ''}\n${tail(r.stdout + r.stderr)}`);
    if (!r.ok) return { ok: false, output: out.join('\n\n') };
  }
  return { ok: true, output: out.join('\n\n') };
}

export async function smokeTest(smoke, artifactsDir, importPw = () => import('playwright')) {
  const urls = (smoke.paths || ['/']).map((p) => new URL(p, smoke.url).href);
  const problems = [], screenshots = [], lines = [];
  // Burn test: hit each page repeatedly to catch flaky starts and leaks.
  const rounds = Math.max(1, smoke.rounds || 1);
  let pw = null;
  try { pw = await importPw(); } catch { lines.push('(Playwright not installed: HTTP checks only, no screenshots)'); }

  if (!pw) {
    for (let r = 0; r < rounds; r++) for (const u of urls) {
      try {
        const res = await fetch(u);
        const body = await res.text();
        if (res.status >= 400) problems.push(`${u} → HTTP ${res.status}`);
        if (smoke.expectText && !body.includes(smoke.expectText)) problems.push(`${u} → missing text "${smoke.expectText}"`);
      } catch (e) { problems.push(`${u} → ${e.message}`); }
    }
    return { ok: !problems.length, problems, screenshots, output: lines.concat(problems).join('\n') };
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const browser = await pw.chromium.launch();
  try {
    const viewports = smoke.viewports || [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];
    for (let r = 0; r < rounds; r++) for (const vp of viewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      for (const u of urls) {
        try {
          const res = await page.goto(u, { waitUntil: 'networkidle', timeout: 30000 });
          if (!res || res.status() >= 400) problems.push(`${u} [${vp.name}] → HTTP ${res?.status()}`);
          if (smoke.expectText && !(await page.content()).includes(smoke.expectText)) problems.push(`${u} [${vp.name}] → missing text "${smoke.expectText}"`);
          if (r === rounds - 1) {
            const file = path.join(artifactsDir, `${vp.name}-${new URL(u).pathname.replace(/\W+/g, '_') || 'root'}.png`);
            await page.screenshot({ path: file, fullPage: true });
            screenshots.push(file);
          }
        } catch (e) { problems.push(`${u} [${vp.name}] → ${e.message}`); }
      }
      for (const e of new Set(errors)) problems.push(`console error [${vp.name}]: ${e}`);
      await page.close();
    }
  } finally { await browser.close(); }
  lines.push(`${urls.length} page(s) × ${rounds} round(s), ${screenshots.length} screenshot(s)`);
  return { ok: !problems.length, problems, screenshots, output: lines.concat(problems).join('\n') };
}

async function askReviewer(hub, agentId, title, prompt, cwd) {
  const { done, session } = hub.startSession({ agentId, title, prompt, cwd, quiet: true });
  const r = await done;
  return { ...r, verdict: parseVerdict(r.text), sessionId: session.id };
}

/** Returns { passed, report (markdown for the PR), feedback (for the coding agent) }. */
export async function runPipeline({ hub, dir, base, cfg, issue, artifactsDir }) {
  const sections = [], feedback = [];
  const add = (name, ok, body) => sections.push(`### ${ok ? '✅' : '❌'} ${name}\n\n<details><summary>details</summary>\n\n\`\`\`\n${tail(body || '(no output)', 6000)}\n\`\`\`\n</details>`);
  const step = (name) => hub.publish({ type: 'pipeline', issue, step: name });

  if (cfg.test?.length) {
    step('tests');
    const t = await runTests(cfg, dir);
    add('Build & tests', t.ok, t.output);
    if (!t.ok) feedback.push(`The tests failed:\n${tail(t.output)}`);
  }

  let screenshots = [];
  if (cfg.deploy) {
    step('deploy');
    const d = await sh(cfg.deploy, { cwd: dir, timeoutMs: 20 * 60000 });
    add('Deploy to test box', d.ok, d.stdout + d.stderr);
    if (!d.ok) feedback.push(`Deploying to the test box failed:\n${tail(d.stdout + d.stderr)}`);
  }
  if (cfg.smoke?.url && !feedback.length) {
    step('smoke');
    const s = await smokeTest(cfg.smoke, artifactsDir);
    screenshots = s.screenshots;
    add('Smoke / burn test', s.ok, s.output);
    if (!s.ok) feedback.push(`The smoke test against ${cfg.smoke.url} found problems:\n${s.problems.join('\n')}`);
  }

  const reviewer = cfg.reviewer || [...hub.agents.values()].find((a) => a.config.roles?.includes('reviewer'))?.config.id;
  if (reviewer && cfg.codeReview !== false) {
    step('code review');
    let diff = await diffAgainst(dir, base);
    if (diff.length > 80000) diff = diff.slice(0, 80000) + '\n… (diff truncated)';
    const r = await askReviewer(hub, reviewer, `Code review: #${issue.number} ${issue.title}`, [
      `You are a strict senior code reviewer. Review this change for issue #${issue.number}: "${issue.title}".`,
      `Issue description:\n${issue.body || '(none)'}`,
      'Look for bugs, security problems, missing error handling, and whether it actually does what the issue asks. Ignore style nits.',
      `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
      'End your reply with exactly one line: "VERDICT: APPROVE" or "VERDICT: CHANGES", and if CHANGES, list each required fix above it.',
    ].join('\n\n'), dir);
    const ok = r.ok && r.verdict === 'APPROVE';
    add(`Code review (${reviewer})`, ok, r.text || r.error);
    if (!ok) feedback.push(`The code reviewer asked for changes:\n${r.text || r.error}`);
  }

  const uiReviewer = cfg.uiReviewer || [...hub.agents.values()].find((a) => a.config.roles?.includes('ui-reviewer'))?.config.id;
  if (uiReviewer && screenshots.length) {
    step('ui review');
    const r = await askReviewer(hub, uiReviewer, `UI review: #${issue.number} ${issue.title}`, [
      `You are a UI/UX reviewer. Open and look at each of these screenshots of the app after the change for "${issue.title}":`,
      screenshots.map((s) => `- ${s}`).join('\n'),
      'Check layout, overflow on phone width, contrast, broken images, obvious visual bugs, and whether the UI matches the request.',
      'End with exactly one line: "VERDICT: APPROVE" or "VERDICT: CHANGES".',
    ].join('\n\n'), dir);
    const ok = r.ok && r.verdict === 'APPROVE';
    add(`UI review (${uiReviewer})`, ok, r.text || r.error);
    if (!ok) feedback.push(`The UI reviewer asked for changes:\n${r.text || r.error}`);
  }

  return { passed: feedback.length === 0, report: sections.join('\n\n') || '_No checks configured._', feedback: feedback.join('\n\n---\n\n'), screenshots };
}
