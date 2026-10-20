# Gitaur

![Gitaur: a gold guitar pick with a Git branch cutout](docs/images/gitaur-logo.png)

**A lightweight, open-source Git client for Windows and Linux.**

Explore your commit graph, stage individual lines, and resolve merge conflicts in a focused desktop workspace. Inspired by GitExtensions' graph and separate commit window, Gitaur works with your installed Git and existing authentication setup.

**[Download Gitaur for Windows or Linux →](https://github.com/MaximBalaganskiy/gitaur/releases)** · [Report a bug](https://github.com/MaximBalaganskiy/gitaur/issues) · [Full feature guide](docs/guide.md)

Gitaur is currently in **beta**, available for **Windows x64 and Linux x64**, and free under the [MIT license](LICENSE).

![Gitaur commit graph with branch lanes and highlighted file changes](docs/images/history.png)

## Download and run

Open [GitHub Releases](https://github.com/MaximBalaganskiy/gitaur/releases), choose the newest release, and expand **Assets** to find your download. Beta versions are marked as prereleases.

| Platform | Download | Start Gitaur |
| --- | --- | --- |
| Windows x64 | Installer ending in `_x64-setup.exe` | Run the installer, then launch Gitaur. |
| Windows x64 | `Gitaur.exe` | Run the executable directly. |
| Linux x64 | `.AppImage` | Make it executable, then launch it. |
| Debian / Ubuntu x64 | `.deb` | Install the package, then launch Gitaur. |

Install Git first and make sure it is on your PATH. Gitaur uses your existing Git identity, SSH configuration, and credential helpers; configure remote authentication in Git before fetching or pushing. You do not need Node.js or Rust to run a downloaded build.

**Windows:** binaries are currently unsigned, so Windows may display a security warning. Gitaur uses the shared WebView2 runtime; the installer downloads it if needed.

**Linux:** AppImage and Debian packages require WebKitGTK 4.1 support. Builds and automated X11/Wayland smoke tests run in CI; interactive GNOME/KDE desktop validation is still pending. See [platform coverage](docs/platform-testing.md) and [Linux launch notes](docs/guide.md#linux-display-servers).

## Try your first commit

1. Launch Gitaur and open a local repository with **Ctrl+O**, or choose **Clone repository…** on the welcome screen.
2. Select a commit to explore its changed files and highlighted diffs.
3. Make a small edit in your editor, return to Gitaur, and press **Ctrl+K** to open the separate commit window.
4. Review and stage the file, enter a commit message, then press **Ctrl+Enter** to commit.

For your first trial, use a sample repository so you can explore the workflow freely.

![Separate commit window for reviewing changes, staging files, and writing a commit message](docs/images/commit.png)

## Make everyday Git work easier

- **Find your place in history.** Follow branch lanes and merge connections, search commits and references, and browse any commit's complete file tree.
- **Build focused commits.** Stage whole files, individual lines, or hunks in a dedicated window. Keep per-repository message drafts and reuse commit templates.
- **Work through conflicts.** Compare Ours, Result, and Theirs in the merge editor, accept or edit changes, and resume saved resolution drafts after restarting.
- **Manage branches and worktrees.** Create and switch branches, move between worktrees, and fetch, pull, or push using your configured remotes.
- **Keep history tidy.** Amend commits, cherry-pick, revert, or edit a rebase plan. Browse the reflog to recover a commit onto a new branch.
- **Set up your workspace.** Choose light or dark mode, Normal or Compact density, and resizable panes with layouts saved per repository.

See the [full feature guide](docs/guide.md#included) for stashes, tags, submodules, Git LFS, keyboard shortcuts, and operation details.

## What to expect from the beta

Gitaur is usable preview software and does not yet offer full GitExtensions parity. Branch switching requires a clean working tree. Partial staging supports modified UTF-8 text files; other file types and changes use whole-file staging. Git LFS requires a separate installation.

See [current limits](docs/guide.md#preview-scope) before relying on a particular workflow. Updates are announced in the app with a link to the release page; downloading and installing them is manual.

## Help shape Gitaur

Try it for a few commits, then [tell us what worked and what got in your way](https://github.com/MaximBalaganskiy/gitaur/issues). Include your Gitaur version, operating system, and steps to reproduce a problem. Use a minimal sample repository and omit private code and credentials. Report security issues through [SECURITY.md](SECURITY.md).

## Build or contribute

Gitaur is built with Aurelia 2, aurelia-headless, its shipped Tailwind theme, and Tauri 2. To run from source, install Node.js 26, Rust, Git, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```sh
npm --prefix app ci
npm start
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, the [development guide](docs/guide.md#development) for builds and tests, and the [release guide](docs/releasing.md) for packaging and publishing.

Gitaur is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt) for dependency licenses. GitExtensions inspired the workflow; its application code is not bundled. Screenshots use a synthetic demonstration repository.
