const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/dialog-overflow-'));
  const repo = path.join(root, 'repo');
  const branch = `feature-${'b'.repeat(140)}`;
  const remote = `remote-${'r'.repeat(140)}`;
  const tag = `release-${'t'.repeat(140)}`;
  const longText = 'Services/InboxService/Dynamik.Inbox.MessageReceiver/Consumers/'.repeat(5);
  const modulePath = `Services/InboxService/${'Submodule'.repeat(14)}`;
  await fs.mkdir(repo);
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  for (const args of [
    ['init', '-b', branch],
    ['config', 'user.name', 'Dialog Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'tag.gpgsign', 'false']
  ]) {
    await git(repo, args);
  }
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', longText]);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['remote', 'add', remote, path.join(root, 'missing', 'repository'.repeat(15))]);
  await git(repo, ['tag', '-a', tag, '-m', longText]);
  await fs.writeFile(path.join(repo, 'file.txt'), `${'wide diff content '.repeat(100)}\n`);
  await git(repo, ['stash', 'push', '-m', longText]);
  await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${head},${modulePath}`]);
  await git(repo, ['commit', '-m', 'Record uninitialized submodule']);
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = page.getByRole('dialog');
  const button = name => page.getByRole('button', { name, exact: true });
  const option = name => page.getByRole('option', { name, exact: true });
  const checked = [];

  async function check(label) {
    await dialog.waitFor();
    for (const width of [1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await dialog.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const overflow = await dialog.evaluate(element => {
        return [element, ...element.querySelectorAll('*')]
          .filter(container => {
            if (container.closest('diff-view, merge-editor, input, textarea')) {
              return false;
            }
            const style = getComputedStyle(container);
            return (
              container.clientWidth &&
              container.scrollWidth > container.clientWidth + 1 &&
              (container === element || ['auto', 'scroll'].includes(style.overflowX))
            );
          })
          .map(container => ({
            element: `${container.tagName}.${container.className}`,
            width: container.clientWidth,
            content: container.scrollWidth
          }));
      });
      assert.deepEqual(overflow, [], `${label} must not scroll horizontally at ${width}px`);
    }
    await dialog.screenshot({ path: path.resolve(`test-results/dialog-overflow-${label}.png`) });
    checked.push(label);
  }

  async function close(name = 'Cancel') {
    await dialog.getByRole('button', { name, exact: true }).press('Enter');
    await dialog.waitFor({ state: 'hidden' });
  }

  async function tool(label) {
    await button('Repository tools').click();
    await option(label).click();
    await dialog.waitFor();
  }

  async function referenceMenu(reference, label) {
    await page.getByRole('textbox', { name: 'Find a branch', exact: true }).fill(reference.replace(/^refs\/(heads|tags)\//, ''));
    await page.locator(`[data-reference-id="${reference}"]`).click({ button: 'right' });
    await option(label).click();
  }

  try {
    await page.locator(`#commit-${head}`).waitFor();
    await button('↑ Push').click();
    await check('publish');
    await dialog.getByRole('button', { name: 'Publish branch', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await check('publish-error');
    await close();

    await referenceMenu(`refs/heads/${branch}`, 'Rename branch…');
    await check('branch');
    await close();
    await referenceMenu(`refs/heads/${branch}`, 'Create branch from here…');
    await check('new-branch');
    await close();
    await referenceMenu(`refs/heads/${branch}`, 'Rebase current branch onto here…');
    await check('history-operation');
    await close();
    await referenceMenu(`refs/heads/${branch}`, 'Merge into current branch…');
    await check('action');
    await close();
    await referenceMenu(`refs/tags/${tag}`, 'Delete local tag…');
    await check('delete-tag');
    await close();

    await page.getByRole('textbox', { name: 'Find a branch', exact: true }).fill('');
    await button('Add remote').click();
    await dialog.getByRole('textbox', { name: 'Remote name', exact: true }).fill(remote);
    await dialog.getByRole('textbox', { name: 'Remote URL', exact: true }).fill(repo);
    await dialog.getByRole('button', { name: 'Create remote', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await check('remote-error');
    await close();

    await button('Create worktree').click();
    await dialog.getByRole('textbox', { name: 'New branch', exact: true }).fill('new-worktree');
    await dialog.getByRole('textbox', { name: 'Worktree folder', exact: true }).fill(root);
    await dialog.getByRole('textbox', { name: 'Start from branch or commit', exact: true }).fill(`missing-${'x'.repeat(180)}`);
    await dialog.getByRole('button', { name: 'Create worktree', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await check('worktree-error');
    await close();

    await button('Stashes').click();
    await dialog.getByRole('button', { name: 'Drop…', exact: true }).click();
    await check('stash');
    await dialog.evaluate(element => {
      element.style.borderWidth = '4px';
    });
    await check('stash-border');
    await dialog.evaluate(element => element.style.removeProperty('border-width'));
    assert.ok(
      await dialog.locator('diff-view').evaluate(element => element.scrollWidth > element.clientWidth),
      'Wide diffs keep their horizontal scroll'
    );
    await close('Close');
    await tool('Reflog recovery…');
    await check('reflog');
    await close('Close');
    await tool('Tags…');
    await dialog.getByRole('option').first().click();
    await dialog.getByRole('button', { name: 'Delete local tag…', exact: true }).click();
    await check('tags');
    await close('Close');
    await tool('Submodules…');
    await dialog.getByText(modulePath, { exact: true }).waitFor();
    await check('submodules');
    await close('Close');
    await tool('Git LFS…');
    await check('lfs');
    await close('Close');

    await button('Repository menu').click();
    await option('Clone repository…').click();
    await dialog
      .getByRole('textbox', { name: 'Repository URL or local path', exact: true })
      .fill(path.join(root, 'nonexistent'.repeat(16)));
    await dialog.getByRole('textbox', { name: 'Destination folder', exact: true }).fill(path.join(root, 'clone'));
    await dialog.getByRole('button', { name: 'Clone and open', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    await check('repository-error');
    await close();
    assert.deepEqual(errors, []);
    console.log(`PASS: long text stays inside dialogs at both widths: ${checked.join(', ')}; diff scrolling preserved.`);
  } catch (error) {
    await page.screenshot({ path: path.resolve('test-results/dialog-overflow-failure.png') });
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
