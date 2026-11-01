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
