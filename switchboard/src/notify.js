// Fan notifications out to your phone and desktop (ntfy), Microsoft Teams, and any webhook.
// The dashboard and VS Code extension get them over the live event stream as well.
export function attachNotifiers(hub, cfg = {}, fetchImpl = globalThis.fetch) {
  const sends = [];
  const minLevel = { info: 0, warn: 1, error: 2 };

  if (cfg.ntfy?.topic) {
    // ntfy: free app for iOS/Android/macOS/Windows/web. Self-host it or use ntfy.sh with a long random topic.
    const server = (cfg.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '');
    sends.push((n) => fetchImpl(`${server}/${encodeURIComponent(cfg.ntfy.topic)}`, {
      method: 'POST',
      headers: {
        Title: n.title.replace(/[^\x20-\x7e]/g, ''),
        Priority: n.level === 'error' ? 'high' : 'default',
        Tags: n.level === 'error' ? 'warning' : 'robot',
        ...(n.url ? { Click: n.url } : {}),
        ...(cfg.ntfy.token ? { Authorization: `Bearer ${cfg.ntfy.token}` } : {}),
      },
      body: n.body,
    }));
  }

  if (cfg.teams?.webhookUrl) {
    // Teams "Workflows" app → "Post to a channel when a webhook request is received". Paste its URL here.
    sends.push((n) => fetchImpl(cfg.teams.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
            body: [
              { type: 'TextBlock', text: n.title, weight: 'Bolder', size: 'Medium', color: n.level === 'error' ? 'Attention' : 'Default', wrap: true },
              { type: 'TextBlock', text: n.body, wrap: true },
            ],
            actions: n.url ? [{ type: 'Action.OpenUrl', title: 'Open', url: n.url }] : [],
          },
        }],
      }),
    }));
  }

  if (cfg.webhookUrl) {
    sends.push((n) => fetchImpl(cfg.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n) }));
  }

  hub.on('notify', (n) => {
    if ((minLevel[n.level] ?? 0) < (minLevel[cfg.minLevel] ?? 0)) return;
    for (const send of sends) Promise.resolve().then(() => send(n)).catch((e) => console.error('[notify]', e.message));
  });
  return sends.length;
}
