// Stand-in for a coding agent CLI. Speaks the "shell" preset's JSON-lines protocol.
import fs from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[0] || '';
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const say = (o) => console.log(JSON.stringify(o));
say({ externalId: resume || 'fake-session-1' });
if (prompt.includes('please fail')) { console.error('boom'); process.exit(3); }
if (prompt.includes('GitHub issue')) {
  fs.writeFileSync('CHANGE.txt', 'changed by fake agent\n');
  say({ text: '⚙ Write: CHANGE.txt' });
}
if (prompt.includes('code reviewer') || prompt.includes('UI reviewer')) {
  say({ final: 'Looks fine.\nVERDICT: APPROVE' });
} else {
  say({ text: 'working on it' });
  say({ final: `done: ${prompt.split('\n').at(-1)}${resume ? ` (resumed ${resume})` : ''}` });
}
