// npm run release:prepare -- <version> [--date YYYY-MM-DD]
// Creates release/<version>, sets the package version, dates the changelog's
// Unreleased section and commits "Prepare <version>". Pushes nothing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseVersion, compareVersions, prepareChangelog } = require('./release/changelog.cjs');

const root = path.resolve(__dirname, '..');
const run = (command, args, stdio = 'pipe') => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] })?.trim();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function options(args) {
    let version, date;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--date' && args[i + 1])
            date = args[++i];
        else if (!args[i].startsWith('-') && !version)
            version = args[i];
        else
            throw Error(`Unknown argument ${args[i]}. Usage: release:prepare -- <version> [--date YYYY-MM-DD]`);
    }
    if (!version)
        throw Error('Usage: release:prepare -- <version> [--date YYYY-MM-DD]');
    parseVersion(version);
    return { version, date: date ?? new Date().toLocaleDateString('sv-SE') };
}

function main() {
    const { version, date } = options(process.argv.slice(2));
    const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (compareVersions(version, current) <= 0)
        throw Error(`${version} is not newer than the current version ${current}`);
    if (run('git', ['status', '--porcelain']))
        throw Error('Commit or set aside local changes first; the release commit must contain only the version change');
    if (run('git', ['tag', '--list', 'v' + version]))
        throw Error(`Tag v${version} already exists`);
    const branch = 'release/' + version;
    if (run('git', ['branch', '--list', branch]))
        throw Error(`Branch ${branch} already exists`);
    const changelogPath = path.join(root, 'CHANGELOG.md');
    const changelog = prepareChangelog(fs.readFileSync(changelogPath, 'utf8'), version, date);

    run('git', ['switch', '-c', branch]);
    run(npm, ['version', version, '--no-git-tag-version']);
    fs.writeFileSync(changelogPath, changelog);
    run(npm, ['run', 'docs:check'], 'inherit');
    run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
    run('git', ['commit', '-q', '-m', `Prepare ${version}`]);
    const commit = run('git', ['rev-parse', '--short', 'HEAD']);
    console.log(`Prepared ${version} as ${commit} on ${branch}. Nothing was pushed.`);
    console.log('Review the summary under the new heading in CHANGELOG.md (amend the commit if you edit it), then run:');
    console.log(`  npm run release:review -- --output output/release-review-${commit}`);
    console.log(`  npm run release:publish -- --report output/release-review-${commit}`);
}

try {
    main();
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
