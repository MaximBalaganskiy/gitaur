import { resolve } from 'aurelia';
import { AlertService } from '@aurelia-ui-toolkits/headless';
import { distinctUntilChanged, type Subscription } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';
import { version } from '../../../package.json';
import { WorkspaceService } from '../../services/workspace-service';
import { AppearanceService } from '../../services/appearance-service';
import logo from '../../assets/gitaur.svg?url';
import './app.css';

export class App {
  readonly logo = logo;
  readonly version = version;
  readonly workspace = resolve(WorkspaceService);
  readonly appearance = resolve(AppearanceService);
  private alerts = resolve(AlertService);
  private timer?: ReturnType<typeof setInterval>;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private progressSubscription?: Subscription;
  working = false;

  binding() {
    this.progressSubscription = this.alerts.busy$.pipe(distinctUntilChanged()).subscribe(busy => {
      clearTimeout(this.progressTimer);
      if (busy) {
        this.progressTimer = setTimeout(() => {
          this.working = true;
        }, 200);
      } else {
        this.working = false;
      }
    });
  }

  unbinding() {
    this.progressSubscription?.unsubscribe();
    clearTimeout(this.progressTimer);
    this.working = false;
  }

  get tracking() {
    const snapshot = this.workspace.snapshot;
    return snapshot?.branches.find(branch => branch.kind === 'local' && branch.name === snapshot.branch)?.tracking || '';
  }

  attached() {
    void this.workspace.initialize();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('storage', this.onStorage);
    this.timer = setInterval(() => {
      if (document.hasFocus() && !this.workspace.busy && !this.workspace.refreshing) {
        void this.workspace.refresh();
      }
    }, 8000);
  }

  detaching() {
    clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('storage', this.onStorage);
    this.workspace.dispose();
  }

  toggleTheme() {
    this.appearance.theme = this.appearance.theme === 'dark' ? 'light' : 'dark';
  }

  toggleDensity() {
    this.appearance.density = this.appearance.density === 'normal' ? 'compact' : 'normal';
  }

  async openProjectRepository() {
    try {
      await invoke('open_project_repository');
    } catch (error) {
      this.workspace.fail(`Could not open GitHub: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key === 'branchlight-density') {
      this.appearance.density = event.newValue === 'compact' ? 'compact' : 'normal';
    }
    if (event.key === 'branchlight-theme') {
      this.appearance.theme = event.newValue === 'light' ? 'light' : 'dark';
    }
  };

  private onFocus = () => {
    if (!this.workspace.busy) {
      void this.workspace.refresh();
    }
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.key === 'F5') {
      event.preventDefault();
      void this.workspace.refresh();
    }

    if (this.workspace.mode !== 'browse') {
      return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      void this.workspace.open();
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'k' && this.workspace.repo) {
      event.preventDefault();
      void this.workspace.openCommit();
    }
  };
}
