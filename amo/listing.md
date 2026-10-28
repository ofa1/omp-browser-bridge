# AMO Listing Copy: OMP Browser Bridge

This document provides a human-readable copy of the add-on listing metadata for the Mozilla Add-ons Developer Hub (AMO) web interface in case manual entry or fallback editing is required.

---

### Add-on Name
`OMP Browser Bridge`
*(Note: Complies with Mozilla naming guidelines by omitting "Firefox" or "Mozilla")*

---

### Summary (216 characters, max 250)
`Bridge connecting the omp coding agent to your browser. Enables automated navigation, DOM text snapshots, form interaction, visual testing, and opt-in scripting over a local native messaging socket. Requires omp CLI.`

---

### Categories
- **Primary Category**: Web Development (`web-development`)
- **Secondary Category**: Other (`other`)

---

### Support & Links
- **Homepage**: https://github.com/ofa1/omp-browser-bridge
- **Support URL / Bug Tracker**: https://github.com/ofa1/omp-browser-bridge/issues
- **Setup Guide**: https://github.com/ofa1/omp-browser-bridge#setup
- **Expected AMO Listing Slug**: `omp-browser-bridge` (expected URL: https://addons.mozilla.org/firefox/addon/omp-browser-bridge/ - unconfirmed until published)
- **License**: MIT (`MIT`)
- **Version**: 0.2.0

---

### Description (AMO-Compatible Markdown - No Headings)

```markdown
**OMP Browser Bridge** connects the **omp** coding agent (oh-my-pi) to your browser, enabling intelligent browser automation for web development, UI inspection, and automated testing directly from your terminal.

*Important*: This extension requires the **omp** CLI and companion native messaging host to be installed on your computer. Follow the setup guide at: https://github.com/ofa1/omp-browser-bridge#setup

The add-on operates entirely over a local Unix domain socket or Windows named pipe via a native messaging host. It makes zero remote network requests, has no telemetry or tracking, and keeps your browsing private.

**Key Features**

- **Transparent Tab Management**: Agent-created tabs are grouped in a distinct purple "omp" tab group so you always know what the agent is browsing.
- **DOM Text Snapshots**: Fast, text-based page snapshots with numbered element references (e.g. `[1] button "Submit"`) for precise agent interaction without fragile selectors.
- **Interactive Actions**: Batched click, double-click, hover, focus, text input, key press, checkbox toggle, select dropdown, scroll, and wait actions.
- **Opt-In Page Scripting**: Execute JavaScript directly within page contexts (firefox_eval) for deep inspection. Disabled by default; easily enabled via the "Allow page JavaScript" toggle in the popup.
- **Visual Capture**: Full-page, viewport, or element-specific screenshots for visual regression checks and layout inspection.
- **Instant Privacy Controls**: Pause agent activity instantly with `Alt+Shift+O` or via the toolbar popup. View recent agent activity right in the popup.

**Setup and Requirements**

1. Install the **omp** CLI (https://github.com/can1357/oh-my-pi).
2. Install this extension in your browser.
3. Run `/firefox setup` in omp (or follow the setup guide: https://github.com/ofa1/omp-browser-bridge#setup).
4. Enable browser control in omp by running `/firefox on` or launching with `omp --firefox`.

**Privacy & Security**

- **100% Local**: All communication between omp and the browser happens locally on your machine.
- **No Remote Telemetry**: The extension and native host make no external network calls.
- **User In Control**: Agent commands can be paused at any moment. Background tabs and agent groups can be closed with a single click.

Source code and documentation: https://github.com/ofa1/omp-browser-bridge
```

---

### Release Notes (Version 0.2.0)
`Initial public listed release (v0.2.0) featuring message-based native messaging bridge, purple omp tab grouping, DOM text snapshots, batched interaction actions, opt-in page eval with sender validation, and tab screenshots.`

---

### Developer Information
- **Author**: Omair Ahmed
- **Extension ID / GUID**: `omp-firefox-bridge@omairahmed`
- **Permissions**: `nativeMessaging`, `tabs`, `tabGroups`, `<all_urls>`, `storage`
- **Strict Min Version**: `139.0`
- **Data Collection Permissions**: `none`
