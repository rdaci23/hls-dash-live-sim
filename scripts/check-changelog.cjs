// npm run changelog:check
// Fails when src/ changed since the latest v* tag and the changelog's
// Unreleased section has no entries (unless a newer version is being prepared).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changelogFailure } = require('./release/changelog.cjs');

const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let lastTag;
try {
    lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
}
catch {
    lastTag = undefined;
}
const sourceChanged = Boolean(lastTag && git(['diff', '--name-only', lastTag, 'HEAD', '--', 'src']));
let failure;
try {
    failure = changelogFailure({
        text: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
        packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
        lastTag,
        sourceChanged,
    });
}
catch (error) {
    failure = error.message;
}
if (failure) {
    console.error(failure);
    process.exitCode = 1;
}
else
    console.log(lastTag ? `Changelog covers source changes since ${lastTag}.` : 'No release tag found; nothing to compare.');
