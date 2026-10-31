// A coordinator closes its own descendants and evidence. Signal it once only.
// Other stages own a detached process group, so cancelling them reaches workers.
function createProcessOwner(terminate) {
    const children = new Map(), signalled = new WeakSet();
    let stopped = false;
    const signal = (child, coordinator) => {
        if (signalled.has(child) || child.exitCode !== null && child.exitCode !== undefined) return;
        signalled.add(child);
        try {
            if (terminate) terminate(child, coordinator);
            else if (coordinator || process.platform === 'win32') child.kill('SIGTERM');
            else process.kill(-child.pid, 'SIGTERM');
        } catch { /* The child may have exited between the check and signal. */ }
    };
    return {
        add(child, coordinator = false) { children.set(child, coordinator); if (stopped) signal(child, coordinator); },
        delete(child) { children.delete(child); },
        stop() { stopped = true; for (const [child, coordinator] of children) signal(child, coordinator); },
        assertRunning() { if (stopped) throw Error('Review interrupted'); },
        get size() { return children.size; }
    };
}
module.exports = { createProcessOwner };
