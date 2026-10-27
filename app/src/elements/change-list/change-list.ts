import { bindable, INode, resolve } from 'aurelia';
import type { UiMenu } from '@aurelia-ui-toolkits/headless';
import type { ChangedFile } from '../../interfaces/changed-file';
import type { WorkingFileNode } from '../../interfaces/working-file-node';
import { WorkspaceService } from '../../services/workspace-service';

export class ChangeList {
  readonly workspace = resolve(WorkspaceService);
  private element = resolve(INode) as HTMLElement;
  menu!: UiMenu;
  contextFile: ChangedFile | null = null;

  @bindable
  files: ChangedFile[] = [];

  @bindable
  staged = false;

  @bindable
  tree = false;

  @bindable
  selectedPath = '';

  get nodes() {
    const roots: WorkingFileNode[] = [];
    const folders = new Map<string, WorkingFileNode>();
    for (const file of this.files) {
      const parts = file.path.split('/');
      let children = roots;
      let path = '';
      for (const name of parts.slice(0, -1)) {
        path += `${name}/`;
        let node = folders.get(path);
        if (!node) {
          node = { path, name, expanded: true, children: [] };
          folders.set(path, node);
          children.push(node);
        }
        children = node.children;
      }
      children.push({ path: file.path, name: parts.at(-1)!, expanded: false, file, children: [] });
    }
    const sort = (nodes: WorkingFileNode[]) => {
      nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
      for (const node of nodes) {
        sort(node.children);
      }
    };
    sort(roots);
    return roots;
  }

  label(file: ChangedFile, name = file.path) {
    const status = this.staged ? file.index : file.worktree;
    return file.originalPath && (status === 'R' || status === 'C') ? `${file.originalPath} → ${name}` : name;
  }

  selectNode(node: WorkingFileNode) {
    if (node.file) {
      this.action('selected', node.file);
    }
  }

  action(action: string, file: ChangedFile | null = this.contextFile, event?: Event) {
    event?.stopPropagation();
    if (file) {
      this.element.dispatchEvent(new CustomEvent(`file-${action}`, { bubbles: true, detail: { file, staged: this.staged } }));
    }
  }

  status(file: ChangedFile) {
    return file.conflict ? '!' : file.index === '?' ? 'A' : this.staged ? file.index : file.worktree;
  }
}
