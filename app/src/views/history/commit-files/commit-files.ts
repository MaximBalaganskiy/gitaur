import { bindable, INode, observable, resolve } from 'aurelia';
import type { TreeEntry } from '../../../interfaces/tree-entry';
import { WorkspaceService } from '../../../services/workspace-service';
import { buildFileTree } from '../../../services/file-tree';
import type { FileTreeNode } from '../../../interfaces/file-tree-node';
import '../../../elements/diff-view/syntax.css';

export class CommitFiles {
  readonly workspace = resolve(WorkspaceService);
  private element = resolve(INode) as HTMLElement;
  private entries: TreeEntry[] = [];
  private treeGeneration = 0;
  private fileGeneration = 0;
  private isBound = false;
  nodes: FileTreeNode[] = [];
  selectedNode = '';
  selectedPath = '';
  lines: string[] = [];
  fileCount = 0;
  treeLoading = false;
  fileLoading = false;
  message = '';
  error = '';
  truncated = false;
  image = '';

  rawLines: string[] = [];
  contentQuery = '';
  matchLine = -1;

  @bindable
  hash = '';
  hashChanged() {
    if (this.isBound) {
      void this.loadTree();
    }
  }

  @bindable
  repository = '';
  repositoryChanged() {
    if (this.isBound) {
      void this.loadTree();
    }
  }

  @observable
  fileQuery = '';
  fileQueryChanged() {
    this.filterFiles();
  }

  filterFiles() {
    const query = this.fileQuery.trim().toLowerCase();
    this.nodes = buildFileTree(
      this.entries.filter(entry => entry.path.toLowerCase().includes(query)),
      !!query
    );
  }

  get contentMatches() {
    return this.contentQuery
      ? this.rawLines.flatMap((line, index) => (line.toLowerCase().includes(this.contentQuery.toLowerCase()) ? [index] : []))
      : [];
  }

  findInFile() {
    const matches = this.contentMatches;
    this.matchLine = matches[(matches.indexOf(this.matchLine) + 1) % matches.length] ?? -1;
    this.element.querySelector(`[data-line="${this.matchLine}"]`)?.scrollIntoView({ block: 'center' });
  }
  binding() {
    this.isBound = true;
    void this.loadTree();
  }

  unbinding() {
    this.isBound = false;
    ++this.treeGeneration;
    ++this.fileGeneration;
  }

  async loadTree() {
    const generation = ++this.treeGeneration;
    ++this.fileGeneration;
    this.nodes = [];
    this.entries = [];
    this.rawLines = [];
    this.selectedNode = '';
    this.selectedPath = '';
    this.image = '';
    this.lines = [];
    this.message = '';
    this.error = '';
    this.fileLoading = false;
    this.treeLoading = false;
    this.fileCount = 0;
    if (!this.hash || !this.repository) {
      return;
    }
    this.treeLoading = true;
    try {
      const entries = await this.workspace.client.commitTree(this.hash);
      if (generation === this.treeGeneration) {
        this.entries = entries;
        this.filterFiles();
        this.fileCount = entries.length;
      }
    } catch (error) {
      if (generation === this.treeGeneration) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.treeGeneration) {
        this.treeLoading = false;
      }
    }
  }

  async selectFile(node: FileTreeNode) {
    if (!node.entry) {
      return;
    }
    const generation = ++this.fileGeneration;
    this.selectedPath = node.path;
    this.image = '';
    this.lines = [];
    this.rawLines = [];
    this.matchLine = -1;
    this.message = '';
    this.truncated = false;
    this.fileLoading = true;
    try {
      const preview = await this.workspace.client.commitFile(this.hash, node.path);
      const { highlightCode } = await import('../../../services/syntax-highlighter');
      if (generation !== this.fileGeneration) {
        return;
      }
      this.image = preview.image || '';
      this.message = preview.message || (preview.text || preview.image ? '' : 'Empty file.');
      const lines = preview.text.split('\n');
      this.truncated = lines.length > 12000;
      this.rawLines = lines.slice(0, 12000);
      this.lines = preview.text ? highlightCode(lines.slice(0, 12000).join('\n'), node.path) : [];
    } catch (error) {
      if (generation === this.fileGeneration) {
        this.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.fileGeneration) {
        this.fileLoading = false;
      }
    }
  }
}
