import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitSelectionHistory } from '../src/services/commit-selection-history';

const commit = (hash: string) => ({ hash, parents: [], subject: hash, author: '', date: '', refs: [] });

test('selection history follows visits rather than graph order and stops at both ends', () => {
  const history = new CommitSelectionHistory();
  assert.equal(history.move(-1), null);
  assert.equal(history.move(1), null);
  for (const hash of ['newest', 'oldest', 'middle']) {
    history.visit(commit(hash));
  }
  assert.equal(history.move(-1)?.hash, 'oldest');
  assert.equal(history.move(-1)?.hash, 'newest');
  assert.equal(history.move(-1), null);
  assert.equal(history.move(1)?.hash, 'oldest');
  assert.equal(history.move(1)?.hash, 'middle');
  assert.equal(history.move(1), null);
});

test('refreshing or selecting the same commit preserves the forward path without duplicates', () => {
  const history = new CommitSelectionHistory();
  history.visit(commit('a'));
  history.visit(commit('b'));
  history.move(-1);
  history.visit({ ...commit('a'), subject: 'Refreshed' });
  assert.equal(history.move(-1), null);
  assert.equal(history.move(1)?.hash, 'b');
  assert.equal(history.move(-1)?.subject, 'Refreshed');
});

test('a new selection after going back replaces the forward path', () => {
  const history = new CommitSelectionHistory();
  for (const hash of ['a', 'b', 'c']) {
    history.visit(commit(hash));
  }
  history.move(-1);
  history.visit(commit('d'));
  assert.equal(history.move(1), null);
  assert.equal(history.move(-1)?.hash, 'b');
  assert.equal(history.move(-1)?.hash, 'a');
  assert.equal(history.move(1)?.hash, 'b');
  assert.equal(history.move(1)?.hash, 'd');
});
