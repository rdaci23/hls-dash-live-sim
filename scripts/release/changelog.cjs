// Pure helpers for versioned releases: changelog sections, version checks,
// review-report validation and release notes. The CLIs in scripts/ do the I/O.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseVersion(value) {
    const match = SEMVER.exec(String(value));
    if (!match)
        throw Error(`Version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(value)}`);
    return match.slice(1).map(Number);
}

function compareVersions(a, b) {
    const [x, y] = [parseVersion(a), parseVersion(b)];
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] < y[i] ? -1 : 1;
    return 0;
}

// Level-two sections in file order: { heading, start, end, body }.
function sections(text) {
    const lines = text.split('\n'), found = [];
    lines.forEach((line, index) => {
        if (line.startsWith('## '))
            found.push({ heading: line.slice(3).trim(), start: index });
    });
    return found.map((section, i) => {
        const end = i + 1 < found.length ? found[i + 1].start : lines.length;
        return { ...section, end, body: lines.slice(section.start + 1, end).join('\n').trim() };
    });
}

const versionHeading = heading => /^(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/.exec(heading);

function unreleased(text) {
    const matches = sections(text).filter(s => s.heading === 'Unreleased');
    if (matches.length !== 1)
        throw Error('CHANGELOG.md must contain exactly one "## Unreleased" section');
    return matches[0];
}

// Renames the Unreleased section to "VERSION — DATE" and opens an empty
// Unreleased section above it.
function prepareChangelog(text, version, date) {
    parseVersion(version);
    if (!DATE.test(date))
        throw Error(`Date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
    if (sections(text).some(s => versionHeading(s.heading)?.[1] === version))
        throw Error(`CHANGELOG.md already has a ${version} section`);
    const section = unreleased(text);
    if (!/^- /m.test(section.body))
        throw Error('The Unreleased section has no entries');
    const lines = text.split('\n');
    lines.splice(section.start, 1, '## Unreleased', '', `## ${version} — ${date}`);
    return lines.join('\n');
}

function releaseSection(text, version) {
    const section = sections(text).find(s => versionHeading(s.heading)?.[1] === version);
    if (!section)
        throw Error(`CHANGELOG.md has no "## ${version} — YYYY-MM-DD" section`);
    const summary = section.body.split(/^### /m)[0].trim();
    const limits = /^### Known limits\n([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(section.body)?.[1].trim() ?? '';
    return { date: versionHeading(section.heading)[2], summary, limits, body: section.body };
}

// Code changes since the last tag need a changelog entry, unless a newer
// version is being prepared. Returns a failure message or undefined.
function changelogFailure({ text, packageVersion, lastTag, sourceChanged }) {
    const section = unreleased(text);
    if (!lastTag || !sourceChanged || /^- /m.test(section.body))
        return undefined;
    if (compareVersions(packageVersion, lastTag.replace(/^v/, '')) > 0)
        return undefined;
    return `Source changed since ${lastTag} but the Unreleased changelog section has no entries`;
}

// The review report must be a complete pass for exactly this commit.
function reviewFailures(report, commit) {
    const failures = [];
    if (report?.commit !== commit)
        failures.push(`review commit ${report?.commit} is not HEAD ${commit}`);
    if (report?.sourceTreeClean !== true)
        failures.push('review did not start from a clean tree');
    if (report?.candidateChecksPassed !== true)
        failures.push('review candidate checks did not pass');
    if (report?.error)
        failures.push(`review error: ${report.error}`);
    if (!Array.isArray(report?.steps) || !report.steps.length)
        failures.push('review has no steps');
    else
        for (const step of report.steps)
            if (step.exitCode !== 0)
                failures.push(`review step ${step.name} exited ${step.exitCode}`);
    if (report?.browser?.browserGatesPassed !== true || report?.browser?.commit !== commit)
        failures.push('browser gate did not pass for this commit');
    if (report?.scenarioIntegrity?.passed !== true)
        failures.push('scenario integrity did not pass');
    if (report?.dvrIntegrity?.releaseCheckPassed !== true)
        failures.push('DVR release check did not pass');
    return failures;
}

// Changelog markdown for a GitHub release page: hard-wrapped lines are joined
// (GitHub renders single newlines as breaks) and repository-relative links point
// at the released commit.
function forRelease(markdown, blob) {
    const lines = [];
    for (const line of markdown.split('\n')) {
        const previous = lines[lines.length - 1];
        const continues = previous && line.trim() && !/^(- |#|\|)/.test(line) && !/^```/.test(previous.trim());
        if (continues)
            lines[lines.length - 1] = previous + ' ' + line.trim();
        else
            lines.push(line);
    }
    return lines.join('\n').replace(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi, (_, target) => `](${blob(target.replace(/^\.\//, ''))})`);
}

function releaseNotes({ repository, commit, version, section, report, browserVersions, npmPackage }) {
    const blob = file => `https://github.com/${repository}/blob/${commit}/${file}`;
    const env = report.verificationExecution ?? {};
    const scenarios = report.scenarioIntegrity?.cases?.length;
    const limitations = (report.dvrIntegrity?.knownLimitations ?? []).map(l => l.caseId).join(', ');
    const platform = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[env.platform] ?? env.platform ?? 'an unknown platform';
    const where = [platform, env.arch].filter(Boolean).join(' ') + (browserVersions.length ? ` with Chrome ${browserVersions.join(', ')}` : '');
    const review = [
        `The release commit \`${commit.slice(0, 7)}\` passed all ${report.steps.length} stages of its clean-clone local review on ${where}.`,
        scenarios ? `It covered HLS and DASH browser checks, ${scenarios} targeted scenario cases, the DVR release check and a ten-minute concurrent smoke run.` : '',
        limitations ? `Documented DVR player limitations: ${limitations}.` : '',
        'Results describe the tested environment; fault delivery, service restoration and player recovery are separate outcomes.',
    ].filter(Boolean).join(' ');
    const parts = [forRelease(section.summary, blob), review];
    if (section.limits)
        parts.push('### Known limits\n\n' + forRelease(section.limits, blob));
    parts.push(`See the [${version} changelog](${blob('CHANGELOG.md')}) for every change.`);
    parts.push('Licensed under MIT; third-party components retain their respective terms. ' + (npmPackage ? `Install with \`npm install -g ${npmPackage}\` or from source.` : 'Install from source; npm publication is not part of this release.'));
    return parts.join('\n\n') + '\n';
}

module.exports = { parseVersion, compareVersions, sections, prepareChangelog, releaseSection, changelogFailure, reviewFailures, forRelease, releaseNotes };
