// CLI and release review recompute the same policy from retained raw evidence.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { evaluate } = require('./core-acceptance.cjs');
const { read: completeDiagnostics } = require('./complete-diagnostics.cjs');
const { expectedCase, CASES } = require('./core-cases.cjs');
function rawManifest(bytes) { return { file: 'raw.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
function qualify(report, { raw, rawBytes, diagnostics, requireContinuation = false, commit, caseId = report?.caseId } = {}) {
  const failures = [];
  try {
    const bytes = rawBytes === undefined ? Buffer.from(JSON.stringify(raw, null, 2) + '\n') : Buffer.from(rawBytes);
    if (bytes.length > 8 * 1024 * 1024) throw Error('Raw browser evidence exceeds its bound');
    raw = JSON.parse(bytes.toString('utf8'));
    if (!isDeepStrictEqual(report.rawEvidence, rawManifest(bytes))) failures.push('Raw browser evidence manifest missing or changed');
  } catch (error) { return { passed: false, failures: ['Raw browser evidence cannot be verified: ' + error.message], report }; }
  if (!raw || !Array.isArray(raw.audit) || !Array.isArray(raw.samples) || !diagnostics) return { passed: false, failures: ['Raw browser evidence and complete source diagnostics are required'], report };
  try {
    const expected = expectedCase(caseId);
    if (report.caseId !== expected.caseId || report.protocol !== expected.protocol || report.preset !== expected.preset || raw.metrics?.caseId !== expected.caseId || raw.metrics?.preset !== expected.preset || !isDeepStrictEqual(report.definition, expected.definition)) failures.push('Core case identity, protocol, preset or shipped definition mismatch');
  } catch (error) { failures.push(error.message); }
  if (commit !== undefined && (report.commit !== commit || report.workingTreeModified !== false)) failures.push('Core browser evidence is not for the exact clean candidate');
  const assessment = evaluate({ ...raw, diagnostics, scenario: report.scenario, injectionMs: report.injectionMs, restoredMs: report.restoredMs, harnessError: report.harnessError,
    protocol: report.protocol, browserVersion: report.browserVersion, playerVersion: report.playerVersion });
  failures.push(...assessment.failures);
  if (!assessment.observationCompleted) failures.push('Core browser observation was not completed');
  if (requireContinuation && !assessment.playerContinuedAfterRestoration) failures.push('Required rendered continuation was not verified');
  return { passed: !failures.length, failures: [...new Set(failures)], classification: failures.length ? 'blocked' : assessment.faultObserved ? 'observed-continuation' : 'target-not-exercised', report, assessment };
}
async function bytes(file) { const stat = await fs.stat(file); if (stat.size > 8 * 1024 * 1024) throw Error('Core evidence JSON exceeds its bound'); return fs.readFile(file); }
async function json(file) { return JSON.parse((await bytes(file)).toString('utf8')); }
async function qualifyDirectory(directory, options = {}) {
  let report;
  try {
    report = await json(path.join(directory, 'report.json'));
    const folderCase = path.basename(path.resolve(directory)), caseId = options.caseId ?? folderCase;
    if (options.caseId && CASES.includes(folderCase) && options.caseId !== folderCase) throw Error('Expected core case disagrees with its case folder');
    const rawBytes = await bytes(path.join(directory, 'raw.json')), raw = JSON.parse(rawBytes.toString('utf8'));
    const diagnostics = await completeDiagnostics(path.join(directory, 'requests.jsonl'), raw.diagnosticMetadata);
    const result = qualify(report, { ...options, caseId, raw, rawBytes, diagnostics });
    if (report.diagnosticFile?.sha256 !== diagnostics.completeFile.sha256 || report.diagnosticFile?.bytes !== diagnostics.completeFile.bytes || report.diagnosticFile?.eventCount !== diagnostics.completeFile.eventCount) {
      result.failures.push('Source file differs from the recorded diagnostic manifest'); result.passed = false; result.classification = 'blocked';
    }
    return result;
  } catch (error) { return { passed: false, failures: ['Core evidence cannot be verified: ' + error.message], report }; }
}
module.exports = { qualify, qualifyDirectory, rawManifest };
