// Checks that run before the long release steps, so a review that could never
// pass, or never be published, stops in seconds instead of an hour in.
const { REVIEWED_BROWSERS } = require('../browser/reviewed-identity.cjs');

// The browser stages accept only reviewed Chrome builds, per evidence profile.
function chromeFailure(version, browsers = REVIEWED_BROWSERS) {
    if (!version)
        return 'Chrome (channel "chrome") could not be started to read its version';
    const missing = Object.keys(browsers).filter(profile => !browsers[profile].includes(version));
    if (!missing.length)
        return undefined;
    return `Chrome ${version} is not a reviewed build for the ${missing.join(', ')} evidence; the browser stages would fail. Review the build first (docs/browser-qualification.md)`;
}

function loadWarning(load, cpus) {
    if (!(load > cpus))
        return undefined;
    return `The 1-minute load average is ${load.toFixed(1)} on ${cpus} CPUs; timing checks in the browser stages may fail. Close other heavy work before reviewing`;
}

// How main reaches the reviewed commit: directly, through a merge whose tree is
// the reviewed tree, or not at all.
function mainPath({ mainIsAncestor, mergeTree, headTree }) {
    if (mainIsAncestor)
        return 'fast-forward';
    if (mergeTree && mergeTree === headTree)
        return 'merge';
    return 'diverged';
}

// A release candidate is a commit whose version has no tag yet. For anything
// else (a candidate review of later work) the branch and tag checks only warn.
function reviewPreflight({ version, chromeVersion, tagExists, main, load, cpus }) {
    const failures = [], warnings = [], tag = 'v' + version;
    const chrome = chromeFailure(chromeVersion);
    if (chrome)
        failures.push(chrome);
    const releaseCandidate = !tagExists;
    if (!main.known)
        warnings.push('origin/main could not be read; the publish step checks it again');
    else if (!main.fetched)
        warnings.push('origin/main could not be fetched; checked against the last fetched copy');
    if (main.known && main.state !== 'fast-forward') {
        const message = main.state === 'merge'
            ? 'origin/main has a merge this commit lacks, with the same files; release:publish merges it before pushing'
            : 'origin/main has changes this commit lacks, so main could not take the reviewed commit. Merge or rebase onto origin/main first';
        (main.state === 'diverged' && releaseCandidate ? failures : warnings).push(message);
    }
    if (tagExists)
        warnings.push(`${tag} already exists, so this review cannot publish ${version}; it reviews the commit only`);
    const busy = loadWarning(load, cpus);
    if (busy)
        warnings.push(busy);
    return { failures, warnings };
}

// Reads origin/main against a commit. `run` executes git and throws on a
// non-zero exit, like execFileSync.
function readMain(run, commit) {
    let fetched = true;
    try {
        run('git', ['fetch', '-q', 'origin', 'main']);
    }
    catch {
        fetched = false;
    }
    try {
        run('git', ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']);
    }
    catch {
        return { known: false, fetched };
    }
    let mainIsAncestor = true, mergeTree;
    try {
        run('git', ['merge-base', '--is-ancestor', 'origin/main', commit]);
    }
    catch {
        mainIsAncestor = false;
        try {
            mergeTree = run('git', ['merge-tree', '--write-tree', 'origin/main', commit]).split('\n')[0];
        }
        catch {
            // Conflicts: no clean merge exists.
        }
    }
    const headTree = run('git', ['rev-parse', commit + '^{tree}']);
    return { known: true, fetched, state: mainPath({ mainIsAncestor, mergeTree, headTree }) };
}

module.exports = { chromeFailure, loadWarning, mainPath, reviewPreflight, readMain };
