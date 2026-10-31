const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_BYTES = 10 * 1024 * 1024;
function validate(bytes, metadata) {
  if (!metadata?.fileEnabled || metadata.fileLimitReached || metadata.fileWriteFailed) throw Error('Diagnostic file unavailable, limited or failed');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.at(-1) !== 10) throw Error('Diagnostic file empty, oversized or truncated');
  let events;
  try { events = bytes.toString('utf8').trimEnd().split('\n').map(JSON.parse); } catch { throw Error('Invalid diagnostic JSONL'); }
  if (events[0]?.event !== 'session.started' || events.at(-1)?.event !== 'session.closed') throw Error('Diagnostic session endpoints missing');
  if (!Number.isSafeInteger(metadata.eventsRecorded) || events.length < metadata.eventsRecorded) throw Error('Diagnostic file has fewer events than observed');
  for (const [index, event] of events.entries()) {
    if (event.eventId !== index + 1 || event.sessionId !== metadata.sessionId || event.protocol !== metadata.protocol) throw Error('Diagnostic event sequence or identity mismatch');
    if (['diagnostics.file_error', 'diagnostics.file_limit'].includes(event.event)) throw Error('Diagnostic file contains loss marker');
  }
  return { ...metadata, source: 'closed-file', events, completeFile: { file: 'requests.jsonl', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), eventCount: events.length, firstEventId: 1, lastEventId: events.length, memoryDroppedEvents: metadata.droppedEvents, complete: true } };
}
async function read(file, metadata) {
  const stat = await fs.stat(file); if (stat.size > MAX_BYTES) throw Error('Diagnostic file exceeds verification limit');
  const result = validate(await fs.readFile(file), metadata); result.completeFile.file = path.basename(file); return result;
}
module.exports = { validate, read };
