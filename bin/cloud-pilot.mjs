#!/usr/bin/env node
// cloud-pilot: let Claude Code (CLI) run work in Claude Code cloud sessions by itself: start them, track them on
// GitHub, wait for what they need, and answer their questions with a signed reply. Node 18+, no npm install.
//
//   cloud-pilot start --brief-file <file> [--cwd <repo>] [--branch claude/<slug>]   start a cloud session and track it
//   cloud-pilot track --repo owner/name [--branch claude/<slug>] [--url <link>] [--title <text>]
//   cloud-pilot watch --repo owner/name | unwatch --repo owner/name   track new claude/* branches by themselves
//   cloud-pilot wait [--max-min 240]          wait for this session's events (one JSON line); run in the background
//   cloud-pilot status [--json] | untrack --id <id> | stop | doctor
//   cloud-pilot channel keygen|fingerprint|setup <repo>|ask|wait   signed question channel
//   cloud-pilot answer --repo owner/name --pr N --id <id> --question-sha256 <hash> --answer "<text>"
//   cloud-pilot version
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB_VERBS = new Set(['track', 'track-repo', 'watch', 'unwatch', 'untrack', 'wait', 'wait-begin', 'wait-take', 'wait-end', 'status', 'stop', 'doctor', 'daemon']);

export function version() {
  try { return JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

export const USAGE = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n');

export async function main(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') { console.log(USAGE); return verb ? 0 : 1; }
  if (verb === 'version' || verb === '--version') { console.log(JSON.stringify({ ok: true, version: version(), root: ROOT })); return 0; }
  if (verb === 'start') return (await import('../start/index.mjs')).main(rest);
  if (verb === 'channel') return (await import('../channel/index.mjs')).main(rest);
  if (verb === 'answer') return (await import('../channel/index.mjs')).main(['answer', ...rest]);
  if (HUB_VERBS.has(verb)) {
    const hub = await import('../hub/hub.mjs');
    try {
      hub.main([verb, ...rest]);
      return process.exitCode ?? 0;
    } catch (err) {
      console.log(JSON.stringify({ status: 'usage', message: err.message }));
      return 1;
    }
  }
  console.log(JSON.stringify({ status: 'usage', message: `unknown command "${verb}"; run cloud-pilot help` }));
  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  const norm = (f) => { let x = resolve(f); try { x = realpathSync(x); } catch { /* keep */ } return process.platform === 'win32' ? x.toLowerCase() : x; };
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.log(JSON.stringify({ status: 'error', message: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
