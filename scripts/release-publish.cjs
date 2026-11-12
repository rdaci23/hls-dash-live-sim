// npm run release:publish -- --report <review dir> [--title <text>] [--yes]
// Checks that the review passed for HEAD, writes release notes and prints the
// push, tag and GitHub release commands. Only --yes runs them.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseVersion, releaseSection, reviewFailures, releaseNotes } = require('./release/changelog.cjs');

const root = path.resolve(__dirname, '..');
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REMOTE = 'origin', BRANCH = 'main';

function options(args) {
    const result = { yes: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--yes')
            result.yes = true;
        else if ((args[i] === '--report' || args[i] === '--title') && args[i + 1])
            result[args[i].slice(2)] = args[++i];
        else
            throw Error(`Unknown argument ${args[i]}. Usage: release:publish -- --report <dir> [--title <text>] [--yes]`);
    }
    if (!result.report)
        throw Error('Usage: release:publish -- --report <dir> [--title <text>] [--yes]');
    return result;
}

// Chrome builds recorded by the browser stages' own reports.
function browserVersions(directory) {
    const found = new Set();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name, 'report.json');
        if (entry.isDirectory() && entry.name !== 'checkout' && fs.existsSync(file))
            for (const match of fs.readFileSync(file, 'utf8').matchAll(/"browserVersion"\s*:\s*"([\d.]+)"/g))
                found.add(match[1]);
    }
    return [...found].sort();
}

function repository() {
    const url = run('git', ['remote', 'get-url', REMOTE]);
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (!match)
        throw Error(`Remote ${REMOTE} is not a GitHub repository`);
    return match[1];
}

function main() {
    const opts = options(process.argv.slice(2));
    const failures = [];
    if (run('git', ['status', '--porcelain']))
        failures.push('the working tree has local changes');
    const commit = run('git', ['rev-parse', 'HEAD']);
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    parseVersion(version);
    const tag = 'v' + version;
    const section = releaseSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
    if (run('git', ['tag', '--list', tag]))
        failures.push(`tag ${tag} already exists locally`);
    if (run('git', ['ls-remote', '--tags', REMOTE, 'refs/tags/' + tag]))
        failures.push(`tag ${tag} already exists on ${REMOTE}`);
    run('git', ['fetch', '-q', REMOTE, BRANCH]);
    try {
        run('git', ['merge-base', '--is-ancestor', `${REMOTE}/${BRANCH}`, commit]);
    }
    catch {
        failures.push(`${REMOTE}/${BRANCH} cannot fast-forward to HEAD; rebase and review again`);
    }
    const directory = path.resolve(opts.report);
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
    failures.push(...reviewFailures(report, commit));
    if (failures.length)
        throw Error('Not releasing:\n- ' + failures.join('\n- '));

    const notesFile = path.join(directory, 'release-notes.md');
    fs.writeFileSync(notesFile, releaseNotes({ repository: repository(), commit, version, section, report, browserVersions: browserVersions(directory) }));
    const title = opts.title ?? tag;
    const commands = [
        ['git', 'push', REMOTE, `${commit}:refs/heads/${BRANCH}`],
        ['git', 'tag', '-a', tag, '-m', title, commit],
        ['git', 'push', REMOTE, 'refs/tags/' + tag],
        ['gh', 'release', 'create', tag, '--verify-tag', '--title', title, '--notes-file', notesFile, ...(parseVersion(version)[0] === 0 ? ['--prerelease'] : [])],
    ];
    console.log(`${tag} at ${commit.slice(0, 7)} passed its review. Release notes: ${notesFile}`);
    if (!opts.yes) {
        console.log('Dry run. These commands run with --yes:');
        for (const command of commands)
            console.log('  ' + command.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' '));
        return;
    }
    for (const [command, ...args] of commands) {
        console.log('> ' + [command, ...args].join(' '));
        execFileSync(command, args, { cwd: root, stdio: 'inherit' });
    }
    console.log(`Published ${tag}. npm publication is separate.`);
}

try {
    main();
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
