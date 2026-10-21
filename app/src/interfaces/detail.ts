export interface Detail {
  message: string;
  files: CommitFile[];
  localBranches: string[];
  remoteBranches: string[];
}
import type { CommitFile } from './commit-file';
