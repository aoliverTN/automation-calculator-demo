import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// "${GITHUB_TOKEN}" in the config file is replaced with the environment variable.
const expand = (v) => typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '')
  : Array.isArray(v) ? v.map(expand)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)])) : v;

export function loadConfig(file = process.env.SWITCHBOARD_CONFIG || 'switchboard.config.json') {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = expand(raw);
  cfg.host ??= '127.0.0.1';
  cfg.port ??= 7777;
  cfg.dataDir = (cfg.dataDir || path.join(os.homedir(), '.switchboard')).replace(/^~(?=\/|$)/, os.homedir());
  cfg.authToken ||= process.env.SWITCHBOARD_TOKEN || '';
  for (const a of cfg.agents || []) if (a.cwd) a.cwd = a.cwd.replace(/^~(?=\/|$)/, os.homedir());
  cfg.agents ??= [];
  return cfg;
}
