// Keep the final cap active while independently started sources and viewers close.
// Measurement still stops at duration; this bounded grace is not extra qualification.
function timeline(duration) {
    const phases = [];
    let cursor = 0;
    for (let at = 60000; at < duration - 15000; at += 600000) {
        phases.push({ afterMs: cursor, beforeMs: at, network: { bandwidthKbps: 3000 } }, { afterMs: at, beforeMs: at + 8000, network: { bandwidthKbps: 1200 } });
        cursor = at + 8000;
    }
    phases.push({ afterMs: cursor, beforeMs: duration + 60000, network: { bandwidthKbps: 3000 } });
    return phases;
}
module.exports = { timeline };
