import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRoot } from "../scripts/install-host.mjs";

describe("syntax and format validation", () => {
  const root = resolveRoot();

  const jsFiles = [
    "host/host.mjs",
    "scripts/install-host.mjs",
    "firefox/background.js",
    "firefox/content.js",
    "firefox/popup/popup.js",
  ];

  for (const relPath of jsFiles) {
    it(`validates JS/MJS syntax for ${relPath}`, () => {
      const fullPath = path.join(root, relPath);
      assert.ok(fs.existsSync(fullPath), `${relPath} exists`);
      // node --check checks syntax without executing
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ["--check", fullPath], { stdio: "pipe" });
      });
    });
  }

  const jsonFiles = [
    "package.json",
    "firefox/manifest.json",
    "amo/metadata.json",
    "tsconfig.json",
  ];

  for (const relPath of jsonFiles) {
    it(`validates JSON formatting for ${relPath}`, () => {
      const fullPath = path.join(root, relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8");
        assert.doesNotThrow(() => {
          JSON.parse(content);
        }, `Invalid JSON in ${relPath}`);
      }
    });
  }
});
