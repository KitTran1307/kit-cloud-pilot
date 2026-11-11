// Pure logic of `start`: argument parsing, output cleanup, URL and prompt detection, branch and title rules, the
// claude executable lookup. No processes and no terminal here, so every rule is unit-tested on every OS.
import { statSync } from 'node:fs';
import path from 'node:path';
import { setting } from '../hub/lib/config.mjs';

export const MAX_BRIEF = 24000; // a Windows command line stops at 32,767 characters; the brief is one argument of it
export const DEFAULT_TIMEOUT_SEC = 90;
export const MAX_TIMEOUT_SEC = 3600;
export const TAIL_CHARS = 2000;
export const TITLE_MAX = 200;
export const BRANCH_RE = /^claude\/[\w./-]+$/; // the hub's rule for a tracked branch
// Permission modes a cloud session offers (code.claude.com/docs/en/permission-modes: "Bypass permissions isn't available").
export const CLOUD_MODES = ['auto', 'acceptEdits', 'plan'];

// An error whose message is meant for the person running the tool. `extra` fields (tail, prompt) go into the JSON.
export class StartError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'StartError';
    this.extra = extra;
  }
}

export const USAGE = `Start a Claude Code cloud session from a shell that has no terminal.

Usage: node start/index.mjs [--cwd <repo>] (--brief-file <file> | --brief "<text>") [options]

  --cwd <repo>            repository to start the session from (default: the current directory)
  --brief-file <file>     the task brief, read from a UTF-8 file (preferred)
  --brief "<text>"        the task brief on the command line
  --branch claude/<slug>  the branch the session will work on (default: taken from a brief line that
                          mentions "branch" and contains claude/<slug>)
  --title "<text>"        title shown in the hub (default: the first non-empty line of the brief)
  --timeout <sec>         how long to wait for the session URL (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC})
  --permission-mode <m>   the session's permission mode: ${CLOUD_MODES.join(', ')} (default: CLOUD_PILOT_PERMISSION_MODE,
                          else claude's own default). Cloud sessions have no bypassPermissions mode.
  --no-track              do not register the session with the cloud-pilot hub
  --help                  this text

The brief is at most ${MAX_BRIEF} characters. Prints one JSON line:
  {"ok":true,"session_id":"...","url":"...","account_dir":"...","hub":{"id":"..."}}
  {"ok":false,"error":"...","tail":"..."}     (exit code 1)
Environment: CLOUD_PILOT_CLAUDE_BIN, CLOUD_PILOT_LOCAL_ONLY, CLOUD_PILOT_PERMISSION_MODE, CLOUD_PILOT_PYTHON, CLOUD_PILOT_DIR.
`;

// ---- arguments ------------------------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['cwd', 'brief', 'brief-file', 'branch', 'title', 'timeout', 'permission-mode']);
const BOOL_FLAGS = new Set(['no-track', 'help']);

// A value flag always takes the next argument as its value, even one that starts with "--" (a brief "--- notes").
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h') { raw.help = true; continue; }
    if (typeof a !== 'string' || !a.startsWith('--')) throw new StartError(`usage: unexpected argument "${a}" (see --help)`);
    const eq = a.indexOf('=');
    const key = eq > 2 ? a.slice(2, eq) : a.slice(2);
    if (BOOL_FLAGS.has(key)) {
      if (eq > 2) throw new StartError(`usage: --${key} takes no value`);
      raw[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      if (eq > 2) raw[key] = a.slice(eq + 1);
      else if (i + 1 < argv.length) { raw[key] = argv[i + 1]; i += 1; }
      else throw new StartError(`usage: --${key} needs a value`);
    } else throw new StartError(`usage: unknown option --${key} (see --help)`);
  }
  if (raw.help) return { help: true };
  if (raw.brief !== undefined && raw['brief-file'] !== undefined) throw new StartError('usage: give --brief or --brief-file, not both');
  if (raw.brief === undefined && raw['brief-file'] === undefined) throw new StartError('usage: a brief is required: --brief-file <file> or --brief "<text>" (see --help)');
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (raw.timeout !== undefined) {
    timeoutSec = Number(raw.timeout);
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
      throw new StartError(`usage: --timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}`);
    }
  }
  if (raw.cwd === '') throw new StartError('usage: --cwd must not be empty');
  if (raw['permission-mode'] !== undefined) checkMode(raw['permission-mode']);
  return {
    help: false,
    cwd: raw.cwd,
    brief: raw.brief,
    briefFile: raw['brief-file'],
    branch: raw.branch,
    title: raw.title,
    timeoutSec,
    track: raw['no-track'] !== true,
    permissionMode: raw['permission-mode'],
  };
}

