// Thin client: everything runs on the hub. This adds a status bar item, desktop toasts when an
// agent finishes, and commands to talk to agents without leaving the editor.
const vscode = require('vscode');
const http = require('http');
const https = require('https');

let statusItem, stream, retry;

function cfg() {
  const c = vscode.workspace.getConfiguration('switchboard');
  return { url: c.get('url').replace(/\/$/, ''), token: c.get('token') };
}

async function api(path, body) {
  const { url, token } = cfg();
  const res = await fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function refreshStatus() {
  try {
    const s = await api('/api/state');
    const working = s.sessions.filter((x) => x.status === 'running').length;
    statusItem.text = `$(hubot) ${working ? `${working} working` : 'idle'}${s.queue.queued.length ? ` · ${s.queue.queued.length} queued` : ''}`;
    statusItem.tooltip = s.agents.map((a) => `${a.name}: ${a.running ? 'working' : 'idle'}`).join('\n');
  } catch {
    statusItem.text = '$(debug-disconnect) Switchboard';
    statusItem.tooltip = 'Cannot reach the hub. Check switchboard.url / switchboard.token.';
  }
}

function connect() {
  clearTimeout(retry);
  if (stream) stream.destroy();
  const { url, token } = cfg();
  const u = new URL(url + '/api/events');
  if (token) u.searchParams.set('token', token);
  const req = (u.protocol === 'https:' ? https : http).get(u, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
        if (e.type === 'activity' && e.activity.kind === 'notify') {
          const a = e.activity;
          const show = a.level === 'error' ? vscode.window.showErrorMessage : a.level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
          show(`${a.title}: ${(a.body || '').split('\n')[0]}`, ...(a.url ? ['Open'] : []), 'Dashboard').then((pick) => {
            if (pick === 'Open') vscode.env.openExternal(vscode.Uri.parse(a.url));
            if (pick === 'Dashboard') openDashboard();
          });
        }
        if (e.type === 'session.updated' || e.type === 'queue' || e.type === 'agents') refreshStatus();
      }
    });
    res.on('end', () => { retry = setTimeout(connect, 5000); });
  });
  req.on('error', () => { retry = setTimeout(connect, 10000); });
  stream = req;
}

function openDashboard() {
  const { url, token } = cfg();
  const target = token ? `${url}/?token=${encodeURIComponent(token)}` : url;
  vscode.commands.executeCommand('simpleBrowser.show', target).then(undefined, () => vscode.env.openExternal(vscode.Uri.parse(target)));
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'switchboard.open';
  statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('switchboard.open', openDashboard),
    vscode.commands.registerCommand('switchboard.status', async () => {
      try { vscode.window.showInformationMessage((await api('/api/command', { text: 'status' })).reply); } catch (e) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('switchboard.command', async () => {
      const text = await vscode.window.showInputBox({ prompt: 'Tell an agent… (VS Code dictation works here too)', placeHolder: 'tell claude to add input validation to the form' });
      if (!text) return;
      try { vscode.window.showInformationMessage((await api('/api/command', { text })).reply); } catch (e) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('switchboard.queueSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : '';
      const title = await vscode.window.showInputBox({ prompt: 'Task title for the queue' });
      if (!title) return;
      const where = ed ? `\n\nFrom ${vscode.workspace.asRelativePath(ed.document.uri)}:${ed.selection.start.line + 1}` : '';
      try {
        const r = await api('/api/queue', { title, body: sel ? `\`\`\`\n${sel}\n\`\`\`${where}` : where.trim() || undefined });
        vscode.window.showInformationMessage(`Queued ${r.repo}#${r.number}`, 'Open').then((p) => p && vscode.env.openExternal(vscode.Uri.parse(r.url)));
      } catch (e) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('switchboard')) { connect(); refreshStatus(); } }),
    { dispose: () => { clearTimeout(retry); stream && stream.destroy(); } },
  );
  refreshStatus();
  connect();
}

module.exports = { activate, deactivate() {} };
