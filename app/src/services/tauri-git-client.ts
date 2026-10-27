import { resolve } from 'aurelia';
import type { ReflogEntry } from '../interfaces/reflog-entry';
import type { Tag } from '../interfaces/tag';
import type { Submodule } from '../interfaces/submodule';
import type { LfsStatus } from '../interfaces/lfs-status';
import { AlertService } from '@aurelia-ui-toolkits/headless';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GitClient } from '../interfaces/git-client';
import type { BootstrapState } from '../interfaces/bootstrap-state';
import type { Snapshot } from '../interfaces/snapshot';
import type { Detail } from '../interfaces/detail';
import type { DiffRequest } from '../interfaces/diff-request';
import type { ImageDiff } from '../interfaces/image-diff';
import type { CommandEntry } from '../interfaces/command-entry';
import type { Remote } from '../interfaces/remote';
import type { TreeEntry } from '../interfaces/tree-entry';
import type { FilePreview } from '../interfaces/file-preview';
import type { Worktree } from '../interfaces/worktree';
import type { ConflictContent } from '../interfaces/conflict-content';
import type { MessageOptions } from '../interfaces/message-options';
import type { Stash } from '../interfaces/stash';
import type { RebaseStep } from '../interfaces/rebase-step';
import type { RepositoryRequest } from '../interfaces/repository-request';

export class TauriGitClient implements GitClient {
  private alerts = resolve(AlertService);

  reflog() {
    return this.request<ReflogEntry[]>('reflog');
  }

  tags() {
    return this.request<Tag[]>('tags');
  }

  submodules() {
    return this.request<Submodule[]>('submodules');
  }

  lfsStatus() {
    return this.request<LfsStatus>('lfs_status');
  }

  createRepository(request: RepositoryRequest) {
    return this.request<string>('create_repository', { request });
  }

  chooseDirectory() {
    return this.request<string | null>('choose_directory');
  }

  rebasePlan(reference: string) {
    return this.request<RebaseStep[]>('rebase_plan', { reference });
  }

  stashes() {
    return this.request<Stash[]>('stashes');
  }

  stashDiff(hash: string) {
    return this.request<string>('stash_diff', { hash });
  }

  worktrees() {
    return this.request<Worktree[]>('worktrees');
  }

  conflictContent(path: string) {
    return this.request<ConflictContent>('conflict_content', { path });
  }

  messageOptions() {
    return this.request<MessageOptions>('message_options');
  }
  commitTree(hash: string) {
    return this.request<TreeEntry[]>('commit_tree', { hash });
  }

  commitFile(hash: string, path: string) {
    return this.request<FilePreview>('commit_file', { hash, path });
  }

  remotes() {
    return this.request<Remote[]>('remotes');
  }

  bootstrap() {
    return this.request<BootstrapState>('bootstrap');
  }

  open(directory?: string) {
    return this.request<string | null>('open_repository', { directory });
  }

  snapshot(limit: number) {
    return this.request<Snapshot>('snapshot', { limit });
  }

  detail(hash: string) {
    return this.request<Detail>('detail', { hash });
  }

  diff(request: DiffRequest) {
    return this.request<string>('diff', { request });
  }

  imageDiff(request: DiffRequest) {
    return this.request<ImageDiff>('image_diff', { request });
  }

  mutate(action: string, payload: Record<string, unknown> = {}) {
    return this.request<boolean>('mutate', { action, payload });
  }

  log() {
    return this.request<CommandEntry[]>('command_log');
  }

  openCommit() {
    return this.request<void>('commit_window');
  }

  private request<T>(command: string, args?: Record<string, unknown>) {
    return this.alerts.usingProgress(() => invoke<T>(command, args));
  }

  async onChanged(callback: () => void) {
    return listen('repository-changed', callback);
  }
}
