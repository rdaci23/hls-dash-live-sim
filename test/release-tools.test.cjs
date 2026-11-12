const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareVersions, prepareChangelog, releaseSection, changelogFailure, reviewFailures, forRelease, releaseNotes } = require('../scripts/release/changelog.cjs');

const changelog = `# Changelog

Intro.

## Unreleased

Summary of the next beta.

### Added

- A feature.

## 0.2.0 — 2026-11-09

Old summary.

### Known limits

- Old limit.
`;

test('versions compare numerically and reject other forms', () => {
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('0.3.0', '0.3.1'), -1);
    for (const bad of ['0.3', 'v0.3.0', '0.3.0-rc.1', ''])
        assert.throws(() => compareVersions(bad, '0.1.0'));
});

test('prepare dates the Unreleased section and opens an empty one above it', () => {
    const prepared = prepareChangelog(changelog, '0.3.0', '2026-11-12');
    assert.match(prepared, /## Unreleased\n\n## 0\.3\.0 — 2026-11-12\n\nSummary of the next beta\./);
    assert.equal(prepared.match(/^## Unreleased$/gm).length, 1);
    assert.equal(releaseSection(prepared, '0.3.0').summary, 'Summary of the next beta.');
    assert.throws(() => prepareChangelog(prepared, '0.4.0', '2026-11-12'), /no entries/);
    assert.throws(() => prepareChangelog(changelog, '0.2.0', '2026-11-12'), /already has/);
    assert.throws(() => prepareChangelog(changelog, '0.3.0', '12/11/2026'), /YYYY-MM-DD/);
    assert.throws(() => prepareChangelog(changelog.replace('## Unreleased', '## Next'), '0.3.0', '2026-11-12'), /exactly one/);
});

test('release sections expose the summary and known limits', () => {
    const section = releaseSection(changelog, '0.2.0');
    assert.deepEqual([section.date, section.summary, section.limits], ['2026-11-09', 'Old summary.', '- Old limit.']);
    assert.throws(() => releaseSection(changelog, '0.9.0'), /no "## 0\.9\.0/);
});

test('the repository changelog parses and has one Unreleased section', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    assert.equal(text.match(/^## Unreleased$/gm).length, 1);
    assert.equal(releaseSection(text, '0.2.0').date, '2026-11-09');
});

test('source changes since the last tag need an Unreleased entry unless a newer version is prepared', () => {
    const empty = prepareChangelog(changelog, '0.3.0', '2026-11-12');
    const base = { text: empty, packageVersion: '0.3.0', lastTag: 'v0.3.0', sourceChanged: true };
    assert.match(changelogFailure(base), /no entries/);
    assert.equal(changelogFailure({ ...base, sourceChanged: false }), undefined);
    assert.equal(changelogFailure({ ...base, text: changelog }), undefined);
    assert.equal(changelogFailure({ ...base, lastTag: 'v0.2.0' }), undefined);
    assert.equal(changelogFailure({ ...base, lastTag: undefined }), undefined);
});

const commit = 'e9896e423e48aac827458b2a79663d7f1169e5ed';
const report = () => ({
    commit, sourceTreeClean: true, candidateChecksPassed: true,
    steps: [{ name: 'clone', exitCode: 0 }, { name: 'build', exitCode: 0 }],
    verificationExecution: { platform: 'darwin', arch: 'arm64' },
    browser: { commit, browserGatesPassed: true },
    scenarioIntegrity: { passed: true, cases: Array(18).fill({}) },
    dvrIntegrity: { releaseCheckPassed: true, knownLimitations: [{ caseId: 'hls-join-during-outage' }] },
});

test('only a complete passing review of the exact commit qualifies', () => {
    assert.deepEqual(reviewFailures(report(), commit), []);
    for (const change of [
        r => r.commit = 'other', r => r.sourceTreeClean = false, r => r.candidateChecksPassed = false,
        r => r.error = 'dvr-browser failed', r => r.steps = [], r => r.steps[1].exitCode = 1,
        r => r.browser.browserGatesPassed = false, r => r.browser.commit = 'other',
        r => r.scenarioIntegrity.passed = false, r => r.dvrIntegrity.releaseCheckPassed = false,
    ]) {
        const r = report();
        change(r);
        assert.notDeepEqual(reviewFailures(r, commit), [], change.toString());
    }
    assert.notDeepEqual(reviewFailures(undefined, commit), []);
});

test('release markdown joins wrapped lines and pins repository links to the commit', () => {
    const blob = file => 'https://github.com/o/r/blob/c/' + file;
    const text = 'One line\nwraps [here](docs/a.md).\n\n- A bullet\n  continues [web](https://x.test) and [anchor](#top).\n- [Next](./b.md)';
    assert.equal(forRelease(text, blob), 'One line wraps [here](https://github.com/o/r/blob/c/docs/a.md).\n\n- A bullet continues [web](https://x.test) and [anchor](#top).\n- [Next](https://github.com/o/r/blob/c/b.md)');
});

test('release notes combine the changelog summary with the review results', () => {
    const section = releaseSection(prepareChangelog(changelog, '0.3.0', '2026-11-12'), '0.3.0');
    const notes = releaseNotes({ repository: 'owner/repo', commit, version: '0.3.0', section, report: report(), browserVersions: ['157.0.8103.50'] });
    assert.match(notes, /^Summary of the next beta\.\n\n/);
    assert.match(notes, /`e9896e4` passed all 2 stages of its clean-clone local review on macOS arm64 with Chrome 157\.0\.8103\.50\./);
    assert.match(notes, /18 targeted scenario cases/);
    assert.match(notes, /limitations: hls-join-during-outage\./);
    assert.match(notes, /https:\/\/github\.com\/owner\/repo\/blob\/e9896e4[0-9a-f]+\/CHANGELOG\.md/);
    assert.doesNotMatch(notes, /Known limits/);
    assert.match(notes, /npm publication is not part of this release\.\n$/);
    assert.match(releaseNotes({ repository: 'owner/repo', commit, version: '0.3.0', section, report: report(), browserVersions: [], npmPackage: 'pkg' }), /Install with `npm install -g pkg` or from source\.\n$/);
    assert.match(releaseNotes({ repository: 'owner/repo', commit, version: '0.2.0', section: releaseSection(changelog, '0.2.0'), report: report(), browserVersions: [] }), /### Known limits\n\n- Old limit\./);
});
