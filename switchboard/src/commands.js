// Turns plain sentences (typed or spoken) into actions:
//   "tell claude to add dark mode to the calculator"
//   "ask grok what's new in the xAI API"
//   "new chat with gemini: compare Postgres and SQLite for this"
//   "queue fix the footer link in automation-calculator-demo"
//   "start the queue" / "pause the queue" / "status"
const VERB = /^(?:hey\s+switchboard[,\s]+)?(tell|ask|have|get)\s+(.+)$/i;

function matchAgentPrefix(hub, rest) {
  const words = rest.split(/\s+/);
  for (const fuzzy of [false, true]) {
    for (let k = Math.min(3, words.length - 1); k >= 1; k--) {
      const name = words.slice(0, k).join(' ');
      const agent = hub.findAgent(name);
      if (agent && (fuzzy || [agent.id, agent.name, ...(agent.aliases || [])].some((n) => n && n.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
        return { agent, text: words.slice(k).join(' ').replace(/^(to|that|about)\s+/i, '').replace(/^[:,]\s*/, '') };
      }
    }
  }
  return null;
}

export function parseCommand(input, hub) {
  const text = String(input || '').trim().replace(/[.!]$/, '');
  if (!text) return { action: 'none' };
  if (/^(status|what'?s (running|going on)|how are (my|the) agents)/i.test(text)) return { action: 'status' };
  if (/^(start|resume|run) (the )?queue/i.test(text)) return { action: 'queue.enable', on: true };
  if (/^(pause|stop) (the )?queue/i.test(text)) return { action: 'queue.enable', on: false };

  let m = text.match(/^(?:queue|add to (?:the )?queue|add (?:a )?task|todo)[:,]?\s+(.+)$/i);
  if (m) {
    let body = m[1], repo = null;
    const r = body.match(/\s+(?:in|for|on)\s+(?:repo\s+)?([\w.-]+\/[\w.-]+|[\w.-]+)$/i);
    if (r) { repo = r[1]; body = body.slice(0, r.index); }
    return { action: 'queue', title: body, repo };
  }

  m = text.match(/^(?:new|start)\s+(?:a\s+)?(?:session|chat|conversation)\s+(?:with|on|in)\s+(.+)$/i);
  if (m) {
    const hit = matchAgentPrefix(hub, m[1]);
    if (hit) return { action: 'new', agentId: hit.agent.id, prompt: hit.text };
  }

  m = text.match(VERB);
  if (m) {
    const hit = matchAgentPrefix(hub, m[2]);
    if (hit && hit.text) return { action: 'tell', agentId: hit.agent.id, prompt: hit.text };
  }
  return { action: 'message', prompt: text };
}
