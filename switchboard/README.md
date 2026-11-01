# Switchboard

One place to see and drive all of your AI agents. Use it to:

- **Talk to every agent from one screen**: Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot CLI, Grok, ChatGPT, Gemini, and Claude.
- **Start new conversations or continue old ones.** Claude Code sessions resume with their full memory.
- **Use your voice.** Say "tell Claude to add dark mode to the calculator" or "queue fix the footer link" from your Mac, Windows PC, or phone.
- **Keep the agents fed from a to-do list in GitHub.** Any GitHub issue labelled `sb:queued` is a task. Each idle coding agent takes the next task and works on it in its own git worktree.
- **Check every change before you see it.** Each change goes through these checks:
  1. Build and tests, run locally or on your Linux test box over SSH.
  2. Deploy to the test box, then a smoke/burn test in a real browser. It takes desktop and phone screenshots.
  3. A code review by a reviewer agent.
  4. A UI review of the screenshots by a UI-reviewer agent.

  If a check fails, the feedback goes back to the coding agent automatically (up to 2 rounds by default).
- **Open a PR, but never merge.** You review the PR and you ship it.
- **Get notified everywhere.** Notifications go to your Mac/Windows desktop (browser, VS Code, or the ntfy app), your phone (ntfy), and a Microsoft Teams channel.

```
        Mac / Windows / phone                       Linux box on your LAN (the hub)
 ┌──────────────────────────────┐          ┌───────────────────────────────────────────────┐
 │ Browser dashboard (PWA)      │◀── SSE ──│ Switchboard server (Node, no dependencies)    │
 │  + mic / voice commands      │── HTTP ─▶│  ├─ Claude Code CLI  ─┐                       │
 │ VS Code extension            │          │  ├─ Codex CLI         │ coding agents run here│
 │ ntfy app (desktop + phone)   │◀─ push ──│  ├─ Gemini / Copilot ─┘ in git worktrees      │
 └──────────────────────────────┘          │  ├─ Grok / ChatGPT / Gemini / Claude APIs     │
                Teams channel ◀── webhook ─│  ├─ GitHub: issues = queue, PRs = output      │
                                           │  └─ ssh/rsync ─▶ Test box: deploy, smoke, UI  │
                                           └───────────────────────────────────────────────┘
```

## Where to run it

**Run it on your existing Linux dev box.** You don't need to buy anything to start.

- Coding agents need a machine that's always on, with your repos, git, and SSH keys. A Linux box is the best fit, and the hub is light (one Node process).
- The agents themselves use a lot of CPU and RAM while they build and test. If they slow your dev box down, move the hub to a small dedicated mini PC (16–32 GB RAM, 4+ cores, ~$300–500) and copy the same config across.
- **Mac** works too (see `deploy/com.switchboard.plist`), but agents stop when the laptop sleeps.
- **Windows** can run it under WSL2, but there's no reason to unless that's the only always-on machine.
- **Your Mac and Windows PCs don't need an install.** Open the dashboard in Chrome or Edge, then:
  - Use "Install app" to get a desktop window.
  - Allow notifications.
  - Install the VS Code extension if you want it in the editor.
