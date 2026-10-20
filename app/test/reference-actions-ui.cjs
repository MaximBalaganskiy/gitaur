const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/reference-actions-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote');
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  await fs.mkdir(repo);
  await fs.mkdir(remote);
  await git(remote, ['init', '--bare']);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Reference Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'tag.gpgsign', 'false'],
    ['config', 'core.autocrlf', 'false']
  ]) {
    await git(repo, args);
  }
  async function commit(content) {
    await fs.writeFile(path.join(repo, 'file.txt'), content);
    await git(repo, ['add', '--', 'file.txt']);
    await git(repo, ['commit', '-m', content.trim()]);
    return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  const base = await commit('Base\n');
  await git(repo, ['branch', 'older']);
  const head = await commit('Latest\n');
  await git(repo, ['branch', 'disposable']);
  await git(repo, ['tag', '-a', 'v-annotated', '-m', 'Annotated release']);
  await git(repo, ['tag', 'v-light']);
  await git(repo, ['tag', 'v-keep']);
  const tagObject = (await git(repo, ['rev-parse', 'refs/tags/v-annotated'])).stdout.trim();
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', 'origin', '--tags']);
  await git(repo, ['push', 'origin', `${base}:refs/heads/topic`, `${head}:refs/heads/new/topic`]);
  await git(repo, ['branch', 'tracking-alias']);
  await git(repo, ['branch', '--set-upstream-to=origin/topic', 'tracking-alias']);
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = page.getByRole('dialog');
  const search = page.getByRole('textbox', { name: 'Find a branch', exact: true });
  const option = name => page.getByRole('option', { name, exact: true });
  const ref = name => page.locator(`[data-reference-id="${name}"]`);
  async function menu(reference, action) {
    await search.fill(reference.replace(/^refs\/(heads|tags|remotes)\//, ''));
    await ref(reference).click({ button: 'right' });
    assert.equal(await page.getByRole('option', { selected: true }).count(), 0, 'Action menus must not retain selection');
    if (action) {
      await option(action).click();
    }
  }
  async function selected(hash) {
    await page.locator(`#commit-${hash}.selected`).waitFor();
  }
  async function cancel() {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
  }
  async function checkout(name, hash) {
    await search.fill(name);
    await page.getByRole('button', { name: `Switch to ${name}`, exact: true }).press('Enter');
    await selected(hash);
  }
  try {
    await selected(head);
    await menu('refs/heads/disposable', 'Delete branch…');
    await cancel();
    await menu('refs/heads/disposable');
    await page
      .getByRole('listbox')
      .filter({ has: option('Delete branch…') })
      .press('End');
    await page.keyboard.press('Enter');
    await cancel();
    await menu('refs/heads/older');
    await page.keyboard.press('Escape');
    await checkout('older', base);
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'older');
    await menu('refs/heads/main', 'Check out branch');
    await selected(head);
    await checkout('older', base);
    await checkout('origin/topic', head);
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'tracking-alias');
    await checkout('older', base);
    await checkout('origin/new/topic', head);
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'new/topic');
    await checkout('older', base);
    await fs.writeFile(path.join(repo, 'file.txt'), 'dirty\n');
    await search.fill('main');
    await page.getByRole('button', { name: 'Switch to main', exact: true }).press('Enter');
    await page.getByText('Commit or stash your changes before switching branches.', { exact: true }).waitFor();
    await selected(base);
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'older');
    await git(repo, ['restore', '--', 'file.txt']);

    await menu('refs/tags/v-light', 'Delete local tag…');
    await cancel();
    assert.equal((await git(repo, ['rev-parse', 'refs/tags/v-light'])).stdout.trim(), head);
    await menu('refs/tags/v-light', 'Delete local tag…');
    const localDelete = dialog.getByRole('button', { name: 'Delete local tag', exact: true });
    await localDelete.waitFor({ state: 'visible' });
    await page.waitForFunction(button => button.getAttribute('aria-disabled') !== 'true', await localDelete.elementHandle());
    await dialog.screenshot({ path: path.resolve('test-results/delete-local-tag.png') });
    await git(repo, ['update-ref', 'refs/tags/v-light', base]);
    await dialog.getByRole('button', { name: 'Delete local tag', exact: true }).press('Enter');
    await dialog.getByRole('alert').getByText('The tag changed. Reload before continuing.', { exact: true }).waitFor();
    assert.equal((await git(repo, ['rev-parse', 'refs/tags/v-light'])).stdout.trim(), base);
    await git(repo, ['update-ref', 'refs/tags/v-light', head]);
    await dialog.getByRole('button', { name: 'Delete local tag', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/tags/v-light']));
    assert.equal((await git(remote, ['rev-parse', 'refs/tags/v-light'])).stdout.trim(), head);

    await menu('refs/tags/v-annotated', 'Delete remote tag…');
    await dialog.getByRole('button', { name: 'Tag remote', exact: true }).waitFor();
    await dialog.screenshot({ path: path.resolve('test-results/delete-remote-tag.png') });
    await git(remote, ['update-ref', 'refs/tags/v-annotated', base]);
    await dialog.getByRole('button', { name: 'Delete remote tag', exact: true }).press('Enter');
    await dialog.getByRole('alert').waitFor();
    assert.equal((await git(remote, ['rev-parse', 'refs/tags/v-annotated'])).stdout.trim(), base);
    await git(remote, ['update-ref', 'refs/tags/v-annotated', tagObject]);
    await dialog.getByRole('button', { name: 'Delete remote tag', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(git(remote, ['show-ref', '--verify', 'refs/tags/v-annotated']));
    assert.equal((await git(repo, ['rev-parse', 'refs/tags/v-annotated'])).stdout.trim(), tagObject);
    await menu('refs/tags/v-annotated', 'Delete local tag…');
    await dialog.getByRole('button', { name: 'Delete local tag', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/tags/v-annotated']));
    await ref('refs/tags/v-annotated').waitFor({ state: 'hidden' });

    await git(repo, ['remote', 'remove', 'origin']);
    await page.keyboard.press('F5');
    await menu('refs/tags/v-keep', 'Delete remote tag…');
    await dialog.getByText('No remotes configured.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Delete remote tag', exact: true }).isDisabled(), true);
    await cancel();
    assert.deepEqual(errors, []);
    console.log(
      'PASS: non-selecting command menus, checkout tip selection, tracking-branch reuse, failed-checkout selection, local/remote annotated and lightweight tag deletion, cancellation, stale-tag rejection, and no-remote handling.'
    );
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
