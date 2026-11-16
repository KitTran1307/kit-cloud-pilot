// The channel starts gh by its full path, never from the folder it runs in (Windows looks there first for a bare name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExe, safeCwd } from '../cloud/channel.mjs';

test('a gh in the current folder, or on a relative PATH entry, is never the one resolved', () => {
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-exe-here-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-exe-real-'));
  const win = process.platform === 'win32';
  const name = win ? 'gh.exe' : 'gh';
  fs.writeFileSync(path.join(here, name), 'planted');
  fs.writeFileSync(path.join(real, name), 'real', { mode: 0o755 });
  const before = process.cwd();
  try {
    process.chdir(here);
    const env = { PATH: ['.', here, '', real].join(path.delimiter) };
    assert.equal(resolveExe('gh', env), path.join(real, name));
    // Not found anywhere safe: the bare name, which fails as "not found" (then GH_TOKEN is used).
    assert.equal(resolveExe('gh', { PATH: ['.', here].join(path.delimiter) }), 'gh');
    // The current folder reached through a link (a junction on Windows, a symlink elsewhere; macOS /var is one) is
    // still the current folder.
    const link = `${here}-link`;
    fs.symlinkSync(here, link, 'junction');
    try {
      assert.equal(resolveExe('gh', { PATH: [link, real].join(path.delimiter) }), path.join(real, name));
    } finally {
      fs.rmSync(link, { recursive: false, force: true });
    }
  } finally {
    process.chdir(before);
    fs.rmSync(here, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
  assert.equal(safeCwd(), os.homedir());
});
