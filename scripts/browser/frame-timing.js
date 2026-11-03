/* Same bounded clock calculation in the browser probe and Node acceptance. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SimFrameTiming = api;
})(globalThis, function () {
  'use strict';
  const LIMIT = 8192, EVENT_LIMIT = 128, SLACK_SECONDS = 0.25, MAX_LAG_SECONDS = 4;
  const COLUMNS = Object.freeze(['atMs', 'mediaTime', 'currentTime', 'playbackRate', 'seeking', 'seekCount', 'presentedFrames', 'callbackMs', 'expectedDisplayTimeMs', 'droppedVideoFrames', 'processingDurationMs']);
  const optional = value => Number.isFinite(value) ? value : null;
  const pack = sample => COLUMNS.map(key => ['presentedFrames', 'callbackMs', 'expectedDisplayTimeMs', 'droppedVideoFrames', 'processingDurationMs'].includes(key) ? optional(sample[key]) : sample[key]);
  const unpack = row => Object.fromEntries(COLUMNS.map((key, index) => [key, row[index]]));
  function create() {
    const samples = [], issues = [], catchUps = [];
    let previous, totalSamples = 0, droppedSamples = 0, droppedEvents = 0, advancingFrames = 0;
    let firstFrameMs, firstMediaTime, lastFrameMs, mediaTime;
    // Credit is measured elapsed time not yet reflected by the decoder/element.
    // It is capped at the existing 4s stall gate; slack is never renewed per frame.
    let mediaCredit = SLACK_SECONDS, elementCredit = SLACK_SECONDS, excess = false;
    const retain = (list, entry) => { if (list.length >= EVENT_LIMIT) { droppedEvents++; return false; } list.push(entry); return true; };
    function observe(sample) {
      const row = Array.isArray(sample) ? sample.slice() : pack(sample), current = unpack(row), added = [];
      totalSamples++;
      if (samples.length < LIMIT) samples.push(row); else droppedSamples++;
      const issue = entry => { if (retain(issues, entry)) added.push(entry); };
      if (row.length !== COLUMNS.length || !['atMs', 'mediaTime', 'currentTime', 'playbackRate'].every(key => Number.isFinite(current[key])) ||
          current.atMs < 0 || current.playbackRate <= 0 || typeof current.seeking !== 'boolean' || !Number.isInteger(current.seekCount) || current.seekCount < 0 ||
          ['presentedFrames', 'droppedVideoFrames'].some(key => current[key] !== null && (!Number.isInteger(current[key]) || current[key] < 0)) ||
          ['callbackMs', 'expectedDisplayTimeMs', 'processingDurationMs'].some(key => current[key] !== null && (!Number.isFinite(current[key]) || current[key] < 0)) ||
          previous && (current.atMs < previous.atMs || current.seekCount < previous.seekCount ||
            current.presentedFrames !== null && previous.presentedFrames !== null && current.presentedFrames < previous.presentedFrames ||
            current.droppedVideoFrames !== null && previous.droppedVideoFrames !== null && current.droppedVideoFrames < previous.droppedVideoFrames)) {
        issue({ kind: 'invalid', atMs: current.atMs, reason: 'Invalid or unordered frame measurements' });
        return { issues: added, truncated: droppedSamples > 0 || droppedEvents > 0 };
      }
      if (!previous || current.mediaTime !== previous.mediaTime) {
        advancingFrames++; firstFrameMs ??= current.atMs; firstMediaTime ??= current.mediaTime;
        lastFrameMs = current.atMs; mediaTime = current.mediaTime;
      }
      if (previous) {
        const gapMs = current.atMs - previous.atMs, wallSeconds = gapMs / 1000 * Math.max(previous.playbackRate, current.playbackRate);
        const mediaAdvance = current.mediaTime - previous.mediaTime, elementAdvance = current.currentTime - previous.currentTime;
        const mediaBefore = Math.min(SLACK_SECONDS + MAX_LAG_SECONDS, mediaCredit + wallSeconds);
        const elementBefore = Math.min(SLACK_SECONDS + MAX_LAG_SECONDS, elementCredit + wallSeconds);
        mediaCredit = mediaBefore - Math.max(0, mediaAdvance); elementCredit = elementBefore - Math.max(0, elementAdvance);
        const seeking = current.seeking || current.seekCount !== previous.seekCount;
        if (seeking) issue({ kind: 'seek', atMs: current.atMs, seekCount: current.seekCount });
        if (mediaAdvance < -0.005 || elementAdvance < -0.005) issue({ kind: 'backward', atMs: current.atMs,
          mediaAdvance, elementAdvance, from: previous.mediaTime, to: current.mediaTime });
        const ahead = mediaCredit < -0.00001 || elementCredit < -0.00001;
        if (ahead && !excess) issue({ kind: 'forward', atMs: current.atMs, from: previous.mediaTime, to: current.mediaTime,
          mediaAdvance, elementAdvance, wallSeconds, mediaCreditSeconds: mediaCredit, elementCreditSeconds: elementCredit });
        excess = ahead;
        if (!ahead && !seeking && mediaAdvance > Math.max(0.5, wallSeconds + SLACK_SECONDS)) retain(catchUps, {
          atMs: current.atMs, from: previous.mediaTime, to: current.mediaTime, mediaAdvance, wallSeconds,
          measuredCreditBeforeSeconds: mediaBefore, remainingCreditSeconds: mediaCredit,
          elementAdvance, presentedFramesDelta: current.presentedFrames !== null && previous.presentedFrames !== null ? current.presentedFrames - previous.presentedFrames : null,
          droppedFramesDelta: current.droppedVideoFrames !== null && previous.droppedVideoFrames !== null ? current.droppedVideoFrames - previous.droppedVideoFrames : null
        });
      }
      previous = current;
      return { issues: added, truncated: droppedSamples > 0 || droppedEvents > 0 };
    }
    const snapshot = () => ({ schemaVersion: 1, columns: COLUMNS, limit: LIMIT, eventLimit: EVENT_LIMIT,
      slackSeconds: SLACK_SECONDS, maxLagSeconds: MAX_LAG_SECONDS, totalSamples, droppedSamples, droppedEvents,
      advancingFrames, firstFrameMs, firstMediaTime, lastFrameMs, mediaTime, samples, issues, catchUps });
    return { observe, snapshot };
  }
  function evaluate(evidence, expected) {
    const failures = [];
    if (!evidence) return { complete: false, failures: ['Incomplete DASH frame timing evidence; new rendered-frame run required'] };
    if (evidence.schemaVersion !== 1 || JSON.stringify(evidence.columns) !== JSON.stringify(COLUMNS) || evidence.limit !== LIMIT || evidence.eventLimit !== EVENT_LIMIT ||
        evidence.slackSeconds !== SLACK_SECONDS || evidence.maxLagSeconds !== MAX_LAG_SECONDS || !Array.isArray(evidence.samples) || evidence.samples.length > LIMIT ||
        evidence.totalSamples !== evidence.samples.length || evidence.droppedSamples !== 0 || evidence.droppedEvents !== 0 ||
        !Array.isArray(evidence.issues) || !Array.isArray(evidence.catchUps) || !evidence.samples.every(row => Array.isArray(row) && row.length === COLUMNS.length))
      return { complete: false, failures: ['Incomplete or truncated DASH frame timing evidence'] };
    const replay = create(); for (const sample of evidence.samples) replay.observe(sample);
    const actual = replay.snapshot();
    if (actual.droppedSamples || actual.droppedEvents)
      return { complete: false, failures: ['Replayed DASH frame timing evidence exceeded its limits'] };
    if (JSON.stringify(actual.issues) !== JSON.stringify(evidence.issues) || JSON.stringify(actual.catchUps) !== JSON.stringify(evidence.catchUps) ||
        ['advancingFrames', 'firstFrameMs', 'firstMediaTime', 'lastFrameMs', 'mediaTime'].some(key => actual[key] !== evidence[key]) ||
        expected && (actual.advancingFrames !== expected.frames || actual.firstFrameMs !== expected.firstFrameMs || actual.firstMediaTime !== expected.firstMediaTime ||
          actual.lastFrameMs !== expected.lastFrameMs || actual.mediaTime !== expected.mediaTime)) failures.push('DASH frame timing evidence disagrees with rendered telemetry');
    if (actual.issues.length) failures.push('Rendered media/element clock discontinuity, seek or invalid frame evidence');
    return { complete: !failures.length, failures, samples: actual.totalSamples, advancingFrames: actual.advancingFrames, issues: actual.issues, catchUps: actual.catchUps,
      slackSeconds: SLACK_SECONDS, maxLagSeconds: MAX_LAG_SECONDS };
  }
  return { LIMIT, COLUMNS, create, evaluate };
});
