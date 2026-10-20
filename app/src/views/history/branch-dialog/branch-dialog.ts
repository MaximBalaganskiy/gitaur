import { ValidatedForm } from '../../../services/validated-form';
import { resolve } from 'aurelia';
import { IDialogController } from '@aurelia/dialog';
import { WorkspaceService } from '../../../services/workspace-service';
import type { BranchOperation } from '../../../interfaces/branch-operation';

export class BranchDialog extends ValidatedForm {
  constructor() {
    super();
    this.requireRef('name', 'New branch name');
  }

  readonly workspace = resolve(WorkspaceService);
  private dialog = resolve(IDialogController);
  model!: BranchOperation;
  name = '';
  upstream = ':none';
  force = false;
  error = '';

  get title() {
    if (this.model.action === 'delete' && this.model.branch.kind === 'remote') {
      return 'Delete remote branch';
    }
    return { rename: 'Rename branch', delete: 'Delete branch', upstream: 'Set upstream' }[this.model.action];
  }

  get upstreams() {
    return [
      { fullName: ':none', name: 'No upstream' },
      ...(this.workspace.snapshot?.branches.filter(branch => branch.kind === 'remote' && !branch.name.endsWith('/HEAD')) ?? [])
    ];
  }

  activate(model: BranchOperation) {
    this.model = model;
    this.name = model.branch.name;
    this.upstream = model.branch.upstream ? `refs/remotes/${model.branch.upstream}` : ':none';
  }

  async save() {
    if (this.model.action === 'rename' && !(await this.validateFields('name'))) {
      return;
    }
    if (this.model.action === 'upstream' && this.upstream === ':none' && !this.model.branch.upstream) {
      await this.dialog.ok();
      return;
    }
    if (
      await this.workspace.action(
        this.model.action === 'delete' && this.model.branch.kind === 'remote' ? 'branch-delete-remote' : `branch-${this.model.action}`,
        {
          name: this.model.branch.name,
          reference: this.model.branch.hash,
          text: this.model.action === 'upstream' ? (this.upstream === ':none' ? '' : this.upstream) : this.name.trim(),
          force: this.force
        },
        false
      )
    ) {
      await this.dialog.ok();
    } else {
      this.error = this.workspace.lastError;
    }
  }

  cancel() {
    return this.dialog.cancel();
  }

  canDeactivate() {
    return !this.workspace.busy;
  }
}
