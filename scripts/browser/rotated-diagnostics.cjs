const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto');
async function read(file, metadata) {
    const rotation = metadata?.rotation;
    if (!metadata?.fileEnabled || metadata.fileLimitReached || metadata.fileWriteFailed || !rotation?.closed || !rotation.complete || !Array.isArray(rotation.files) || !rotation.files.length || rotation.files.length > 256)
        throw Error('Rotated diagnostics are incomplete');
    if (rotation.indexFile !== path.basename(file) + '.manifest.json' || !Number.isInteger(rotation.maxFiles) || rotation.maxFiles < 2 || rotation.maxFiles > 256 || !Number.isInteger(rotation.maxFileBytes) || rotation.maxFileBytes < 1024 || rotation.maxFileBytes > 10 * 1024 * 1024 || rotation.files.length > rotation.maxFiles)
        throw Error('Diagnostic manifest bounds invalid');
    const indexPath = path.join(path.dirname(file), rotation.indexFile), indexStat = await fs.stat(indexPath);
    if (indexStat.size > 256 * 1024)
        throw Error('Diagnostic index oversized');
    const indexBytes = await fs.readFile(indexPath);
    if (indexBytes.length > 256 * 1024)
        throw Error('Diagnostic index oversized');
    const index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes));
    if (JSON.stringify(index) !== JSON.stringify(rotation))
        throw Error('Diagnostic index does not match the closed runtime manifest');
    let next = 1, total = 0, first, last;
    const recent = [];
    for (const [number, part] of rotation.files.entries()) {
        const expected = number ? path.basename(file) + '.part-' + String(number).padStart(4, '0') + '.jsonl' : path.basename(file);
        if (part.file !== expected || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > rotation.maxFileBytes || part.firstEventId !== next)
            throw Error('Diagnostic part name, size or continuity invalid');
        const filename = path.join(path.dirname(file), part.file), stat = await fs.stat(filename);
        if (stat.size !== part.bytes)
            throw Error('Diagnostic part missing or truncated');
        const bytes = await fs.readFile(filename);
        if (bytes.at(-1) !== 10 || createHash('sha256').update(bytes).digest('hex') !== part.sha256)
            throw Error('Diagnostic part identity mismatch');
        const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n');
        let count = 0;
        for (const line of lines) {
            if (Buffer.byteLength(line) > 65536)
                throw Error('Diagnostic event oversized');
            const event = JSON.parse(line);
            if (event.eventId !== next++ || event.sessionId !== metadata.sessionId || event.protocol !== metadata.protocol || ['diagnostics.file_limit', 'diagnostics.file_error'].includes(event.event))
                throw Error('Diagnostic event lost or identity changed');
            first ??= event;
            last = event;
            recent.push(event);
            if (recent.length > 2000)
                recent.shift();
            count++;
        }
        if (count !== part.eventCount || part.lastEventId !== next - 1)
            throw Error('Diagnostic part count mismatch');
        total += bytes.length;
    }
    if (first?.event !== 'session.started' || last?.event !== 'session.closed' || next - 1 !== metadata.eventsRecorded)
        throw Error('Diagnostic session endpoints or final count missing');
    return { ...metadata, source: 'closed-rotated-files', events: recent, completeFile: { file: rotation.indexFile, indexBytes: indexBytes.length, indexSha256: createHash('sha256').update(indexBytes).digest('hex'), bytes: total, eventCount: next - 1, firstEventId: 1, lastEventId: next - 1, files: rotation.files, complete: true, memoryDroppedEvents: metadata.droppedEvents } };
}
module.exports = { read };
