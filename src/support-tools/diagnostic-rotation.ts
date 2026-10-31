import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export interface DiagnosticPart {
    file: string;
    bytes: number;
    sha256: string;
    firstEventId: number;
    lastEventId: number;
    eventCount: number;
}
/** Append-only bounded parts. No eviction: reaching the bound makes evidence incomplete. */
export class DiagnosticRotation {
    private fd?: number;
    private hash = createHash('sha256');
    private bytes = 0;
    private first = 0;
    private last = 0;
    private count = 0;
    private parts: DiagnosticPart[] = [];
    private part = 0;
    private closed = false;
    failed = false;
    limited = false;
    readonly indexFile: string;
    constructor(private file: string, private limit: number, private maximum: number, private identity: {
        sessionId: string;
        protocol: 'hls' | 'dash';
    }) {
        if (!Number.isInteger(maximum) || maximum < 2 || maximum > 256)
            throw Error('Diagnostics rotation requires 2–256 bounded files');
        this.indexFile = path.basename(file) + '.manifest.json';
        this.fd = fs.openSync(file, 'wx', 0o600);
    }
    private name() { return this.part ? this.file + '.part-' + String(this.part).padStart(4, '0') + '.jsonl' : this.file; }
    private finishPart() { if (this.fd === undefined)
        return; fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = undefined; this.parts.push({ file: path.basename(this.name()), bytes: this.bytes, sha256: this.hash.digest('hex'), firstEventId: this.first, lastEventId: this.last, eventCount: this.count }); }
    write(line: string, eventId: number) {
        if (this.closed || this.failed || this.limited)
            return;
        const bytes = Buffer.from(line);
        try {
            if (bytes.length > this.limit) {
                this.limited = true;
                return;
            }
            if (this.bytes + bytes.length > this.limit) {
                if (this.part + 1 >= this.maximum) {
                    this.limited = true;
                    return;
                }
                this.finishPart();
                this.part++;
                this.fd = fs.openSync(this.name(), 'wx', 0o600);
                this.hash = createHash('sha256');
                this.bytes = 0;
                this.first = 0;
                this.last = 0;
                this.count = 0;
            }
            const before = this.bytes;
            let written = 0;
            try {
                while (written < bytes.length) {
                    const n = fs.writeSync(this.fd, bytes, written, bytes.length - written);
                    if (!n)
                        throw Error('No diagnostic progress');
                    written += n;
                }
            }
            catch (error) {
                fs.ftruncateSync(this.fd, before);
                throw error;
            }
            this.hash.update(bytes);
            this.bytes += bytes.length;
            this.first ||= eventId;
            this.last = eventId;
            this.count++;
        }
        catch {
            this.failed = true;
            try {
                if (this.fd !== undefined)
                    fs.closeSync(this.fd);
            }
            catch { }
            this.fd = undefined;
        }
    }
    snapshot() { return { schemaVersion: 1, ...this.identity, closed: this.closed, complete: this.closed && !this.failed && !this.limited, indexFile: this.indexFile, maxFiles: this.maximum, maxFileBytes: this.limit, files: structuredClone(this.parts), openFileBytes: this.closed ? 0 : this.bytes, limited: this.limited, failed: this.failed }; }
    close() { if (this.closed)
        return; try {
        this.finishPart();
    }
    catch {
        this.failed = true;
        try {
            if (this.fd !== undefined)
                fs.closeSync(this.fd);
        }
        catch { }
        this.fd = undefined;
    } this.closed = true; try {
        fs.writeFileSync(path.join(path.dirname(this.file), this.indexFile), JSON.stringify(this.snapshot(), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    catch {
        this.failed = true;
    } }
}
