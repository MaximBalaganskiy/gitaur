import type { ChangedFile } from '../interfaces/changed-file';

export function canResetFile(file: ChangedFile | null, staged: boolean) {
  if (!file || file.conflict || file.index === '?' || file.originalPath) {
    return false;
  }
  return staged ? file.staged && ['M', 'D', 'T'].includes(file.index) : file.unstaged;
}
