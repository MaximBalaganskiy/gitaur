import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, newestRelease } from '../src/services/release-version';

test('release ordering follows semantic versions including numeric prerelease identifiers', () => {
  for (const [older, newer] of [
    ['0.4.0-beta.6', '0.4.0-beta.10'],
    ['0.4.0-beta.10', '0.4.0'],
    ['0.4.9', '0.4.10'],
    ['0.4.10', '0.5.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-1', '1.0.0-alpha']
  ]) {
    assert.equal(compareVersions(newer, older), 1);
    assert.equal(compareVersions(older, newer), -1);
  }
  assert.equal(compareVersions('v1.0.0+build', '1.0.0'), 0);
  assert.equal(compareVersions('invalid', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0-beta.01', '1.0.0'), null);
});

test('release selection ignores drafts, malformed versions and older releases and respects channels', () => {
  const release = (tag_name: string, prerelease = false, draft = false) => ({ tag_name, prerelease, draft });
  const releases = [
    release('v0.5.0-beta.2', true),
    release('v0.4.0'),
    release('v9.0.0', false, true),
    release('not-a-version'),
    release('v0.4.0-beta.10', true),
    release('v0.3.0')
  ];
  assert.equal(newestRelease(releases, '0.4.0-beta.6'), '0.5.0-beta.2');
  assert.equal(newestRelease(releases, '0.3.0'), '0.4.0');
  assert.equal(newestRelease(releases, '0.4.0'), null);
  assert.equal(newestRelease(null, '0.4.0'), null);
  assert.equal(newestRelease([null, {}, release('v0.4.0')], '0.4.0-beta.6'), '0.4.0');
});
