import { ValidatedForm } from '../../services/validated-form';
import { observable, resolve } from 'aurelia';
import { IDialogService } from '@aurelia/dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ConflictDialog } from './conflict-dialog/conflict-dialog';
import { RebaseEditDialog } from './rebase-edit-dialog/rebase-edit-dialog';
import { ActionDialog } from '../history/action-dialog/action-dialog';
import { WorkspaceService } from '../../services/workspace-service';
import type { ChangedFile } from '../../interfaces/changed-file';
import './commit.css';

export class Commit extends ValidatedForm {
  constructor() {
    super();
    this.requireText('message', 'Commit message');
  }

  editPausedCommit() {
    return this.dialogs.open({ component: RebaseEditDialog });
  }

  readonly workspace = resolve(WorkspaceService);
  private dialogs = resolve(IDialogService);
  private unsubscribe?: () => void;
  private diffGeneration = 0;
  workingFile: ChangedFile | null = null;
  workingStaged = false;
  diff = '';
  diffLoading = false;
  fullFile = false;
  amendHead = '';
  private previousDraft = '';

  fileQuery = '';

  @observable
  message = '';
  messageChanged() {
    localStorage.setItem('draft:' + this.workspace.repo, this.message);
  }

  @observable
  treeLayout = localStorage.getItem('commit-file-layout') === 'tree';
  treeLayoutChanged() {
    localStorage.setItem('commit-file-layout', this.treeLayout ? 'tree' : 'flat');
  }

  get visibleUnstaged() {
    return this.unstaged.filter(file => file.path.toLowerCase().includes(this.fileQuery.toLowerCase()));
  }

  get visibleStaged() {
    return this.staged.filter(file => file.path.toLowerCase().includes(this.fileQuery.toLowerCase()));
  }

  ignore(file: ChangedFile) {
    return this.workspace.action('ignore', { paths: [file.path] });
  }

  resolveConflict(file: ChangedFile) {
    return this.dialogs.open({ component: ConflictDialog, model: file.path });
  }

  abortMerge() {
    return this.dialogs.open({
      component: ActionDialog,
      model: {
        title: 'Abort merge',
        description: 'Abort the current merge and discard its in-progress conflict resolutions?',
        action: 'merge-abort',
        payload: {},
        confirm: 'Abort merge',
        danger: true
      }
    });
  }

  get replaying() {
    return !!this.workspace.snapshot?.operation && this.workspace.snapshot.operation !== 'Merge';
  }

  get canContinue() {
    return !this.workspace.busy && !this.workspace.snapshot?.files.some(file => file.conflict);
  }

  async continueOperation() {
    if (await this.workspace.action('operation-continue', { choice: this.workspace.snapshot?.operation })) {
      await this.closeCompletedOperation();
    }
  }

  async controlOperation(control: 'skip' | 'abort') {
    const operation = this.workspace.snapshot?.operation ?? '';
    const result = await this.dialogs.open({
      component: ActionDialog,
      model: {
        title: `${control === 'skip' ? 'Skip commit' : 'Abort operation'}`,
        description:
          control === 'skip'
            ? `Skip the current ${operation.toLowerCase()} commit and discard its in-progress changes?`
            : `Abort ${operation.toLowerCase()} and restore the state before it started? In-progress resolutions will be discarded.`,
        action: `operation-${control}`,
        payload: { choice: operation },
        confirm: control === 'skip' ? 'Skip commit' : 'Abort operation',
        danger: true
      }
    });
    if ((await result.dialog.closed).status === 'ok') {
      await this.closeCompletedOperation();
    }
  }

  async closeCompletedOperation() {
    if (!this.workspace.snapshot?.operation) {
      await this.closeWindow();
    }
  }

  get unstaged() {
    return this.workspace.snapshot?.files.filter(file => file.unstaged).sort((a, b) => a.path.localeCompare(b.path)) ?? [];
  }

  get staged() {
    return this.workspace.snapshot?.files.filter(file => file.staged).sort((a, b) => a.path.localeCompare(b.path)) ?? [];
  }

  get canStageAll() {
    return !this.workspace.busy && this.unstaged.some(file => !file.conflict);
  }

  get canCommit() {
    return (
      !this.workspace.busy &&
      !this.replaying &&
      !!this.message.trim() &&
      (this.staged.length > 0 || !!this.amendHead || this.workspace.snapshot?.operation === 'Merge') &&
      !this.workspace.snapshot?.files.some(file => file.conflict)
    );
  }

  get summaryLength() {
    return this.message.split('\n')[0].length;
  }

  binding() {
    this.message = localStorage.getItem('draft:' + this.workspace.repo) || '';
    this.unsubscribe = this.workspace.subscribe(() => this.refresh());
    this.refresh();
  }

  attached() {
    window.addEventListener('keydown', this.onKey);
  }

  detaching() {
    window.removeEventListener('keydown', this.onKey);
  }

  unbinding() {
    this.unsubscribe?.();
    ++this.diffGeneration;
  }

  refresh() {
    const current = this.workspace.snapshot?.files.find(
      file => file.path === this.workingFile?.path && (this.workingStaged ? file.staged : file.unstaged)
    );
    if (current) {
      void this.selectWorking(current, this.workingStaged);
    } else if (this.unstaged[0]) {
      void this.selectWorking(this.unstaged[0], false);
    } else if (this.staged[0]) {
      void this.selectWorking(this.staged[0], true);
    } else {
      ++this.diffGeneration;
      this.workingFile = null;
      this.diff = '';
      this.diffLoading = false;
    }
  }

