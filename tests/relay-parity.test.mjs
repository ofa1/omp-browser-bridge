import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

describe("Relay feature parity: tab matching and tab line formatting", () => {
  function findMatchingTab(tabs, target) {
    const query = target.toLowerCase().trim();
    if (!query) return undefined;
    return tabs.find((t) => {
      const url = (t.url || "").toLowerCase();
      const title = (t.title || "").toLowerCase();
      return url.includes(query) || title.includes(query);
    });
  }

  function tabLine(t, currentTab) {
    const marks = [
      t.id === currentTab ? "*" : " ",
      t.agent ? "agent" : "",
      t.active ? "visible" : "",
      t.pinned ? "pinned" : "",
      t.discarded ? "discarded" : "",
    ].filter(Boolean).join(" ");
    return `${marks} tab ${t.id} (win ${t.windowId}) ${JSON.stringify(t.title || "")} ${t.url || ""}`;
  }

  const sampleTabs = [
    { id: 10, windowId: 1, active: true, title: "Google", url: "https://www.google.com", agent: false, pinned: true },
    { id: 20, windowId: 1, active: false, title: "GitHub Dashboard", url: "https://github.com/dashboard", agent: true },
    { id: 30, windowId: 1, active: false, title: "Local App", url: "http://localhost:3000/app", agent: true, discarded: true },
  ];

  it("matches tab by URL substring (case-insensitive)", () => {
    const matched = findMatchingTab(sampleTabs, "localhost:3000");
    assert.ok(matched);
    assert.equal(matched.id, 30);
  });

  it("matches tab by title substring (case-insensitive)", () => {
    const matched = findMatchingTab(sampleTabs, "github");
    assert.ok(matched);
    assert.equal(matched.id, 20);
  });

  it("returns undefined when no tab matches query", () => {
    const matched = findMatchingTab(sampleTabs, "nonexistent");
    assert.equal(matched, undefined);
  });

  it("returns undefined for empty or whitespace query", () => {
    assert.equal(findMatchingTab(sampleTabs, ""), undefined);
    assert.equal(findMatchingTab(sampleTabs, "   "), undefined);
  });

  it("formats tab line with pinned and discarded status marks", () => {
    const pinnedLine = tabLine(sampleTabs[0], 10);
    assert.ok(pinnedLine.includes("pinned"), "Pinned tab includes 'pinned' mark");
    assert.ok(pinnedLine.includes("visible"), "Active tab includes 'visible' mark");
    assert.ok(pinnedLine.startsWith("*"), "Current tab starts with '*'");

    const discardedLine = tabLine(sampleTabs[2], 10);
    assert.ok(discardedLine.includes("discarded"), "Discarded tab includes 'discarded' mark");
    assert.ok(discardedLine.includes("agent"), "Agent tab includes 'agent' mark");
  });
});

describe("Relay feature parity: tab group hygiene", () => {
  it("skips pinned tabs from being grouped", () => {
    let groupCalled = false;
    function mockGroupAgentTab(tab, groupTabsEnabled) {
      if (!groupTabsEnabled) return false;
      if (tab.pinned) return false;
      groupCalled = true;
      return true;
    }

    const pinnedTab = { id: 1, pinned: true, windowId: 1 };
    assert.equal(mockGroupAgentTab(pinnedTab, true), false);
    assert.equal(groupCalled, false, "Must not group pinned tab");

    const normalTab = { id: 2, pinned: false, windowId: 1 };
    assert.equal(mockGroupAgentTab(normalTab, true), true);
    assert.equal(groupCalled, true, "Groups normal agent tab");
  });

  it("skips grouping when groupTabs setting is disabled", () => {
    let groupCalled = false;
    function mockGroupAgentTab(tab, groupTabsEnabled) {
      if (!groupTabsEnabled) return false;
      if (tab.pinned) return false;
      groupCalled = true;
      return true;
    }

    const normalTab = { id: 2, pinned: false, windowId: 1 };
    assert.equal(mockGroupAgentTab(normalTab, false), false);
    assert.equal(groupCalled, false, "Must respect groupTabs setting");
  });

  it("retries tab removal on temporary failure", async () => {
    let attempts = 0;
    async function mockRemoveTab(_tabId) {
      for (let attempt = 1; ; attempt++) {
        try {
          attempts++;
          if (attempts < 3) {
            throw new Error("Tabs cannot be edited right now");
          }
          return;
        } catch (error) {
          if (/Invalid tab id|No tab with id/i.test(error.message)) return;
          if (attempt >= 3) throw error;
        }
      }
    }

    await mockRemoveTab(42);
    assert.equal(attempts, 3, "Retried 3 times before succeeding");
  });
});

