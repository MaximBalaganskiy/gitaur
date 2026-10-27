import type { Commit } from '../interfaces/commit';

export class CommitSelectionHistory {
  private commits: Commit[] = [];
  private index = -1;

  get canGoBack() {
    return this.index > 0;
  }

  get canGoForward() {
    return this.index + 1 < this.commits.length;
  }

  visit(commit: Commit) {
    if (this.commits[this.index]?.hash === commit.hash) {
      this.commits[this.index] = commit;
      return;
    }

    this.commits.splice(this.index + 1);
    this.commits.push(commit);
    this.index = this.commits.length - 1;
  }

  move(direction: -1 | 1) {
    const index = this.index + direction;
    if (index < 0 || index >= this.commits.length) {
      return null;
    }

    this.index = index;
    return this.commits[index];
  }
}
