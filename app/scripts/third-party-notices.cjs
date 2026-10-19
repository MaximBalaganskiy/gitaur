const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'app');
const overrides = JSON.parse(fs.readFileSync(path.join(root, 'licenses/upstream/sources.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
const fingerprint = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(app, 'package-lock.json')))
  .update(fs.readFileSync(path.join(app, 'src-tauri/Cargo.lock')))
  .digest('hex');
const output = path.join(root, 'THIRD_PARTY_NOTICES.txt');

if (process.argv.includes('--check')) {
  if (!fs.readFileSync(output, 'utf8').includes(`Lockfile SHA-256: ${fingerprint}`)) {
    throw new Error('Dependency notices are stale. Run npm run notices and review license changes.');
  }
  console.log('Dependency notices match the locked versions.');
  process.exit(0);
}

function licenseTexts(directory, id) {
  const texts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isFile()) texts.push(fs.readFileSync(target, 'utf8'));
    if (entry.isDirectory()) {
      for (const name of fs.readdirSync(target)) {
        if (fs.statSync(path.join(target, name)).isFile()) texts.push(fs.readFileSync(path.join(target, name), 'utf8'));
      }
    }
  }
  const override = overrides.find(entry => entry.id === id);
  if (override)
    texts.push(`License source: ${override.source}\n\n${fs.readFileSync(path.join(root, 'licenses/upstream', override.file), 'utf8')}`);
  if (!texts.length) throw new Error(`Missing license text: ${id}`);
  return texts.map(text => text.replaceAll('\r\n', '\n').trim());
}

const records = [];
const visited = new Set();
function addNpm(name, parent = '') {
  const candidates = [];
  let directory = parent;
  while (directory) {
    candidates.push(`${directory}/node_modules/${name}`);
    directory = directory.includes('/node_modules/') ? directory.slice(0, directory.lastIndexOf('/node_modules/')) : '';
  }
  candidates.push(`node_modules/${name}`);
  const key = candidates.find(candidate => lock.packages[candidate]);
  if (!key) throw new Error(`Dependency missing from lockfile: ${name}`);
  if (visited.has(key)) return;
  visited.add(key);
  const directoryPath = path.join(app, key);
  const pkg = JSON.parse(fs.readFileSync(path.join(directoryPath, 'package.json'), 'utf8'));
  const id = `npm:${pkg.name}@${pkg.version}`;
  if (!pkg.license) throw new Error(`Missing declared license: ${id}`);
  records.push({
    id,
    license: pkg.license,
    source: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`,
    text: licenseTexts(directoryPath, id)
  });
  for (const dependency of Object.keys(pkg.dependencies || {})) addNpm(dependency, key);
}

// Runtime JavaScript, syntax grammars, and the shipped CSS theme. Build-only npm tools are not embedded.
for (const name of Object.keys(lock.packages[''].devDependencies)) {
  if (
    name === 'aurelia' ||
    name === 'rxjs' ||
    name === 'tslib' ||
    name === 'diff' ||
    name === 'lowlight' ||
    name === '@tauri-apps/api' ||
    /^@codemirror\/|^@lezer\/|^@aurelia-ui-toolkits\//.test(name) ||
    (name.startsWith('@aurelia/') && name !== '@aurelia/vite-plugin')
  )
    addNpm(name);
}

const crates = new Map();
for (const target of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
  const data = execFileSync(
    process.execPath,
    [
      'scripts/native.cjs',
      'cargo',
      'metadata',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--locked',
      '--format-version',
      '1',
      '--filter-platform',
      target
    ],
    { cwd: app, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }
  );
  const metadata = JSON.parse(data);
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
  for (const pkg of metadata.packages) {
    if (pkg.source && resolved.has(pkg.id)) crates.set(pkg.id, pkg);
  }
}
for (const pkg of crates.values()) {
  const id = `cargo:${pkg.name}@${pkg.version}`;
  if (!pkg.license) throw new Error(`Missing declared license: ${id}`);
  records.push({
    id,
    license: pkg.license,
    source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
    text: licenseTexts(path.dirname(pkg.manifest_path), id)
  });
}
const theme = overrides.find(entry => entry.id === 'theme:dark-plus@2.9.0');
const githubIcon = overrides.find(entry => entry.id.startsWith('icon:octicons-mark-github@'));
records.push({
  id: githubIcon.id,
  license: 'MIT',
  source: 'https://github.com/primer/octicons/blob/6dbe38e4e9b4987b2c9332d719c57fbbdd083e2d/icons/mark-github-16.svg',
  text: fs.readFileSync(path.join(root, 'licenses/upstream', githubIcon.file), 'utf8')
});
records.push({
  id: theme.id,
  license: 'BSD-3-Clause',
  source: 'https://github.com/samdark/intellij-visual-studio-code-dark-plus/tree/v2.9.0',
  text: fs.readFileSync(path.join(root, 'licenses/upstream', theme.file), 'utf8')
});
records.sort((a, b) => a.id.localeCompare(b.id, 'en'));

const header = `Gitaur third-party notices\n\nLockfile SHA-256: ${fingerprint}\n\nGitaur's own source is MIT licensed. Third-party components retain their\nown licenses below. This inventory includes the renderer dependencies and\nthe Windows/Linux native dependency graph, including build-time Rust crates;\nnot every listed component is present in every executable.\n\nSource archives for the exact unmodified dependency versions are linked in\neach entry. MPL-2.0 portions remain available in source form under MPL-2.0\nat those links. No third-party dependency source has been modified.\n\nThe Rider Dark Plus palette is adapted to Headless and Lowlight tokens.\nGitExtensions inspired the workflow; its application code is not bundled.\nGit, Git LFS and Windows WebView2 are separately installed components.\nLinux AppImage runtime libraries have additional notices and source links\nin LINUX_RUNTIME_NOTICES.txt supplied alongside Linux releases.\n\n`;
const texts = new Map();
const inventory = records.map(record => {
  const ids = (Array.isArray(record.text) ? record.text : [record.text]).map(value => {
    const text = value
      .trim()
      .replaceAll('\r\n', '\n')
      .replace(/[\t ]+$/gm, '');
    if (!texts.has(text)) texts.set(text, texts.size + 1);
    return texts.get(text);
  });
  return `${record.id}\nLicense: ${record.license}\nSource: ${record.source}\nFull notices: ${ids.join(', ')}\n`;
});
const notices = [...texts].map(([text, id]) => `${'='.repeat(78)}\nNOTICE ${id}\n\n${text}\n`);
fs.writeFileSync(output, header + inventory.join('\n') + '\n' + notices.join('\n'));
console.log(`Wrote notices for ${records.length} components.`);
