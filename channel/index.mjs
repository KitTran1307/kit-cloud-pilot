#!/usr/bin/env node
// Entry point of the channel: `cloud-pilot channel <verb> ...`. argv[0] is the verb.
//   keygen [--force]      create your Ed25519 key pair
//   fingerprint           print the SPKI sha256 of your public key
//   setup <repo> [--write]   copy the cloud script, public key and pin into a repository (dry run by default)
//   ask ...               post a question on a PR (what a cloud session runs; works locally too)
//   wait ...              wait for the signed answer to a question, checked against your own public key
//   questions ...         list the questions on a PR with the hash `answer` needs
//   answer ...            answer a cloud session's question with a signed comment
// Every verb prints JSON lines and takes --help.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run as runCloud } from './cloud/channel.mjs';
import { runKeygen, runFingerprint, localPublicKeyPem } from './keys.mjs';
import { runSetup } from './setup.mjs';
import { runAnswer, runQuestions } from './answer.mjs';

export const HELP = [
  'usage: cloud-pilot channel <command> [options]',
  '  keygen [--force]                      create your Ed25519 key pair (private key stays outside any repository)',
  '  fingerprint                           print the SPKI sha256 of your public key',
  '  setup <repo path> [--write]           prepare a repository: cloud script, public key, pin, CLAUDE.md block (dry run without --write)',
  '  ask  --repo owner/name --pr N --id <id> --text "<question>"',
  '                                        post a question on a PR (a cloud session runs this)',
  '  wait --repo owner/name --pr N --id <id> [--timeout-min 360] [--interval-sec 60] [--ask-authors a,b]',
  '                                        wait for the signed answer; checked against your own public key',
  '  questions --repo owner/name --pr N [--all] [--ask-authors a,b]',
  '                                        list the open questions on a PR: id, question_sha256, text',
  '  answer --repo owner/name --pr N --id <id> --question-sha256 <hash> --answer "<text>" [--valid-hours 24] [--ask-authors a,b] [--dry-run]',
  '                                        answer a question with a signed comment',
  'Run a command with --help for details. Settings: CLOUD_PILOT_KEY_DIR, CLOUD_PILOT_PRIVATE_KEY, CLOUD_PILOT_ASK_AUTHORS.',
].join('\n');

// Runs one command line. deps: env, out, errOut, and for tests api, now, sleep, account, loadPrivateKey, loadPublicKey.
// Returns the exit code: 0 ok, 1 bad usage or refused, 2 error, 3 timeout, 4 refused_agent_config (the last three from `wait`).
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => console.log(line));
  const all = [...argv];
  if (all[0] === 'channel') all.shift();
  const [verb, ...rest] = all;
  const { loadPrivateKey, loadPublicKey, ...shared } = { ...deps, env, out };
  if (!verb || ['--help', '-h', 'help'].includes(verb)) {
    out(HELP);
    return verb ? 0 : 1;
  }
  switch (verb) {
    case 'keygen': return runKeygen(rest, shared);
    case 'fingerprint': return runFingerprint(rest, shared);
    case 'setup': return runSetup(rest, shared);
    case 'questions': return runQuestions(rest, loadPublicKey ? { ...shared, loadPublicKey } : shared);
    case 'answer': return runAnswer(rest, loadPrivateKey ? { ...shared, loadKey: loadPrivateKey } : shared);
    case 'ask':
    case 'wait':
      // Run locally, `wait` trusts your own public key (the cloud copy trusts the key and pin shipped by setup).
      return runCloud([verb, ...rest], { ...shared, loadKey: loadPublicKey ?? (() => crypto.createPublicKey(localPublicKeyPem(env))) });
    default:
      out(JSON.stringify({ status: 'usage', message: `unknown command "${verb}"; run with --help` }));
      return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2));
