# Privacy Policy for OMP Browser Bridge

**Last updated**: October 2026

**OMP Browser Bridge** is designed from the ground up to respect user privacy and operate transparently. The add-on is open-source (MIT licensed) and functions as a local execution bridge between your browser and the local `omp` coding agent running on your computer.

*Setup note*: This add-on requires the companion `omp` CLI and native messaging host installed on your machine. See the setup guide at: https://github.com/ofa1/omp-browser-bridge#setup

---

### 1. Data Processed Locally

When directed by the user via the `omp` coding agent, the add-on accesses and processes the following information from active or agent-controlled browser tabs:

- **Page Content & DOM Structure**: Text, form controls, links, and element attributes necessary to compute DOM-derived text snapshots and execute requested browser interaction actions.
- **Visual Screenshots**: Viewport, full-page, or element-level screenshots captured when explicitly requested by an agent tool call (`firefox_screenshot` or `firefox_navigate`).
- **Tab Metadata**: Tab IDs, window IDs, page URLs, page titles, and loading statuses to manage agent tabs and display active tabs in the toolbar popup.
- **Opt-In Script Evaluation Results**: Values returned from JavaScript expressions executed within web page contexts via the `firefox_eval` tool. **This feature is strictly opt-in and disabled by default.** It only executes if the user explicitly enables "Allow page JavaScript" in the toolbar popup.

---

### 2. How Data is Transmitted (100% Local Communication)

- **Local Transport**: All data processed by the add-on is transmitted strictly to the local `omp` process on the same machine through a local native messaging host (`omp-firefox-host`) communicating over:
  - **macOS / Linux**: A local Unix domain socket (`~/.omp/firefox/<pid>.sock`) secured with restrictive filesystem permissions (directory mode `0700`, socket mode `0600`).
  - **Windows**: A secure local named pipe (`\\.\pipe\omp-firefox-<uuid>`).
- **No Remote Transmission by the Add-on**: The add-on and its native messaging host **never** transmit any data to the developer, to Mozilla, or to any third-party servers. The add-on contains no analytics, telemetry, tracking code, or remote reporting mechanisms.
- **Manifest Declaration**: The add-on manifest explicitly declares `"data_collection_permissions": { "required": ["none"] }`.

---

### 3. Role of the `omp` Coding Agent & LLM Providers

- The browser add-on acts purely as an execution bridge. It delivers requested page content and screenshots to the local `omp` CLI process.
- **The `omp` CLI process—not this add-on—controls what data is subsequently forwarded to large language model (LLM) providers.**
- Depending on the user's personal `omp` configuration, `omp` may send page snapshots, text, or screenshots to an external LLM provider (such as Anthropic, OpenAI, or a custom endpoint) or process them completely locally using a local model (such as Ollama).
- Users should review the privacy policies of the LLM providers they configure within `omp`.

---

### 4. Local Storage & In-Memory Activity Logging

- **Local Storage (`storage` permission)**: The add-on uses `browser.storage.local` solely to persist the user's explicit preference for the **"Allow page JavaScript"** opt-in toggle across browser sessions. No browsing history, page contents, session tokens, or personal identifiers are stored.
- **In-Memory Activity Logging**: For user transparency and safety, the add-on maintains a transient log of recent agent actions (up to 50 operations) visible in the toolbar popup.
  - To protect user privacy, sensitive details (such as full script code passed to `eval`) are omitted from the log (only character length is noted).
  - This activity log is stored **strictly in memory** within the extension's background process. It is never written to disk, never synchronized across devices, and is completely discarded whenever the browser closes or the extension reloads.

---

### 5. User Controls & Oversight

- **Pause / Resume**: Users can immediately pause all agent interactions at any time by pressing **`Alt+Shift+O`** or toggling the Agent Control switch in the toolbar popup. When paused, any incoming agent requests and in-flight action batches are immediately aborted.
- **JavaScript Execution Control**: The "Allow page JavaScript" toggle allows the user to completely disable `firefox_eval`. It remains off by default.
- **Agent Tab Segregation**: All agent-created tabs are clearly grouped in a purple "omp" tab group, allowing the user to monitor agent browsing at a glance.
- **One-Click Close**: The popup provides a "Close agent tabs" button to instantly close all agent-opened tabs.

---

### 6. Contact and Source Code

The full source code of OMP Browser Bridge is available for inspection and audit at:
https://github.com/ofa1/omp-browser-bridge

For questions or issues regarding this privacy policy, please open an issue on GitHub:
https://github.com/ofa1/omp-browser-bridge/issues
