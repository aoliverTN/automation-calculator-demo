#!/usr/bin/env bash
# Installs Switchboard as a service on a Linux box (Ubuntu/Debian/Fedora).
# Usage: sudo ./deploy/install-linux.sh <user-that-runs-the-agents>
set -euo pipefail
RUN_AS="${1:-${SUDO_USER:-}}"
[ -n "$RUN_AS" ] || { echo "usage: sudo $0 <username>"; exit 1; }
command -v node >/dev/null || { echo "Install Node.js 20+ first (https://nodejs.org or your package manager)."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p /opt/switchboard
cp -r "$SRC/src" "$SRC/public" "$SRC/package.json" /opt/switchboard/
chown -R "$RUN_AS" /opt/switchboard
(cd /opt/switchboard && sudo -u "$RUN_AS" npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true)  # optional Playwright

if [ ! -f /etc/switchboard.config.json ]; then
  cp "$SRC/switchboard.config.example.json" /etc/switchboard.config.json
  echo "→ Edit /etc/switchboard.config.json (agents, repos, test box)."
fi
if [ ! -f /etc/switchboard.env ]; then
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  TOPIC="switchboard-$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | tr 'A-Z' 'a-z')"
  cat > /etc/switchboard.env <<ENV
SWITCHBOARD_TOKEN=$TOKEN
NTFY_TOPIC=$TOPIC
GITHUB_TOKEN=
TEAMS_WEBHOOK_URL=
XAI_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
ENV
  chmod 600 /etc/switchboard.env
  chown "$RUN_AS" /etc/switchboard.env
  echo "→ Fill in the keys in /etc/switchboard.env"
  echo "→ Your dashboard token: $TOKEN"
  echo "→ Subscribe to ntfy topic '$TOPIC' in the ntfy app on your phone and Mac/PC."
fi

sed "s/^User=%i/User=$RUN_AS/" "$SRC/deploy/switchboard.service" > /etc/systemd/system/switchboard.service
systemctl daemon-reload
systemctl enable --now switchboard
echo "Switchboard is running: http://$(hostname):7777   (logs: journalctl -u switchboard -f)"
echo "Make sure '$RUN_AS' has logged in once to each CLI: claude, codex login, gemini, copilot, and has an SSH key for the test box."