describe("Relay feature parity: host metadata browserSession", () => {
  it("writes browserSession into host metadata on hello message", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-parity-test-"));
    const hostPath = path.resolve("host/host.mjs");
    const testSessionId = "session-" + Date.now();

    const hostProc = spawn(process.execPath, [hostPath], {
      env: { ...process.env, OMP_FIREFOX_DIR: tmpDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const metaPath = path.join(tmpDir, `${hostProc.pid}.json`);
      // Wait for initial metadata file
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(metaPath)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(fs.existsSync(metaPath), "Metadata file created");

      // Send hello with browserSession
      const body = Buffer.from(JSON.stringify({ type: "hello", version: "0.2.3", browserSession: testSessionId }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      hostProc.stdin.write(Buffer.concat([header, body]));

      // Wait for metadata to be updated with browserSession
      let updatedMeta = null;
      for (let i = 0; i < 50; i++) {
        const raw = fs.readFileSync(metaPath, "utf8");
        try {
          const parsed = JSON.parse(raw);
          if (parsed.browserSession === testSessionId) {
            updatedMeta = parsed;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(updatedMeta, "Metadata was updated with browserSession");
      assert.equal(updatedMeta.browserSession, testSessionId);
    } finally {
      hostProc.stdin.end();
      hostProc.kill();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Relay performance & token efficiency optimizations", () => {
  it("compresses select options to preview limit of 5 with total count", () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ text: `Option ${i + 1}`, value: `opt_${i + 1}` }));
    const totalOpts = options.length;
    const preview = options.slice(0, 5).map((o) => o.text);
    const formatted = `options: ${preview.join(" | ")}${totalOpts > 5 ? ` | …(${totalOpts} total)` : ""}`;
    assert.equal(formatted, "options: Option 1 | Option 2 | Option 3 | Option 4 | Option 5 | …(12 total)");
  });

  it("suppresses redundant target URL when link text matches destination or is anchor hash", () => {
    function shouldEmitHref(name, rawHref, targetUrl) {
      if (!rawHref || rawHref.startsWith("javascript:") || rawHref === "#" || rawHref === "#!") return false;
      if (targetUrl && name?.toLowerCase() === targetUrl.toLowerCase()) return false;
      if (name === rawHref) return false;
      return true;
    }

    assert.equal(shouldEmitHref("Docs", "/docs", "/docs"), true);
    assert.equal(shouldEmitHref("/docs", "/docs", "/docs"), false);
    assert.equal(shouldEmitHref("Top", "#", "#"), false);
    assert.equal(shouldEmitHref("Close", "javascript:void(0)", "javascript:void(0)"), false);
  });

  it("collapses consecutive blank lines in snapshot text", () => {
    const input = "Line 1\n\n\n\nLine 2\n\n\nLine 3";
    const cleaned = input.replace(/\n{3,}/g, "\n\n");
    assert.equal(cleaned, "Line 1\n\nLine 2\n\nLine 3");
  });

  it("identifies navigation-inducing actions correctly for settling latency bypass", () => {
    const NAV_ACTIONS = new Set(["click", "dblclick", "submit"]);
    function isNavigatingAction(step) {
      if (NAV_ACTIONS.has(step?.action)) return true;
      if (step?.action === "press") {
        const val = String(step.value || "").toLowerCase();
        return val === "enter" || val.endsWith("+enter") || val === "space" || val === " ";
      }
      return false;
    }

    assert.equal(isNavigatingAction({ action: "click" }), true);
    assert.equal(isNavigatingAction({ action: "dblclick" }), true);
    assert.equal(isNavigatingAction({ action: "submit" }), true);
    assert.equal(isNavigatingAction({ action: "press", value: "Enter" }), true);
    assert.equal(isNavigatingAction({ action: "press", value: "Control+Enter" }), true);
    assert.equal(isNavigatingAction({ action: "press", value: "Space" }), true);
    assert.equal(isNavigatingAction({ action: "fill", value: "test" }), false);
    assert.equal(isNavigatingAction({ action: "type", value: "abc" }), false);
    assert.equal(isNavigatingAction({ action: "focus" }), false);
    assert.equal(isNavigatingAction({ action: "select", value: "1" }), false);
    assert.equal(isNavigatingAction({ action: "check" }), false);
    assert.equal(isNavigatingAction({ action: "scroll", value: "down" }), false);
  });
});
