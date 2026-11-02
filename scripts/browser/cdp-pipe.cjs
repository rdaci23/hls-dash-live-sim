const { EventEmitter } = require('node:events');
class CdpPipe extends EventEmitter {
    constructor(read, write, { maxBytes = 8 * 1024 * 1024, maxPending = 64, timeoutMs = 15000 } = {}) {
        super(); this.read = read; this.write = write; this.maxBytes = maxBytes; this.maxPending = maxPending; this.timeoutMs = timeoutMs;
        this.pending = new Map(); this.parts = []; this.bytes = 0; this.sequence = 0; this.closed = false;
        this.onData = buffer => {
            try {
                let start = 0, end;
                while ((end = buffer.indexOf(0, start)) >= 0) {
                    const part = buffer.subarray(start, end);
                    if (this.bytes + part.length > this.maxBytes) throw Error('Chrome protocol message exceeds its bound');
                    this.parts.push(part);
                    const message = JSON.parse(Buffer.concat(this.parts, this.bytes + part.length).toString('utf8'));
                    this.parts.length = 0; this.bytes = 0; start = end + 1;
                    if (message.id !== undefined) {
                        const waiter = this.pending.get(message.id);
                        if (!waiter) continue;
                        this.pending.delete(message.id); clearTimeout(waiter.timer);
                        message.error ? waiter.reject(Error(waiter.method + ': ' + message.error.message)) : waiter.resolve(message.result);
                    } else this.emit('event', message);
                }
                if (start < buffer.length) { const part = buffer.subarray(start); this.bytes += part.length; if (this.bytes > this.maxBytes) throw Error('Chrome protocol message exceeds its bound'); this.parts.push(part); }
            } catch (error) { this.close(error); }
        };
        this.onClose = () => this.close(Error('Chrome protocol closed'));
        this.onError = error => this.close(error);
        read.on('data', this.onData); read.on('end', this.onClose); read.on('error', this.onError); write.on('error', this.onError);
    }
    send(method, params = {}, sessionId) {
        if (this.closed) return Promise.reject(Error('Chrome protocol is closed'));
        if (this.pending.size >= this.maxPending) return Promise.reject(Error('Chrome protocol pending-call capacity reached'));
        const id = ++this.sequence, data = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0';
        if (Buffer.byteLength(data) > this.maxBytes) return Promise.reject(Error('Chrome protocol command exceeds its bound'));
        return new Promise((resolve, reject) => {
            const fail = error => { const waiter = this.pending.get(id); if (!waiter) return; this.pending.delete(id); clearTimeout(waiter.timer); reject(error); };
            const timer = setTimeout(() => fail(Error('Chrome protocol deadline: ' + method)), this.timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            try { this.write.write(data, error => { if (error) fail(error); }); } catch (error) { fail(error); }
        });
    }
    ownership() { return { pendingCalls: this.pending.size, pendingTimers: this.pending.size, bufferedBytes: this.bytes }; }
    close(error = Error('Chrome protocol closed')) {
        if (this.closed) return; this.closed = true;
        this.read.removeListener('data', this.onData);
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        this.pending.clear(); this.parts.length = 0; this.bytes = 0;
        this.emit('failure', error);
    }
}
module.exports = { CdpPipe };
