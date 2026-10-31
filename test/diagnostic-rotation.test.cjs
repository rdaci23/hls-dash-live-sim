const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { SessionDiagnostics } = require('../dist/support-tools/session-diagnostics.js'), { read } = require('../scripts/browser/complete-diagnostics.cjs');
async function record(t, maximum = 64, count = 80) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rotated-diag-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'requests.jsonl'), diag = new SessionDiagnostics('hls', { file, maxEvents: 3, maxFileBytes: 1024, rotateFiles: maximum }); for (let i = 0; i < count; i++)
    diag.record('scenario.started'); diag.close(); return { file, diag, metadata: diag.snapshot() }; }
test('bounded append-only rotation retains every event across closed hashed parts despite memory eviction', async (t) => { const { file, metadata } = await record(t); const result = await read(file, metadata); assert.equal(result.completeFile.eventCount, 82); assert.ok(result.completeFile.files.length > 1); assert.equal(result.completeFile.complete, true); assert.equal(result.events.at(-1).event, 'session.closed'); assert.ok(metadata.droppedEvents > 0); assert.ok(result.completeFile.files.every(p => p.bytes <= 1024)); });
test('missing, truncated, changed or mismatched rotated evidence never qualifies', async (t) => { for (const mutation of ['missing', 'truncated', 'body', 'index', 'runtime']) {
    const { file, metadata } = await record(t), part = path.join(path.dirname(file), metadata.rotation.files[1].file);
    if (mutation === 'missing')
        await fs.unlink(part);
    if (mutation === 'truncated') {
        const bytes = await fs.readFile(part);
        await fs.writeFile(part, bytes.subarray(0, -1));
    }
    if (mutation === 'body') {
        const bytes = await fs.readFile(part);
        bytes[5] ^= 1;
        await fs.writeFile(part, bytes);
    }
    if (mutation === 'index') {
        const name = path.join(path.dirname(file), metadata.rotation.indexFile), doc = JSON.parse(await fs.readFile(name));
        doc.files.pop();
        await fs.writeFile(name, JSON.stringify(doc));
    }
    if (mutation === 'runtime')
        metadata.eventsRecorded++;
    await assert.rejects(read(file, metadata));
} });
test('reaching rotation capacity is visible incomplete evidence and old files are preserved', async (t) => { const { file, metadata } = await record(t, 2, 100); assert.equal(metadata.fileLimitReached, true); assert.equal(metadata.rotation.files.length, 2); assert.equal(metadata.rotation.complete, false); await assert.rejects(read(file, metadata), /incomplete/); });
test('rotation rejects missing file, invalid bounds and existing destinations', async (t) => { assert.throws(() => new SessionDiagnostics('hls', { rotateFiles: 4 }), /explicit file/); for (const n of [0, 1, 257, 2.5]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bad-rotate-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    assert.throws(() => new SessionDiagnostics('hls', { file: path.join(dir, 'events'), rotateFiles: n }), /2–256/);
} const { file } = await record(t); assert.throws(() => new SessionDiagnostics('hls', { file, rotateFiles: 4 }), /EEXIST/); });
