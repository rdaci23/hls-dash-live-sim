const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../scripts/browser/complete-diagnostics.cjs');
const { evaluate } = require('../scripts/browser/core-acceptance.cjs');
function data() {
  const metadata = { sessionId: 'session-test', protocol: 'dash', fileEnabled: true, eventsRecorded: 3, droppedEvents: 1, fileLimitReached: false, fileWriteFailed: false };
  const events = ['session.started', 'request.completed', 'session.closed'].map((event, index) => ({ event, eventId: index + 1, sessionId: metadata.sessionId, protocol: metadata.protocol }));
  return { metadata, events, bytes: () => Buffer.from(events.map(JSON.stringify).join('\n') + '\n') };
}
test('a complete closed file proves all events despite bounded in-memory ring eviction', () => {
  const d = data(), result = validate(d.bytes(), d.metadata);
  assert.equal(result.source, 'closed-file'); assert.equal(result.events.length, 3); assert.equal(result.droppedEvents, 1);
  assert.equal(result.completeFile.memoryDroppedEvents, 1); assert.equal(result.completeFile.complete, true);
  assert.match(result.completeFile.sha256, /^[a-f0-9]{64}$/); assert.equal(result.completeFile.bytes, d.bytes().length);
});
test('missing final newline, malformed JSON, session endpoints, identity and sequence gaps fail completeness', () => {
  const original = data(); assert.throws(() => validate(original.bytes().subarray(0, -1), original.metadata), /truncated/);
  assert.throws(() => validate(Buffer.from('not-json\n'), original.metadata), /JSONL/);
  assert.throws(() => validate(Buffer.alloc(10 * 1024 * 1024 + 1, 10), original.metadata), /oversized/);
  for (const edit of [d => d.events.pop(), d => d.events.shift(), d => d.events[1].eventId = 5, d => d.events[1].sessionId = 'other', d => d.events[1].protocol = 'hls', d => d.events[1].event = 'diagnostics.file_limit', d => d.metadata.fileWriteFailed = true, d => d.metadata.fileLimitReached = true, d => d.metadata.fileEnabled = false, d => d.metadata.eventsRecorded = 4]) {
    const d = data(); edit(d); assert.throws(() => validate(d.bytes(), d.metadata));
  }
});
test('a claimed closed-file source without a verified manifest cannot qualify browser evidence', () => {
  const result = evaluate({ metrics: { elapsedMs: 1, frames: 1, firstFrameMs: 0, runs: [], gaps: [], retrySettings: {} }, samples: [], audit: [], diagnostics: { source: 'closed-file', droppedEvents: 0 } });
  assert.ok(result.failures.includes('Evidence missing or truncated'));
});
