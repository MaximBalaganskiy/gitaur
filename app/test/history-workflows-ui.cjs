const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitaur-history-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'History Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  async function makeCommit(file, content, subject) {
    await fs.writeFile(path.join(repo, file), content);
    await git(repo, ['add', '--', file]);
    await git(repo, ['commit', '-m', subject]);
    return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  const base = await makeCommit('file.txt', 'base\n', 'Base');
  await git(repo, ['branch', 'disposable']);
  await git(repo, ['switch', '-c', 'feature']);
  await makeCommit('file.txt', 'feature\n', 'Feature change');
  await git(repo, ['switch', 'main']);
  await makeCommit('file.txt', 'main\n', 'Main change');
  await makeCommit('one.txt', 'one\n', 'Add one');
  const original = await makeCommit('two.txt', 'two\n', 'Add two');
  await git(repo, ['branch', 'remote-delete']);
  await git(repo, ['remote', 'add', 'origin', repo]);
  await git(repo, ['fetch', 'origin']);
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  app.context.on('page', window => window.on('pageerror', error => errors.push(error.message)));
  const dialog = page.getByRole('dialog');

  async function dismiss(window = page) {
    for (const button of await window.locator('.ui-toast-host button').all()) {
      if (await button.isVisible()) {
        await button.click();
      }
    }
  }

  async function commitMenu(subject, action) {
    await dismiss();
    await page.getByRole('button', { name: subject, exact: true }).first().click({ button: 'right' });
    await page.getByRole('option', { name: action, exact: true }).click();
  }

  async function branchMenu(name, action) {
    await dismiss();
    await page.locator(`repository-sidebar .branch-item[title="${name}"]`).first().click({ button: 'right' });
    await page.getByRole('option', { name: action, exact: true }).click();
  }

  async function choose(window, label, option) {
    await window.getByRole('button', { name: label, exact: true }).click();
    await window.getByRole('option', { name: option, exact: true }).click();
  }

  try {
    await branchMenu('origin/remote-delete', 'Delete remote branch…');
    await dialog.getByText('Delete this branch from the remote server?', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await git(repo, ['rev-parse', 'refs/heads/remote-delete'])).stdout.trim(), original);
    await branchMenu('origin/remote-delete', 'Delete remote branch…');
    await git(repo, ['update-ref', 'refs/heads/remote-delete', base]);
    await dialog.getByRole('button', { name: 'Delete remote branch', exact: true }).press('Enter');
    await dialog.getByRole('alert').waitFor();
    assert.equal((await git(repo, ['rev-parse', 'refs/heads/remote-delete'])).stdout.trim(), base);
    await git(repo, ['update-ref', 'refs/heads/remote-delete', original]);
    await dialog.getByRole('button', { name: 'Delete remote branch', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/heads/remote-delete']));
    await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/remotes/origin/remote-delete']));
    await page.locator('repository-sidebar .branch-item[title="origin/remote-delete"]').waitFor({ state: 'hidden' });

    await branchMenu('disposable', 'Rename branch…');
    await dialog.getByRole('textbox', { name: 'New branch name', exact: true }).fill('bad name');
    await dialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
    await dialog.locator('.ui-input__error').filter({ hasText: 'must not contain spaces' }).waitFor();
    await dialog.getByRole('textbox', { name: 'New branch name', exact: true }).fill('renamed');
    await dialog.getByRole('textbox', { name: 'New branch name', exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await branchMenu('renamed', 'Delete branch…');
    await dialog.getByRole('button', { name: 'Delete branch', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/heads/renamed']));

    await branchMenu('main', 'Set upstream…');
    await choose(page, 'Upstream branch', 'origin/main');
    await dialog.getByRole('button', { name: 'Set upstream', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).stdout.trim(), 'origin/main');

    await page.getByRole('button', { name: 'Actions for remote origin', exact: true }).click();
    await page.getByRole('option', { name: 'Edit remote…', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Push URL (optional)', exact: true }).fill(repo);
    await dialog.getByRole('checkbox', { name: 'Prune deleted remote branches when fetching', exact: true }).first().press('Space');
    await dialog.getByRole('button', { name: 'Save remote', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Remote updated', { exact: true }).waitFor();
    assert.equal((await git(repo, ['config', '--get', 'remote.origin.prune'])).stdout.trim(), 'true');
    await page.getByRole('button', { name: 'Actions for remote origin', exact: true }).click();
    await page.getByRole('option', { name: 'Fetch remote', exact: true }).click();
    await page.getByText('Remote fetched', { exact: true }).waitFor();

    await commitMenu('Add two', 'Revert commit…');
    await dialog.getByRole('button', { name: 'Revert commit', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await assert.rejects(fs.access(path.join(repo, 'two.txt')));
    await commitMenu('Add two', 'Cherry-pick commit…');
    await dialog.getByRole('button', { name: 'Cherry-pick commit', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(path.join(repo, 'two.txt'), 'utf8'), 'two\n');

    await commitMenu('Base', 'Reset current branch here…');
    await choose(page, 'Reset mode', 'Soft — keep changes staged');
    await dialog.getByRole('button', { name: 'Reset current branch', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), base);
    assert.ok((await git(repo, ['diff', '--cached', '--name-only'])).stdout.includes('one.txt'));
    await git(repo, ['reset', '--hard', original]);
    await page.keyboard.press('F5');
    await page
      .locator(`#commit-${original}`)
      .filter({ has: page.getByText('⑂ main', { exact: true }) })
      .waitFor();
    await commitMenu('Base', 'Edit rebase plan from here…');
    const actions = dialog.locator('.ui-select__control');
    await actions.first().waitFor();
    assert.equal(await actions.count(), 3);
    await actions.nth(2).click();
    await page.getByRole('option', { name: 'fixup', exact: true }).click();
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Rebase plan must fit inside its dialog');
    await page.screenshot({ path: path.resolve('test-results/rebase-plan.png') });
    await dialog.getByRole('button', { name: 'Apply rebase plan', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await git(repo, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '3');

    await commitMenu('Feature change', 'Cherry-pick commit…');
    const [commit] = await Promise.all([
      app.context.waitForEvent('page'),
      dialog.getByRole('button', { name: 'Cherry-pick commit', exact: true }).click()
    ]);
    commit.setDefaultTimeout(15000);
    await commit.getByRole('button', { name: 'Resolve conflict…', exact: true }).click();
    await commit.getByRole('dialog').getByRole('button', { name: 'Accept theirs', exact: true }).click();
    await commit.getByRole('dialog').getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await commit.getByRole('dialog').waitFor({ state: 'hidden' });
    await dismiss(commit);
    await commit.screenshot({ path: path.resolve('test-results/cherry-pick-continue.png') });
    await Promise.all([commit.waitForEvent('close'), commit.getByRole('button', { name: 'Continue cherry-pick', exact: true }).click()]);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'feature\n');
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');

    await dismiss();
    await page.getByRole('button', { name: 'Repository menu', exact: true }).click();
    await page.getByRole('option', { name: 'Clone repository…', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Repository URL or local path', exact: true }).fill(repo);
    await dialog.getByRole('textbox', { name: 'Destination folder', exact: true }).fill(path.join(root, 'cloned repo'));
    await dialog.getByRole('button', { name: 'Clone and open', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Repository menu', exact: true }).getByText('cloned repo', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Repository menu', exact: true }).click();
    await page.getByRole('option', { name: 'Create repository…', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Destination folder', exact: true }).fill(path.join(root, 'empty repo'));
    await dialog.getByRole('textbox', { name: 'Initial branch', exact: true }).fill('trunk');
    await dialog.getByRole('button', { name: 'Create and open', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Repository menu', exact: true }).getByText('empty repo', { exact: true }).waitFor();
    assert.equal((await git(path.join(root, 'empty repo'), ['branch', '--show-current'])).stdout.trim(), 'trunk');
    assert.deepEqual(errors, []);
    console.log(
      'Desktop history workflows passed: branch errors/keyboard rename/delete, upstream, remotes, revert, cherry-pick conflict/continue, reset, editable rebase, clone/init.'
    );
  } catch (error) {
    console.error(
      await dialog
        .evaluate(element =>
          [element, ...element.querySelectorAll('*')]
            .filter(item => item.getBoundingClientRect().right > element.getBoundingClientRect().right)
            .slice(0, 12)
            .map(item => ({
              tag: item.tagName,
              class: item.className,
              width: getComputedStyle(item).width,
              maxWidth: getComputedStyle(item).maxWidth,
              display: getComputedStyle(item).display,
              box: item.getBoundingClientRect().toJSON()
            }))
        )
        .catch(() => [])
    );
    await page.screenshot({ path: path.resolve('test-results/history-workflows-failure.png') }).catch(() => {});
    console.error(errors);
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
