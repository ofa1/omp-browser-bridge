# Contributing to OMP Browser Bridge

Thank you for your interest in improving OMP Browser Bridge! This guide covers development workflow, local testing against isolated Firefox profiles, code quality checks, and release procedures.

## Architecture Overview

OMP Browser Bridge consists of three coordinated pieces:
1. **Firefox Add-on (`firefox/`)**: Manifest V2 WebExtension handling tab management, DOM inspection, accessibility snapshots, synthetic action dispatch, and toolbar popup UI.
2. **Native Messaging Host (`host/host.mjs`)**: Node.js/Bun executable launched by Firefox over standard I/O (`stdio`), bridging to local domain sockets / named pipes.
3. **omp Extension (`omp/index.ts`, `omp/client.ts`)**: Integrates with the `omp` coding agent CLI, registering `/firefox` commands and tool definitions (`firefox_tabs`, `firefox_navigate`, `firefox_snapshot`, `firefox_act`, `firefox_eval`, `firefox_screenshot`).

### Security & Content Isolation Architecture
- Communication between the native messaging host and content scripts avoids dynamic code strings. Operations such as `snapshot`, `act`, and bounds queries inject the bundled `firefox/content.js` file and dispatch typed messages via `browser.tabs.sendMessage`.
- Dynamic JavaScript evaluation (`firefox_eval`) is strictly opt-in and disabled by default. It requires the user to enable "Allow page JavaScript" in the extension popup.
- Popup commands (`setPaused`, `setAllowEval`, `closeAgentTabs`, `focusTab`) are restricted to messages originating from the extension's popup context.
- Native bridge socket directories (`~/.omp/firefox`) are verified for user ownership and strict permissions (`0700` directory, `0600` sockets/descriptors).

## Development Setup

### Prerequisites
- Node.js >= 18.0.0
- npm
- Firefox (Firefox Developer Edition or standard desktop release)
- [omp CLI](https://github.com/can1357/oh-my-pi)

### Setup Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/ofa1/omp-browser-bridge.git
   cd omp-browser-bridge
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Link the extension to your local `omp` installation:
   ```bash
   omp plugin link .
   ```

4. Register the native messaging host:
   ```bash
   npm run install-host
   ```
   Or inside omp:
   ```
   /firefox setup
   ```

## Development Workflow & Testing

### Running in a Development Firefox Profile
Run the extension in an isolated, temporary Firefox profile that auto-reloads when you make changes to extension files:

```bash
npm run dev
```

> **Note on macOS**: `npm run dev` points to `/Applications/Firefox.app/Contents/MacOS/firefox`. If your binary is in a custom path or on Linux/Windows, run:
> ```bash
> npx web-ext run --source-dir firefox --firefox <path-to-firefox> --start-url about:blank
> ```

### Linting and Code Quality

Run WebExtension lint checks:
```bash
npm run lint:addon
```

Run syntax checks across scripts and host code:
```bash
node --check host/host.mjs
node --check scripts/install-host.mjs
```

Build the production zip artifact:
```bash
npm run build:addon
```

## Cutting an AMO & GitHub Release

Mozilla Add-ons (AMO) requires strict version increments: **a published or submitted version number can never be reused or re-signed on AMO**.

When preparing a new release:
1. **Synchronize version numbers**:
   Bump `version` identically across both files:
   - `firefox/manifest.json`
   - `package.json`
2. **Update CHANGELOG.md**:
   Add a new entry following [Keep a Changelog](https://keepachangelog.com) conventions with the release date.
3. **Commit and Tag**:
   ```bash
   git commit -am "chore: release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```
4. **Automated CI/CD**:
   The GitHub Actions release workflow triggers on tags matching `v*`, verifies the tag version matches `firefox/manifest.json`, submits the extension for signing on AMO via `web-ext sign`, and creates a GitHub release with the signed `.xpi` artifact attached.
