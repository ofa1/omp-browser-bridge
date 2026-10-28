# Reviewer Notes for OMP Browser Bridge

**Add-on ID**: `omp-firefox-bridge@omairahmed`  
**Version**: `0.2.0`  
**Source Repository**: https://github.com/ofa1/omp-browser-bridge (MIT License)

Thank you for reviewing **OMP Browser Bridge**! This document explains the purpose of the extension, the necessity of requested permissions, our execution architecture and message-based content script design, sender validation, and step-by-step instructions to test the add-on with its companion local native messaging host.

---

### 1. Purpose of the Add-on

OMP Browser Bridge is an open-source companion extension for the **omp** coding agent ([oh-my-pi](https://github.com/can1357/oh-my-pi)). It allows a software developer using the `omp` CLI in their local terminal to drive Firefox during local web application development, debugging, and testing workflows:
- Inspecting web pages via fast, DOM-derived text snapshots with numbered element references (e.g. `[1] textbox "Email"`).
- Automating form submission, button clicking, typing, select options, and scrolling over local development servers (e.g. `http://localhost:3000`).
- Capturing screenshots of full pages, viewports, or specific DOM elements.
- Running optional, user-approved JavaScript expressions within page contexts via the `firefox_eval` tool for deep diagnostic inspection.

All communication is strictly local between the user's terminal and their local browser instance.

---

### 2. Permissions Justification

| Permission | Justification |
| :--- | :--- |
| `nativeMessaging` | Required to exchange JSON messages with the local native messaging host executable (`omp-firefox-host`). The native host connects the browser to the local `omp` CLI process via a local Unix domain socket (`~/.omp/firefox/<pid>.sock`) or Windows named pipe. No internet network calls are made. |
| `tabs` | Needed to inspect tab metadata (IDs, URLs, titles, loading status), open agent-controlled tabs when browsing sessions start, activate tabs, close tabs, capture viewport images via `browser.tabs.captureTab`, and inject content scripts. |
| `tabGroups` | Used to organize all agent-created tabs into a visible, purple "omp" tab group. This gives the user clear visual transparency into agent activity and allows them to monitor or close agent tabs at any time. |
| `<all_urls>` | The add-on is a general-purpose local development assistant. Developers direct the agent to test and inspect arbitrary local servers (`http://localhost:*`), staging environments, and documentation sites. The extension must be able to inject its interaction script into URLs the user instructs the agent to visit. Privileged internal Firefox pages (`about:*` and `addons.mozilla.org`) are never scripted and are explicitly rejected. |
| `storage` | Used exclusively via `browser.storage.local` to persist the user's explicit opt-in preference for the "Allow page JavaScript" toggle (`allowEval: true/false`) across browser sessions. No user data, history, or tokens are ever stored. |

---

### 3. Execution Architecture, Messaging, and Opt-In `eval`

#### Message-Based Operation (No Code Strings for Standard Tools)
In previous prototypes, commands were evaluated via string expressions. In this release, **all standard operations (`snapshot`, `act`, `rectOf`, `pageRect`, `check`) use file injection and structured message passing**:
1. The background script ensures the bundled static script `/content.js` is loaded into the tab via `browser.tabs.executeScript(tabId, { file: "/content.js", frameId: 0 })`.
2. It sends structured JSON payloads via `browser.tabs.sendMessage(tabId, { op, args }, { frameId: 0 })`.
3. In `content.js`, `browser.runtime.onMessage` handles the operation directly within the unprivileged content sandbox and replies with a serialized result.
4. **No dynamic code strings are evaluated for navigation, snapshots, interaction steps, or element coordinate calculations.**

#### Opt-In `firefox_eval` (`tabs.executeScript({ code })`)
The single place where dynamic code execution is used is the `firefox_eval` developer tool:
- **Default OFF**: By default, `allowEval` is `false`. Any attempt by the agent to call `firefox_eval` is immediately rejected with:
  `firefox_eval is disabled. Ask the user to turn on "Allow page JavaScript" in the OMP Browser Bridge popup in Firefox.`
- **Explicit User Opt-In**: The user must explicitly toggle the **"Allow page JavaScript"** switch in the extension's toolbar popup. This preference is stored in `browser.storage.local`.
- **Target Context**: When enabled by the user, `executeEval` executes the user-directed snippet inside the tab's page context (`window.wrappedJSObject`) via an async IIFE:
  ```javascript
  const body = `(async () => { const page = window.wrappedJSObject; const args = ${JSON.stringify(args)}; const ref = (n) => window.__omp.resolve({ ref: n });\n${code}\n})()`;
  const evalCode = `Promise.resolve().then(() => ${body}).then(v => ({ ok: true, v: window.__omp.toJSONSafe(v) }), e => ({ ok: false, e: String(e && e.message || e) }))`;
  await browser.tabs.executeScript(tabId, { file: "/content.js", frameId: 0 });
  return await browser.tabs.executeScript(tabId, { code: evalCode, frameId: 0 });
  ```
- This capability is strictly for developer inspection (analogous to running a command in Firefox DevTools Web Console or Puppeteer's `page.evaluate()`).

#### Sender Validation
To prevent unauthorized control from arbitrary web pages or malicious scripts:
- In `background.js`, `browser.runtime.onMessage` verifies:
  1. `sender.id === browser.runtime.id`
  2. `sender.url` starts with `browser.runtime.getURL("popup/")`
- Any message attempting to invoke administrative actions (`setPaused`, `setAllowEval`, `closeAgentTabs`, `focusTab`, `state`) from a web page, iframe, or content script is ignored and dropped.
- Web content cannot un-pause agent control or enable `allowEval`.

#### Security Guarantees
- **No Remote Code**: No remote scripts, `eval()`, or `new Function()` calls are ever loaded into extension background or popup contexts. All extension scripts are packaged with the add-on.
- **Immediate Pause**: The user can press **`Alt+Shift+O`** or click Pause in the popup at any time. When paused, all in-flight batched actions and subsequent agent calls are immediately aborted.

---

### 4. Step-by-Step Instructions to Test the Add-on

Testing requires Node.js ≥ 18 and a local clone of the repository to register the native messaging host.

#### Step 1: Install Native Messaging Host
```bash
git clone https://github.com/ofa1/omp-browser-bridge.git
cd omp-browser-bridge
npm run install-host
```
*(This writes the native messaging host manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/omp_firefox.json` on macOS or `~/.mozilla/native-messaging-hosts/omp_firefox.json` on Linux).*

#### Step 2: Load Extension in Firefox
1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **"Load Temporary Add-on..."**.
3. Select `firefox/manifest.json` from the repository clone.

#### Step 3: Verify Status in Popup
1. Click the **OMP Browser Bridge** icon in the toolbar.
2. The popup will display:
   - Green status indicator: **Host running (0 active sessions)**
   - **Agent Control**: Active switch
   - **Allow page JavaScript**: Disabled by default switch
   - **Agent Tabs**: Empty state
   - **Recent Activity**: Empty state

#### Step 4: Run RPC Verification Script
From the repository root, run the test script using Node.js:
```bash
node -e '
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const dir = path.join(os.homedir(), ".omp", "firefox");
const sockFile = fs.readdirSync(dir).find(f => f.endsWith(".sock"));
if (!sockFile) throw new Error("No socket found in " + dir);

const s = net.createConnection(path.join(dir, sockFile));
s.on("connect", () => {
  console.log("Connected to native bridge socket!");
  // 1. Open and navigate an agent tab
  s.write(JSON.stringify({ id: 1, method: "tabs", params: { action: "open", url: "https://example.com" } }) + "\n");
});

s.on("data", (chunk) => {
  const res = JSON.parse(chunk.toString().trim().split("\n")[0]);
  console.log("Bridge response:", res);
  s.destroy();
});
'
```
Observe:
- Firefox opens `https://example.com` in a purple "omp" tab group.
- The toolbar popup updates to show **Connected (1 active session)** and logs the navigation in Recent Activity.

#### Step 5: Clean Up
To remove the test native host registration:
```bash
node scripts/install-host.mjs --uninstall
```