- **For your phone**, use the ntfy app for notifications and the same dashboard URL for control.
- **From outside your LAN**, use [Tailscale](https://tailscale.com) on the hub, your laptops, and your phone. Don't open a port on your router.

## What it can and can't connect to

| You asked for | How Switchboard does it |
|---|---|
| Claude Code sessions | Runs the `claude` CLI headless on the hub with your Claude login. It starts, resumes, and streams sessions. |
| Codex | Runs the `codex` CLI headless (`codex exec`) with your ChatGPT login. |
| Copilot | Runs the GitHub Copilot CLI (`copilot -p`). |
| Gemini | Two options: the Gemini CLI for coding, or the Gemini API for chat (free API key from Google AI Studio). |
| Grok | Uses the xAI API with an API key from console.x.ai. |
| ChatGPT | Uses the OpenAI API with an API key. |
| Claude chat | Uses the Anthropic API with an API key, or a Claude Code agent with no repo. |
| Your existing chats in the ChatGPT / Grok / Gemini / Claude **websites and desktop apps** | **Not supported.** Those apps have no supported way for another program to read or type into them. Automating a browser login breaks often and is against their terms. Start those conversations in Switchboard instead, and they'll all be in one place from then on. |
| GitHub | Uses a fine-grained token. Issues are the queue and PRs are the output. |
| Teams | Posts to a channel through a Teams Workflows webhook. |

Chat through the APIs is billed per use. It's separate from your ChatGPT Plus, SuperGrok, or Claude subscriptions. The coding CLIs (Claude Code, Codex, Copilot) use your existing subscriptions.

## Set it up (about 30 minutes)

On the Linux box:

```bash
# 1. Node 20+ and git
sudo apt install -y nodejs npm git rsync     # or use nodesource / nvm for a current Node

# 2. Install and sign in once to each coding CLI you want
npm i -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli @github/copilot
claude            # sign in
codex login
gemini            # sign in
copilot           # sign in

# 3. Install Switchboard as a service
git clone <this repo> && cd <repo>/switchboard
sudo ./deploy/install-linux.sh $USER
sudo nano /etc/switchboard.env               # paste keys (see below)
sudo nano /etc/switchboard.config.json       # agents, repos, test box
sudo systemctl restart switchboard
```

Then:

- **Dashboard:** open `http://<linux-box>:7777/?token=<token printed by the installer>` on your Mac or PC. Click 🔔 to allow desktop notifications.
- **Phone:** install **ntfy** (iOS/Android) and subscribe to the topic the installer printed. The ntfy web/desktop app does the same on Mac and Windows.
- **GitHub token:** create a fine-grained token at github.com → Settings → Developer settings. Give it the repos you want worked, with *Issues*, *Pull requests*, and *Contents* set to read/write.
- **Teams:** in the channel, open **Workflows** → "Post to a channel when a webhook request is received". Copy the URL into `TEAMS_WEBHOOK_URL`.
- **Test box:** run `ssh-copy-id tester@testbox` from the hub user. Then set `deploy` and `smoke` for the repo, or set `testBox: { host, dir }` to run tests there.
- **Screenshots and UI review:** run `npm install` in `/opt/switchboard` to add Playwright, then `npx playwright install chromium`. Without it, the smoke test only does HTTP checks.

## Using it

**Voice and typed commands** go in the top bar, or the VS Code command `Cmd/Ctrl+Alt+S`. Built-in OS dictation also works in any box: Fn Fn on Mac, Win+H on Windows.

| Say | What happens |
|---|---|
| "tell claude to add input validation to the form" | Continues your last Claude chat, or starts a new one |
| "ask grok what's new in the xAI API" | Same, for Grok |
| "new chat with gemini: compare SQLite and Postgres for this" | Always starts a new session |
| "queue fix the footer link in automation-calculator-demo" | Creates a GitHub issue labelled `sb:queued` |
| "start the queue" / "pause the queue" | Turns the automatic workers on or off |
| "status" | Says what's working and what's waiting |

**The queue:**
- Add tasks from the dashboard, by voice, from VS Code ("Queue Task from selection"), or as GitHub issues with the `sb:queued` label.
- Labels change as a task moves: `sb:working` → `sb:review` (PR ready) or `sb:failed`.
- Add `agent:codex` to an issue to pick the agent. Add `priority:high` to jump the line.

**Per-repo settings** can be committed to the repo as `.switchboard.json`. Example:

```json
{
  "test": ["npm ci", "npm test"],
  "deploy": "rsync -az --delete --exclude .git ./ tester@testbox:/srv/app/ && ssh tester@testbox 'cd /srv/app && docker compose up -d --build'",
  "smoke": { "url": "http://testbox:8080", "paths": ["/", "/login"], "expectText": "Welcome", "rounds": 5 },
  "instructions": "Use TypeScript strict mode. Keep the ThrottleNet colors."
}
```

## Safety

- Coding agents run with the permissions you give them in `extraArgs`. The example uses Claude Code's `acceptEdits`. Run the hub as a normal user, not root.
- Agents work in separate git worktrees. Your own checkout is never touched.
- Switchboard pushes branches and opens PRs. **It never merges.**
- The server won't listen on the network without an auth token. Keep it on your LAN or Tailscale.

## Develop

```bash
npm test                                       # 9 tests: adapters, commands, notifications, full queue→PR run
SWITCHBOARD_CONFIG=my.json npm start
```

The VS Code extension is in `vscode-extension/`. To install it:

1. Run `npx @vscode/vsce package` in that folder.
2. In VS Code, run "Extensions: Install from VSIX…".
3. Set `switchboard.url` and `switchboard.token`.

## Roadmap ideas

- Reply to agents from Teams (Teams bot → `/api/command`).
- An orchestrator agent that breaks a big idea into queued issues.
- Show cost and usage per agent.
- Two-way approval buttons in ntfy and Teams.
- Run Claude Code cloud sessions as remote workers.
