import type { ChangedFile } from '../interfaces/changed-file';

export function canDeleteFile(file: ChangedFile | null) {
  return (
    !!file && !file.conflict && !file.originalPath && (['?', 'A'].includes(file.index) || (file.index === ' ' && file.worktree === 'A'))
  );
}
