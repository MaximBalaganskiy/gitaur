import { observable, resolve, watch } from 'aurelia';
import { IDialogService } from '@aurelia/dialog';
import { WorkspaceService } from '../../services/workspace-service';
import type { ImageDiff } from '../../interfaces/image-diff';
import { isImagePath } from '../../services/image-path';
import { buildGraph } from '../../services/graph-layout';
import { AppearanceService } from '../../services/appearance-service';
import { CommitSelectionHistory } from '../../services/commit-selection-history';
import { NewBranchDialog } from './new-branch-dialog/new-branch-dialog';
import { RemoteDialog } from './remote-dialog/remote-dialog';
import { NewWorktreeDialog } from './new-worktree-dialog/new-worktree-dialog';
import { ActionDialog } from './action-dialog/action-dialog';
import { PublishDialog } from './publish-dialog/publish-dialog';
import { StashesDialog } from './stashes-dialog/stashes-dialog';
import { BranchDialog } from './branch-dialog/branch-dialog';
import { HistoryOperationDialog } from './history-operation-dialog/history-operation-dialog';
import { ReflogDialog } from './reflog-dialog/reflog-dialog';
import { TagsDialog } from './tags-dialog/tags-dialog';
import { DeleteTagDialog } from './delete-tag-dialog/delete-tag-dialog';
import { SubmodulesDialog } from './submodules-dialog/submodules-dialog';
import { LfsDialog } from './lfs-dialog/lfs-dialog';
import type { RepositoryToolDialog } from './repository-tool-dialog';
import type { UiMenu } from '@aurelia-ui-toolkits/headless';
import type { Commit } from '../../interfaces/commit';
import type { Branch } from '../../interfaces/branch';
import type { Detail } from '../../interfaces/detail';
import type { CommandEntry } from '../../interfaces/command-entry';
import type { GraphRow } from '../../interfaces/graph-row';
import type { Snapshot } from '../../interfaces/snapshot';
import type { Worktree } from '../../interfaces/worktree';
import type { Remote } from '../../interfaces/remote';
import './history.css';
import './details.css';
import './commit-details.css';

export class History {
  toolsOpen = false;
  toolsAnchor!: HTMLElement;

  async repositoryTool(action: string) {
    const component = { reflog: ReflogDialog, tags: TagsDialog, submodules: SubmodulesDialog, lfs: LfsDialog }[action];
    if (component) {
      try {
        await this.dialogs.open<RepositoryToolDialog>({ component });
      } catch (error) {
        this.workspace.fail(error);
      }
    }
  }
  readonly workspace = resolve(WorkspaceService);
  readonly appearance = resolve(AppearanceService);
  private dialogs = resolve(IDialogService);
  private unsubscribe?: () => void;
  private lastSnapshot: Snapshot | null = null;
  private detailGeneration = 0;
  private diffGeneration = 0;
  private branchGeneration = 0;
  private selectionHistory = new CommitSelectionHistory();

  rows: GraphRow[] = [];
  selected: Commit | null = null;
  detail: Detail | null = null;
  detailError = '';
  selectedFile = '';
  diff = '';
  images: ImageDiff | null = null;
  diffLoading = false;
  fullFile = false;
  query = '';
  fileQuery = '';

  get changedFiles() {
    const query = this.fileQuery.trim().toLowerCase();
    return this.detail?.files.filter(file => file.path.toLowerCase().includes(query)) ?? [];
  }

  selectFirstChangedFile() {
    const file = this.changedFiles[0];
    if (file) {
      return this.selectFile(file.path);
    }
  }

  commandLog: CommandEntry[] = [];
  commitMenu!: UiMenu;
  contextCommit: Commit | null = null;

  get contextBranches() {
    return (this.workspace.snapshot?.branches ?? []).filter(
      branch =>
        branch.hash === this.contextCommit?.hash &&
        (branch.kind === 'local' || (branch.kind === 'remote' && !branch.name.endsWith('/HEAD')))
    );
  }

  setCommitContext(commit: Commit, event: Event) {
    this.contextCommit = commit;
    this.commitMenu.tabReference = event.currentTarget as HTMLElement;
  }

