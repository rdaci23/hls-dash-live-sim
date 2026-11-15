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

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromeFailure, loadWarning, mainPath, reviewPreflight, readMain } = require('../scripts/release/preflight.cjs');

test('preflight accepts only Chrome builds reviewed for every evidence profile', () => {
    const browsers = { scenario: ['1.0.0.1', '1.0.0.2'], dvr: ['1.0.0.1'] };
    assert.equal(chromeFailure('1.0.0.1', browsers), undefined);
    assert.match(chromeFailure('1.0.0.2', browsers), /not a reviewed build for the dvr evidence/);
    assert.match(chromeFailure('1.0.0.3', browsers), /scenario, dvr/);
    assert.match(chromeFailure(undefined, browsers), /could not be started/);
});

test('preflight warns about load only above one runnable task per CPU', () => {
    assert.equal(loadWarning(8, 8), undefined);
    assert.match(loadWarning(12.6, 8), /12\.6 on 8 CPUs/);
});

test('main reaches the reviewed commit by fast-forward, an identical-tree merge, or not at all', () => {
    assert.equal(mainPath({ mainIsAncestor: true }), 'fast-forward');
    assert.equal(mainPath({ mainIsAncestor: false, mergeTree: 't1', headTree: 't1' }), 'merge');
    assert.equal(mainPath({ mainIsAncestor: false, mergeTree: 't2', headTree: 't1' }), 'diverged');
    assert.equal(mainPath({ mainIsAncestor: false, mergeTree: undefined, headTree: 't1' }), 'diverged');
});

test('a release candidate review stops early when main diverged; other reviews only warn', () => {
    const base = { version: '0.4.0', chromeVersion: '157.0.8103.51', tagExists: false, main: { known: true, fetched: true, state: 'fast-forward' }, load: 1, cpus: 8 };
    assert.deepEqual(reviewPreflight(base), { failures: [], warnings: [] });
    const diverged = { ...base, main: { ...base.main, state: 'diverged' } };
    assert.match(reviewPreflight(diverged).failures.join(), /Merge or rebase onto origin\/main/);
    const later = reviewPreflight({ ...diverged, tagExists: true });
    assert.deepEqual(later.failures, []);
    assert.match(later.warnings.join(), /v0\.4\.0 already exists/);
    assert.match(reviewPreflight({ ...base, main: { ...base.main, state: 'merge' } }).warnings.join(), /release:publish merges it/);
    assert.match(reviewPreflight({ ...base, chromeVersion: '1.2.3.4' }).failures.join(), /Chrome 1\.2\.3\.4 is not a reviewed build/);
    assert.match(reviewPreflight({ ...base, main: { known: false } }).warnings.join(), /could not be read/);
});

test('readMain classifies a real origin/main against the release commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-main-'));
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (cwd, file, text, message) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message); };
    try {
        const origin = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), other = path.join(dir, 'other');
        git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
        git(dir, 'clone', '-q', origin, work);
        git(work, 'switch', '-q', '-c', 'main');
        commit(work, 'a.txt', 'a', 'base');
        git(work, 'push', '-q', 'origin', 'main');
        git(work, 'switch', '-q', '-c', 'feature');
        commit(work, 'b.txt', 'b', 'feature');
        git(work, 'push', '-q', 'origin', 'feature');
        git(work, 'switch', '-q', '-c', 'release');
        commit(work, 'c.txt', 'c', 'release');
        const run = (command, args) => execFileSync(command, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        assert.deepEqual(readMain(run, 'HEAD'), { known: true, fetched: true, state: 'fast-forward' });

        // A pull-request merge of the feature on main: no new files for the release.
        git(dir, 'clone', '-q', origin, other);
        git(other, 'fetch', '-q', 'origin', 'feature');
        git(other, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'origin/feature');
        git(other, 'push', '-q', 'origin', 'main');
        assert.equal(readMain(run, 'HEAD').state, 'merge');

        commit(other, 'd.txt', 'd', 'new work on main');
        git(other, 'push', '-q', 'origin', 'main');
        assert.equal(readMain(run, 'HEAD').state, 'diverged');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
