// `cloud-pilot nudge`: tell a tracked cloud session something now (`claude -p "<text>" --cloud <session_id>`).
// Prints exactly one JSON line: { sent, session_url?, reason? }. Exit 0 even when nothing was sent (the reason says why);
// exit 1 only for bad arguments. The text is the default below or the person's own --text, never text from GitHub.
import { paths, hubDir, readJson } from './lib/store.mjs';
import { locateSession, sessionOfTrack, sendToSession } from './lib/send.mjs';

export const DEFAULT_TEXT = 'Status check from your local session: if your task is not finished, continue it; push work in progress; if you are blocked, ask on the PR.';
const MAX_TEXT = 2000;
const FLAGS = new Set(['--id', '--repo', '--pr', '--text']);
const USAGE_LINE = 'usage: cloud-pilot nudge --id <trackId> | --repo owner/name --pr N [--text "<message>"]';

class UsageError extends Error {}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) throw new UsageError(`unknown option "${flag}"`);
    if (argv[i + 1] === undefined) throw new UsageError(`${flag} needs a value`);
    o[flag.slice(2)] = argv[i + 1];
  }
  if (o.id !== undefined) {
    if (o.repo !== undefined || o.pr !== undefined) throw new UsageError('use --id alone, or --repo with --pr');
    if (!/^[\w-]{1,64}$/.test(o.id)) throw new UsageError('--id is a track id (see cloud-pilot status)');
  } else {
    if (o.repo === undefined || o.pr === undefined) throw new UsageError('give --id <trackId>, or --repo owner/name with --pr N');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new UsageError('--repo must look like owner/name');
    if (!/^[1-9]\d{0,9}$/.test(o.pr)) throw new UsageError('--pr must be a positive whole number');
  }
  if (o.text !== undefined && (!o.text.trim() || o.text.length > MAX_TEXT)) throw new UsageError(`--text must be 1 to ${MAX_TEXT} characters`);
  return { id: o.id, repo: o.repo, pr: o.pr === undefined ? undefined : Number(o.pr), text: o.text ?? DEFAULT_TEXT };
}

async function defaultApi(path) {
  // Loaded only when a PR has to be read: the channel module is large and needs gh.
  return (await import('../channel/cloud/channel.mjs')).ghApi(path);
}

// deps (for tests): env, out (a line printer), api (reads a PR), tracked (the tracks), run, claude (see send.mjs).
export async function runNudge(argv, deps = {}) {
  const { env = process.env, out = (s) => console.log(s), api = defaultApi, run, claude } = deps;
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE_LINE); return 0; }
  let a;
  try { a = parse(argv); } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    out(JSON.stringify({ status: 'usage', message: `${err.message}. ${USAGE_LINE}` }));
    return 1;
  }
  let list = deps.tracked;
  if (list === undefined) {
    try { list = readJson(paths(hubDir(env)).tracked, []); } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];

  let found = null;
  if (a.id !== undefined) {
    const track = list.find((t) => t && t.id === a.id);
    if (!track) { out(JSON.stringify({ sent: false, reason: 'no track with that id (run cloud-pilot status)' })); return 0; }
    found = sessionOfTrack(track);
    // A track started without a link may still have a PR whose body carries one.
    if (!found && track.repo && Number.isInteger(track.memo?.pr)) found = await locateSession(list, { repo: track.repo, pr: track.memo.pr }, api);
  } else {
    found = await locateSession(list, { repo: a.repo, pr: a.pr }, api);
  }
  if (!found) {
    out(JSON.stringify({ sent: false, reason: 'no session link for it (the track has no session url and its PR does not name one)' }));
    return 0;
  }
  const r = sendToSession(a.text, found, { env, claude, ...(run ? { run } : {}) });
  out(JSON.stringify({ sent: r.sent, session_url: r.session_url, ...(r.sent ? {} : { reason: r.reason }) }));
  return 0;
}
