// Stand-in for `claude --cloud <brief>`, used by the tests through CLOUD_PILOT_CLAUDE_BIN (a .mjs file runs with Node).
// FAKE_CLAUDE_MODE picks what it does:
//   ok            banner, the brief echoed line by line, "Created cloud session" and the link, then keeps running
//   partial-url   the link arrives in two pieces, 100 ms apart
//   url-at-end    the link is the last thing printed, with no line break after it
//   trust         asks the folder trust question
//   login         says it is not logged in
//   picker        shows an environment picker
//   confirm       asks a (y/n) question
//   silent        prints a banner and then nothing
//   exit1         prints an error and exits with code 1
// FAKE_CLAUDE_RECORD (a file path) receives { args, cwd, pid, config } as JSON when the process starts.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const at = args.indexOf('--cloud');
const brief = at >= 0 ? (args[at + 1] ?? '') : '';
if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, config: process.env.CLAUDE_CONFIG_DIR ?? null }));
}

const w = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = () => setInterval(() => {}, 1000); // a real client keeps running until it is closed

w('\x1b[2J\x1b[H\x1b]0;fake claude\x07\x1b[1mClaude Code\x1b[0m (fake)\r\n');
for (const line of brief.split(/\r?\n/)) w(`\x1b[2m> ${line}\x1b[0m\r\n`);

const LINK = 'https://claude.ai/code/session_TEST123';

if (mode === 'ok') {
  w(`Created\x1b[1Ccloud\x1b[1Csession\x1b[1C\x1b[36m${LINK}\x1b[0m\r\n`);
  hold();
} else if (mode === 'partial-url') {
  w('Created cloud session https://claude.ai/code/session_TEST1');
  await sleep(100);
  w('23\r\n');
  hold();
} else if (mode === 'url-at-end') {
  w(`Created cloud session ${LINK}`);
  hold();
} else if (mode === 'trust') {
  w('Accessing workspace:\r\n\r\n \x1b[1mDo you trust the files in this folder?\x1b[0m\r\n\r\n \u276f 1. Yes, proceed\r\n   2. No, exit\r\n\r\n Enter to confirm \u00b7 Esc to cancel\r\n');
  hold();
} else if (mode === 'login') {
  w('Not logged in \u00b7 Please run /login\r\n');
  hold();
} else if (mode === 'picker') {
  w('Select an environment\r\n \u276f 1. Default\r\n   2. Staging\r\n');
  hold();
} else if (mode === 'confirm') {
  w('Create a new environment? (y/n) ');
  hold();
} else if (mode === 'silent') {
  hold();
} else if (mode === 'exit1') {
  w('error: something went wrong\r\n');
  process.exitCode = 1;
} else {
  w(`unknown FAKE_CLAUDE_MODE ${mode}\r\n`);
  process.exitCode = 2;
}
