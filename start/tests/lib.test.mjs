import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BRIEF, StartError, analyze, briefArg, checkBranch, checkBrief, checkDenied, claudeArgv, cleanOutput, defaultTitle, detectBranch,
  detectPrompt, findSessionUrl, isLocalOnly, makeTitle, parseArgs, parseLocalOnly, promptError, resolveClaude, tailOf,
} from '../lib.mjs';

const throwsStart = (fn, re) => assert.throws(fn, (err) => err instanceof StartError && re.test(err.message));

describe('cleanOutput', () => {
  test('removes colors, titles and cursor sequences', () => {
    const raw = '\x1b[2J\x1b[H\x1b]0;window title\x07\x1b[1mClaude\x1b[0m \x1b[36mCode\x1b[0m\x1b[?25l\x1b(B';
    assert.equal(cleanOutput(raw).replace(/\n/g, ''), 'Claude Code');
  });
  test('a cursor move to the right keeps words apart', () => {
    assert.equal(cleanOutput('Created\x1b[1Ccloud\x1b[3Csession'), 'Created cloud session');
  });
  test('line breaks: CRLF and lone CR become one and one', () => {
    assert.equal(cleanOutput('a\r\nb\rc\n'), 'a\nb\nc\n');
  });
  test('OSC sequences ended by ESC backslash are removed', () => {
    assert.equal(cleanOutput('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'link');
  });
  test('other control characters go, tab and newline stay', () => {
    assert.equal(cleanOutput('a\x07b\x00c\td\ne'), 'abc\td\ne');
  });
});

describe('tailOf', () => {
  test('drops blank lines and keeps the last characters', () => {
    assert.equal(tailOf('one\n\n   \ntwo  \nthree\n'), 'one\ntwo\nthree');
    const long = Array.from({ length: 500 }, (_, i) => `line number ${i}`).join('\n');
    const tail = tailOf(long);
    assert.equal(tail.length, 2000);
    assert.ok(tail.endsWith('line number 499'));
  });
});

describe('findSessionUrl', () => {
  test('finds the id and the link', () => {
    const f = findSessionUrl('Created cloud session https://claude.ai/code/session_TEST123\nnext', '');
    assert.deepEqual(f, { sessionId: 'session_TEST123', url: 'https://claude.ai/code/session_TEST123', atEnd: false });
  });
  test('keeps a query string, drops trailing punctuation', () => {
    const f = findSessionUrl('see https://claude.ai/code/session_01AbC?from=cli&m=0. Done\n');
    assert.equal(f.url, 'https://claude.ai/code/session_01AbC?from=cli&m=0');
  });
  test('stops at box-drawing characters and quotes', () => {
    assert.equal(findSessionUrl('\u2502 https://claude.ai/code/session_X1/ \u2502\n').url, 'https://claude.ai/code/session_X1/');
    assert.equal(findSessionUrl('"https://claude.ai/code/session_X2"\n').sessionId, 'session_X2');
  });
  test('a link that ends the text may still be growing', () => {
    assert.equal(findSessionUrl('url https://claude.ai/code/session_TES').atEnd, true);
    assert.equal(findSessionUrl('url https://claude.ai/code/session_TES  \n  ').atEnd, false);
    assert.equal(findSessionUrl('url https://claude.ai/code/session_TES\n').atEnd, false);
    assert.equal(findSessionUrl('url https://claude.ai/code/session_TES\nmore').atEnd, false);
  });
  test('a session the brief itself mentions is not the new one', () => {
    const brief = 'Continue the work of https://claude.ai/code/session_OLD999 please';
    const text = '> Continue the work of https://claude.ai/code/session_OLD999 please\nCreated https://claude.ai/code/session_NEW1\n';
    assert.equal(findSessionUrl(text, brief).sessionId, 'session_NEW1');
    assert.equal(findSessionUrl('> https://claude.ai/code/session_OLD999\n', brief), null);
  });
  test('other claude.ai links are ignored', () => {
    assert.equal(findSessionUrl('https://claude.ai/login and https://claude.ai/code/ and https://claude.ai/code/abc'), null);
  });
});

describe('detectPrompt', () => {
  test('recognizes claude prompt lines', () => {
    assert.equal(detectPrompt('Do you trust the files in this folder?').kind, 'trust');
    assert.equal(detectPrompt(' \u2502 Do you trust the files in this folder? \u2502').kind, 'trust');
    assert.equal(detectPrompt('Quick safety check: Is this a project you created or one you trust?').kind, 'trust');
    assert.equal(detectPrompt('Not logged in \u00b7 Please run /login').kind, 'login');
    assert.equal(detectPrompt('Select login method:\n 1. Claude account with subscription').kind, 'login');
    assert.equal(detectPrompt('Cloud sessions need a claude.ai sign-in. Run `claude auth login` (or /login), then try again.').kind, 'login');
    assert.equal(detectPrompt('Unable to get organization UUID').kind, 'login');
    assert.equal(detectPrompt('Create a new environment? (y/n)').kind, 'confirm');
    assert.equal(detectPrompt('Overwrite? [Y/n]').kind, 'confirm');
    assert.equal(detectPrompt('Select an environment\n 1. Default').kind, 'picker');
    assert.equal(detectPrompt('\u2191/\u2193 to navigate \u00b7 Enter to select \u00b7 Esc to cancel').kind, 'picker');
  });
  test('a trust question wins over the footer it shares with menus', () => {
    assert.equal(detectPrompt('Do you trust the files in this folder?\nEnter to confirm \u00b7 Esc to cancel').kind, 'trust');
  });
  test('the word login (or trust, or y/n) inside ordinary text is not a prompt', () => {
    for (const text of [
      'Fix the login page so it does not log in twice',
      'The user is not logged in, show the form',
      '> Add a (y/n) confirmation to the login flow, then check you log in again',
      'Do not ask: do you trust this device? Just continue',
      'Created cloud session https://claude.ai/code/session_A1 - the login bug',
      'the app must log in to the API',
    ]) assert.equal(detectPrompt(text), null, text);
  });
  test('lines that only echo the brief are skipped, wrapped or framed', () => {
    const brief = 'Handle this case:\nNot logged in \u00b7 Please run /login\nDo you trust the files in this folder?\nAsk (y/n)';
    const echo = '> Handle this case:\n\u2502 Not logged in \u00b7 Please run\n\u2502 /login\n> Do you trust the files in this folder?\n> Ask (y/n)\n';
    assert.equal(detectPrompt(echo, brief), null);
    // the same text from claude itself, not in the brief, is a prompt
    assert.equal(detectPrompt(echo, 'something else').kind, 'trust');
    assert.equal(detectPrompt(echo + 'Not logged in \u00b7 Please run /login again please\n', brief)?.kind, 'login');
  });
});

describe('analyze', () => {
  test('pending, url, prompt', () => {
    assert.equal(analyze('\x1b[1mClaude Code\x1b[0m\r\n').kind, 'pending');
    const url = analyze('Created cloud session \x1b[36mhttps://claude.ai/code/session_TEST123\x1b[0m\r\n');
    assert.equal(url.kind, 'url');
    assert.equal(url.sessionId, 'session_TEST123');
    assert.equal(url.url, 'https://claude.ai/code/session_TEST123');
    const prompt = analyze('Not logged in \u00b7 Please run /login\r\n');
    assert.equal(prompt.kind, 'prompt');
    assert.equal(prompt.prompt, 'login');
  });
  test('a link at the very end waits until the output is quiet', () => {
    const raw = 'Created cloud session https://claude.ai/code/session_TEST1';
    assert.deepEqual(analyze(raw), { kind: 'pending', settling: true, text: raw });
    assert.equal(analyze(raw, { settled: true }).sessionId, 'session_TEST1');
    assert.equal(analyze(`${raw}23\n`).sessionId, 'session_TEST123');
  });
  test('a brief with the word login and a link in it still ends in the real link', () => {
    const brief = 'Fix the login bug. See https://claude.ai/code/session_OLD1 for context.';
    const raw = `> ${brief}\nCreated https://claude.ai/code/session_NEW2\n`;
    assert.equal(analyze(raw, { brief }).sessionId, 'session_NEW2');
  });
  test('the link wins when a prompt line is also on screen', () => {
    const a = analyze('Not logged in? Please run /login\nhttps://claude.ai/code/session_Z9\n');
    assert.equal(a.kind, 'url');
  });
});

describe('detectBranch', () => {
  const cases = [
    ['Work on branch claude/fix-login-bug and open a PR', 'claude/fix-login-bug'],
    ['Branch: `claude/add-pricing.v2`', 'claude/add-pricing.v2'],
    ['create the branch claude/a/b-c from main, push it.', 'claude/a/b-c'],
    ['Use the BRANCH claude/x1.', 'claude/x1'],
    ['Several branches exist: claude/one, claude/two', 'claude/one'],
    ['first line\nsecond mentions claude/not-a-branch-line\nbranch claude/real-one', 'claude/real-one'],
    ['no branch is named here', ''],
    ['see claude/just-a-path-without-the-word', ''],
    ['branch rules live in .claude/cloud/policy.md', ''],
    ['branch origin/claude/slug is remote', ''],
    ['branch foo/claude/slug', ''],
    ['branch claude/a..b then claude/ok-1', 'claude/ok-1'],
    ['branch claude/', ''],
    ['', ''],
  ];
  for (const [brief, want] of cases) {
    test(JSON.stringify(brief), () => assert.equal(detectBranch(brief), want));
  }
  test('checkBranch accepts only claude/<slug>', () => {
    assert.equal(checkBranch('claude/fix-1'), 'claude/fix-1');
    for (const bad of ['main', 'claude/', 'claude/a..b', 'claude/a b', 'feature/claude/x', '']) throwsStart(() => checkBranch(bad), /claude\/<slug>/);
  });
});

describe('title', () => {
  test('the first non-empty line', () => {
    assert.equal(defaultTitle('\n\n  Fix the pricing table  \nmore\n'), 'Fix the pricing table');
  });
  test('skips lines without a letter or digit, and heading marks', () => {
    assert.equal(defaultTitle('---\n```\n## Add dark mode\nbody'), 'Add dark mode');
    assert.equal(defaultTitle('   \n\n'), '');
  });
  test('at most 200 characters, without splitting a character', () => {
    assert.equal(defaultTitle('x'.repeat(500)).length, 200);
    const emoji = defaultTitle('a\u{1F600}'.repeat(300));
    assert.equal(Array.from(emoji).length, 200);
    assert.ok(!/[\ud800-\udbff]$/.test(emoji));
  });
  test('an explicit title wins, trimmed and cut', () => {
    assert.equal(makeTitle('  My title ', 'Brief line'), 'My title');
    assert.equal(makeTitle('', 'Brief line'), 'Brief line');
    assert.equal(makeTitle(undefined, 'Brief line'), 'Brief line');
    assert.equal(makeTitle('y'.repeat(300), 'b').length, 200);
  });
});

describe('parseArgs', () => {
  test('defaults', () => {
    const a = parseArgs(['--brief', 'do it']);
    assert.deepEqual(a, { help: false, cwd: undefined, brief: 'do it', briefFile: undefined, branch: undefined, title: undefined, timeoutSec: 90, track: true, permissionMode: undefined, model: undefined, effort: undefined });
  });
  test('every flag, both spellings', () => {
    const a = parseArgs(['--cwd', '/r', '--brief-file=b.md', '--branch', 'claude/x', '--title=T', '--timeout', '30', '--no-track', '--permission-mode', 'auto']);
    assert.deepEqual(a, { help: false, cwd: '/r', brief: undefined, briefFile: 'b.md', branch: 'claude/x', title: 'T', timeoutSec: 30, track: false, permissionMode: 'auto', model: undefined, effort: undefined });
  });
  test('a value that starts with -- is still a value', () => {
    assert.equal(parseArgs(['--brief', '--- notes']).brief, '--- notes');
    assert.equal(parseArgs(['--brief=--- notes', '--title', '--x']).title, '--x');
  });
  test('--help', () => {
    assert.deepEqual(parseArgs(['--help']), { help: true });
    assert.deepEqual(parseArgs(['-h']), { help: true });
    assert.deepEqual(parseArgs(['--brief', 'x', '--help']), { help: true });
  });
  test('usage errors', () => {
    throwsStart(() => parseArgs([]), /brief is required/);
    throwsStart(() => parseArgs(['--brief', 'a', '--brief-file', 'b']), /not both/);
    throwsStart(() => parseArgs(['--brief']), /needs a value/);
    throwsStart(() => parseArgs(['--bogus']), /unknown option --bogus/);
    throwsStart(() => parseArgs(['stray']), /unexpected argument "stray"/);
    throwsStart(() => parseArgs(['--brief', 'a', '--no-track=1']), /takes no value/);
    for (const t of ['0', '-5', '1.5', 'abc', '3601', '']) throwsStart(() => parseArgs(['--brief', 'a', '--timeout', t]), /--timeout/);
    throwsStart(() => parseArgs(['--brief', 'a', '--cwd=']), /--cwd/);
    throwsStart(() => parseArgs(['--brief', 'a', '--permission-mode', 'bypassPermissions']), /no bypass mode; use auto/);
    throwsStart(() => parseArgs(['--brief', 'a', '--permission-mode=manual']), /must be one of auto, acceptEdits, plan/);
  });
});

describe('brief', () => {
  test('limits', () => {
    assert.equal(checkBrief('x'.repeat(MAX_BRIEF)).length, MAX_BRIEF);
    throwsStart(() => checkBrief('x'.repeat(MAX_BRIEF + 1)), /24001 characters; keep it under 24000/);
    throwsStart(() => checkBrief('  \n\t '), /empty/);
    throwsStart(() => checkBrief(undefined), /empty/);
    throwsStart(() => checkBrief('a\0b'), /NUL/);
  });
  test('a byte-order mark is dropped, the rest is kept as is', () => {
    assert.equal(checkBrief('\uFEFFLine one\r\nLine two\n'), 'Line one\r\nLine two\n');
  });
  test('a leading dash gets a space so claude reads a value, not an option', () => {
    assert.equal(briefArg('--- notes'), ' --- notes');
    assert.equal(briefArg('-x'), ' -x');
    assert.equal(briefArg('plain'), 'plain');
    assert.deepEqual(claudeArgv(['/bin/claude'], 'do it'), ['/bin/claude', '--cloud', 'do it']);
    assert.deepEqual(claudeArgv(['node', 'fake.mjs'], '-x'), ['node', 'fake.mjs', '--cloud', ' -x']);
    assert.deepEqual(claudeArgv(['claude'], 'do it', 'auto'), ['claude', '--permission-mode', 'auto', '--cloud', 'do it']);
    assert.deepEqual(claudeArgv(['claude'], 'do it', 'auto', { model: 'sonnet', effort: 'high' }),
      ['claude', '--permission-mode', 'auto', '--model', 'sonnet', '--effort', 'high', '--cloud', 'do it']);
  });
  test('the argument list is never joined into a command string', () => {
    const brief = 'a "quoted" $(whoami) && echo; `x` %PATH% \\n\nline';
    const argv = claudeArgv(['claude'], brief);
    assert.equal(argv.length, 3);
    assert.equal(argv[2], brief);
  });
});

describe('local-only accounts', () => {
  test('comma list, spaces and case ignored', () => {
    assert.deepEqual([...parseLocalOnly(' work, Other ,,')], ['work', 'other']);
    assert.equal(isLocalOnly('work', 'work'), true);
    assert.equal(isLocalOnly('WORK', 'a, work'), true);
    assert.equal(isLocalOnly('default', 'work'), false);
    assert.equal(isLocalOnly('default', undefined), false);
    assert.equal(isLocalOnly('default', ''), false);
    assert.equal(isLocalOnly('default', 'default'), true);
  });
});

describe('promptError', () => {
  test('names the prompt and what to do', () => {
    assert.match(promptError('trust', '/repo'), /trust prompt.*claude once in \/repo/);
    assert.match(promptError('login', '/repo'), /login prompt.*claude auth login/);
    assert.match(promptError('picker', '/repo'), /picker prompt/);
    assert.match(promptError('confirm', '/repo'), /confirm prompt/);
  });
});

describe('resolveClaude', () => {
  const exists = (...files) => (f) => files.includes(f);
  test('claude on PATH (POSIX)', () => {
    const r = resolveClaude({ PATH: '/a:/usr/local/bin:/b' }, { platform: 'linux', exists: exists('/usr/local/bin/claude') });
    assert.deepEqual(r, { path: '/usr/local/bin/claude', prefix: ['/usr/local/bin/claude'] });
  });
  test('claude.exe on PATH (Windows), the Path variable in any case', () => {
    const r = resolveClaude({ Path: 'C:\\x;C:\\Users\\me\\bin' }, { platform: 'win32', exists: exists('C:\\Users\\me\\bin\\claude.exe') });
    assert.deepEqual(r, { path: 'C:\\Users\\me\\bin\\claude.exe', prefix: ['C:\\Users\\me\\bin\\claude.exe'] });
  });
  test('claude.exe is preferred over claude.cmd in the same folder', () => {
    const files = ['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe'];
    assert.equal(resolveClaude({ PATH: 'C:\\bin' }, { platform: 'win32', exists: exists(...files) }).path, 'C:\\bin\\claude.exe');
  });
  test('a claude.cmd shim is replaced by the native binary of the npm package, else refused', () => {
    const native = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const ok = resolveClaude({ PATH: 'C:\\npm' }, { platform: 'win32', exists: exists('C:\\npm\\claude.cmd', native) });
    assert.deepEqual(ok, { path: native, prefix: [native] });
    const refused = resolveClaude({ PATH: 'C:\\npm' }, { platform: 'win32', exists: exists('C:\\npm\\claude.cmd') });
    assert.match(refused.error, /cmd\.exe shim/);
    assert.match(refused.error, /CLOUD_PILOT_CLAUDE_BIN/);
  });
  test('not found', () => {
    const r = resolveClaude({ PATH: '/a' }, { platform: 'linux', exists: () => false });
    assert.match(r.error, /claude not found/);
    assert.match(r.error, /CLOUD_PILOT_CLAUDE_BIN/);
  });
  test('CLOUD_PILOT_CLAUDE_BIN: a full path, a name on PATH, a missing file', () => {
    assert.equal(resolveClaude({ CLOUD_PILOT_CLAUDE_BIN: '/opt/claude' }, { platform: 'linux', exists: exists('/opt/claude') }).path, '/opt/claude');
    assert.equal(resolveClaude({ CLOUD_PILOT_CLAUDE_BIN: 'claude-beta', PATH: '/p' }, { platform: 'linux', exists: exists('/p/claude-beta') }).path, '/p/claude-beta');
    assert.match(resolveClaude({ CLOUD_PILOT_CLAUDE_BIN: '/no/such' }, { platform: 'linux', exists: () => false }).error, /"\/no\/such", which does not exist/);
  });
  test('the older KIT_HUB_ name works too', () => {
    assert.equal(resolveClaude({ KIT_HUB_CLAUDE_BIN: '/opt/c' }, { platform: 'linux', exists: exists('/opt/c') }).path, '/opt/c');
  });
  test('a script file runs with node', () => {
    const r = resolveClaude({ CLOUD_PILOT_CLAUDE_BIN: '/t/fake.mjs' }, { platform: 'linux', exists: exists('/t/fake.mjs'), node: '/usr/bin/node' });
    assert.deepEqual(r.prefix, ['/usr/bin/node', '/t/fake.mjs']);
  });
});

test('prompts drawn with cursor moves (no spaces left after cleanup) are still recognised', async () => {
  const { detectPrompt } = await import('../lib.mjs');
  const seen = 'Accessingworkspace:\nQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\nNo,exit\nYes,Itrustthisfolder\nEntertoconfirm\u00b7Esctocancel';
  assert.equal(detectPrompt(seen, 'add a file').kind, 'trust');
  assert.equal(detectPrompt('Notloggedin\u00b7Run/login', 'x').kind, 'login');
  // A brief that itself says these words, echoed without spaces, is not a prompt.
  const brief = 'Quick safety check: is this a project you trust? Not logged in.';
  assert.equal(detectPrompt('Quicksafetycheck:isthisaprojectyoutrust?Notloggedin.', brief), null);
});

describe('model, effort and the deny list', () => {
  test('--model and --effort are parsed and checked', () => {
    const a = parseArgs(['--brief', 'x', '--model', 'claude-sonnet-5-5[1m]', '--effort', 'xhigh']);
    assert.equal(a.model, 'claude-sonnet-5-5[1m]');
    assert.equal(a.effort, 'xhigh');
    assert.throws(() => parseArgs(['--brief', 'x', '--model', '--x']), /--model must be/);
    assert.throws(() => parseArgs(['--brief', 'x', '--model', 'a b']), /--model must be/);
    assert.throws(() => parseArgs(['--brief', 'x', '--effort', 'huge']), /--effort must be one of/);
  });
  test('checkDenied: off without a list; with one, a model is required and must not contain a denied word', () => {
    assert.equal(checkDenied(undefined, ''), undefined);
    assert.equal(checkDenied('opus', undefined), 'opus');
    assert.equal(checkDenied('sonnet', 'opus, fable'), 'sonnet');
    assert.equal(checkDenied('claude-haiku-5-5', 'opus,fable'), 'claude-haiku-5-5');
    assert.throws(() => checkDenied(undefined, 'opus'), /give the session a model/);
    assert.throws(() => checkDenied('claude-Opus-5-5', 'opus,fable'), /denied/);
    assert.throws(() => checkDenied('fable', 'opus,fable'), /denied/);
  });
});
