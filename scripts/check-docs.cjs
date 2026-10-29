const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function markdown(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdown(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}
const files = [path.join(root, 'README.md'), path.join(root, 'CONTRIBUTING.md'), ...markdown(path.join(root, 'docs')), ...markdown(path.join(root, 'assets'))];
let checked = 0;
const errors = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
    const relative = decodeURIComponent(target.split('#')[0]);
    if (!relative) continue;
    checked++;
    const resolved = path.resolve(path.dirname(file), relative);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) errors.push(path.relative(root, file) + ': ' + target);
  }
}
if (errors.length) {
  console.error('Broken local documentation links:\n' + errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${checked} local links in ${files.length} Markdown files.`);
