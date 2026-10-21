const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/commit-details-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Details Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  async function commit(file, message) {
    await fs.writeFile(path.join(repo, file), message);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', message]);
    return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  const base = await commit('base.txt', 'Base');
  await git(repo, ['branch', 'older']);
  await git(repo, ['switch', '-c', 'feature/nested']);
  const feature = await commit('feature.txt', 'Feature');
  await git(repo, ['switch', 'main']);
  await commit('main.txt', 'Main');
  await git(repo, ['merge', '--no-edit', 'feature/nested']);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git(repo, ['switch', '--detach']);
  const detached = await commit('detached.txt', 'Detached');
  await git(repo, ['tag', 'tag-only']);
  await git(repo, ['switch', 'main']);

  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const local = page.locator('.local-containing-branches');
  const remote = page.locator('.remote-containing-branches');
  async function select(hash, locals, remotes) {
    await page.locator(`#commit-${hash}`).press('Enter');
    await page.waitForFunction(
      ({ locals, remotes }) => {
        const names = selector => Array.from(document.querySelectorAll(`${selector} code`), item => item.textContent);
        return (
          JSON.stringify(names('.local-containing-branches')) === JSON.stringify(locals) &&
          JSON.stringify(names('.remote-containing-branches')) === JSON.stringify(remotes) &&
          !document.querySelector('.local-containing-branches')?.textContent.includes('Loading')
        );
      },
      { locals, remotes }
    );
  }
  try {
    await page.locator(`#commit-${base}`).waitFor();
    const tab = page.getByRole('tab', { name: /^Changes/ });
    await tab.focus();
    await tab.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await select(base, ['feature/nested', 'main', 'older'], ['origin/main']);
    await select(feature, ['feature/nested', 'main'], ['origin/main']);
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('test-results/commit-details.png') });
    await select(detached, [], []);
    assert.equal((await local.innerText()).trim(), 'None');
    assert.equal((await remote.innerText()).trim(), 'None');
    await select(feature, ['feature/nested', 'main'], ['origin/main']);
    await git(repo, ['branch', 'added-after-selection', feature]);
    await page.keyboard.press('F5');
    await local.getByText('added-after-selection', { exact: true }).waitFor();
    const object = path.join(repo, '.git', 'objects', base.slice(0, 2), base.slice(2));
    const backup = path.join(root, 'saved-commit-object');
    await fs.rename(object, backup);
    try {
      await page.locator(`#commit-${base}`).press('Enter');
      await local.getByText('Unavailable', { exact: true }).waitFor();
      await page
        .locator('.ui-toast-host')
        .getByText(/bad object/)
        .waitFor();
    } finally {
      await fs.rename(backup, object);
    }
    await select(feature, ['added-after-selection', 'feature/nested', 'main'], ['origin/main']);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: commit containment across merged ancestry, local/remote refs, aliases, tag-only commits, reference refresh, keyboard, and lookup failure recovery.'
    );
  } catch (error) {
    console.error(await page.locator('.detail-panel').innerText());
    console.error(await page.evaluate(hash => window.__TAURI_INTERNALS__.invoke('detail', { hash }), base));
    console.error(errors);
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
