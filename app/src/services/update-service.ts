import { resolve } from 'aurelia';
import { UiToastService } from '@aurelia-ui-toolkits/headless';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { version } from '../../package.json';
import { compareVersions, newestRelease } from './release-version';

export class UpdateService {
  private toasts = resolve(UiToastService);
  private timer?: ReturnType<typeof setInterval>;
  private request?: AbortController;
  private active = false;
  private notified = '';
  private readonly storageKey = 'branchlight-notified-release';

  start() {
    if (this.active || !isTauri() || getCurrentWindow().label !== 'main') {
      return;
    }
    this.active = true;
    void this.check();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.request?.abort();
  }

  async check() {
    if (!this.active || this.request) {
      return;
    }
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const response = await fetch('https://api.github.com/repos/MaximBalaganskiy/gitaur/releases?per_page=100', {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        signal: request.signal
      });
      if (!response.ok) {
        return;
      }
      const latest = newestRelease(await response.json(), version);
      if (!latest || !this.active) {
        return;
      }
      let notified = this.notified;
      try {
        notified = localStorage.getItem(this.storageKey) || notified;
      } catch {
        // Retain session suppression when browser storage is unavailable.
      }
      if (compareVersions(latest, notified) !== 1 && compareVersions(latest, notified) !== null) {
        return;
      }
      await this.toasts.show({
        title: 'Update available',
        message: `Gitaur ${latest} is available. You are using ${version}.`,
        duration: 0,
        action: { label: 'View release', handler: () => void this.openRelease(latest) }
      });
      this.notified = latest;
      try {
        localStorage.setItem(this.storageKey, latest);
      } catch {
        // The in-memory value still prevents repeated notices this session.
      }
    } catch {
      // Offline, unavailable and rate-limited checks stay quiet until the next check.
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
    }
  }

  private async openRelease(release: string) {
    try {
      await invoke('open_release', { version: release });
    } catch (error) {
      await this.toasts.danger(`Could not open the release: ${String(error)}`);
    }
  }
}
