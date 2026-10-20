const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/remote-checkout-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Remote Checkout Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.autocrlf', 'false']
  ]) {
    await git(repo, args);
  }
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', 'Base']);
  await git(repo, ['remote', 'add', 'origin', '.']);
  for (const name of ['feature/mouse', 'feature/keyboard', 'feature/menu', 'feature/dirty']) {
    await git(repo, ['update-ref', `refs/remotes/origin/${name}`, 'HEAD']);
  }
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/mouse']);
  await git(repo, ['tag', 'v1']);
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const search = page.getByRole('textbox', { name: 'Find a branch', exact: true });
  const button = name => page.getByRole('button', { name: `Switch to ${name}`, exact: true });
  async function current(name) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await git(repo, ['branch', '--show-current'])).stdout.trim() === name) {
        return;
      }
      await delay(100);
    }
    assert.fail(`Expected current branch ${name}`);
  }
  async function tracking(name) {
    await current(name);
    assert.equal((await git(repo, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).stdout.trim(), `refs/remotes/origin/${name}`);
    await search.fill(name);
    await page.locator(`[data-reference-id="refs/heads/${name}"]`).waitFor();
    await search.fill('main');
    await button('main').click();
    await current('main');
    await search.fill(name);
    await button(name).waitFor();
  }
  try {
    await page.locator('.commit-row').first().waitFor();
    await search.fill('feature/mouse');
    await button('origin/feature/mouse').click();
    await tracking('feature/mouse');

    await search.fill('feature/keyboard');
    await button('origin/feature/keyboard').focus();
    assert.equal(await button('origin/feature/keyboard').evaluate(element => getComputedStyle(element).opacity), '1');
    await page.keyboard.press('Enter');
    await tracking('feature/keyboard');

    await search.fill('feature/menu');
    await page.locator('[data-reference-id="refs/remotes/origin/feature/menu"]').click({ button: 'right' });
    await page.getByRole('option', { name: 'Check out branch', exact: true }).click();
    await tracking('feature/menu');

    await fs.writeFile(path.join(repo, 'base.txt'), 'dirty\n');
    await search.fill('feature/dirty');
    await button('origin/feature/dirty').click();
    await page.getByText('Commit or stash your changes before switching branches.', { exact: true }).waitFor();
    await current('main');
    assert.equal((await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/dirty'])).stdout.trim(), '');
    await git(repo, ['restore', 'base.txt']);

    await git(repo, ['branch', '-m', 'feature/mouse', 'renamed-mouse']);
    await search.fill('feature/mouse');
    await button('origin/feature/mouse').click();
    await current('renamed-mouse');
    assert.equal(
      (await git(repo, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).stdout.trim(),
      'refs/remotes/origin/feature/mouse'
    );
    assert.ok((await fs.readFile(path.join(repo, '.git', 'FETCH_HEAD'), 'utf8')).length > 0, 'Existing tracking checkout must fetch');
    await search.fill('main');
    await button('main').click();
    await current('main');
    await search.fill('renamed-mouse');
    await button('renamed-mouse').waitFor();

    await git(repo, ['branch', '--unset-upstream', 'renamed-mouse']);
    await git(repo, ['branch', 'feature/mouse']);
    await search.fill('feature/mouse');
    await button('origin/feature/mouse').click();
    await page.getByText(/a branch named 'feature\/mouse' already exists/).waitFor();
    await current('main');
    assert.equal((await git(repo, ['rev-parse', 'feature/mouse'])).stdout, (await git(repo, ['rev-parse', 'main'])).stdout);

    await search.fill('origin/HEAD');
    assert.equal(await button('origin/HEAD').count(), 0);
    await search.fill('v1');
    await page.locator('[data-reference-id="refs/tags/v1"]').waitFor();
    assert.equal(await button('v1').count(), 0);
    await search.fill('feature/mouse');
    await page.locator('[data-reference-id="refs/remotes/origin/feature/mouse"]').hover();
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('test-results/remote-checkout.png') });
    assert.deepEqual(errors, []);
    console.log(
      'Remote checkout desktop checks passed: button, keyboard, menu, upstream, dirty worktree, existing branch, and reference visibility.'
    );
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
