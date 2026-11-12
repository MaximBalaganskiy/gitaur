const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/delete-files-ui-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Delete Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Base']);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'working edit\n');
  const files = ['flat.txt', 'tree.txt', 'staged-flat.txt', 'staged-tree.txt'];
  for (const file of files) {
    await fs.writeFile(path.join(repo, file), 'new content\n');
    if (file.startsWith('staged-')) {
      await git(repo, ['add', '--', file]);
      await fs.writeFile(path.join(repo, file), 'unstaged content\n');
    }
  }
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const errors = [];
  app.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let commit;
  try {
    [commit] = await Promise.all([app.context.waitForEvent('page'), app.page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(15000);
    await commit.locator('.file-item').first().waitFor();
    const button = name => commit.getByRole('button', { name, exact: true });
    const dialog = commit.getByRole('dialog');
    for (const tree of [false, true]) {
      if (tree) {
        await button('Show file tree').click();
      }
      for (const staged of [false, true]) {
        const file = `${staged ? 'staged-' : ''}${tree ? 'tree' : 'flat'}.txt`;
        const list = commit.locator('change-list').nth(staged ? 1 : 0);
        const row = tree ? list.locator(`.group[title="${file}"]`) : list.locator(`.file-item[title="${file}"]`);
        await row.click({ button: 'right' });
        await commit.getByRole('option', { name: 'Delete file…', exact: true }).click();
        await dialog.waitFor();
        assert.match(await dialog.innerText(), /Permanently delete/);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await fs.readFile(path.join(repo, file), 'utf8'), staged ? 'unstaged content\n' : 'new content\n');
        if (staged) {
          const unstaged = commit.locator('change-list').first();
          const workingRow = tree ? unstaged.locator(`.group[title="${file}"]`) : unstaged.locator(`.file-item[title="${file}"]`);
          await workingRow.click();
          // A staged addition with further edits still offers reset-to-index as well as deletion.
          await button('Reset file changes…').waitFor();
          await button('Delete file…').waitFor();
        }
        await row.click();
        await commit.locator('.diff-heading button:not([aria-disabled="true"])').filter({ hasText: 'Delete file…' }).focus();
        await commit.keyboard.press('Enter');
        await dialog.waitFor();
        if (!tree && !staged) {
          await fs.writeFile(path.join(repo, file), 'external edit\n');
          await dialog.getByRole('button', { name: 'Delete file', exact: true }).press('Enter');
          await dialog.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
          assert.equal(await fs.readFile(path.join(repo, file), 'utf8'), 'external edit\n');
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await button('Delete file…').click();
          await dialog.waitFor();
        }
        await dialog.getByRole('button', { name: 'Delete file', exact: true }).press('Enter');
        await dialog.waitFor({ state: 'hidden' });
        await assert.rejects(fs.stat(path.join(repo, file)), { code: 'ENOENT' });
        assert.equal((await git(repo, ['ls-files', '--', file])).stdout, '');
        assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'working edit\n');
      }
    }
    await commit.locator('.group[title="tracked.txt"]').click();
    await button('Reset file changes…').waitFor();
    assert.equal(await button('Delete file…').count(), 0);
    await commit.screenshot({ path: path.resolve('test-results/delete-new-files.png') });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: new-file deletion from flat/tree menus and toolbar; staged additions removed; keyboard confirmation, cancellation and stale-file errors; tracked edits preserved.'
    );
  } catch (error) {
    if (commit && !commit.isClosed()) {
      await commit.screenshot({ path: path.resolve('test-results/delete-new-files-failure.png') });
    }
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