  async checkoutBranch(branch: Branch) {
    if (
      this.workspace.busy ||
      this.workspace.snapshot?.operation ||
      (branch.kind === 'local' && branch.name === this.workspace.snapshot?.branch)
    ) {
      return;
    }

    this.commitMenu.open = false;
    const switched = await this.workspace.action('checkout', {
      name: branch.name,
      reference: branch.kind === 'remote' ? branch.fullName : undefined
    });
    if (switched) {
      const current = this.workspace.snapshot?.branches.find(
        item => item.kind === 'local' && item.name === this.workspace.snapshot?.branch
      );
      if (current) {
        await this.focusBranch(current);
      }
    }
  }

  @observable
  tab = 'diff';
  tabChanged() {
    if (this.tab === 'log') {
      void this.loadLog();
    }
  }

  async commitAction(action: string) {
    const commit = this.contextCommit;
    if (!commit) {
      return;
    }
    if (action === 'files') {
      await this.selectCommit(commit);
      this.tab = 'files';
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(commit.hash);
        this.workspace.inform('Commit hash copied');
      } catch (error) {
        this.workspace.fail(error);
      }
    } else if (action === 'branch') {
      await this.createBranch(commit.hash);
    } else if (action === 'tag') {
      await this.dialogs.open({ component: TagsDialog, model: commit.hash });
    } else if (action === 'merge') {
      await this.mergeReference(commit.hash, commit.subject);
    } else if (['cherry-pick', 'revert', 'reset', 'rebase', 'rebase-plan'].includes(action)) {
      await this.dialogs.open({
        component: HistoryOperationDialog,
        model: { action, reference: commit.hash, label: commit.subject, parents: commit.parents }
      });
    } else if (action === 'checkout') {
      await this.dialogs.open({
        component: ActionDialog,
        model: {
          title: 'Check out commit',
          description: `Check out ${commit.hash.slice(0, 8)} in detached HEAD mode? Create a branch before making new commits you want to keep.`,
          action: 'checkout-detached',
          payload: { reference: commit.hash },
          confirm: 'Check out commit'
        }
      });
    }
  }

  async branchAction(detail: { action: string; branch: Branch }) {
    if (detail.action === 'delete-tag' || detail.action === 'delete-tag-remote') {
      await this.dialogs.open({ component: DeleteTagDialog, model: { tag: detail.branch, remote: detail.action === 'delete-tag-remote' } });
    } else if (detail.action === 'merge') {
      await this.mergeReference(detail.branch.fullName, detail.branch.name);
    } else if (detail.action === 'branch') {
      await this.createBranch(detail.branch.hash);
    } else if (['rename', 'delete', 'upstream'].includes(detail.action)) {
      await this.dialogs.open({ component: BranchDialog, model: detail });
    } else if (detail.action === 'rebase' || detail.action === 'rebase-plan') {
      await this.dialogs.open({
        component: HistoryOperationDialog,
        model: { action: detail.action, reference: detail.branch.hash, label: detail.branch.name }
      });
    }
  }

  mergeReference(reference: string, label: string) {
    return this.dialogs.open({
      component: ActionDialog,
      model: {
        title: 'Merge into current branch',
        description: `Merge ${label} into ${this.workspace.snapshot?.branch}? The merge will pause before creating a commit so you can review changes and resolve conflicts.`,
        action: 'merge',
        payload: { reference },
        confirm: 'Start merge'
      }
    });
  }

  createWorktree() {
    return this.dialogs.open({ component: NewWorktreeDialog });
  }

  removeWorktree(tree: Worktree) {
    return this.dialogs.open({
      component: ActionDialog,
      model: {
        title: 'Remove worktree',
        description: `Remove ${tree.path}? Git will refuse if it contains uncommitted or untracked files. Its branch will remain.`,
        action: 'worktree-remove',
        payload: { directory: tree.path },
        confirm: 'Remove worktree',
        danger: true
      }
    });
  }

  push() {
    const current = this.workspace.snapshot?.branches.find(
      branch => branch.kind === 'local' && branch.name === this.workspace.snapshot?.branch
    );
    return current?.upstream ? this.workspace.action('push') : this.dialogs.open({ component: PublishDialog });
  }

  manageStashes() {
    return this.dialogs.open({ component: StashesDialog });
  }

  @watch('appearance.density')
  densityChanged() {
    this.rows = buildGraph(this.workspace.snapshot?.commits ?? [], this.appearance.rowHeight);
  }

  get matchCount() {
    return this.rows.filter(row => this.matches(row.commit)).length;
  }

  get canGoBack() {
    return this.selectionHistory.canGoBack;
  }

  get canGoForward() {
    return this.selectionHistory.canGoForward;
  }

  binding() {
    this.unsubscribe = this.workspace.subscribe(() => this.refresh());
    this.refresh();
  }

  attached() {
    window.addEventListener('keydown', this.onNavigationKey, true);
    window.addEventListener('mousedown', this.onNavigationMouseDown, true);
    window.addEventListener('mouseup', this.onNavigationMouseUp, true);
    window.addEventListener('auxclick', this.onNavigationMouseDown, true);
  }

  detaching() {
    window.removeEventListener('keydown', this.onNavigationKey, true);
    window.removeEventListener('mousedown', this.onNavigationMouseDown, true);
    window.removeEventListener('mouseup', this.onNavigationMouseUp, true);
    window.removeEventListener('auxclick', this.onNavigationMouseDown, true);
  }

  private onNavigationKey = (event: KeyboardEvent) => {
    const back = event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
    const forward = event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight');
    if ((!back && !forward) || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.navigateSelection(back ? -1 : 1);
  };

  private onNavigationMouseDown = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private onNavigationMouseUp = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      event.stopPropagation();
      this.navigateSelection(event.button === 3 ? -1 : 1);
    }
  };

  navigateSelection(direction: -1 | 1) {
    if (this.dialogs.controllers.length) {
      return;
    }

    const previous = this.selectionHistory.move(direction);
    if (!previous) {
      return;
    }

    ++this.branchGeneration;
    const commit = this.workspace.snapshot?.commits.find(item => item.hash === previous.hash) ?? previous;
    void this.selectCommit(commit, false);
    requestAnimationFrame(() => {
      if (this.selected?.hash === commit.hash) {
        const row = document.getElementById('commit-' + commit.hash);
        row?.scrollIntoView({ block: 'center' });
      }
    });
  }

  unbinding() {
    this.unsubscribe?.();
    ++this.detailGeneration;
    ++this.diffGeneration;
    ++this.branchGeneration;
  }

  refresh() {
    const snapshot = this.workspace.snapshot;
    if (!snapshot || snapshot === this.lastSnapshot) {
      return;
    }

    const branchesChanged = JSON.stringify(snapshot.branches) !== JSON.stringify(this.lastSnapshot?.branches);
    const repositoryChanged = snapshot.path !== this.lastSnapshot?.path;
    if (repositoryChanged) {
      this.selectionHistory = new CommitSelectionHistory();
    }
    this.lastSnapshot = snapshot;
    this.rows = buildGraph(snapshot.commits, this.appearance.rowHeight);
    const commit = snapshot.commits.find(item => item.hash === this.selected?.hash) ?? snapshot.commits[0];
    if (!commit) {
      ++this.detailGeneration;
      ++this.diffGeneration;
      this.selected = null;
      this.detail = null;
      this.selectedFile = '';
      this.images = null;
      this.diff = '';
      this.diffLoading = false;
    }
    if (commit && (commit.hash !== this.selected?.hash || branchesChanged || repositoryChanged)) {
      void this.selectCommit(commit);
    }
  }

  async selectCommit(commit: Commit, remember = true) {
    if (remember) {
      this.selectionHistory.visit(commit);
    }

    const generation = ++this.detailGeneration;
    ++this.diffGeneration;
    this.selected = commit;
    this.detail = null;
    this.detailError = '';
    this.selectedFile = '';
    this.images = null;
    this.diff = '';
    this.diffLoading = false;

    try {
      const detail = await this.workspace.client.detail(commit.hash);
      if (generation !== this.detailGeneration) {
        return;
      }

      this.detail = detail;
      await this.selectFirstChangedFile();
    } catch (error) {
      if (generation === this.detailGeneration) {
        this.detailError = 'Unavailable';
        this.workspace.fail(error);
      }
    }
  }

  async toggleFullFile() {
    this.fullFile = !this.fullFile;
    if (this.selectedFile) {
      await this.selectFile(this.selectedFile);
    }
  }

  async selectFile(path: string) {
    if (!this.selected) {
      return;
    }

    const generation = ++this.diffGeneration;
    this.selectedFile = path;
    this.images = null;
    this.diffLoading = true;
    this.diff = '';

    try {
      const request = { path, hash: this.selected.hash, fullFile: this.fullFile };
      const images = isImagePath(path) ? await this.workspace.client.imageDiff(request) : null;
      const text = images ? '' : await this.workspace.client.diff(request);
      if (generation === this.diffGeneration) {
        this.images = images;
        this.diff = text || 'No text changes for this file.';
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

  matches(commit: Commit) {
    return `${commit.subject} ${commit.author} ${commit.hash} ${commit.refs.join(' ')}`.toLowerCase().includes(this.query.toLowerCase());
  }

  async focusContainingBranch(name: string, kind: 'local' | 'remote') {
    const branch = this.workspace.snapshot?.branches.find(item => item.name === name && item.kind === kind);
    if (!branch) {
      this.workspace.fail(new Error('This branch is no longer available. Refresh the repository and try again.'));
      return;
    }

    await this.focusBranch(branch);
  }

  async focusBranch(branch: Branch) {
    const generation = ++this.branchGeneration;
    const repo = this.workspace.repo;
    let commit = this.workspace.snapshot?.commits.find(item => item.hash === branch.hash);
    while (!commit && this.workspace.canLoadMore) {
      const loaded = await this.workspace.loadMore(true);
      if (!loaded || generation !== this.branchGeneration || repo !== this.workspace.repo) {
        return;
      }
      commit = this.workspace.snapshot?.commits.find(item => item.hash === branch.hash);
    }

    if (commit) {
      void this.selectCommit(commit);
      requestAnimationFrame(() => {
        if (generation === this.branchGeneration && repo === this.workspace.repo) {
          document.getElementById('commit-' + commit.hash)?.scrollIntoView({ block: 'center' });
        }
      });
    } else {
      this.workspace.fail(new Error('The branch tip is not available in the loaded history.'));
    }
  }

  findNext() {
    const matches = this.rows.filter(row => this.matches(row.commit));
    if (!matches.length) {
      return;
    }

    const index = matches.findIndex(row => row.commit.hash === this.selected?.hash);
    const commit = matches[(index + 1) % matches.length].commit;
    void this.selectCommit(commit);
    document.getElementById('commit-' + commit.hash)?.scrollIntoView({ block: 'center' });
  }

  async createBranch(reference?: string) {
    try {
      await this.dialogs.open({ component: NewBranchDialog, model: reference });
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  async remoteAction(detail: { action: string; remote: Remote | null }) {
    try {
      if (detail.action === 'add' || detail.action === 'edit') {
        await this.dialogs.open({ component: RemoteDialog, model: detail.remote });
      } else if (detail.action === 'remove' && detail.remote) {
        await this.dialogs.open({
          component: ActionDialog,
          model: {
            title: 'Remove remote',
            description: `Remove ${detail.remote.name} and its remote-tracking branches from this repository? The server repository and local branches will remain.`,
            action: 'remote-remove',
            payload: { name: detail.remote.name },
            confirm: `Remove ${detail.remote.name}`,
            danger: true
          }
        });
      }
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  async loadLog() {
    try {
      this.commandLog = await this.workspace.client.log();
    } catch (error) {
      this.workspace.fail(error);
    }
  }

  short(hash: string) {
    return hash.slice(0, 7);
  }

  date(value: string) {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  fullDate(value: string) {
    return new Date(value).toLocaleString();
  }
}
