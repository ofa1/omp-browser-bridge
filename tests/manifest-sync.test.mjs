import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveRoot, DEFAULT_EXTENSION_ID } from "../scripts/install-host.mjs";

describe("manifest and package version synchronization", () => {
  const root = resolveRoot();
  const pkgPath = path.join(root, "package.json");
  const manifestPath = path.join(root, "firefox", "manifest.json");

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  it("package.json and firefox/manifest.json versions match exactly", () => {
    assert.ok(pkg.version, "package.json has version");
    assert.ok(manifest.version, "manifest.json has version");
    assert.equal(
      pkg.version,
      manifest.version,
      `Version mismatch: package.json (${pkg.version}) vs manifest.json (${manifest.version})`
    );
  });

  it("gecko add-on ID matches expected literal ID", () => {
    const geckoId = manifest.browser_specific_settings?.gecko?.id;
    assert.equal(geckoId, "omp-firefox-bridge@omairahmed");
    assert.equal(DEFAULT_EXTENSION_ID, "omp-firefox-bridge@omairahmed");
  });

  it("all files referenced in firefox/manifest.json exist on disk", () => {
    const firefoxDir = path.join(root, "firefox");

    // Background scripts
    const bgScripts = manifest.background?.scripts || [];
    assert.ok(bgScripts.length > 0, "Manifest has background scripts");
    for (const s of bgScripts) {
      const p = path.join(firefoxDir, s);
      assert.ok(fs.existsSync(p), `Background script "${s}" exists at ${p}`);
    }

    // Popup HTML
    const popupHtml = manifest.browser_action?.default_popup;
    if (popupHtml) {
      const p = path.join(firefoxDir, popupHtml);
      assert.ok(fs.existsSync(p), `Popup HTML "${popupHtml}" exists`);
    }

    // Icons
    const icons = Object.values(manifest.icons || {});
    for (const iconPath of icons) {
      const p = path.join(firefoxDir, iconPath);
      assert.ok(fs.existsSync(p), `Icon "${iconPath}" exists`);
    }

    const defaultIcon = manifest.browser_action?.default_icon;
    if (typeof defaultIcon === "string") {
      assert.ok(fs.existsSync(path.join(firefoxDir, defaultIcon)), `Default icon "${defaultIcon}" exists`);
    } else if (defaultIcon && typeof defaultIcon === "object") {
      for (const iconPath of Object.values(defaultIcon)) {
        assert.ok(fs.existsSync(path.join(firefoxDir, iconPath)), `Browser action icon "${iconPath}" exists`);
      }
    }

    const themeIcons = manifest.browser_action?.theme_icons || [];
    for (const ti of themeIcons) {
      if (ti.light) assert.ok(fs.existsSync(path.join(firefoxDir, ti.light)), `Theme icon light "${ti.light}" exists`);
      if (ti.dark) assert.ok(fs.existsSync(path.join(firefoxDir, ti.dark)), `Theme icon dark "${ti.dark}" exists`);
    }
  });

  it("package.json published files exist on disk", () => {
    const files = pkg.files || [];
    assert.ok(files.length > 0, "package.json declares published files");
    for (const f of files) {
      const p = path.join(root, f);
      assert.ok(fs.existsSync(p), `Published file/dir "${f}" exists`);
    }
  });

  it("amo/metadata.json conforms to AMO submission guidelines", () => {
    const amoMetaPath = path.join(root, "amo", "metadata.json");
    assert.ok(fs.existsSync(amoMetaPath), "amo/metadata.json exists");
    const amoMeta = JSON.parse(fs.readFileSync(amoMetaPath, "utf8"));
    const categories = Array.isArray(amoMeta.categories)
      ? amoMeta.categories
      : amoMeta.categories?.firefox || [];
    assert.ok(Array.isArray(categories), "categories is an array");
    assert.equal(
      categories.length,
      1,
      "AMO rejects multiple categories when combined with 'other' — must have exactly 1 category"
    );
    assert.ok(
      amoMeta.version?.approval_notes && amoMeta.version.approval_notes.length <= 3000,
      `AMO reviewer notes length (${amoMeta.version?.approval_notes?.length}) exceeds 3000 character limit`
    );
  });
});
