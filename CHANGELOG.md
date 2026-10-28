# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-10-28

### Added
- First-class subframe & iframe support:
  - `firefox_snapshot`: traverses accessible same-origin iframes with distinct boundary headers (`--- [frame #id] ---`) and ref indexing. Added `frameSelector` parameter to snapshot a target iframe directly.
  - `firefox_act`: added `frameSelector` to act steps; `resolve()` automatically searches accessible subframes if an element is not found in the root document. Mouse and pointer events dispatch using the subframe's `window` context.
  - `firefox_eval`: added `frameSelector` to execute scripts directly within an iframe's scope without manual `contentWindow` drilling.
  - `action: "wait"`: `check()` validates selectors and text within subframes.
- High-resolution 512x512 brand icon asset (`brand/icon-512.png`).

### Fixed
- Fixed subtree truncation in `firefox_snapshot`: container elements (`div`, `section`, `article`, etc.) with `tabindex >= 0` are no longer treated as leaf interactive elements if they contain interactive descendants, preventing child elements and iframes from being dropped.
- Hardened `contenteditable` / rich-text input in `firefox_act`: automatically focuses element, sets DOM selection range, and dispatches synthetic `beforeinput` and `input` events (`inputType: 'insertText'`) for apps like Google Keep and Draft.js.
- Set `strict_min_version` to `142.0` in `firefox/manifest.json`, eliminating AMO validation warnings for `data_collection_permissions`.

## [0.2.2] - 2026-10-28

### Changed
- No add-on behaviour changes; maintenance release exercising the new release pipeline.
- CI: multi-OS (Linux, macOS, Windows) x Node 18/22/24 test matrix, TypeScript typecheck, and a native Node test suite.
- Release workflow: GitHub release is created before asynchronous AMO submission; fails early if AMO credentials are missing.
- `npm run bump <version>` keeps `package.json`, `package-lock.json`, and `firefox/manifest.json` in sync with strict version validation.

## [0.2.1] - 2026-10-28

### Added
- `firefox_act` `upload` step: attaches local files to a file input (or its label / a container holding one, so hidden inputs behind styled buttons work). Files stream to the extension in chunks under Firefox's 1 MB native-messaging limit, up to 50 MB per step. No page JavaScript required.

## [0.2.0] - 2026-10-27

### Added
- Rich toolbar popup interface displaying connection status, agent control switch, active agent tabs list, and recent activity log.
- Brand identity assets: custom icon, wordmark, and social preview.
- Cross-platform native messaging host installer supporting macOS, Linux, and Windows.
- Automatic runtime detection with support for Node.js (>= 18) and fallback to embedded `omp` binary runtime (`BUN_BE_BUN=1`).
- Copying host files to a stable per-user location (`~/.omp/firefox/host/`) ensuring reliability across extension updates.
- Hardened Windows named pipe IPC using cryptographically random UUIDs (`\\.\pipe\omp-firefox-<uuid>`) discovered via per-user metadata (`0600`).
- Shell-free installer implementation on Windows and POSIX, eliminating relative PATH hijacking risks.
- `/firefox setup` and `/firefox uninstall` subcommands.
- Auto-setup check on `/firefox on` and session startup if host registration is missing or outdated.
- Configurable keyboard shortcut (`Alt+Shift+O`) to quickly toggle agent pause state.
- In-memory ring buffer tracking the last 50 browser actions and evaluation requests.

### Security & Hardening
- **Opt-in `firefox_eval`**: Disabled by default; requires explicit user opt-in via "Allow page JavaScript" switch in the toolbar popup (persisted in `storage.local`).
- **No dynamic code execution in content scripts**: `snapshot`, `act`, and measurement calls inject bundled `/content.js` and communicate via typed extension messages; only `eval` (when explicitly enabled by the user) executes dynamic code.
- **Popup sender verification**: State changes (`setPaused`, `closeAgentTabs`, `focusTab`, `setAllowEval`) are strictly restricted to the extension popup context; web content and content scripts cannot un-pause or modify extension state.
- **Immediate pause abort**: Pausing agent control immediately aborts in-flight action batches and active wait polling loops.
- **Approval tiers**: Sensitive inspection operations (`firefox_snapshot`, `firefox_screenshot`, `firefox_tabs select`) operate under `read` approval on agent-created tabs, but require `exec` approval when targeting the user's personal tabs.
- **Snapshot ref escaping**: Page text matching `[digits]` is automatically escaped as `\[digits]`, preventing malicious web pages from spoofing numbered action references. Newlines in page titles are sanitized to preserve snapshot header integrity.
- **Native messaging size limits & buffering**: Host enforces a 1 MB limit on requests to prevent native messaging host termination and caps socket line buffers at 64 MB.
- **Bridge directory validation**: Host and client verify that `~/.omp/firefox` is a real directory owned by the user with restricted permissions (`0700`), rejecting symlinks or non-compliant paths.
- **Predictable, safe uninstallation**: `uninstallHost` removes only files written by the installer and prunes the directory only if empty.

### Changed
- Refactored tab management with purple "omp" tab grouping for background agent tabs.
- Multi-instance support: `omp` automatically connects to the most recently started live Firefox instance.

## [0.1.0] - 2026-10-20

### Added
- Initial release of OMP Browser Bridge.
- Core WebExtension MV2 implementation for Firefox.
- Native messaging bridge communicating with `omp` coding agent over Unix domain sockets.
- omp extension providing browser interaction tools:
  - `firefox_tabs` (list, open, select, activate, close)
  - `firefox_navigate` (back, forward, reload, URL load with automatic snapshot)
  - `firefox_snapshot` (accessibility/DOM text snapshot with numbered element references)
  - `firefox_act` (batched interaction: click, dblclick, hover, focus, fill, type, press, select, check, uncheck, submit, scroll, wait)
  - `firefox_eval` (isolated async JavaScript evaluation in content script scope)
  - `firefox_screenshot` (viewport, full page, or element capture)
- Pause and resume enforcement mechanism.
- Automatic tab group association under the "omp" label.
