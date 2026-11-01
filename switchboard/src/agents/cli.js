// Drives coding agents through their official headless CLIs, on the hub machine,
// using whatever login you did once with that CLI (claude login, codex login, gemini, copilot).
//
// Each preset is a default. Every field can be overridden in the agent's config entry, so when a
// CLI changes its flags you fix it in config, not in code. Placeholders: {prompt} {resume} {model}
import { spawn } from 'node:child_process';

const tryJson = (line) => { try { return JSON.parse(line); } catch { return null; } };

export const PRESETS = {
  // Claude Code: https://code.claude.com/docs (headless mode, stream-json output)
  'claude-code': {
    command: 'claude',
    args: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose'],
    resumeArgs: ['--resume', '{resume}'],
    modelArgs: ['--model', '{model}'],
    parse(line) {
      const j = tryJson(line);
      if (!j) return { text: line };
      const out = {};
      if (j.session_id) out.externalId = j.session_id;
      if (j.type === 'assistant' && j.message?.content) {
        const parts = [];
        for (const c of j.message.content) {
          if (c.type === 'text') parts.push(c.text);
          else if (c.type === 'tool_use') parts.push(`⚙ ${c.name}${c.input?.command ? `: ${c.input.command}` : c.input?.file_path ? `: ${c.input.file_path}` : ''}`);
        }
        if (parts.length) out.text = parts.join('\n');
      } else if (j.type === 'result') {
        out.final = j.result ?? '';
        if (j.is_error) out.error = j.result || 'Claude Code reported an error';
      }
      return out;
    },
  },

  // OpenAI Codex CLI: `codex exec --json`
  codex: {
    command: 'codex',
    args: ['exec', '--json', '--full-auto', '{prompt}'],
    resumeArgs: null, // set e.g. ["exec","--json","resume","{resume}","{prompt}"] if your version supports it
    modelArgs: ['-m', '{model}'],
    parse(line) {
      const j = tryJson(line);
      if (!j) return { text: line };
      const out = {};
      if (j.thread_id) out.externalId = j.thread_id;
      const item = j.item || j.msg;
      if (item?.type === 'agent_message' && item.text) { out.text = item.text; out.final = item.text; }
      else if (item?.type === 'command_execution' && j.type === 'item.started') out.text = `⚙ ${item.command}`;
      else if (j.type === 'error' || j.type === 'turn.failed') out.error = j.message || j.error?.message || 'Codex error';
      return out;
    },
  },

  // Google Gemini CLI
  'gemini-cli': {
    command: 'gemini',
    args: ['-p', '{prompt}', '--yolo'],
    resumeArgs: null,
    modelArgs: ['-m', '{model}'],
    parse: (line) => ({ text: line, finalAppend: line }),
  },

  // GitHub Copilot CLI
  'copilot-cli': {
    command: 'copilot',
    args: ['-p', '{prompt}', '--allow-all-tools'],
    resumeArgs: null,
    modelArgs: ['--model', '{model}'],
    parse: (line) => ({ text: line, finalAppend: line }),
  },

  // Any other program: set "command" and "args" in config. The prompt is passed as an argument,
  // never through a shell. JSON lines {text, final, externalId, error} are understood too.
  shell: {
    command: 'echo',
    args: ['{prompt}'],
    resumeArgs: null,
    modelArgs: null,
    parse: (line) => {
      const j = tryJson(line);
      if (j && typeof j === 'object') return { text: j.text, externalId: j.externalId, final: j.final, error: j.error };
      return { text: line, finalAppend: line };
    },
  },
};

const fill = (arr, vars) => arr.map((a) => a.replace(/\{(prompt|resume|model)\}/g, (_, k) => vars[k] ?? ''));

export function buildCommand(agent, { prompt, resumeId }) {
  const preset = PRESETS[agent.preset || 'shell'];
  if (!preset) throw new Error(`Unknown CLI preset "${agent.preset}"`);
  const command = agent.command || preset.command;
  const resumeArgs = agent.resumeArgs !== undefined ? agent.resumeArgs : preset.resumeArgs;
  const modelArgs = agent.modelArgs !== undefined ? agent.modelArgs : preset.modelArgs;
  const vars = { prompt, resume: resumeId, model: agent.model };
  const args = [
    ...fill(agent.args || preset.args, vars),
    ...(resumeId && resumeArgs ? fill(resumeArgs, vars) : []),
    ...(agent.model && modelArgs ? fill(modelArgs, vars) : []),
    ...(agent.extraArgs || []),
  ];
  return { command, args, parse: preset.parse, canResume: Boolean(resumeArgs) };
}

export function cliAdapter(agent) {
  return {
    kind: 'cli',
    canResume: buildCommand(agent, { prompt: '' }).canResume,
    runTurn({ prompt, resumeId, cwd, signal, onEvent, timeoutMs }) {
      const { command, args, parse } = buildCommand(agent, { prompt, resumeId });
      return new Promise((resolve) => {
        let externalId = resumeId || null, final = null, appended = [], error = null, buf = '', errBuf = '';
        const child = spawn(command, args, {
          cwd: cwd || agent.cwd || process.cwd(),
          env: { ...process.env, ...(agent.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const kill = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', kill, { once: true });
        const timer = timeoutMs ? setTimeout(() => { error = `Timed out after ${Math.round(timeoutMs / 60000)} min`; kill(); }, timeoutMs) : null;

        const handle = (line) => {
          if (!line.trim()) return;
          const ev = parse(line) || {};
          if (ev.externalId) externalId = ev.externalId;
          if (ev.final !== undefined) final = ev.final;
          if (ev.finalAppend !== undefined) appended.push(ev.finalAppend);
          if (ev.error) error = ev.error;
          if (ev.text) onEvent?.({ kind: 'output', text: ev.text });
        };
        child.stdout.on('data', (d) => {
          buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
        });
        child.stderr.on('data', (d) => { errBuf += d; onEvent?.({ kind: 'stderr', text: String(d).trimEnd() }); });
        child.on('error', (e) => { error = `Could not start "${command}": ${e.message}`; });
        child.on('close', (code) => {
          if (buf) handle(buf);
          clearTimeout(timer);
          if (signal?.aborted) error = 'Cancelled';
          else if (code !== 0 && !error) error = `Exited with code ${code}${errBuf ? `: ${errBuf.trim().slice(-500)}` : ''}`;
          resolve({ ok: !error, error, externalId, text: final ?? appended.join('\n') });
        });
      });
    },
  };
}
