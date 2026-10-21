const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/history-checkout-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote');
  await fs.mkdir(repo);
  await fs.mkdir(remote);
  await git(remote, ['init', '--bare']);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Checkout Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Base']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['branch', 'older']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'latest\n');
  await git(repo, ['commit', '-am', 'Latest']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['tag', 'release']);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', 'origin', `${base}:refs/heads/topic`, `${head}:refs/heads/new/topic`]);
  await git(repo, ['branch', 'tracking-alias']);
  await git(repo, ['branch', '--set-upstream-to=origin/topic', 'tracking-alias']);
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic']);
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const option = name => page.getByRole('option', { name, exact: true });
  async function open(hash) {
    await option('Check out commit…').waitFor({ state: 'hidden' });
    await page.locator(`#commit-${hash}`).click({ button: 'right' });
    await option('Check out commit…').waitFor();
  }
  async function current(name, hash) {
    await page.waitForFunction(name => document.querySelector('.branch-pill')?.textContent === name, name);
    await page.locator('.statusbar').getByText('Ready', { exact: true }).waitFor();
    await page.locator(`#commit-${hash}.selected`).waitFor();
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), name);
  }
  try {
    await open(base);
    assert.equal(await option('Check out local branch main').count(), 0);
    assert.equal(await option('Check out remote branch origin/HEAD').count(), 0);
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('test-results/history-checkout.png') });
    await option('Check out local branch older').click();
    await current('older', base);
    await open(head);
    assert.equal(await option('Check out tag branch release').count(), 0);
    await option('Check out local branch main').click();
    await current('main', head);
    await open(base);
    await option('Check out remote branch origin/topic').click();
    await current('tracking-alias', head);
    await open(base);
    await option('Check out local branch older').click();
    await current('older', base);
    await open(head);
    await option('Check out remote branch origin/new/topic').click();
    await current('new/topic', head);
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).stdout.trim(), 'origin/new/topic');
    await open(base);
    await option('Check out local branch older').click();
    await current('older', base);
    await fs.writeFile(path.join(repo, 'file.txt'), 'dirty\n');
    await open(head);
    await option('Check out local branch main').click();
    await page.getByText('Commit or stash your changes before switching branches.', { exact: true }).waitFor();
    await current('older', base);
    await git(repo, ['restore', '--', 'file.txt']);
    for (const button of await page.locator('.ui-toast-host button').all()) {
      if (await button.isVisible()) {
        await button.click();
      }
    }
    const row = page.locator(`#commit-${head}`);
    await row.focus();
    await row.press('Shift+F10');
    const list = page.getByRole('listbox').filter({ has: option('Check out local branch main') });
    await list.press('Home');
    for (let index = 0; index < 4; index++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await current('main', head);
    await open(head);
    assert.equal(await option('Check out local branch main').getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Escape');
    await row.waitFor({ state: 'visible' });
    assert.equal(await row.evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
    console.log('PASS: history checkout local/remote choices, tracking reuse/creation, keyboard, focus return, and dirty-tree rejection.');
  } catch (error) {
    console.error((await page.getByRole('dialog').allTextContents()).map(text => text.replace(/\s+/g, ' ').trim()));
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
