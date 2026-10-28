# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within OMP Browser Bridge, please do not open a public issue. Instead, report it privately via GitHub Security Advisories:

**[Submit a Private Vulnerability Report](https://github.com/ofa1/omp-browser-bridge/security/advisories/new)**

Reports are reviewed promptly. Please provide:
- A description of the vulnerability and potential impact.
- Step-by-step instructions or proof-of-concept to reproduce the behavior.
- Affected platforms, operating system versions, and Firefox versions.

---

## Threat Model & Security Boundaries

OMP Browser Bridge allows the `omp` coding agent to inspect web pages, capture screenshots, and dispatch user interactions inside your active Firefox browser instance. Understanding the design boundaries, accepted-by-design trade-offs (D1–D7), and built-in mitigations helps ensure safe operation.

### Accepted-by-Design Considerations

#### D1: Local Same-User Access
**Any process running as your local user can drive the browser while the add-on is unpaused.**
- While Firefox is running with the add-on active and unpaused, any process executing under your local operating system account can connect to the local socket or named pipe and interact with open browser tabs using your existing logins and cookies.
- This is by design: `omp` and its extensions run as your local user account without administrative privilege.
- *Distinction*: Settings inside `omp` (such as `/firefox off`, tool inactivity, or approval prompts) are agent-side workflow controls, not OS-level security boundaries.
- *Mitigation*: The primary boundary is the add-on's **Pause** toggle in the toolbar popup (and shortcut <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>). When paused, the add-on immediately rejects all bridge requests and aborts in-flight actions. Local IPC endpoints are restricted to user-only permissions (`0700` directory, `0600` sockets/files).

#### D2: `firefox_eval` Privileges
**When enabled, `firefox_eval` runs with the add-on's `<all_urls>` privileges.**
- In Firefox MV2, content scripts execute with extension privileges that bypass the page's Content Security Policy (CSP).
- Furthermore, content-script `fetch` requests can make cross-origin requests to any origin matching `<all_urls>` including the user's active session cookies.
- *Mitigation*: `firefox_eval` is **disabled by default**. It cannot run until the user explicitly toggles "Allow page JavaScript" in the toolbar popup. In `omp`, `firefox_eval` always requires explicit `exec` approval.

#### D3: Access to User Tabs vs. Agent Tabs
**Reading the user's existing personal tabs requires elevated confirmation.**
- A prompt-injected agent might attempt to inspect tabs containing confidential information (such as personal email, financial dashboards, or session tokens).
- *Mitigation*: Multi-tiered approval enforcement in `omp`:
  - `firefox_snapshot`, `firefox_screenshot`, and `firefox_tabs select` run under `read` approval **only on agent tabs** (tabs created by `omp` in the purple tab group).
  - Targeting any personal, non-agent tab automatically elevates the approval requirement to **`exec`**, requiring explicit user confirmation before any content or visual snapshot is captured.

#### D4: Inherent Indirect Prompt Injection
**Web pages can contain instructions aimed at manipulating the AI agent.**
- Untrusted web content, comments, reviews, documentation, or hidden text (tiny fonts, off-screen CSS, or low contrast) can contain adversarial prompts designed to mislead the language model into navigating away, clicking destructive buttons, or leaking information.
- *Mitigations*:
  - **Snapshot Ref Escaping**: Page text matching `[digits]` is automatically escaped as `\[digits]`, preventing malicious sites from faking clickable element markers.
  - **Password Masking**: Input elements with `type="password"` have their values masked in text snapshots (`••••••••`).
  - **Tab Group Isolation**: Agent tabs open in the background inside a distinct purple "omp" tab group so actions are visually conspicuous.
  - **Confirmation for Actionable Steps**: Sensitive actions (`firefox_act`, `firefox_navigate`, `firefox_eval`) require `exec` approval. Confirm any consequential submits, purchases, or deletions.

#### D5: Background Tab Screenshots
`firefox_screenshot` can capture tabs that are not currently focused (`captureTab`). This enables the agent to verify page layout without disrupting your current browsing focus, but requires the same awareness as page text inspection.

#### D6: Private Browsing Isolation
The add-on does not run in Private Browsing windows by default unless explicitly granted permission by the user in `about:addons` ("Run in Private Windows").

#### D7: Native Host Extension Binding
The native messaging host manifest specifies `allowed_extensions: ["omp-firefox-bridge@omairahmed"]`. Firefox strictly prevents any other add-on from launching or communicating with this native host unless the extension ID matches.

---

## Defensive Engineering & Hardening

1. **Local-Only IPC**:
   - macOS / Linux: Unix domain sockets in `~/.omp/firefox/<pid>.sock` with `0700` directory and `0600` socket permissions.
   - Windows: Named pipes with cryptographically random UUIDs (`\\.\pipe\omp-firefox-<uuid>`), published exclusively via per-user metadata files (`~/.omp/firefox/<pid>.json`).
   - Host and client validate that `~/.omp/firefox` is a genuine directory owned by the current user with no group/other permissions, rejecting symlinks.
2. **Shell-Free Installer**:
   - The installer invokes binaries directly without invoking `cmd.exe` or `sh`, searching absolute `PATH` entries in JavaScript to eliminate relative directory binary hijacking.
3. **Popup Context Verification**:
   - Control operations (`setPaused`, `setAllowEval`, `closeAgentTabs`, `focusTab`) are accepted exclusively from the extension's popup UI; content scripts, web pages, and eval code cannot modify extension pause or permission state.
4. **Immediate Pause Enforcement**:
   - Pausing agent control immediately aborts multi-step batches in `firefox_act` and stops polling wait loops.
5. **Payload and Buffer Limits**:
   - Host limits requests to 1 MB to prevent native messaging channel termination and caps socket buffer memory at 64 MB.
6. **No Network Requests**:
   - The add-on and native messaging host make zero external network requests (`data_collection_permissions: none`).
