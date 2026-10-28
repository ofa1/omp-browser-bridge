# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
