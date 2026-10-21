const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/app-overflow-'));
  const repo = path.join(root, 'repo');
  const profile = path.join(root, 'profile');
  const branch = `feature-${'b'.repeat(160)}`;
  const relative = 'Services/InboxService/Dynamik.Inbox.MessageReceiver/Consumers/MessageReceivedNotificationConsumerImplementation.cs';
  const longText = 'Services/InboxService/Dynamik.Inbox.MessageReceiver/Consumers/'.repeat(8);
  const recent = path.join(root, 'RepositoryWithAnExtremelyLongDirectoryName'.repeat(4));
  const missing = path.join(root, 'missing-remote-repository-'.repeat(7));
  await fs.mkdir(repo);
  await fs.mkdir(profile);
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  for (const args of [
    ['init', '-b', branch],
    ['config', 'user.name', 'LongAuthorName'.repeat(20)],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.autocrlf', 'false']
  ]) {
    await git(repo, args);
  }
  const file = path.join(repo, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${'wide source text '.repeat(150)}\n`);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', longText, '-m', longText]);
  await git(repo, ['remote', 'add', 'origin', missing]);
  await fs.writeFile(file, `${'changed source text '.repeat(150)}\n`);
  await fs.writeFile(path.join(profile, 'repositories.json'), JSON.stringify([repo, recent]));
  const app = await launchTauri('', profile);
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  app.context.on('page', window => window.on('pageerror', error => errors.push(error.message)));
  let commit;

  async function contained(window, selector, label) {
    const failures = await window.locator(selector).evaluateAll(elements => {
      return elements.flatMap(element => {
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) {
          return [];
        }
        const problems = [];
        if (element.scrollWidth > element.clientWidth + 1) {
          problems.push(`horizontal overflow: ${element.tagName}.${element.className}`);
        }
        for (const control of element.querySelectorAll('button')) {
          const box = control.getBoundingClientRect();
          if (box.width && box.height && (box.left < bounds.left - 1 || box.right > bounds.right + 1)) {
            problems.push(`escaped control: ${control.getAttribute('aria-label') || control.textContent}`);
          }
        }
        return problems;
      });
    });
    assert.deepEqual(failures, [], label);
  }

  try {
    await page.locator('.recent button').first().waitFor();
    for (const width of [1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await contained(page, '.welcome, .recent, .recent button', 'Recent repository names and paths stay contained');
    }
    await page.screenshot({ path: path.resolve('test-results/app-overflow-welcome.png') });
    await page.locator('.recent button').first().press('Enter');
    await page.getByRole('button', { name: longText, exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Commit details', exact: true }).click();
    await page.locator('.commit-message pre').filter({ hasText: longText }).waitFor();
    for (const width of [1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await contained(
        page,
        '.commit-message, .statusbar, .topbar, .toolbar, .sidebar',
        'Commit prose, toolbar and status bar stay contained'
      );
    }
    await page.screenshot({ path: path.resolve('test-results/app-overflow-details.png') });
    await page.getByRole('button', { name: '↓ Fetch', exact: true }).click();
    await page.locator('.ui-toast-region').filter({ hasText: 'missing-remote-repository' }).waitFor();
    await contained(page, '.ui-toast-region, .ui-toast-region__toast', 'Long Git errors wrap inside notifications');
    await page.screenshot({ path: path.resolve('test-results/app-overflow-notification.png') });
    for (const close of await page.locator('.ui-toast-region button[aria-label="Dismiss alert"]').all()) {
      await close.click();
    }
    await page.getByRole('tab', { name: 'Command log', exact: true }).click();
    await page.locator('.command-log pre').filter({ hasText: 'missing-remote-repository' }).waitFor();
    await contained(page, '.command-log, .log-entry', 'Commands and Git error output stay contained');
    await page.getByRole('tab', { name: /^Changes/ }).click();
    await page.locator('.diff-heading > span').first().filter({ hasText: relative }).waitFor();
    await page.locator('.diff-line.added').first().waitFor();
    await contained(page, '.diff-heading, .changed-files-scroll', 'History file labels stay contained');
    assert.equal(await page.locator('.diff-heading > span').first().getAttribute('title'), relative);
    assert.ok(
      await page.locator('diff-view').evaluate(element => element.scrollWidth > element.clientWidth),
      'Source diffs remain horizontally scrollable'
    );
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.getByRole('textbox', { name: 'Find a file', exact: true }).fill('Implementation.cs');
    await page.locator('commit-files [title]').filter({ hasText: 'Implementation.cs' }).click();
    await page.locator('.file-content').waitFor();
    await contained(page, 'commit-files ui-tree', 'File tree labels stay contained');

    [commit] = await Promise.all([app.context.waitForEvent('page'), page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(15000);
    await commit.locator('.diff-heading > span').first().filter({ hasText: relative }).waitFor();
    for (const width of [1200, 900]) {
      await commit.setViewportSize({ width, height: 900 });
      for (const density of ['normal', 'compact']) {
        if ((await commit.locator('html').getAttribute('data-density')) !== density) {
          await commit.getByRole('button', { name: 'Toggle density', exact: true }).click();
        }
        await contained(
          commit,
          '.commit-toolbar, .statusbar, .topbar, .diff-heading, .stage-files, .message-composer',
          'Commit paths, branch names and actions stay contained'
        );
      }
    }
    const submit = commit.getByRole('button', { name: `✓ Commit to ${branch}`, exact: true });
    assert.equal(await submit.getAttribute('title'), `Commit to ${branch}`);
    await commit.getByRole('button', { name: 'Show file tree', exact: true }).click();
    await contained(commit, '.stage-files', 'Tree file labels stay contained');
    await commit.screenshot({ path: path.resolve('test-results/app-overflow-commit.png') });
    await commit.getByRole('button', { name: 'Previous messages & templates ▾', exact: true }).press('Enter');
    await contained(commit, '[aria-label="Commit messages and templates"]', 'Long previous messages stay inside the menu');
    await commit.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(
      'PASS: long recent paths, commit prose, errors, notifications, branch labels, status bars, file lists/trees and commit actions; both densities and window sizes; source scrolling preserved.'
    );
  } catch (error) {
    const window = commit && !commit.isClosed() ? commit : page;
    await window.screenshot({ path: path.resolve('test-results/app-overflow-failure.png') });
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
