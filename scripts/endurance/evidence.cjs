const { DiagnosticRotation } = require('../../dist/support-tools/diagnostic-rotation.js'), { randomUUID } = require('node:crypto');
class Evidence {
    constructor(file, protocol, maxBytes = 8 * 1024 * 1024) { this.sessionId = randomUUID(); this.protocol = protocol; this.count = 0; this.journal = new DiagnosticRotation(file, maxBytes, 64, { sessionId: this.sessionId, protocol }); this.file = file; this.started = performance.now(); this.append('session.started'); }
    append(event, fields = {}) { this.journal.write(JSON.stringify({ schemaVersion: 1, event, eventId: ++this.count, sessionId: this.sessionId, protocol: this.protocol, elapsedMs: performance.now() - this.started, ...fields }) + '\n', this.count); if (this.journal.failed || this.journal.limited)
        throw Error('Endurance evidence recording failed or reached its bound'); }
    close() { if (this.closed)
        return; try {
        this.append('session.closed');
    }
    finally {
        this.journal.close();
        this.closed = true;
    } }
    metadata() { return { fileEnabled: true, fileLimitReached: this.journal.limited, fileWriteFailed: this.journal.failed, sessionId: this.sessionId, protocol: this.protocol, eventsRecorded: this.count, droppedEvents: 0, rotation: this.journal.snapshot() }; }
}
module.exports = { Evidence };
