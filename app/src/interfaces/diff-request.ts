export interface DiffRequest {
  path: string;
  originalPath?: string;
  hash?: string;
  staged?: boolean;
  untracked?: boolean;
  fullFile?: boolean;
}
