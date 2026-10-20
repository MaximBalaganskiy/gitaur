import { RepositoryToolDialog } from '../repository-tool-dialog';
import type { Branch } from '../../../interfaces/branch';
import type { Remote } from '../../../interfaces/remote';

export class DeleteTagDialog extends RepositoryToolDialog {
  tag!: Branch;
  remoteDeletion = false;
  remotes: Remote[] = [];
  remote = '';
  object = '';

  get title() {
    return this.remoteDeletion ? 'Delete remote tag' : 'Delete local tag';
  }

  activate(model: { tag: Branch; remote: boolean }) {
    this.tag = model.tag;
    this.remoteDeletion = model.remote;
  }

  async load() {
    const tags = await this.workspace.client.tags();
    const tag = tags.find(item => item.name === this.tag.name);
    if (!tag || tag.target !== this.tag.hash) {
      throw new Error('The tag changed or no longer exists. Close this dialog and refresh.');
    }
    this.object = tag.object;
    if (this.remoteDeletion) {
      this.remotes = await this.workspace.client.remotes();
      this.remote = this.remotes[0]?.name ?? '';
    }
  }

  async save() {
    if (this.loading || !this.object || (this.remoteDeletion && !this.remote)) {
      return;
    }
    if (
      await this.workspace.action(
        this.remoteDeletion ? 'tag-delete-remote' : 'tag-delete',
        {
          name: this.tag.name,
          reference: this.object,
          url: this.remote
        },
        false
      )
    ) {
      await this.dialog.ok();
    } else {
      this.error = this.workspace.lastError;
    }
  }
}
