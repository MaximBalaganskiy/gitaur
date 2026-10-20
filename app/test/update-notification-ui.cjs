const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchTauri } = require('./support/launch-tauri.cjs');

(async () => {
  const root = path.resolve('../.test-repos');
  await fs.mkdir(root, { recursive: true });
  const profile = await fs.mkdtemp(path.join(root, 'update-profile-'));
  let app = await launchTauri('', profile);
  try {
    let page = app.page;
    page.setDefaultTimeout(15000);
    await page.locator('.app-name').waitFor();
    const instrument = () => {
      const original = window.fetch;
      const interval = window.setInterval;
      window.setInterval = (handler, duration, ...args) => {
        if (duration === 6 * 60 * 60 * 1000) {
          window.checkForUpdate = handler;
        }
        return interval(handler, duration, ...args);
      };
      window.releaseCalls = 0;
      window.fetch = (resource, options) => {
        if (String(resource).startsWith('https://api.github.com/repos/MaximBalaganskiy/gitaur/releases')) {
          const fixture = sessionStorage.getItem('release-fixture') || '99.0.0';
          window.releaseChecked = true;
          if (fixture === 'offline') {
            return Promise.reject(new TypeError('Offline'));
          }
          return Promise.resolve(new Response(JSON.stringify([{ tag_name: `v${fixture}`, draft: false, prerelease: false }])));
        }
        if (resource === window.__TAURI_INTERNALS__.convertFileSrc('open_release', 'ipc')) {
          window.releaseCalls++;
          window.releaseBody = JSON.parse(options.body);
          return Promise.resolve(
            new Response(JSON.stringify('Browser unavailable'), {
              headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'error' }
            })
          );
        }
        return original.call(window, resource, options);
      };
    };
    await page.addInitScript(instrument);
    await page.reload();
    const notice = page.getByText('Update available', { exact: true });
    await notice.waitFor();
    await page.getByRole('button', { name: 'Dismiss alert', exact: true }).focus();
    await page.keyboard.press('Enter');
    await notice.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => localStorage.getItem('branchlight-notified-release')), '99.0.0');
    await page.reload();
    await page.waitForFunction(() => window.releaseChecked);
    await page.waitForTimeout(500);
    assert.equal(await notice.count(), 0);
    await app.close();
    app = await launchTauri('', profile);
    page = app.page;
    page.setDefaultTimeout(15000);
    await page.locator('.app-name').waitFor();
    await page.addInitScript(instrument);
    await page.reload();
    await page.waitForFunction(() => window.releaseChecked);
    await page.waitForTimeout(500);
    assert.equal(await page.getByText('Update available', { exact: true }).count(), 0);
    await page.evaluate(() => sessionStorage.setItem('release-fixture', '99.0.1'));
    await page.evaluate(() => window.checkForUpdate());
    await page.getByText('Update available', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'View release', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.getByText('Could not open the release: Browser unavailable', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.releaseCalls), 1);
    assert.equal(await page.evaluate(() => window.releaseBody.version), '99.0.1');
    await page.evaluate(() => sessionStorage.setItem('release-fixture', 'offline'));
    await page.reload();
    await page.waitForFunction(() => window.releaseChecked);
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('region', { name: 'Notifications' }).count(), 0);
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await page.evaluate(() => sessionStorage.setItem('release-fixture', '99.0.2'));
    await page.reload();
    await page.getByText('Update available', { exact: true }).waitFor();
    await page.screenshot({ path: path.resolve('test-results/update-notification.png') });
    console.log('Desktop update notice: keyboard dismissal/action, persisted silence, newer version and offline path passed.');
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
