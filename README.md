# Gitaur

![Gitaur: a gold guitar pick with a Git branch cutout](docs/images/gitaur-logo.png)

A local desktop Git client built with **Aurelia 2**, **aurelia-headless**, its shipped Tailwind theme, and **Tauri 2**. Inspired by GitExtensions' commit graph and separate staging window.

**Preview software — Windows x64 and Linux x64.** Gitaur is MIT licensed. It uses your installed Git and authentication configuration. Windows binaries are unsigned; Linux GNOME/KDE desktop validation is still pending. See [platform coverage](docs/platform-testing.md), [known limitations](#preview-scope), and [security reporting](SECURITY.md).

![Commit graph and highlighted file changes](docs/images/history.png)

<details>
<summary>Separate staging and commit window</summary>

![Staging and commit window](docs/images/commit.png)

</details>

Screenshots use a synthetic demonstration repository.

## Run

Download the Windows executable or installer, or the Linux AppImage or Debian package, from [GitHub Releases](https://github.com/MaximBalaganskiy/gitaur/releases). Download visibility follows repository access. Keep the accompanying license and third-party notices when redistributing binaries.

The main window checks public GitHub Releases at startup and every six hours. A newer version shows a dismissible notification with a link to its release page. Each version is announced once per profile, including across restarts; another notice appears only for a newer version. Beta installations include prereleases, while stable installations check stable releases only. Offline, inaccessible and rate-limited checks stay quiet. Updates are downloaded and installed manually.

Open `app/release/windows/Gitaur.exe` after packaging, or run from source:

```powershell
npm --prefix app ci
npm start
```

Development requires Node.js 26, Rust, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). The supported Node major is recorded in `.node-version`, which also selects the runtime for CI. On Windows, install the Visual Studio C++ build tools and Windows SDK. Install Git on PATH (or set `GITAUR_GIT` to its executable). The desktop app uses your installed Git, identity, SSH configuration, and credential helpers. Remote authentication must already be configured. This preview does not provide a login wizard.

The Windows executable embeds the bundled, minified UI and uses the shared WebView2 runtime. The NSIS installer downloads WebView2 if it is missing. Neither Node nor Git is bundled. Linux uses WebKitGTK; build Linux packages on Linux with `npm --prefix app run pack:linux`. Linux packaging and native Git integration tests are validated in GitHub Actions; interactive Linux desktop behavior has not yet been validated.

### Linux display servers

The GTK/WebKitGTK shell supports native Wayland and X11. GTK selects the available display backend; Gitaur does not force X11. The locked Tauri CLI includes the AppImage bundler's native Wayland fixes. The same Aurelia UI and separate commit window are used on both backends.

To explicitly select native Wayland when launching an AppImage from your Wayland session:

```bash
GDK_BACKEND=wayland ./Gitaur_0.4.0-beta.3_amd64.AppImage
```

Use the filename of your downloaded AppImage. For a Debian installation, run `GDK_BACKEND=wayland gitaur`. `GDK_BACKEND=x11` selects X11 instead (requiring XWayland in a Wayland session). Wayland compositors control window placement; restoring exact screen coordinates is not guaranteed, while size and maximized state remain saved.

Native Wayland desktop testing on GNOME/KDE, including clipboard, file dialogs, scaling, and multiple windows, is still pending. For driver-specific rendering problems, consult [Tauri's Linux graphics troubleshooting](https://v2.tauri.app/develop/debug/linux-graphics/); Gitaur does not disable hardware acceleration globally.

Measured Windows x64 release (14 October 2026): **3.64 MiB** executable, **1.44 MiB** installer. Loading 300 commits and the initial diff from the headless repository took approximately **1.5 seconds** on this development machine, using both fresh and existing WebView2 profiles. These artifact sizes exclude the shared WebView2 runtime and installed Git.

## Included

- Commit graph with branch lanes, merge connections, refs, author, date, and SHA.
- Local branches, remote branches, tags, commit search, and paginated history (up to 100,000 commits). Selecting an unloaded branch tip automatically expands history and scrolls to it.
- Headless reference tree groups slash-separated branch and tag names into folders, with remotes grouped by name. Arrow keys navigate the tree; search reveals matching paths and clearing it restores collapsed folders.
- Changed files, syntax-highlighted unified diffs using Lowlight/highlight.js, full commit messages, and a Git command log.
- Files tab with the complete selected commit's file tree and highlighted historical contents, including unchanged files. Binary files and submodule pointers show an explanatory preview; text previews are limited to 2 MiB and 12,000 lines.
- Filename filtering and search within historical file contents, with a search icon inside each input.
- Context menus on commits and references for browsing, copying, creating branches, checking out, and merging.
- A separate native desktop window for staging, unstaging, reviewing, and committing whole files.
- Stage or unstage selected lines and complete hunks in modified UTF-8 text files. The working file stays intact; stale diffs are rejected. Added/deleted/renamed files, mode changes, binary files, links, and submodules still use whole-file staging.
- Flat/tree staging lists, changed-file filtering, and an action to ignore an untracked file. Ignore rules escape pattern characters; the resulting `.gitignore` edit remains unstaged for review.
- Commit drafts saved per repository; changes synchronize between open windows.
- Commit-message dropdown with recent messages, the repository's configured `commit.template`, and named templates saved in the app.
- Amend the last commit, including message-only corrections, with a review prompt. Undo a normal last commit with a soft reset, retaining index and working files; root and merge commits are excluded. Both operations reject a changed HEAD and warn about rewriting published history.
- Stash tracked changes and optionally untracked files, inspect saved diffs, apply/pop with the saved index state, and confirm deletion. Apply/pop require a clean working tree; failed application retains the stash.
- Merge into the current branch, review before committing, and abort a merge. The internal merge editor shows complete, syntax-highlighted Ours / Result / Theirs files with an optional common ancestor, resizable panes, synchronized scrolling, blank spacer rows aligning corresponding lines, and inline differences from CodeMirror's merge engine. Line alignment uses jsdiff and falls back to simplified alignment for very large differences. Sources are compared with the result; the result is compared with the ancestor. The editable result preserves Git's automatic merges and initially uses ours for unresolved regions without showing Git markers. Accept either side, keep both orderings, or edit and mark a conflict resolved. F7/Shift+F7 navigates remaining conflicts. The conflict selector also revisits resolved decisions; replace an earlier choice directly or reopen it while keeping its text. Later decisions and edits outside that region are preserved. Undo/redo restores both text and resolution decisions. Every conflict must be resolved before saving and staging. Unsaved drafts and externally modified files are protected. Text editing is limited to UTF-8 files up to 1 MiB; binary/large files can use an entire side and externally resolved text can be marked resolved.
- Collapsible Worktrees section above local branches in the sidebar, with folder names, checked-out branches, current-worktree markers, and full paths on hover. Click to switch worktrees, use the header's add button to create one on a new branch, or right-click for open/copy-path/remove actions. Removal preserves the branch and refuses dirty, current, main, or locked worktrees.
- Inline merge controls beside each conflict, CodeMirror find/replace (Ctrl+F or Ctrl+H, with case and regex options), and word wrap. Wrapping scrolls to corresponding code; turn it off for exact spacer-row alignment. Resolution drafts autosave locally, survive app restarts, and restore only when the conflict is unchanged. Stale drafts remain available to copy from.
- Dedicated binary/large-file side choices, delete/rename resolutions with an optional new path, and submodule conflict resolution by indexed side or a commit in the initialized submodule. Renamed paths are resolved individually; choosing a submodule side updates the index without changing its checkout.
- Repository tools: searchable reflog recovery onto a new branch, lightweight/annotated tags, individual tag pushes and confirmed local/remote tag deletion. Remote deletion uses an expected-object lease. Creating a tag is also available from a commit's context menu.
- Submodule listing, add, initialize/update recursively, sync URLs, open, and confirmed removal. Updates/removal refuse local changes. Git's configured transport policy applies to submodule URLs.
- Git LFS detection, repository-local setup, tracking/untracking patterns, file/status inspection, and remote fetch/pull/push. Git LFS must be installed separately. Tracking updates `.gitattributes`; commit it and re-stage matching files. Existing history is not migrated.
- Create and switch local branches, add/edit/remove remotes, fetch, fast-forward pull, and push to the configured upstream. Push opens a publishing dialog when no upstream exists; choose the remote and destination branch. Remote removal confirms the name and removes its local tracking references without deleting the server repository.
- Compact repository-name menu in the top bar switches between recent repositories and opens new ones. Full paths distinguish identical folder names.
- Resizable panes, light/dark themes, Normal/Compact density, recent repositories, and keyboard shortcuts. Normal density is the default; appearance choices are saved and synchronized between windows.
- Main and commit windows remember their size, position, and maximized state separately across launches; unavailable monitors fall back to OS placement. All splitter positions, including collapsed panes, are saved separately for each repository in both windows.
- Integrated title bar on main and commit windows, with headless minimize, maximize/restore, and close buttons. Drag the header's empty space or title to move the window; double-click to maximize/restore. Repository and appearance controls remain interactive. Resizing uses Tauri's native undecorated-window support; Linux compositor behavior still needs desktop validation.
- The title bar shows the installed app version and links to the Gitaur GitHub repository in your default browser.

| Shortcut | Action |
| --- | --- |
| Ctrl+O | Open repository |
| Ctrl+K | Open commit window |
| F5 | Refresh |
| Enter in commit search | Select next match |
| Ctrl+Enter in commit window | Commit staged files |
| Ctrl+F / Ctrl+H in merge editor | Find / replace in result |
| F7 / Shift+F7 in merge editor | Next / previous unresolved conflict |

Branch switching currently requires a clean working tree. Clicking a branch name selects its tip; the arrow beside a different local branch checks it out. Merge commit changes are compared with the first parent.

## Preview scope

Clone or create a repository from the repository menu or welcome screen. Right-click a local branch to rename/delete it or set its upstream. Manage remotes directly in the reference tree: the Remotes section has an add button, and each remote has a context/actions menu for fetch, edit, and confirmed removal. Configured remotes remain visible before their first fetch. The edit form supports a separate push URL and pruning on fetch.

Right-click a commit to cherry-pick, revert, reset the current branch, or rebase onto it. Merge commits require selecting a mainline parent for cherry-pick/revert. Reset offers soft, mixed, and explicitly confirmed hard modes; hard reset refuses untracked files and overlapping ignored files. History operations check the current branch and HEAD again before applying changes.

Ordinary rebase preserves merges. **Edit rebase plan from here** opens a linear history plan, oldest first, with reorder, pick, edit, reword, drop, squash, and fixup controls. Arrange matching `fixup!`/`squash!` commits with the autosquash button, then review the resulting plan. Ambiguous or unmatched subjects remain unchanged. Squash combines the existing messages; fixup keeps the preceding message. Edit/reword pause in the commit window: use **Edit paused commit** to amend its full message and any staged edits, then Continue. A conflicted cherry-pick, revert, or rebase also opens the commit window, with Continue, Skip, and Abort controls. The window closes when the operation completes. During rebase, “Ours” is the new base plus commits already replayed; “Theirs” is the commit being replayed.

This is an initial usable version, not full GitExtensions parity. Editable rebase plans do not yet edit merge topology or arbitrary exec/break instructions. LFS history migration and file locking, nested submodule management as a tree, and external merge-tool launching remain outside the UI. Reflog browsing is limited to the latest 1,000 entries; expired entries cannot be recovered here. Merge regions are initialized from Git's conflict markers and tracked through edits. Partial staging is unavailable for truncated previews. Untracked text previews are limited to 1 MB; rendered diffs are limited to 12,000 lines. Repository changes are refreshed on focus, after an app operation, and every eight seconds while focused.

## Development

### Automated binaries and releases

The **Build desktop binaries** GitHub Actions workflow builds Windows x64 and Linux x64 on every push to `main`, pull request, or manual run. Each build runs formatting, source checks, renderer tests, Git integration tests, and Clippy before packaging. Windows desktop workflows and Linux X11/Wayland smoke tests then run against the native executable. A separate job scans Git history and audits npm/Rust dependencies. Download the two platform artifacts from the workflow run; they are retained for 14 days.

Push a version tag such as `v0.1.0` to publish a GitHub Release after both platforms pass. The tag must match the versions in `app/package.json`, `app/src-tauri/tauri.conf.json`, and `app/src-tauri/Cargo.toml`. Tags containing a suffix such as `-beta.1` create prereleases. Releases contain:

- `Gitaur.exe`: Windows executable.
- `Gitaur_<version>_x64-setup.exe`: Windows NSIS installer.
- Linux `.AppImage` and `.deb` packages.
- `SHA256SUMS.txt`: checksums for all four downloads.
- `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and `LINUX_RUNTIME_NOTICES.txt`: redistribution notices and dependency source links.

Release assets remain available independently of Actions artifact retention and inherit repository visibility. Windows binaries are unsigned. Git must be installed separately; Windows uses the shared WebView2 runtime. On Linux, mark the downloaded AppImage executable with `chmod +x *.AppImage`. Linux packages are built on Ubuntu 22.04 for compatibility with systems providing WebKitGTK 4.1.

### Local commands

```powershell
npm run build       # TypeScript checks and production renderer
npm test            # Rust Git integration, graph, and highlighting tests
npm run pack        # Native release executable with embedded frontend
npm run test:e2e    # Real Windows WebView2 staging/commit workflow
npm --prefix app run pack:installer # Windows NSIS installer
npm --prefix app run pack:linux     # Linux .deb and AppImage (run on Linux)
npm --prefix app run test:packaged  # Check the packaged desktop workflow
npm --prefix app run check:conventions
npm --prefix app run check:native
npm --prefix app run format:check
```

Tests create disposable repositories under `.test-repos/` or the OS temporary directory; they do not modify your working repositories. Desktop smoke-test screenshots are written to `app/test-results/`. `npm --prefix app run dev` runs only the renderer in a browser; filesystem and Git operations require the desktop app. The Windows smoke test enables WebView2 debugging only for its isolated test process and profile.

The renderer invokes a fixed set of Rust commands. Rust owns each window's repository path and launches Git with argument arrays, literal pathspecs, and no shell interpolation. There is no generic shell or filesystem API exposed to the UI. Git hooks and signing behave as configured in the repository. Same-repository windows receive change events after Git operations.

Source layout: `app/src/views/` contains folder-based views; `elements/` contains reusable components; `services/` contains workspace, graph, diff, and Tauri bridge logic; `interfaces/` has one contract per file. `app/src-tauri/src/` contains the native shell, commands, Git service, and individual model files. Native integration tests are in `app/src-tauri/tests/`; renderer and desktop tests are in `app/test/`.

Build caches (`app/src-tauri/target/`), `node_modules`, and optional workspace toolchains (`.toolchains/`) are development files, not distribution contents. `scripts/native.cjs` uses the workspace Rust/compiler fallback when present and otherwise uses the installed toolchain. Packaging copies the executable into `app/release/windows/` or `app/release/linux/` and installer packages directly into `app/release/`. Only these collected artifacts need distributing.

Headless supplies buttons, inputs, tabs, splitters, dialogs, and service-created toast notifications. The app imports `@aurelia-ui-toolkits/headless-tailwind` and uses its Normal and Compact density tokens, with inset field labels enabled globally. Templates use inline Tailwind layout utilities; reusable app selectors use nested CSS. `AGENTS.md` and the formatter record these conventions.

Forms use Aurelia Validation with the Headless validation-controller factory. Field messages and accessible invalid states are rendered by the inputs; Git-operation errors are displayed separately. Search and optional free-text fields do not require arbitrary validation rules.

Dark mode uses the UI and editor palette from Alexander Makarov's [Visual Studio Code Dark Plus theme](https://github.com/samdark/intellij-visual-studio-code-dark-plus/tree/v2.9.0) for Rider (plugin 2.9.0, BSD-3-Clause). The colours override headless semantic tokens in `app/src/styles/dark-plus.css`; the diff styles map the editor palette to Lowlight's token categories. Syntax classification remains Lowlight's, so it does not reproduce Rider's language-aware semantic highlighting exactly. Light mode retains its separate palette.

## Contributing and licensing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release guide](docs/releasing.md). Gitaur's source is [MIT licensed](LICENSE); third-party components retain their own licenses and attribution in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). GitExtensions inspired the workflow; its application code is not bundled. The [publication review](docs/publication-audit.md) records audit scope, dependency warnings, and remaining platform checks.
