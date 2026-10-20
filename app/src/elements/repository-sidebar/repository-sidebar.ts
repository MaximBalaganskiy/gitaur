import { INode, observable, resolve, watch } from 'aurelia';
import { WorkspaceService } from '../../services/workspace-service';
import { buildBranchTree } from '../../services/branch-tree';
import { BranchTreeState } from '../../services/branch-tree-state';
import type { BranchTreeNode } from '../../interfaces/branch-tree-node';
import type { Branch } from '../../interfaces/branch';
import type { Remote } from '../../interfaces/remote';
import type { UiMenu } from '@aurelia-ui-toolkits/headless';
import './repository-sidebar.css';

export class RepositorySidebar {
  readonly workspace = resolve(WorkspaceService);
  private element = resolve(INode) as HTMLElement;
  private treeState = resolve(BranchTreeState);
  private expansion = new Map<string, boolean>();
  private repository = '';
  private unsubscribe?: () => void;
  private remoteGeneration = 0;
  private remotes: Remote[] = [];
  remotesError = '';
  remotesLoading = false;
  selectedNode = '';
  nodes: BranchTreeNode[] = [];
  branchMenu!: UiMenu;
  contextBranch: Branch | null = null;
  remoteMenu!: UiMenu;
  contextRemote: Remote | null = null;

  setContext(node: BranchTreeNode) {
    this.contextBranch = node.branch ?? null;
    this.contextRemote = node.remote ?? null;
  }

  async loadRemotes() {
    const generation = ++this.remoteGeneration;
    const repository = this.workspace.repo;
    this.remotesLoading = true;
    try {
      const remotes = await this.workspace.client.remotes();
      if (generation === this.remoteGeneration && repository === this.workspace.repo) {
        this.remotesError = '';
        if (JSON.stringify(remotes) !== JSON.stringify(this.remotes)) {
          this.remotes = remotes;
          this.rebuildTree();
        }
      }
    } catch (error) {
      if (generation === this.remoteGeneration && repository === this.workspace.repo) {
        this.remotesError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.remoteGeneration) {
        this.remotesLoading = false;
      }
    }
  }

  showRemoteMenu(node: BranchTreeNode, event: Event) {
    event.stopPropagation();
    this.contextRemote = node.remote ?? null;
    this.remoteMenu.anchor = event.currentTarget as HTMLElement;
    this.remoteMenu.tabReference = event.currentTarget as HTMLElement;
    this.remoteMenu.open = true;
  }

  async remoteAction(action: string, event?: Event) {
    event?.stopPropagation();
    if (this.workspace.busy) {
      return;
    }
    if (action === 'fetch' && this.contextRemote) {
      await this.workspace.action('remote-fetch', { name: this.contextRemote.name });
    } else if (action === 'add' || this.contextRemote) {
      this.element.dispatchEvent(
        new CustomEvent('remote-action', { detail: { action, remote: action === 'add' ? null : this.contextRemote }, bubbles: true })
      );
    }
  }

  async branchAction(action: string) {
    const branch = this.contextBranch;
    if (!branch) {
      return;
    }
    if (this.workspace.busy && action !== 'tip' && action !== 'copy') {
      return;
    }
    if (this.workspace.snapshot?.operation && ['merge', 'rebase', 'rebase-plan', 'rename', 'upstream', 'delete'].includes(action)) {
      return;
    }
    if (action === 'delete' && branch.kind === 'local' && branch.name === this.workspace.snapshot?.branch) {
      return;
    }
    if (action === 'tip') {
      this.focusBranch(branch);
    } else if (action === 'checkout') {
      await this.checkout(branch);
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(branch.name);
        this.workspace.inform('Reference name copied');
      } catch (error) {
        this.workspace.fail(error);
      }
    } else {
      this.element.dispatchEvent(new CustomEvent('branch-action', { detail: { action, branch }, bubbles: true }));
    }
  }

  @observable
  branchSearch = '';
  branchSearchChanged() {
    this.rebuildTree();
  }

  binding() {
    this.rebuildTree();
    this.unsubscribe = this.workspace.subscribe(() => void this.loadRemotes());
    void this.loadRemotes();
  }

  unbinding() {
    this.unsubscribe?.();
    ++this.remoteGeneration;
  }

  @watch('workspace.snapshot')
  rebuildTree() {
    if (this.repository !== this.workspace.repo) {
      this.repository = this.workspace.repo;
      this.expansion = this.treeState.load(this.repository);
      this.selectedNode = '';
      this.remotes = [];
      this.contextRemote = null;
    }
    this.nodes = buildBranchTree(this.workspace.snapshot?.branches ?? [], this.branchSearch, this.expansion, this.remotes);
  }

  rememberExpansion(node: BranchTreeNode, expanded: boolean) {
    if (!this.branchSearch.trim()) {
      this.expansion.set(node.id, expanded);
      this.treeState.save(this.repository, this.expansion);
    }
  }

  selectNode(node: BranchTreeNode) {
    if (node.branch) {
      this.focusBranch(node.branch);
    }
  }

  private focusBranch(branch: Branch) {
    this.selectedNode = branch.fullName;
    this.element.dispatchEvent(new CustomEvent('branch-selected', { detail: branch, bubbles: true }));
  }

  canCheckout(branch?: Branch | null) {
    return branch?.kind === 'remote'
      ? !branch.name.endsWith('/HEAD')
      : branch?.kind === 'local' && branch.name !== this.workspace.snapshot?.branch;
  }

  async checkout(branch: Branch, event?: Event) {
    event?.stopPropagation();
    if (!this.workspace.busy && this.canCheckout(branch)) {
      const switched = await this.workspace.action('checkout', {
        name: branch.name,
        reference: branch.kind === 'remote' ? branch.fullName : undefined
      });
      if (switched) {
        const current = this.workspace.snapshot?.branches.find(
          item => item.kind === 'local' && item.name === this.workspace.snapshot?.branch
        );
        if (current) {
          this.focusBranch(current);
        }
      }
    }
  }
}
