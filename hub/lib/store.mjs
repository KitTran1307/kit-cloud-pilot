// Files the hub and its clients share, under CLOUD_PILOT_DIR (default ~/.claude/cloud-pilot). Writes are atomic (tmp + rename).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from './config.mjs';

export function hubDir(env = process.env) {
  return setting('DIR', env) || join(homedir(), '.claude', 'cloud-pilot');
}

export function paths(dir = hubDir()) {
  return {
    dir,
    tracked: join(dir, 'tracked.json'),
    state: join(dir, 'state.json'),
    snapshots: join(dir, 'snapshots.json'),
    etags: join(dir, 'etags.json'),
    pid: join(dir, 'hub.pid'),
    log: join(dir, 'hub.log'),
    queues: join(dir, 'queue'),
    waiters: join(dir, 'waiters'),
    lock: join(dir, 'tracked.lock'),
  };
}

// The fallback only when the file does not exist. Any other failure (a scanner holding the file, a torn read) is
// retried, then thrown: a caller inside the lock must never write a fallback over real data.
// Damaged JSON (a power cut before the data reached the disk): `{ cache: true }` files (etags, snapshots, state,
// queues of nothing important) start over from the fallback; other files are read from their `.bak` (writeJson with
// `{ backup: true }` keeps one), else the error is thrown.
export function readJson(file, fallback, { cache = false } = {}) {
  for (let i = 0; ; i += 1) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      if (i >= 10) throw new Error(`kit-hub: cannot read ${file}: ${err.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      if (i < 3) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); continue; } // a torn read: retry
      if (cache) return fallback;
      try {
        return JSON.parse(readFileSync(`${file}.bak`, 'utf8'));
      } catch {
        throw new Error(`kit-hub: ${file} is damaged and has no usable .bak: ${err.message}`);
      }
    }
  }
}

export function writeJson(file, value, { backup = false } = {}) {
  mkdirSync(join(file, '..'), { recursive: true });
  if (backup && existsSync(file)) {
    try { JSON.parse(readFileSync(file, 'utf8')); writeFileSync(`${file}.bak`, readFileSync(file)); } catch { /* keep the last good .bak */ }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  for (let i = 0; ; i += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows: a reader holding the file makes rename fail for a moment.
      if (i >= 20) { rmSync(tmp, { force: true }); throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
}

export function remove(file) {
  rmSync(file, { force: true });
}

export function log(p, line) {
  try {
    mkdirSync(p.dir, { recursive: true });
    if (existsSync(p.log) && statSync(p.log).size > 2_000_000) renameSync(p.log, `${p.log}.1`);
    appendFileSync(p.log, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging never breaks the hub
  }
}

// A short exclusive section around read-modify-write of tracked.json / queues (mkdir is atomic on Windows too).
export function withLock(p, fn) {
  mkdirSync(p.dir, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(p.lock);
      break;
    } catch {
      try {
        // A stale lock (holder crashed) is renamed away first: only one process wins the rename, so two never both
        // clear it and enter.
        if (Date.now() - statSync(p.lock).mtimeMs > 30_000) {
          const aside = `${p.lock}.stale.${process.pid}.${Date.now()}`;
          renameSync(p.lock, aside);
          rmSync(aside, { recursive: true, force: true });
        }
      } catch { /* gone already, or another process renamed it */ }
      if (Date.now() - started > 10_000) throw new Error('kit-hub: lock busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(p.lock, { recursive: true, force: true });
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
