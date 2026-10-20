import { resolve } from 'aurelia';
import { isTauri } from '@tauri-apps/api/core';
import { UiToastService } from '@aurelia-ui-toolkits/headless';
import type { Snapshot } from '../interfaces/snapshot';
import { TauriGitClient } from './tauri-git-client';

export class WorkspaceService {
  readonly client = resolve(TauriGitClient);
  private toasts = resolve(UiToastService);
  private listeners = new Set<() => void>();
  private generation = 0;
  private signature = '';
  private unsubscribe?: () => void;

  mode: 'browse' | 'commit' = 'browse';
  repo = '';
  recent: string[] = [];
  snapshot: Snapshot | null = null;
  initializing = true;
  busy = false;
  refreshing = false;
  limit = 300;
  lastError = '';

  get canLoadMore() {
    return !!this.snapshot?.hasMore && this.limit < 100000;
  }

  get splitterStoragePrefix() {
    return `branchlight:${encodeURIComponent(this.repo.replaceAll('\\', '/'))}`;
  }

  async initialize() {
    if (!isTauri()) {
      this.fail(new Error('Launch the desktop app to access local repositories.'));
      this.initializing = false;
      return;
    }

    try {
      const initial = await this.client.bootstrap();
      this.mode = initial.mode;
      this.repo = initial.repo;
      this.recent = initial.recent;
      this.unsubscribe = await this.client.onChanged(() => {
        if (!this.busy) {
          void this.refresh();
        }
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.initializing = false;
    }
  }

  dispose() {
    this.unsubscribe?.();
    this.listeners.clear();
    this.toasts.clear();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async open(directory?: string) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.lastError = '';
    try {
      const repo = await this.client.open(directory);
      if (!repo) {
        return;
      }

      this.snapshot = null;
      this.repo = repo;
      this.signature = '';
      this.limit = 300;
      await this.refresh();
      this.recent = (await this.client.bootstrap()).recent;
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  async refresh() {
    if (!this.repo) {
      return;
    }

    const generation = ++this.generation;
    this.refreshing = true;
    try {
      const snapshot = await this.client.snapshot(this.limit);
      if (generation !== this.generation) {
        return;
      }

      const signature = JSON.stringify(snapshot);
      if (signature !== this.signature) {
        this.signature = signature;
        this.snapshot = snapshot;
      }

      for (const listener of this.listeners) {
        listener();
      }
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.fail(error);
      }
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
      }
    }
  }

  async loadMore(expand = false) {
    this.limit = Math.min(expand ? this.limit * 2 : this.limit + 300, 100000);
    return this.refresh();
  }

  async openCommit() {
    try {
      await this.client.openCommit();
    } catch (error) {
      this.fail(error);
    }
  }

  async action(action: string, payload: Record<string, unknown> = {}, notifyErrors = true) {
    if (this.busy) {
      return false;
    }

    this.busy = true;
    this.lastError = '';
    try {
      await this.client.mutate(action, payload);
      await this.refresh();
      const messages: Record<string, string> = {
        stage: 'Changes staged',
        unstage: 'Changes unstaged',
        commit: 'Commit created',
        fetch: 'Fetch complete',
        pull: 'Pull complete',
        push: 'Push complete',
        publish: 'Branch published and upstream configured',
        'stash-save': 'Changes stashed',
        'stash-apply': 'Stash applied',
        'stash-pop': 'Stash applied and removed',
        'stash-drop': 'Stash removed',
        amend: 'Commit amended',
        'undo-commit': 'Commit undone; changes remain staged',
        'partial-stage': 'Selected changes updated in the index',
        checkout: 'Branch switched',
        branch: 'Branch created',
        'branch-rename': 'Branch renamed',
        'branch-delete': 'Branch deleted',
        'branch-delete-remote': 'Remote branch deleted',
        'branch-upstream': 'Upstream updated',
        reset: 'Branch reset',
        'remote-fetch': 'Remote fetched',
        'cherry-pick': this.snapshot?.operation ? 'Cherry-pick paused — resolve conflicts to continue' : 'Commit cherry-picked',
        revert: this.snapshot?.operation ? 'Revert paused — resolve conflicts to continue' : 'Commit reverted',
        rebase: this.snapshot?.operation ? 'Rebase paused — resolve conflicts to continue' : 'Rebase complete',
        'rebase-plan': this.snapshot?.operation ? 'Rebase paused — review the current step' : 'Rebase complete',
        'rebase-amend': 'Paused commit amended',
        'reflog-recover': 'Recovery branch created',
        'tag-create': 'Tag created',
        'tag-push': 'Tag pushed',
        'tag-delete': 'Local tag deleted',
        'tag-delete-remote': 'Remote tag deleted',
        'submodule-add': 'Submodule added — commit the parent repository changes',
        'submodule-update': 'Submodule checkout updated',
        'submodule-sync': 'Submodule URLs synchronized',
        'submodule-remove': 'Submodule removal staged',
        'lfs-install': 'Git LFS enabled for this repository',
        'lfs-track': 'LFS pattern tracked — review .gitattributes',
        'lfs-untrack': 'LFS pattern removed — review .gitattributes',
        'lfs-fetch': 'LFS objects fetched',
        'lfs-pull': 'LFS objects downloaded into the checkout',
        'lfs-push': 'LFS objects pushed',
        'operation-continue': this.snapshot?.operation ? 'Operation paused — review the current step' : 'Operation complete',
        'operation-skip': this.snapshot?.operation ? 'Commit skipped — review the next step' : 'Operation complete',
        'operation-abort': 'Operation aborted',
        'remote-add': 'Remote added',
        'remote-edit': 'Remote updated',
        'remote-remove': 'Remote removed',
        merge: this.snapshot?.operation === 'Merge' ? 'Merge prepared — review the result in the commit window' : 'Already up to date',
        'merge-abort': 'Merge aborted',
        resolve: 'File resolved and staged',
        ignore: 'Added to .gitignore',
        'worktree-add': 'Worktree created',
        'worktree-remove': 'Worktree removed',
        'checkout-detached': 'Commit checked out in detached HEAD mode'
      };
      if (action !== 'partial-stage') {
        void this.toasts.success(messages[action] || 'Done');
      }
      return true;
    } catch (error) {
      if (notifyErrors) {
        this.fail(error);
      } else {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      await this.refresh();
      return false;
    } finally {
      this.busy = false;
    }
  }

  inform(message: string) {
    void this.toasts.info(message);
  }

  fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.lastError) {
      void this.toasts.show({ tone: 'danger', message, duration: 0 });
    }
    this.lastError = message;
  }
}