// A mode the cloud session honours; bypassPermissions/dontAsk are refused, since the cloud drops them silently.
export function checkMode(mode) {
  if (CLOUD_MODES.includes(mode)) return mode;
  const hint = /^(bypassPermissions|dontAsk)$/.test(mode) ? ' (cloud sessions have no bypass mode; use auto)' : '';
  throw new StartError(`usage: --permission-mode must be one of ${CLOUD_MODES.join(', ')}${hint}`);
}

// The brief as it will be passed to claude. A byte-order mark (Windows editors) is dropped; empty, oversized or
// NUL-containing briefs are refused (a NUL cannot be part of a process argument).
export function checkBrief(text) {
  const brief = String(text ?? '').replace(/^\ufeff/, '');
  if (!brief.trim()) throw new StartError('the brief is empty');
  if (brief.length > MAX_BRIEF) throw new StartError(`the brief is ${brief.length} characters; keep it under ${MAX_BRIEF} (point at repository files instead of pasting them)`);
  if (brief.includes('\0')) throw new StartError('the brief contains a NUL character');
  return brief;
}

// claude would read a leading "-" as one of its own options; a leading space keeps the brief a plain value.
export function briefArg(brief) {
  return brief.startsWith('-') ? ` ${brief}` : brief;
}

export function claudeArgv(prefix, brief, mode) {
  return [...prefix, ...(mode ? ['--permission-mode', mode] : []), '--cloud', briefArg(brief)];
}

// ---- branch and title -----------------------------------------------------------------------------------------------

// claude/<slug>, not part of a longer path: `.claude/cloud/policy.md` and `origin/claude/x` never match.
const BRANCH_IN_TEXT = /(?<![\w./-])claude\/[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]/g;

// The session's branch: the first claude/<slug> on a line that mentions "branch"; '' when there is none.
export function detectBranch(brief) {
  for (const line of String(brief).split(/\r?\n/)) {
    // the word "branch" inside a slug (claude/fix-branch-bug) does not count as the line talking about a branch
    if (!/\bbranch(?:es)?\b/i.test(line.replace(BRANCH_IN_TEXT, ' '))) continue;
    for (const m of line.matchAll(BRANCH_IN_TEXT)) {
      if (BRANCH_RE.test(m[0]) && !m[0].includes('..')) return m[0];
    }
  }
  return '';
}

export function checkBranch(branch) {
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new StartError('usage: --branch must look like claude/<slug>');
  return branch;
}

const cut = (s, n) => Array.from(s).slice(0, n).join('');

