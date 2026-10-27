import { bindable, INode, resolve } from 'aurelia';
import type { DiffLine } from '../../interfaces/diff-line';
import type { ImageDiff } from '../../interfaces/image-diff';
import './diff-view.css';
import './syntax.css';

export class DiffView {
  private generation = 0;
  private element = resolve(INode) as HTMLElement;
  lines: DiffLine[] = [];
  truncated = false;
  selected: number[] = [];

  @bindable
  images: ImageDiff | null = null;

  @bindable
  text = '';
  textChanged() {
    void this.render();
  }

  @bindable
  filePath = '';
  filePathChanged() {
    void this.render();
  }

  @bindable
  isLoading = false;

  @bindable
  selectable = false;

  @bindable
  staged = false;

  @bindable
  resettable = false;

  @bindable
  disabled = false;

  toggle(index: number) {
    this.selected = this.selected.includes(index) ? this.selected.filter(value => value !== index) : [...this.selected, index];
  }

  apply(indices = this.selected, reset = false) {
    if (reset && !this.resettable) {
      return;
    }
    if (indices.length && !this.disabled && !this.isLoading && !this.truncated) {
      this.element.dispatchEvent(new CustomEvent(reset ? 'reset-selection' : 'stage-selection', { bubbles: true, detail: indices }));
    }
  }

  applyHunk(index: number, reset = false) {
    const indices: number[] = [];
    for (let cursor = index + 1; cursor < this.lines.length && this.lines[cursor].kind !== 'hunk'; cursor++) {
      if (['added', 'removed'].includes(this.lines[cursor].kind)) {
        indices.push(cursor);
      }
    }
    this.apply(indices, reset);
  }

  binding() {
    return this.render();
  }

  unbinding() {
    ++this.generation;
  }

  private async render() {
    const generation = ++this.generation;
    const { parseDiff } = await import('../../services/parse-diff');
    if (generation !== this.generation) {
      return;
    }

    this.truncated = this.text.split('\n').length > 12000;
    this.selected = [];
    this.lines = parseDiff(this.text, this.filePath);
  }
}
