# Publication review — 16 October 2026

## Scope and evidence

The initial scan covered all 38 commits reachable from local branches/tags, including removed Electron sources. Gitleaks 8.30.1, verified against the upstream SHA-256 checksum, reported zero findings with `git . --log-opts='--all --full-history' --redact`. Reports are kept locally under the ignored test-results directory. This is a pattern-based scan, not a guarantee that every secret or confidential detail has been identified.

Current tracked files consist of application source, tests, build configuration, documentation, lockfiles, and project icons. Dependency caches, private test repositories, webview profiles, and development screenshots are ignored. Public documentation screenshots must come from disposable synthetic fixtures, not real repositories.

History was rewritten to use the Branchlight contributors project identity and remove personal contact details and private development references. Published dependency copyright notices are preserved. The GitHub account name and repository URL still identify the owner. The original GitHub repository was deleted and recreated privately on 16 October 2026. Only the cleaned main branch and five rewritten release tags were pushed; old releases, pull requests, Actions runs, and caches were not restored. The previously accessible old tip is no longer retrievable through the new repository's commit API. This does not guarantee erasure from GitHub's internal backups or existing clones. The ignored local recovery backup retains the previous history.

## Dependency review

The source uses MIT. The Rider Visual Studio Code Dark Plus 2.9.0 palette uses BSD-3-Clause. Exact upstream notice sources are recorded under `licenses/upstream/`. Renderer and Windows/Linux Rust dependencies are inventoried in THIRD_PARTY_NOTICES.txt, with exact source archive links and full license texts. Git and WebView2 are installed separately. Linux AppImage shared-library notices are collected from the packaging host.

The npm audit reported zero advisories. Cargo audit 0.22.2 reported zero vulnerability entries and two informational warnings: **RUSTSEC-2024-0370**, the unmaintained transitive build dependency `proc-macro-error` 1.0.4; and **RUSTSEC-2024-0429**, unsound `glib::VariantStrIter` methods in `glib` 0.18.5. **GitHub classified the GLib advisory as medium severity in the original repository; recreating the repository does not fix the dependency.** The latter enters through Tauri's Linux GTK stack; Branchlight does not directly use this iterator. This does not prove the entire transitive stack is unaffected. The fixed GLib API is 0.20+, which is not a drop-in replacement for GTK 0.18. Track an upstream-compatible fix; warnings are retained in CI rather than hidden with ignores.

### 19 October 2026 release review

For 0.4.0-beta.5, Gitleaks 8.30.1 scanned all 67 reachable commits without findings, and npm audit reported zero vulnerabilities. Cargo audit 0.22.2 passed with the two warnings recorded above and three new unmaintained-crate advisories: **RUSTSEC-2026-0370** (`zvariant` 5.15.1), **RUSTSEC-2026-0371** (`zbus_names` 4.3.5), and **RUSTSEC-2026-0372** (`zvariant_derive` 5.15.1).

These three crates enter through `tauri-plugin-opener` 2.7.2 and its Linux `zbus` 5.19.0 dependency. Their advisory records describe consolidation into `zbus` 6, with no patched standalone versions. Migration requires an upstream-compatible opener update; this release retains the locked dependencies and visible audit warnings. No advisory ignores were added.

### 20 October 2026 release review

For 0.4.0-beta.6, Gitleaks 8.30.1 scanned all 65 reachable commits without findings, and npm audit reported zero vulnerabilities. Cargo audit passed with the same five informational warnings reviewed for beta.5. Locked dependency versions are unchanged; the Node 26 and upstream-compatible Linux dependency conclusions above still apply. No advisory ignores were added.

The Linux packaging check detected AppImage runtime `fedfad51acc2860b2916a1eef32ba4a500ff31ef`, replacing `8f39b89e2ac31e1640b3d3f7e9a5108e6ce805fa`. The upstream comparison contains one build-script change: mapping temporary build paths to a fixed path for reproducible dependency binaries. Dependency source versions, checksums, and license files are unchanged. The runtime source links and revision check now record the reviewed revision; existing full license notices are retained.

## Remaining external checks

Actual GNOME/KDE, GPU/scaling, cross-application clipboard, and native chooser validation remain pending; see [platform testing](platform-testing.md). Windows signing requires publisher credentials.

The repository became public on 16 October 2026 after rechecking the cleaned history and passing the release candidate's security job. Private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and automated security updates are enabled. Dependency copyright notices remain intact.