  async toggleFullFile() {
    this.fullFile = !this.fullFile;
    if (this.workingFile) {
      this.diffLoading = true;
      await this.selectWorking(this.workingFile, this.workingStaged);
    }
  }

  async selectWorking(file: ChangedFile, staged: boolean) {
    const generation = ++this.diffGeneration;
    const changed = this.workingFile?.path !== file.path || this.workingStaged !== staged;
    this.workingFile = file;
    this.workingStaged = staged;
    if (changed || !this.diff) {
      this.diff = '';
      this.diffLoading = true;
    }

    try {
      const text = await this.workspace.client.diff({
        path: file.path,
        originalPath: (staged ? file.index : file.worktree) === 'R' ? file.originalPath : undefined,
        staged,
        untracked: file.index === '?',
        fullFile: this.fullFile
      });
      if (generation === this.diffGeneration) {
        this.diff = text || 'No text changes. This may be a rename, mode change or submodule.';
      }
    } catch (error) {
      if (generation === this.diffGeneration) {
        this.workspace.fail(error);
      }
    } finally {
      if (generation === this.diffGeneration) {
        this.diffLoading = false;
      }
    }
  }

  stage(file: ChangedFile, staged: boolean) {
    return this.workspace.action(staged ? 'unstage' : 'stage', { paths: [file.path, ...(file.originalPath ? [file.originalPath] : [])] });
  }

  stageAll(staged: boolean) {
    const files = (staged ? this.staged : this.unstaged).filter(file => !file.conflict);
    const paths = [...new Set(files.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]))];
    if (paths.length) {
      return this.workspace.action(staged ? 'unstage' : 'stage', { paths });
    }
  }

  async commit() {
    if (!(await this.validateFields('message'))) {
      return;
    }
    if (this.canCommit && this.amendHead) {
      const result = await this.dialogs.open({
        component: ActionDialog,
        model: {
          title: 'Amend last commit',
          description: `Replace commit ${this.amendHead.slice(0, 8)} with the current index and this message? This rewrites its history, including if it was already pushed.\n\n${this.message}`,
          action: 'amend',
          payload: { reference: this.amendHead, message: this.message },
          confirm: 'Amend commit',
          danger: true
        }
      });
      const closed = await result.dialog.closed;
      if (closed.status === 'ok') {
        this.amendHead = '';
        this.message = '';
        await this.closeWindow();
      }
      return;
    }
    if (this.canCommit && (await this.workspace.action('commit', { message: this.message }))) {
      this.message = '';
      await this.closeWindow();
    }
  }

  async toggleAmend() {
    if (this.amendHead) {
      this.amendHead = '';
      this.message = this.previousDraft;
      return;
    }
    const head = this.workspace.snapshot?.head;
    if (!head) {
      return;
    }
    try {
      const detail = await this.workspace.client.detail(head);
      this.previousDraft = this.message;
      this.message = detail.message;
      this.amendHead = head;
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  undoCommit() {
    return this.dialogs.open({
      component: ActionDialog,
      model: {
        title: 'Undo last commit',
        description:
          'Move the branch back one commit while keeping the index and working files intact. The undone changes stay staged. This rewrites branch history, including if the commit was already pushed.',
        action: 'undo-commit',
        payload: { reference: this.workspace.snapshot?.head },
        confirm: 'Undo commit',
        danger: true
      }
    });
  }

  get canStageSelection() {
    const file = this.workingFile;
    return !!file && !file.conflict && !file.originalPath && (this.workingStaged ? file.index : file.worktree) === 'M';
  }

  canResetFile(file: ChangedFile | null, staged = this.workingStaged) {
    return !!file && !staged && !file.conflict && file.index !== '?' && !file.originalPath && file.unstaged;
  }

  async resetFile(file: ChangedFile) {
    if (!this.canResetFile(file, false) || this.workspace.busy) {
      return;
    }
    try {
      const original = await this.workspace.client.diff({ path: file.path, fullFile: this.fullFile });
      return this.dialogs.open({
        component: ActionDialog,
        model: {
          title: 'Reset file changes',
          description: `Discard all unstaged changes in ${file.path}? The file will be restored from the index. Staged changes will be kept. This cannot be undone.`,
          action: 'reset-file',
          payload: { paths: [file.path], original, full_file: this.fullFile },
          confirm: 'Reset file',
          danger: true
        }
      });
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  resetSelection(lines: number[]) {
    if (!this.canResetFile(this.workingFile) || !this.canStageSelection || !lines.length || this.diffLoading || this.workspace.busy) {
      return;
    }
    return this.dialogs.open({
      component: ActionDialog,
      model: {
        title: 'Reset selected changes',
        description: `Discard the ${lines.length} selected changed lines in ${this.workingFile!.path}? Other unstaged changes and staged changes will be kept. This cannot be undone.`,
        action: 'partial-reset',
        payload: { paths: [this.workingFile!.path], original: this.diff, lines, full_file: this.fullFile },
        confirm: 'Reset changes',
        danger: true
      }
    });
  }

  stageSelection(lines: number[]) {
    return this.workspace.action('partial-stage', {
      paths: [this.workingFile?.path],
      staged: this.workingStaged,
      full_file: this.fullFile,
      original: this.diff,
      lines
    });
  }

  statusLabel(file: ChangedFile, staged: boolean) {
    const status = staged ? file.index : file.worktree;
    return file.conflict ? '!' : status === '?' ? 'A' : status;
  }

  private async closeWindow() {
    try {
      await getCurrentWindow().close();
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.key === 'Enter' && this.canCommit) {
      event.preventDefault();
      void this.commit();
    }
  };
}
