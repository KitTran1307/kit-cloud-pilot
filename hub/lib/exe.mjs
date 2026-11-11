// Starting other programs (gh, git, python, powershell, osascript, notify-send) without letting the folder we happen to
// run in choose which program that is. Node on Windows looks in the current folder before PATH for a bare command name,
// so a checkout that holds a `gh.exe` or `git.exe` at its root would run it. Two defences, used together:
//   - resolveExe(name): the full path of `name` found on PATH, skipping relative entries and the current folder;
//   - safeCwd(): the folder a child process starts in, the home folder, never a repository.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** The folder every child process is started in: the home folder (not a checkout, not chosen by a PR or a repository). */
export const safeCwd = () => homedir();

const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
const isExecutable = (f) => { try { const s = statSync(f); return s.isFile() && (process.platform === 'win32' || (s.mode & 0o111) !== 0); } catch { return false; } };

const sameDir = (a, b, p, platform) => {
  const norm = (d) => { const x = p.resolve(d).replace(/[\\/]+$/, ''); return platform === 'win32' ? x.toLowerCase() : x; };
  return norm(a) === norm(b);
};

/**
 * The full path of `name` on PATH, or null. PATH entries that are empty, relative ("."), or the current folder are
 * skipped. On Windows only .exe and .com files count (what Node can start without a shell) unless `name` has an extension.
 * A name that already holds a folder part is the caller's own choice of file: returned as an absolute path (a relative one
 * is taken from the current folder, which is where the person typed it; the child process starts elsewhere).
 */
export function findOnPath(name, { env = process.env, platform = process.platform, cwd = process.cwd(), exists = platform === 'win32' ? isFile : isExecutable } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (/[\\/]/.test(name)) return p.isAbsolute(name) ? name : p.resolve(cwd, name);
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const exts = platform === 'win32' && !p.extname(name) ? ['.exe', '.com'] : [''];
  for (const raw of String(key ? env[key] : '').split(p.delimiter)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!dir || !p.isAbsolute(dir) || sameDir(dir, cwd, p, platform)) continue;
    for (const ext of exts) {
      const full = p.join(dir, name + ext);
      if (exists(full)) return full;
    }
  }
  return null;
}

/** `name` as a full path (see findOnPath); the bare name when PATH has none, so a missing tool still fails as "not found". */
export function resolveExe(name, opts) {
  return findOnPath(name, opts) ?? name;
}

/**
 * Programs that ship with the operating system are taken from their fixed place first (Windows PowerShell, macOS
 * osascript), then from PATH.
 */
export function resolveSystemExe(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  let fixed = null;
  if (platform === 'win32' && name.toLowerCase() === 'powershell.exe') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    fixed = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  } else if (platform === 'darwin' && name === 'osascript') fixed = '/usr/bin/osascript';
  if (fixed && exists(fixed)) return fixed;
  return resolveExe(name, { env, platform });
}
