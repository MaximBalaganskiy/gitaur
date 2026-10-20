const { launchTauri } = require('./support/launch-tauri.cjs');
const { git } = require('./support/git.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = await fs.mkdtemp(path.resolve('../.test-repos/resolver-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Merge Test'],
    ['user.email', 'merge@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false']
  ]) {
    await git(repo, ['config', key, value]);
  }
  const file = path.join(repo, 'sample.ts');
  const separator = Array.from({ length: 80 }, (_, index) => `// context ${index}\r\n`).join('');
  const base = `const first = "base";\r\n${separator}const last = "base";\r\n${separator.replaceAll('context', 'tail context')}// tail\r\n`;
  await fs.writeFile(file, base);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Base']);
  await git(repo, ['switch', '-c', 'feature']);
  const theirs = base
    .replaceAll('"base"', '"theirs"')
    .replace('const last = "theirs";\r\n', 'const last = "theirs";\r\nconst extra = 1;\r\nconst more = 2;\r\n')
    .replace('// tail\r\n', '// automatic merge\r\n')
    .replace('// context 30\r\n', '// inserted A\r\n// inserted B\r\n// context 30\r\n');
  await fs.writeFile(file, theirs);
  await git(repo, ['commit', '-am', 'Theirs']);
  await git(repo, ['switch', 'main']);
  const ours = base.replaceAll('"base"', '"ours"');
  await fs.writeFile(file, ours);
  await git(repo, ['commit', '-am', 'Ours']);
  await git(repo, ['merge', 'feature']).catch(() => {});
  const conflicted = await fs.readFile(file, 'utf8');
  assert.ok(conflicted.includes('<<<<<<<'));
  const app = await launchTauri(repo, path.join(root, 'profile'));
  const errors = [];
  app.context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const [commit] = await Promise.all([
      app.context.waitForEvent('page'),
      app.page.getByRole('button', { name: /Commit changes/ }).click()
    ]);
    commit.setDefaultTimeout(15000);
    await commit.getByRole('button', { name: 'Resolve conflict…', exact: true }).click();
    const dialog = commit.getByRole('dialog');
    const result = dialog.getByRole('textbox', { name: 'Resolved content', exact: true });
    const assertAligned = async labels => {
      await commit.waitForFunction(expected => {
        const panes = [...document.querySelectorAll('.merge-panes .cm-scroller')];
        return expected.every(text => {
          const tops = panes.map(pane => {
            const line = [...pane.querySelectorAll('.cm-line')].find(line => line.textContent === text);
            return line ? line.getBoundingClientRect().top - pane.getBoundingClientRect().top : null;
          });
          return tops.length === 3 && tops.every(top => top !== null && Math.abs(top - tops[0]) < 1);
        });
      }, labels);
    };
    await result.waitFor();
    await dialog.getByText('Conflict 1 of 2 remaining', { exact: true }).waitFor();
    await result.press('Control+f');
    await dialog.getByRole('textbox', { name: 'Find in result', exact: true }).fill('[');
    await dialog.getByRole('checkbox', { name: 'Regex', exact: true }).first().click();
    await dialog.getByRole('button', { name: 'Next match', exact: true }).click();
    await dialog.getByText('Invalid regular expression', { exact: true }).waitFor();
    await dialog.getByRole('checkbox', { name: 'Regex', exact: true }).first().click();
    await dialog.getByRole('textbox', { name: 'Find in result', exact: true }).fill('context 12');
    await dialog.getByRole('textbox', { name: 'Replace with', exact: true }).fill('search replacement');
    await dialog.getByRole('button', { name: 'Replace all', exact: true }).click();
    await result.press('Escape');
    await result.press('Control+z');
    await result.press('Control+Home');
    await dialog.getByRole('button', { name: 'Word wrap', exact: true }).click();
    assert.equal(await dialog.locator('.merge-result .cm-lineWrapping').count(), 1);
    await dialog.getByRole('button', { name: 'Word wrap', exact: true }).click();
    await dialog.getByRole('button', { name: 'Accept ours for conflict 1', exact: true }).click();
    await dialog.getByText('Conflict 1 of 1 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await dialog.getByText('Conflict 1 of 2 remaining', { exact: true }).waitFor();
    assert.ok(!(await result.innerText()).includes('<<<<<<<'), 'The result should contain code, not Git markers');
    assert.ok(
      (await dialog.getByRole('textbox', { name: 'Ours', exact: true }).innerText()).includes('// context'),
      'Source panes must show surrounding code'
    );
    await dialog.locator('.merge-word-difference').first().waitFor();
    // Source panes cannot be edited, even through keyboard commands.
    const oursEditor = dialog.getByRole('textbox', { name: 'Ours', exact: true });
    await oursEditor.focus();
    await commit.keyboard.press('Control+a');
    await commit.keyboard.press('Backspace');
    await commit.evaluate(() => {
      document.addEventListener(
        'copy',
        event => {
          window.copiedSource = event.clipboardData.getData('text/plain');
        },
        { once: true }
      );
    });
    // Copy the full selection: rendered DOM lines change as CodeMirror virtualizes the viewport.
    await oursEditor.press('Control+a');
    await oursEditor.press('Control+c');
    await commit.waitForFunction(() => window.copiedSource !== undefined);
    assert.equal((await commit.evaluate(() => window.copiedSource)).replaceAll('\r\n', '\n'), ours.replaceAll('\r\n', '\n'));
    await oursEditor.press('Control+Home');
    await result.focus();
    await commit.keyboard.press('Control+Home');
    // Follow corresponding lines through source-only/automatically merged insertions.
    const scroller = dialog.locator('.merge-result .cm-scroller');
    await scroller.evaluate(element => {
      element.scrollTop = 500;
    });
    await assertAligned(['// context 28', '// context 32']);
    await dialog.locator('.merge-side .merge-spacer').first().waitFor({ state: 'attached' });
    await commit.screenshot({ path: path.resolve('test-results/merge-alignment.png') });
    await scroller.evaluate(element => {
      element.scrollTop = 1050;
    });
    await commit.waitForFunction(() => {
      const panes = [...document.querySelectorAll('.merge-panes .cm-scroller')];
      const lines = panes.map(pane => {
        const top = pane.getBoundingClientRect().top;
        return [...pane.querySelectorAll('.cm-line')].find(line => line.getBoundingClientRect().top >= top)?.textContent;
      });
      return lines.length === 3 && lines[0]?.includes('// context') && lines.every(line => line === lines[0]);
    });
    await dialog.getByRole('button', { name: 'Sync scrolling', exact: true }).click();
    const beforeScroll = await dialog
      .locator('.merge-side .cm-scroller')
      .first()
      .evaluate(element => element.scrollTop);
    await scroller.evaluate(element => {
      element.scrollTop += 250;
    });
    await commit.waitForTimeout(150);
    assert.equal(
      await dialog
        .locator('.merge-side .cm-scroller')
        .first()
        .evaluate(element => element.scrollTop),
      beforeScroll
    );
    await dialog.getByRole('button', { name: 'Sync scrolling', exact: true }).click();
    await result.press('Control+Home');
    const splitter = dialog.getByRole('separator', { name: 'Resize ours pane', exact: true });
    const width = await dialog
      .locator('.merge-side')
      .first()
      .evaluate(element => element.getBoundingClientRect().width);
    await splitter.focus();
    await commit.keyboard.press('ArrowRight');
    assert.ok(
      (await dialog
        .locator('.merge-side')
        .first()
        .evaluate(element => element.getBoundingClientRect().width)) > width
    );
    await dialog.getByRole('button', { name: 'Common ancestor', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Common ancestor', exact: true }).waitFor();
    assert.equal(
      await dialog
        .locator('.cm-gutters')
        .first()
        .evaluate(element => getComputedStyle(element).backgroundColor),
      'rgb(30, 30, 30)'
    );
    await commit.screenshot({ path: path.resolve('test-results/internal-resolver-conflicts.png') });
    await app.page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
    await commit.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(
      await dialog
        .locator('.cm-gutters')
        .first()
        .evaluate(element => getComputedStyle(element).backgroundColor),
      'rgb(255, 255, 255)'
    );
    await commit.screenshot({ path: path.resolve('test-results/internal-resolver-light.png') });
    await app.page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
    await commit.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.ok((await dialog.getByRole('textbox', { name: 'Common ancestor', exact: true }).innerText()).includes('"base"'));
    assert.ok(await result.locator('span').count(), 'Result should have syntax tokens');
    await dialog.getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await dialog
      .getByRole('alert')
      .getByText(/Resolve each conflict before saving/)
      .waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), conflicted);
    await result.focus();
    await commit.keyboard.press('F7');
    await dialog.getByText('Conflict 2 of 2 remaining', { exact: true }).waitFor();
    await assertAligned(['// tail context 0', '// tail context 3']);
    await commit.keyboard.press('Shift+F7');
    await dialog.getByText('Conflict 1 of 2 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Accept ours', exact: true }).click();
    await dialog.getByText('Conflict 1 of 1 remaining', { exact: true }).waitFor();
    await dialog.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(file, 'utf8'), conflicted, 'Choices must not write the working file');
    await commit.keyboard.press('Control+z');
    await dialog.getByText('Conflict 1 of 2 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Redo', exact: true }).click();
    await dialog.getByText('Conflict 1 of 1 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Both: theirs first', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await dialog.getByText('Conflict 1 of 1 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Both: ours first', exact: true }).click();
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await dialog.getByRole('button', { name: 'Accept theirs', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await result.press('Escape');
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await result.focus();
    await commit.keyboard.press('Control+End');
    await commit.keyboard.insertText('// reviewed\n');
    // Editing outside the first region must survive changing that earlier decision.
    await result.press('Control+Home');
    await result.press('ArrowDown');
    await result.press('Home');
    await commit.keyboard.insertText('// keep boundary edit\n');
    await dialog.getByRole('button', { name: 'Review conflict', exact: true }).click();
    await dialog.getByRole('option', { name: 'Conflict 1 · Resolved', exact: true }).click();
    await dialog.getByRole('button', { name: 'Accept theirs', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    assert.ok((await result.innerText()).includes('// keep boundary edit'));
    await dialog.getByRole('button', { name: 'Reopen conflict', exact: true }).click();
    await dialog.getByText('Conflict 1 of 1 remaining', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await dialog
      .getByRole('alert')
      .getByText(/Resolve each conflict before saving/)
      .waitFor();
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Reopen conflict', exact: true }).click();
    await dialog.getByRole('button', { name: 'Accept ours', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    await commit.screenshot({ path: path.resolve('test-results/merge-revisited.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save draft and close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await commit.getByRole('button', { name: 'Resolve conflict…', exact: true }).click();
    await dialog.getByRole('button', { name: 'Restore draft', exact: true }).click();
    await dialog.getByText('All conflicts resolved — review the result', { exact: true }).waitFor();
    await result.press('Control+End');
    await commit.screenshot({ path: path.resolve('test-results/internal-resolver.png') });
    // Explicit decisions must not bypass Git's marker check after a manual edit.
    await commit.keyboard.insertText('<<<<<<< manual\n');
    await dialog.getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await dialog.getByRole('alert').getByText('Remove conflict markers before marking the file resolved.', { exact: true }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), conflicted);
    await result.press('Control+z');
    // Typing may be grouped into one history event; restore the intended comment explicitly.
    await result.press('Control+End');
    const text = await result.innerText();
    if (!text.includes('// reviewed')) {
      await commit.keyboard.insertText('// reviewed\n');
    }
    // Stale working files must not be overwritten, including a partially resolved draft.
    await fs.writeFile(file, 'External edit\r\n');
    await dialog.getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await dialog
      .getByRole('alert')
      .getByText(/file changed outside this editor/)
      .waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), 'External edit\r\n');
    await fs.writeFile(file, conflicted);
    await dialog.getByRole('button', { name: 'Save result and stage', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const expected =
      theirs.replace('const first = "theirs";\r\n', 'const first = "ours";\r\n// keep boundary edit\r\n') + '// reviewed\r\n';
    assert.equal(await fs.readFile(file, 'utf8'), expected);
    assert.equal((await git(repo, ['show', ':sample.ts'])).stdout, expected);
    assert.equal((await git(repo, ['ls-files', '-u'])).stdout, '');
    assert.deepEqual(errors, []);
    console.log(
      'PASS: full-file merge panes, inline differences, synchronized scrolling, resizing, read-only sources, both themes, conflict choices, undo/redo, keyboard navigation, draft protection, stale-file rejection and CRLF preservation.'
    );
  } catch (error) {
    for (const [index, page] of app.context.pages().entries()) {
      await page.screenshot({ path: path.resolve(`test-results/merge-editor-failure-${index}.png`) }).catch(() => {});
    }
    console.error('Desktop page errors:', errors);
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
