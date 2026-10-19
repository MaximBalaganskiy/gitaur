const { launchTauri } = require('./support/launch-tauri.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { git } = require('./support/git.cjs');
const { version } = require('../package.json');
(async () => {
  const output = path.resolve('test-results');
  await fs.mkdir(output, { recursive: true });
  const root = path.resolve('../.test-repos');
  await fs.mkdir(root, { recursive: true });
  const repo = await fs.mkdtemp(path.join(root, 'ui-test-'));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Gitaur Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repo, 'README.md'), '# A clear history\n\nStart here.\n');
  await git(repo, ['add', '--', 'README.md']);
  await git(repo, ['commit', '-m', 'Start the workspace']);
  await git(repo, ['switch', '-c', 'feature/graph']);
  await fs.writeFile(path.join(repo, 'graph.ts'), 'export const lanes = 3;\n');
  await git(repo, ['add', '--', 'graph.ts']);
  await git(repo, ['commit', '-m', 'Draw branch lanes in the history view']);
  await git(repo, ['switch', 'main']);
  await fs.writeFile(path.join(repo, 'theme.css'), ':root { color-scheme: dark; }\n');
  await git(repo, ['add', '--', 'theme.css']);
  await git(repo, ['commit', '-m', 'Add the workspace theme']);
  await git(repo, ['merge', '--no-ff', 'feature/graph', '-m', 'Merge the graph workspace']);
  await fs.writeFile(path.join(repo, 'README.md'), '# A clear history\n\nStage only what matters.\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'Keep this change for later.\n');
  const profile = await fs.mkdtemp(path.join(root, 'tauri-profile-'));
  let app;
  const errors = [];
  try {
    const started = performance.now();
    app = await launchTauri(repo, profile);
    const page = app.page;
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error') console.log('Renderer:', m.text());
    });
    await page.locator('.commit-row').first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.app-name').innerText(), 'Gitaur');
    assert.equal(await page.locator('.app-version').innerText(), `v${version}`);
    const projectLink = page.getByRole('button', { name: 'Open Gitaur on GitHub', exact: true });
    assert.equal(await projectLink.locator('svg path').count(), 1);
    const appUrl = page.url();
    await page.evaluate(() => {
      const original = window.fetch;
      const endpoint = window.__TAURI_INTERNALS__.convertFileSrc('open_project_repository', 'ipc');
      window.projectLinkProbe = { original, calls: 0, fail: true };
      window.fetch = (resource, options) => {
        if (resource === endpoint) {
          window.projectLinkProbe.calls++;
          return Promise.resolve(
            new Response(JSON.stringify(window.projectLinkProbe.fail ? 'Browser unavailable' : null), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': window.projectLinkProbe.fail ? 'error' : 'ok' }
            })
          );
        }
        return original.call(window, resource, options);
      };
    });
    try {
      await projectLink.focus();
      await projectLink.press('Enter');
      await page.getByText('Could not open GitHub: Browser unavailable', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.projectLinkProbe.calls), 1);
      assert.equal(page.url(), appUrl);
      await page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Dismiss' }).click();
      await page.evaluate(() => {
        window.projectLinkProbe.fail = false;
      });
      await projectLink.focus();
      await projectLink.press('Space');
      assert.equal(await page.evaluate(() => window.projectLinkProbe.calls), 2);
      assert.equal(page.url(), appUrl);
    } finally {
      await page.evaluate(() => {
        window.fetch = window.projectLinkProbe.original;
        delete window.projectLinkProbe;
      });
    }
    assert.match(await page.title(), /Gitaur/);
    assert.ok(await page.locator('.topbar img').evaluate(image => image.complete && image.naturalWidth > 0));
    console.log(`Launch to rendered history: ${Math.round(performance.now() - started)} ms`);
    assert.equal(await page.locator('.commit-row').count(), 4);
    assert.equal(await page.locator('.graph circle').count(), 4);
    assert.equal(await page.locator('html').getAttribute('data-density'), 'normal');
    assert.equal((await page.locator('.commit-row').first().boundingBox()).height, 34);
    assert.equal(await page.locator('.working-row').count(), 0);
    assert.equal(await page.locator('ui-tabs').evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    const referenceTree = page.getByRole('tree', { name: 'Repository references', exact: true });
    const featureFolder = referenceTree.getByRole('treeitem').filter({ has: page.locator('.branch-name', { hasText: /^feature$/ }) });
    const graphBranch = referenceTree.getByRole('treeitem').filter({ has: page.locator('[title="feature/graph"]') });
    assert.equal(await graphBranch.getAttribute('aria-level'), '3');
    await featureFolder.click();
    assert.equal(await graphBranch.count(), 0);
    await featureFolder.press('ArrowRight');
    await graphBranch.waitFor();
    await featureFolder.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.locator('.commit-row.selected').filter({ hasText: 'Draw branch lanes' }).waitFor();
    await featureFolder.click();
    await git(repo, ['branch', 'feat/auth/login']);
    await git(repo, ['branch', 'feat/search']);
    await git(repo, ['update-ref', 'refs/remotes/origin/feat/auth/login', 'HEAD']);
    await page.keyboard.press('F5');
    await referenceTree.locator('[title="feat/auth/login"]').first().waitFor();
    assert.equal(await featureFolder.getAttribute('aria-expanded'), 'false');
    const branchSearch = page.getByRole('textbox', { name: 'Find a branch', exact: true });
    await branchSearch.fill('feature/graph');
    await graphBranch.waitFor();
    await branchSearch.fill('no-such-branch');
    await page.getByText('No matching branches or tags', { exact: true }).waitFor();
    await branchSearch.fill('');
    await featureFolder.waitFor();
    assert.equal(await featureFolder.getAttribute('aria-expanded'), 'false');
    await featureFolder.click();
    await graphBranch.waitFor();
    await page.screenshot({ path: path.join(output, 'branch-tree.png'), animations: 'disabled' });
    const selectedBeforeCheckout = await page.locator('.commit-row.selected').getAttribute('id');
    const checkoutSearch = page.getByRole('button', { name: 'Switch to feat/search', exact: true });
    await checkoutSearch.focus();
    await checkoutSearch.press('Enter');
    await page.getByText('Commit or stash your changes before switching branches.', { exact: true }).waitFor();
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'main');
    await page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Dismiss' }).click();
    await fs.writeFile(path.join(repo, 'README.md'), '# A clear history\n\nStart here.\n');
    await fs.unlink(path.join(repo, 'notes.txt'));
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout.trim(), '');
    await page.keyboard.press('F5');
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('0 changes'));
    await checkoutSearch.focus();
    await checkoutSearch.press('Enter');
    await page
      .locator('.branch-pill')
      .filter({ hasText: /^feat\/search$/ })
      .waitFor();
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'feat/search');
    assert.equal(await page.locator('.commit-row.selected').getAttribute('id'), selectedBeforeCheckout);
    await page.getByRole('button', { name: 'Switch to main', exact: true }).click();
    await page
      .locator('.branch-pill')
      .filter({ hasText: /^main$/ })
      .waitFor();
    await fs.writeFile(path.join(repo, 'README.md'), '# A clear history\n\nStage only what matters.\n');
    await fs.writeFile(path.join(repo, 'notes.txt'), 'Keep this change for later.\n');
    await page.keyboard.press('F5');
    await page.getByRole('button', { name: 'Commit changes 2' }).waitFor();
    const branchHeights = await page
      .locator('.branch-item')
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.equal(new Set(branchHeights).size, 1);
    const row = page.locator('.commit-row').first();
    const rowBounds = await row.boundingBox();
    await row.hover();
    await page.mouse.down();
    assert.equal(await row.evaluate(element => getComputedStyle(element).transform), 'none');
    assert.deepEqual(await row.boundingBox(), rowBounds);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Toggle density', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.graph').getAttribute('height') === '26');
    assert.equal((await row.boundingBox()).height, 26);
    await page.getByRole('button', { name: 'Toggle density', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.graph').getAttribute('height') === '34');
    await page.getByRole('button', { name: 'Draw branch lanes in the history view', exact: true }).click();
    await page.locator('.diff-code').getByText('+export const lanes = 3;', { exact: true }).waitFor();
    assert.ok(await page.locator('.diff-code .hljs-keyword').count());
    assert.equal(await page.locator('.ui-input').count(), 3);
    assert.equal(await page.locator('.ui-input[data-inset]').count(), 3);
    assert.equal(await page.getByRole('textbox', { name: 'Search commits' }).count(), 1);
    assert.equal(await page.getByRole('textbox', { name: 'Find changed files', exact: true }).count(), 1);
    const sidebarWidth = (await page.locator('repository-sidebar').boundingBox()).width;
    await page.getByRole('separator', { name: 'Resize branches sidebar' }).press('ArrowRight');
    assert.ok((await page.locator('repository-sidebar').boundingBox()).width > sidebarWidth);
    await page.getByRole('button', { name: '⑂ New branch', exact: true }).click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.locator('.ui-input[data-inset]').count(), 1);
    await dialog.getByRole('textbox', { name: 'Branch name' }).fill('invalid branch name');
    await dialog.getByRole('button', { name: 'Create branch', exact: true }).click();
    await dialog.locator('.ui-input__error').filter({ hasText: 'must not contain spaces' }).waitFor();
    assert.equal(await dialog.getByRole('textbox', { name: 'Branch name' }).getAttribute('aria-invalid'), 'true');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Add remote', exact: true }).click();
    const remotes = page.getByRole('dialog');
    await remotes.getByRole('textbox', { name: 'Remote name', exact: true }).fill('origin');
    await remotes.getByRole('textbox', { name: 'Remote URL', exact: true }).fill('https://example.invalid/first.git');
    await remotes.getByRole('button', { name: 'Create remote', exact: true }).click();
    await remotes.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Actions for remote origin', exact: true }).click();
    await page.getByRole('option', { name: 'Edit remote…', exact: true }).click();
    await remotes.getByRole('textbox', { name: 'Remote URL', exact: true }).fill('https://example.invalid/second.git');
    await remotes.getByRole('button', { name: 'Save remote', exact: true }).click();
    await remotes.waitFor({ state: 'hidden' });
    assert.equal((await git(repo, ['remote', 'get-url', 'origin'])).stdout.trim(), 'https://example.invalid/second.git');
    await page.getByRole('tab', { name: 'Commit details', exact: true }).click();
    await page.getByRole('tab', { name: 'Commit details', exact: true }).press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Command log', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: /^Changes/ }).click();
    await page.getByRole('button', { name: 'Merge the graph workspace', exact: true }).click();
    await page.locator('.diff-code').getByText('+export const lanes = 3;', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'history.png'), animations: 'disabled' });
    const [commit] = await Promise.all([app.context.waitForEvent('page'), page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(10000);
    commit.on('pageerror', e => errors.push(e.message));
    await commit.getByRole('button', { name: 'Stage README.md', exact: true }).waitFor();
    assert.equal(await commit.locator('.app-name').innerText(), 'Commit — Gitaur');
    assert.ok(await commit.locator('.topbar img').evaluate(image => image.complete && image.naturalWidth > 0));
    const layoutBeforeToast = await commit.locator('.commit-workspace').boundingBox();
    await commit.getByRole('button', { name: 'Stage README.md', exact: true }).click();
    await commit.getByRole('button', { name: 'Unstage README.md', exact: true }).waitFor();
    await commit.getByRole('region', { name: 'Notifications' }).waitFor();
    assert.deepEqual(await commit.locator('.commit-workspace').boundingBox(), layoutBeforeToast);
    assert.equal(await commit.locator('.ui-input[data-textarea]').count(), 1);
    assert.equal(await commit.locator('.ui-input[data-textarea][data-inset]').count(), 1);
    await commit.locator('#commit-message').fill('Refine the getting started guide');
    await commit.screenshot({ path: path.join(output, 'commit.png'), animations: 'disabled' });
    await Promise.all([commit.waitForEvent('close'), commit.getByRole('button', { name: '✓ Commit to main', exact: true }).click()]);
    await page.getByRole('button', { name: 'Refine the getting started guide', exact: true }).waitFor();
    assert.equal((await git(repo, ['log', '-1', '--format=%s'])).stdout.trim(), 'Refine the getting started guide');
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout.trim(), '?? notes.txt');
    await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'history-light.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    await page.evaluate(async directory => {
      await window.__TAURI_INTERNALS__.invoke('open_repository', { directory });
      await window.__TAURI_INTERNALS__.invoke('open_repository', { directory });
    }, repo);
    await app.close();
    app = undefined;
    app = await launchTauri('', profile);
    await app.page.getByRole('heading', { name: 'Open a repository', exact: true }).waitFor();
    await app.page
      .locator('.recent button')
      .filter({ hasText: path.basename(repo) })
      .click();
    await app.page.getByRole('button', { name: 'Refine the getting started guide', exact: true }).waitFor();
    assert.equal(await app.page.locator('.commit-row').count(), 5);
    const rootCommit = (await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim();
    await git(repo, ['branch', 'older-tip', rootCommit]);
    const tree = (await git(repo, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    let tip = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    for (let index = 0; index < 320; index++) {
      tip = (await git(repo, ['commit-tree', tree, '-p', tip, '-m', `Recent commit ${index}`])).stdout.trim();
    }
    await git(repo, ['update-ref', 'refs/heads/main', tip]);
    await app.page.keyboard.press('F5');
    await app.page.waitForFunction(() => document.querySelectorAll('.commit-row').length === 300);
    await app.page.locator('.branch-name').filter({ hasText: 'older-tip' }).click();
    const selectedTip = app.page.locator('.commit-row.selected').filter({ hasText: 'Start the workspace' });
    await selectedTip.waitFor();
    await app.page.waitForFunction(() => {
      const row = document.querySelector('.commit-row.selected').getBoundingClientRect();
      const scroll = document.querySelector('.history-scroll').getBoundingClientRect();
      return row.top >= scroll.top - 1 && row.bottom <= scroll.bottom + 1;
    });
    assert.equal(await app.page.locator('.commit-row').count(), 325);
    await app.page.getByRole('button', { name: 'Toggle density', exact: true }).click();
    await app.page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
    assert.equal(await app.page.evaluate(() => localStorage.getItem('branchlight-density')), 'compact');
    await app.page.reload();
    await app.page.locator('.commit-row').first().waitFor();
    assert.equal(await app.page.locator('html').getAttribute('data-density'), 'compact');
    console.log(
      'PASS: app version, GitHub link keyboard/error handling, branch tree grouping, search, expansion state, keyboard selection/checkout, desktop Git workflow, stable row heights, inset labels, borderless tabs, persistent density, and automatic branch-tip navigation.'
    );
    console.log('Screenshots:', output);
  } catch (error) {
    console.log('Renderer errors:', errors);
    if (app)
      for (const [index, page] of app.context.pages().entries()) {
        console.log('Window', index, (await page.locator('body').innerText()).slice(-8000));
        await page.screenshot({ path: path.join(output, `failure-${index}.png`) });
      }
    throw error;
  } finally {
    if (app) await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
