const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/reset-ui-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Reset Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  const relative = 'Services/InboxService/Dynamik.Inbox.MessageReceiver/Consumers/MessageReceivedNotificationConsumerImplementation.cs';
  const file = path.join(repo, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join('');
  await fs.writeFile(file, base);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Base']);
  const indexed = base.replace('line 15\n', 'staged 15\n');
  await fs.writeFile(file, indexed);
  await git(repo, ['add', '.']);
  const working = indexed.replace('line 2\n', 'changed 2\n').replace('line 28\n', 'changed 28\n');
  await fs.writeFile(file, working);
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'keep\n');
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const errors = [];
  app.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let commit;
  try {
    [commit] = await Promise.all([app.context.waitForEvent('page'), app.page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(15000);
    const button = name => commit.getByRole('button', { name, exact: true });
    const dialog = commit.getByRole('dialog');
    await button('Reset hunk…').first().focus();
    await commit.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(file, 'utf8'), working);
    await button('Reset hunk…').first().click();
    await dialog.getByRole('button', { name: 'Reset changes', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(file, 'utf8'), indexed.replace('line 28\n', 'changed 28\n'));
    assert.equal((await git(repo, ['show', `:${relative}`])).stdout, indexed);
    await button('Show full file').click();
    await commit.locator('.diff-content').getByText('line 12', { exact: true }).waitFor();
    await commit.locator('.diff-line.added').filter({ hasText: '+changed 28' }).getByRole('button').press('Space');
    await button('Reset selected lines…').press('Enter');
    await dialog.getByRole('button', { name: 'Reset changes', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(file, 'utf8'), indexed.replace('line 28\n', ''));
    await button('Reset file changes…').click();
    await dialog.waitFor();
    await commit.setViewportSize({ width: 900, height: 640 });
    await dialog.evaluate(element => {
      for (const container of [element, ...element.querySelectorAll('*')]) {
        assertNoHorizontalScroll(container);
      }
      function assertNoHorizontalScroll(container) {
        if (container.clientWidth && container.scrollWidth > container.clientWidth + 1) {
          throw new Error(`Dialog overflows horizontally: ${container.tagName}`);
        }
      }
    });
    await dialog.screenshot({ path: path.resolve('test-results/reset-long-path-dialog.png') });
    await commit.setViewportSize({ width: 1200, height: 900 });
    const external = indexed.replace('line 28\n', 'external edit\n');
    await fs.writeFile(file, external);
    await dialog.getByRole('button', { name: 'Reset file', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'diff changed' }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), external);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await commit.locator('.diff-line.added').filter({ hasText: '+external edit' }).waitFor();
    // Both list layouts expose the same reset action through their context menu.
    for (const tree of [false, true]) {
      if (tree) {
        await button('Show file tree').click();
      }
      const row = tree
        ? commit.locator(`.unstaged-section [title="${relative}"]`)
        : commit.locator('.unstaged-section .stage-file').filter({ hasText: relative });
      await row.click({ button: 'right' });
      await commit.getByRole('option', { name: 'Reset file changes…', exact: true }).click();
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await button('Reset file changes…').click();
    await dialog.getByRole('button', { name: 'Reset file', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(file, 'utf8'), indexed);
    assert.equal((await git(repo, ['show', `:${relative}`])).stdout, indexed);
    assert.equal((await git(repo, ['show', `HEAD:${relative}`])).stdout, base);
    assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'keep\n');
    assert.equal(await button('Reset file changes…').count(), 0);
    assert.deepEqual(errors, []);
    await commit.screenshot({ path: path.resolve('test-results/reset-changes.png') });
    console.log(
      'PASS: file, hunk and line reset; keyboard confirmation and cancellation; stale diff errors; flat/tree menus; index and untracked files preserved.'
    );
  } catch (error) {
    if (commit && !commit.isClosed()) {
      await commit.screenshot({ path: path.resolve('test-results/reset-changes-failure.png') });
    }
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
