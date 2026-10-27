const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/commit-files-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Commit Files Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await fs.mkdir(path.join(repo, 'folder'));
  for (const file of ['zebra.txt', 'Beta.txt', 'folder/zebra.txt', '[old].txt']) {
    await fs.writeFile(path.join(repo, file), 'original content\n');
  }
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Initial files']);
  await fs.rename(path.join(repo, '[old].txt'), path.join(repo, 'renamed.txt'));
  await git(repo, ['add', '--', '[old].txt', 'renamed.txt']);
  for (const file of ['Zebra-staged.txt', 'alpha-staged.txt']) {
    await fs.writeFile(path.join(repo, file), 'staged content\n');
    await git(repo, ['add', '--', file]);
  }
  for (const file of ['zebra.txt', 'Beta.txt', 'folder/zebra.txt']) {
    await fs.writeFile(path.join(repo, file), 'changed content\n');
  }
  await fs.writeFile(path.join(repo, 'alpha.txt'), 'untracked content\n');
  await fs.writeFile(path.join(repo, 'folder/alpha.txt'), 'untracked content\n');
  const profile = path.join(root, 'profile');
  const app = await launchTauri(repo, profile);
  const errors = [];
  let commit;
  app.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    [commit] = await Promise.all([app.context.waitForEvent('page'), app.page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(15000);
    await commit.locator('.file-item').last().waitFor();
    const lists = commit.locator('change-list');
    assert.deepEqual(
      await lists
        .nth(0)
        .locator('.file-item')
        .evaluateAll(items => items.map(item => item.title)),
      ['alpha.txt', 'Beta.txt', 'folder/alpha.txt', 'folder/zebra.txt', 'zebra.txt']
    );
    assert.deepEqual(
      await lists
        .nth(1)
        .locator('.file-item')
        .evaluateAll(items => items.map(item => item.title)),
      ['alpha-staged.txt', '[old].txt → renamed.txt', 'Zebra-staged.txt']
    );
    const rename = lists.nth(1).locator('.file-item[title="[old].txt → renamed.txt"]');
    await rename.focus();
    await rename.press('Enter');
    await commit.locator('.diff-line.removed').first().waitFor();
    assert.equal(await commit.locator('.diff-line.removed .diff-marker').innerText(), '-');
    assert.equal(await commit.locator('.diff-line.added .diff-marker').innerText(), '+');
    assert.match(await commit.locator('.diff-line.removed .diff-content').innerText(), /original content/);
    await commit.getByRole('button', { name: 'Show full file', exact: true }).click();
    await commit.getByRole('button', { name: 'Show changes only', exact: true }).waitFor();
    await commit.locator('.diff-line.removed').first().waitFor();
    assert.match(await commit.locator('.diff-code').innerText(), /--- a\/\[old\]\.txt/);
    await commit.screenshot({ path: path.resolve('test-results/commit-renamed-files.png') });

    // A working edit on an already staged rename compares only the destination against the index.
    await fs.writeFile(path.join(repo, 'renamed.txt'), 'working edit\n');
    await commit.keyboard.press('F5');
    const workingRename = lists.nth(0).locator('.file-item[title="renamed.txt"]');
    await workingRename.waitFor();
    await workingRename.click();
    await commit.locator('.diff-line.added').filter({ hasText: 'working edit' }).waitFor();
    assert.doesNotMatch(await commit.locator('.diff-code').innerText(), /\[old\]\.txt|deleted file mode/);

    await commit.getByRole('button', { name: 'Show file tree', exact: true }).click();
    const tree = commit.getByRole('tree', { name: 'Unstaged files', exact: true });
    await tree.waitFor();
    // Inspect the rendered labels as well as exercising keyboard tree selection.
    const labels = await tree.locator('.group > span.truncate').allTextContents();
    assert.deepEqual(labels, ['folder', 'alpha.txt', 'zebra.txt', 'alpha.txt', 'Beta.txt', 'renamed.txt', 'zebra.txt']);
    assert.equal(await tree.getByRole('treeitem').count(), labels.length);
    await tree.focus();
    await tree.press('Home');
    await tree.press('ArrowDown');
    await tree.press('Enter');
    await commit.locator('.diff-heading > span').first().filter({ hasText: 'folder/alpha.txt' }).waitFor();

    await commit.getByRole('button', { name: 'Unstage renamed.txt', exact: true }).focus();
    await commit.getByRole('button', { name: 'Unstage renamed.txt', exact: true }).press('Enter');
    await commit.waitForFunction(() => !document.querySelectorAll('change-list')[1].textContent.includes('renamed.txt'));
    const status = (await git(repo, ['status', '--porcelain'])).stdout;
    assert.match(status, / D \[old\]\.txt/);
    assert.match(status, /\?\? renamed\.txt/);
    await commit.screenshot({ path: path.resolve('test-results/commit-files.png') });

    // A file disappearing between refresh and selection reports an error and allows another selection.
    await fs.unlink(path.join(repo, 'alpha.txt'));
    await tree.locator('.group[title="alpha.txt"]').click();
    await commit.locator('.ui-toast-region__toast[data-tone="danger"]').waitFor();
    await tree.locator('.group[title="Beta.txt"]').click();
    await commit.locator('.diff-line.added').filter({ hasText: 'changed content' }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: sorted staging lists and trees; rename labels, removed/added diffs, full-file view and keyboard unstage.');
  } catch (error) {
    if (commit && !commit.isClosed()) {
      await commit.screenshot({ path: path.resolve('test-results/commit-files-failure.png') });
    }
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
