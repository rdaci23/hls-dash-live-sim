const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

test('native suite rejects an unavailable Docker daemon before creating or launching test cases', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roku-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fakeBin = path.join(directory, 'bin');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const output = path.join(directory, 'evidence');
  await assert.rejects(exec(process.execPath, [path.resolve(__dirname, '../scripts/verify-roku-suite.cjs'),
    '--device', '127.0.0.1', '--server-host', '127.0.0.1', '--output', output], {
    cwd: directory, env: { ...process.env, PATH: fakeBin }, timeout: 5000
  }), error => {
    assert.match(error.stderr, /Docker daemon must be running before starting the Roku suite/);
    return true;
  });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});
