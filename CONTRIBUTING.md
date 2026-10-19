# Contributing to Gitaur

Gitaur is a preview Git client. Changes that protect repository data, improve platform compatibility, or make daily workflows reliable are especially useful.

Discuss substantial changes in an issue before implementing them. For bugs, include a minimal disposable repository and reproducible steps. Never attach a private repository or unredacted credentials. Follow [SECURITY.md](SECURITY.md) for security reports.

## Setup

Install Node.js 26 (see `.node-version`), Rust stable, Git, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Then run `npm --prefix app ci` and `npm start` from the repository root. Git LFS is optional; install it to test LFS workflows.

Follow [AGENTS.md](AGENTS.md), the existing component structure, and the formatter. Use the shipped Aurelia Headless controls and theme. Keep each class/interface in its own file and source readable; only production output is minified.

## Before submitting

From `app/`, run:

```sh
npm run format:check
npm run check:conventions
npm test
npm run check:native
npm run build
```

For desktop changes, build with `npm run pack` and run `npm run test:e2e` on Windows. Linux desktop checks are described in [the platform test guide](docs/platform-testing.md). Check keyboard navigation, errors, empty states, and both densities. Tests must use disposable repositories, never a contributor's working repositories.

Git mutations need integration tests for failure and stale-state paths, not just successful commands. Include the checks you actually ran and any platform limitations in the pull request. Keep commits focused. Do not include generated binaries, caches, user profiles, credentials, or unrelated formatting changes.

## Dependencies and licensing

Contributions are provided under this repository's MIT license. Third-party code retains its own license. Record provenance for copied code, assets, and themes; do not copy code from incompatible or unlicensed sources. Dependency updates must refresh the notices and pass the publication checks described in [the release guide](docs/releasing.md).
