const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/image-preview-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Image Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.autocrlf', 'false']
  ]) {
    await git(repo, args);
  }
  const svg = (width, color) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="320"><rect x="20" y="20" width="220" height="220" rx="32" fill="${color}"/><circle cx="210" cy="190" r="90" fill="gold" opacity=".65"/></svg>`;
  const old = svg(480, 'teal');
  const current = svg(640, 'royalblue');
  const staged = svg(720, 'purple');
  const working = svg(800, 'tomato');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(repo, 'picture.svg'), old);
  await fs.writeFile(path.join(repo, 'pixel.png'), png);
  await fs.writeFile(path.join(repo, 'deleted.svg'), old);
  await fs.writeFile(path.join(repo, 'note.txt'), 'text before\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Original images']);
  const first = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  await fs.writeFile(path.join(repo, 'picture.svg'), current);
  await fs.unlink(path.join(repo, 'deleted.svg'));
  await fs.writeFile(path.join(repo, 'broken.png'), 'damaged image');
  await fs.writeFile(path.join(repo, 'large.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Update images']);
  await fs.writeFile(path.join(repo, 'picture.svg'), staged);
  await git(repo, ['add', 'picture.svg']);
  await fs.writeFile(path.join(repo, 'picture.svg'), working);
  await fs.writeFile(path.join(repo, 'new.png'), png);
  await fs.writeFile(path.join(repo, 'note.txt'), 'text after\n');
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const errors = [];
  app.page.on('pageerror', error => errors.push(error.message));
  app.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = app.page;
  page.setDefaultTimeout(15000);
  async function dimensions(target, widths) {
    await target.waitForFunction(widths => {
      const images = [...document.querySelectorAll('image-preview img')];
      return images.length === widths.length && images.every((image, index) => image.naturalWidth === widths[index]);
    }, widths);
  }
  async function changed(file) {
    await page.locator(`.file-item[title="${file}"]`).press('Enter');
  }
  let commit;
  try {
    await page.locator('.file-item').first().waitFor();
    await changed('picture.svg');
    await dimensions(page, [480, 640]);
    const splitter = await page.locator('ui-splitter[aria-label="Resize commit history"]').boundingBox();
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y - 200, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.getByRole('button', { name: 'Show full file', exact: true }).count(), 0);
    const zoom = page.getByRole('button', { name: 'Actual size', exact: true }).first();
    await zoom.focus();
    await zoom.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Fit image', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Fit image', exact: true }).press('Space');
    await page.locator('.image-surface').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('diff-view').evaluate(element => {
      element.scrollTop = 0;
    });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve('test-results/image-diff.png') });
    await page.locator('.diff-panel').screenshot({ path: path.resolve('test-results/image-preview.png') });
    await changed('deleted.svg');
    await dimensions(page, [480]);
    assert.match(await page.getByRole('region', { name: 'After image', exact: true }).innerText(), /does not exist/);
    await changed('broken.png');
    await page.getByText('Unable to display this image.', { exact: false }).waitFor();
    await changed('large.png');
    await page.getByText('This image exceeds the 10 MiB preview limit.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Commit files', exact: true });
    await tree.locator('[title="pixel.png"]').click();
    await dimensions(page, [1]);
    await tree.locator('[title="picture.svg"]').click();
    await dimensions(page, [640]);
    await tree.locator('[title="broken.png"]').click();
    await page.getByText('Unable to display this image.', { exact: false }).waitFor();
    await tree.locator('[title="note.txt"]').click();
    await page.locator('.file-content').getByText('text before', { exact: true }).waitFor();
    assert.equal(await page.locator('image-preview').count(), 0);
    await tree.locator('[title="picture.svg"]').click();
    await dimensions(page, [640]);
    await page.locator(`#commit-${first}`).press('Enter');
    await page.getByRole('tree', { name: 'Commit files', exact: true }).locator('[title="picture.svg"]').click();
    await dimensions(page, [480]);
    [commit] = await Promise.all([app.context.waitForEvent('page'), page.getByRole('button', { name: /Commit changes/ }).click()]);
    commit.setDefaultTimeout(15000);
    const lists = commit.locator('change-list');
    await lists.nth(0).locator('.file-item[title="picture.svg"]').press('Enter');
    await dimensions(commit, [720, 800]);
    assert.equal(await commit.getByRole('button', { name: 'Stage selected lines', exact: true }).count(), 0);
    await lists.nth(1).locator('.file-item[title="picture.svg"]').press('Enter');
    await dimensions(commit, [640, 720]);
    await commit.screenshot({ path: path.resolve('test-results/image-staged.png') });
    await lists.nth(0).locator('.file-item[title="new.png"]').press('Enter');
    await dimensions(commit, [1]);
    await commit.getByRole('button', { name: 'Stage new.png', exact: true }).press('Enter');
    await commit.getByRole('button', { name: 'Unstage new.png', exact: true }).waitFor();
    await lists.nth(1).locator('.file-item[title="new.png"]').press('Enter');
    await dimensions(commit, [1]);
    await lists.nth(0).locator('.file-item[title="note.txt"]').press('Enter');
    await commit.locator('.diff-line.added').filter({ hasText: 'text after' }).waitFor();
    assert.equal(await commit.locator('image-preview').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: historical, root, added, deleted, staged and working images; PNG/SVG decoding; keyboard zoom/staging; corrupt/oversized images; switching to text.'
    );
  } catch (error) {
    console.error(
      'Preview diagnostics:',
      await page
        .locator('image-preview')
        .evaluateAll(elements => elements.map(element => ({ label: element.textContent, html: element.innerHTML }))),
      errors
    );
    await page.screenshot({ path: path.resolve('test-results/image-preview-failure.png') });
    if (commit) await commit.screenshot({ path: path.resolve('test-results/image-commit-failure.png') });
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
