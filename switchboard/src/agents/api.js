// Chat models reached through their official APIs (API keys, not browser logins).
// OpenAI-compatible endpoints cover ChatGPT models, Grok (xAI), Gemini, and local Ollama.
export const API_PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', style: 'openai' },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', style: 'openai' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', style: 'openai' },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: null, style: 'openai' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', style: 'anthropic' },
};

export function apiAdapter(agent, fetchImpl = globalThis.fetch) {
  const p = API_PROVIDERS[agent.provider];
  if (!p) throw new Error(`Unknown API provider "${agent.provider}"`);
  const baseUrl = agent.baseUrl || p.baseUrl;
  const key = agent.apiKey || (agent.apiKeyEnv || p.keyEnv ? process.env[agent.apiKeyEnv || p.keyEnv] : undefined);

  return {
    kind: 'api',
    canResume: false, // history is replayed from the session instead
    async runTurn({ prompt, history = [], signal, onEvent }) {
      if (p.keyEnv && !key) return { ok: false, error: `Missing API key: set ${agent.apiKeyEnv || p.keyEnv}` };
      const messages = [...history.map((m) => ({ role: m.role, content: m.text })), { role: 'user', content: prompt }];
      try {
        let text;
        if (p.style === 'anthropic') {
          const res = await fetchImpl(`${baseUrl}/messages`, {
            method: 'POST', signal,
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: agent.model, max_tokens: agent.maxTokens || 8192, system: agent.system, messages }),
          });
          const j = await res.json();
          if (!res.ok) return { ok: false, error: j.error?.message || `HTTP ${res.status}` };
          text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        } else {
          const res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST', signal,
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model: agent.model, messages: agent.system ? [{ role: 'system', content: agent.system }, ...messages] : messages }),
          });
          const j = await res.json();
          if (!res.ok) return { ok: false, error: j.error?.message || `HTTP ${res.status}` };
          text = j.choices?.[0]?.message?.content ?? '';
        }
        onEvent?.({ kind: 'output', text });
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: signal?.aborted ? 'Cancelled' : e.message };
      }
    },
  };
}
