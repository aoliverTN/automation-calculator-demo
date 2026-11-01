import { cliAdapter } from './cli.js';
import { apiAdapter } from './api.js';

export function makeAdapter(agent) {
  if (agent.type === 'cli') return cliAdapter(agent);
  if (agent.type === 'api') return apiAdapter(agent);
  throw new Error(`Agent "${agent.id}": type must be "cli" or "api"`);
}
