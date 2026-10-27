import { bindable } from 'aurelia';
import './image-preview.css';

export class ImagePreview {
  failed = false;
  dimensions = '';
  actualSize = false;

  @bindable
  source = '';
  sourceChanged() {
    this.failed = false;
    this.dimensions = '';
    this.actualSize = false;
  }

  @bindable
  label = '';

  loaded(event: Event) {
    const image = event.target as HTMLImageElement;
    if (image.currentSrc !== this.source || !image.naturalWidth) {
      return;
    }
    this.failed = false;
    this.dimensions = `${image.naturalWidth} × ${image.naturalHeight}`;
  }

  loadFailed(event: Event) {
    const image = event.target as HTMLImageElement;
    if (image.currentSrc === this.source && image.complete && !image.naturalWidth) {
      this.failed = true;
    }
  }
}
