import type { FilePreview } from './file-preview';

export interface ImageDiff {
  before: FilePreview | null;
  after: FilePreview | null;
}