// The first line that has a letter or digit in it (a leading "---" or a code fence is not a title), without markdown
// heading marks, at most 200 characters.
export function defaultTitle(brief) {
  for (const line of String(brief).split(/\r?\n/)) {
    const t = line.replace(/^\s*#+\s*/, '').trim();
    if (/[\p{L}\p{N}]/u.test(t)) return cut(t, TITLE_MAX);
  }
  return '';
}

export function makeTitle(explicit, brief) {
  const t = typeof explicit === 'string' ? explicit.trim() : '';
  return t ? cut(t, TITLE_MAX) : defaultTitle(brief);
}

// ---- accounts -------------------------------------------------------------------------------------------------------

export function parseLocalOnly(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function isLocalOnly(account, value) {
  return parseLocalOnly(value).has(String(account).toLowerCase());
}

// ---- terminal output ------------------------------------------------------------------------------------------------

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_FORWARD = /\x1b\[(\d*)C/g; // a terminal moves right instead of printing spaces
const CSI_LINE = /\x1b\[\d*(?:;\d*)?[HfBEJ]/g; // positioning and screen clears start a new line
const CSI = /\x1b\[[0-9;:?<>=]*[ -/]*[@-~]/g;
const ESC_REST = /\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>78]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// Plain text of what a terminal program printed: escape sequences removed, cursor moves turned into spaces or line
// breaks so words do not run together, carriage returns turned into line breaks.
export function cleanOutput(raw) {
  return String(raw)
    .replace(OSC, '')
    .replace(CSI_FORWARD, ' ')
    .replace(CSI_LINE, '\n')
    .replace(CSI, '')
    .replace(ESC_REST, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL, '');
}

// The last `n` characters of the non-blank lines (what goes into the "tail" field of a failure).
export function tailOf(text, n = TAIL_CHARS) {
  const joined = String(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).join('\n');
  return joined.slice(-n);
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
// Frame characters a terminal UI draws around a line: box lines, quote and bullet marks.
const FRAME_LEAD = /^[\s\u2500-\u259f|>\u276f\u203a\u00bb*\u2022\u00b7\u25cf\u25cb\u25c6\u25c7\u273b\u273d\u2736]+/u;
const FRAME_TAIL = /[\s\u2500-\u259f|]+$/u;
const bare = (line) => squash(line.replace(FRAME_LEAD, '').replace(FRAME_TAIL, ''));

// ---- session URL ----------------------------------------------------------------------------------------------------

const SESSION_URL = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)((?:[/?#][^\s"'<>)\]}\u2500-\u259f]*)?)/g;

// The first cloud session link that is not one the brief itself mentions. `atEnd` is true when nothing follows the link
// yet, not even a line break: more characters may still be on their way (a link cut by a read boundary).
export function findSessionUrl(text, brief = '') {
  for (const m of text.matchAll(SESSION_URL)) {
    if (brief && brief.includes(m[1])) continue;
    const suffix = m[2].replace(/[.,;:!?]+$/, '');
    return { sessionId: m[1], url: `https://claude.ai/code/${m[1]}${suffix}`, atEnd: m.index + m[0].length >= text.length };
  }
  return null;
}

// ---- prompts claude asks --------------------------------------------------------------------------------------------

// claude's own prompt lines. Each pattern is anchored to the start (or end) of a line, so a brief that talks about
// logging in or trusting a folder does not look like a prompt.
export const PROMPTS = [
  { kind: 'trust', re: /^(?:do you trust\b|is this a project you\b|quick safety check\b|yes, i trust this folder\b)|\btrust (?:the files in )?this (?:folder|directory)\??$/i },
  { kind: 'login', re: /^(?:cloud sessions need a claude\.ai sign-in\b|cloud sessions aren'?t available with this console sign-in\b|unable to get organization uuid\b|not logged in\b|you are not logged in\b|please (?:run )?\/?log ?in\b|please sign in\b|select login method\b|choose (?:a )?login method\b|paste (?:the )?code here\b|browser didn'?t open\b|opening browser to sign in\b|invalid api key\b|oauth token has expired\b|run \/login\b|(?:sign|log) in (?:to|with)\b|\d\.\s*(?:claude account with subscription|anthropic console account)\b)/i },
  { kind: 'confirm', re: /(?:\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\])\s*[:?]?$/i },
  { kind: 'picker', re: /^(?:select|choose|pick) (?:an? |the )?(?:environment|repository|repo|organization|account|region)\b|\benter to (?:select|confirm)\b.*\besc\b|\bto navigate\b.*\besc\b/i },
];

// The same prompts with every space removed: a terminal UI may place words with cursor moves the cleanup cannot turn
// back into spaces (seen for real on Windows: "Quicksafetycheck:Isthisaproject..."). Anchored like PROMPTS.
export const PROMPTS_NOSPACE = [
  { kind: 'trust', re: /^(?:doyoutrust|isthisaprojectyou|quicksafetycheck|yes,itrustthisfolder)/i },
  { kind: 'login', re: /^(?:cloudsessionsneedaclaude\.aisign-in|notloggedin|youarenotloggedin|please(?:run)?\/?login|pleasesignin|selectloginmethod|choose(?:a)?loginmethod|pastethecodehere|invalidapikey|oauthtokenhasexpired|run\/login)/i },
  { kind: 'picker', re: /^(?:select|choose|pick)(?:an?|the)?(?:environment|repository|repo|organization|account|region)|entertoconfirm.*esc/i },
];

const nospace = (s) => s.replace(/\s+/g, '').toLowerCase();

// Which prompt claude is showing, from the cleaned output: { kind, line } or null. Lines that are only the echo of the
// brief (any piece of it, wrapped or framed) are skipped.
export function detectPrompt(text, brief = '') {
  const flat = squash(brief);
  const lines = text.split('\n').map(bare).filter(Boolean).filter((l) => !flat.includes(l));
  for (const { kind, re } of PROMPTS) {
    const line = lines.find((l) => re.test(l));
    if (line) return { kind, line };
  }
  const flatNo = nospace(brief);
  const squeezed = lines.map((l) => ({ l, n: nospace(l) })).filter(({ n }) => n && !flatNo.includes(n));
  for (const { kind, re } of PROMPTS_NOSPACE) {
    const hit = squeezed.find(({ n }) => re.test(n));
    if (hit) return { kind, line: hit.l };
  }
  return null;
}

// One look at everything claude printed so far.
//   { kind: 'url', sessionId, url, text }   the session was created
//   { kind: 'prompt', prompt, line, text }  claude is waiting for an answer this tool never gives
//   { kind: 'pending', settling, text }     nothing decisive yet; `settling` when a link ends the text and more may follow
// `settled` says the output has been quiet for a moment, so a link at the very end is complete.
export function analyze(raw, { brief = '', settled = false } = {}) {
  const text = cleanOutput(raw);
  const found = findSessionUrl(text, brief);
  if (found && (settled || !found.atEnd)) return { kind: 'url', sessionId: found.sessionId, url: found.url, text };
  if (found) return { kind: 'pending', settling: true, text };
  const prompt = detectPrompt(text, brief);
  if (prompt) return { kind: 'prompt', prompt: prompt.kind, line: prompt.line, text };
  return { kind: 'pending', settling: false, text };
}

export function promptError(kind, cwd) {
  const where = {
    trust: `open claude once in ${cwd} and accept the trust question, then retry`,
    login: 'run "claude auth login" (or /login inside claude), then retry',
    confirm: 'run "claude --cloud" yourself once to answer it, then retry',
    picker: 'run "claude --cloud" yourself once and pick the environment or repository, then retry',
  }[kind];
  return `claude --cloud stopped at a ${kind} prompt, which this tool never answers: ${where}`;
}

// ---- the claude executable ------------------------------------------------------------------------------------------

const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
const SCRIPT_EXT = /\.(?:mjs|cjs|js)$/i;

// The absolute folders of PATH. An empty or relative entry ("." means the folder we run in) is skipped: a program in
// the current folder (a repository's own claude.exe) is never what the person meant.
function pathDirs(env, p) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  return String(key ? env[key] : '').split(p.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter((d) => d && p.isAbsolute(d));
}

// Every file on PATH that `name` can stand for, best first. On Windows the extensions are tried one after the other
// over ALL folders (every claude.exe on PATH before any claude.cmd), not folder by folder: a claude.cmd shim in an
// early folder must not hide the claude.exe in a later one.
function lookupAll(name, env, platform, exists) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' && !p.extname(name) ? ['.exe', '.cmd', '.bat'] : [''];
  const out = [];
  for (const ext of exts) {
    for (const dir of pathDirs(env, p)) {
      const full = p.join(dir, name + ext);
      if (exists(full) && !out.includes(full)) out.push(full);
    }
  }
  return out;
}

// Where claude is and how to start it: { prefix: [exe, ...fixed args] } or { error }.
// - CLOUD_PILOT_CLAUDE_BIN (a path, or a name looked up on PATH) overrides the lookup of "claude" on PATH.
// - A .js/.mjs/.cjs file is run with Node (a stand-in claude for tests).
// - On Windows a claude.cmd shim would pass the brief through cmd.exe, which parses quotes and % signs: use a real
//   claude.exe from any PATH folder, else the native claude.exe inside the npm package next to a claude.cmd shim, else
//   ask for one.
export function resolveClaude(env = process.env, { platform = process.platform, exists = isFile, node = process.execPath } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const wanted = setting('CLAUDE_BIN', env);
  let found;
  if (wanted) {
    const hasDir = /[\\/]/.test(wanted) || p.isAbsolute(wanted);
    found = hasDir ? (exists(wanted) ? [wanted] : []) : lookupAll(wanted, env, platform, exists);
    if (!found.length) return { error: `claude not found: CLOUD_PILOT_CLAUDE_BIN is set to "${wanted}", which does not exist` };
  } else {
    found = lookupAll('claude', env, platform, exists);
    if (!found.length) return { error: 'claude not found: install Claude Code (https://code.claude.com/docs) and put it on PATH, or set CLOUD_PILOT_CLAUDE_BIN to its full path' };
  }
  const isShim = (f) => platform === 'win32' && /\.(?:cmd|bat)$/i.test(f);
  const direct = found.find((f) => !isShim(f));
  if (direct) return SCRIPT_EXT.test(direct) ? { path: direct, prefix: [node, direct] } : { path: direct, prefix: [direct] };
  for (const shim of found) {
    const native = p.join(p.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exists(native)) return { path: native, prefix: [native] };
  }
  return { error: `found ${found[0]}, a cmd.exe shim that would parse the brief as shell text: install the native claude.exe (see the Claude Code docs) or set CLOUD_PILOT_CLAUDE_BIN to claude.exe` };
}
