import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXTENSION_ID,
  resolveRoot,
  getStableHostDir,
  getCandidateManifestPaths,
  getAllManifestLocationsForCleanup,
  escapeShArg,
  escapeBatArg,
  buildWrapperContent,
  buildManifestContent,
  getRegExePath,
  getRegistryAddArgs,
  getRegistryDeleteArgs,
  installHost,
  uninstallHost,
  checkHostStatus,
} from "../scripts/install-host.mjs";

describe("install-host metadata helpers", () => {
  it("resolveRoot returns an existing directory with package.json", () => {
    const root = resolveRoot();
    assert.ok(fs.existsSync(root), "root directory exists");
    assert.ok(fs.existsSync(path.join(root, "package.json")), "package.json exists in root");
    assert.ok(fs.existsSync(path.join(root, "firefox", "manifest.json")), "firefox/manifest.json exists in root");
  });


  it("getStableHostDir honors customDir and falls back to home/.omp/firefox/host", () => {
    const fakeHome = path.join("/tmp", "fake-home");
    const defaultHostDir = getStableHostDir(undefined, fakeHome);
    assert.equal(defaultHostDir, path.join(fakeHome, ".omp", "firefox", "host"));

    const customDir = path.join("/tmp", "custom-dir");
    const overriddenHostDir = getStableHostDir(customDir, fakeHome);
    assert.equal(overriddenHostDir, path.join(customDir, "host"));
  });
});

describe("candidate manifest paths across platforms", () => {
  const fakeHome = path.join("/tmp", "user-home");
  const fakeStableDir = path.join(fakeHome, ".omp", "firefox", "host");

  it("calculates macOS candidate paths correctly", () => {
    const paths = getCandidateManifestPaths("darwin", fakeHome, fakeStableDir);
    assert.equal(paths.length, 1);
    assert.equal(
      paths[0],
      path.join(fakeHome, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "omp_firefox.json")
    );
  });

  it("calculates Linux candidate paths and cleanup locations correctly", () => {
    const cleanupPaths = getAllManifestLocationsForCleanup("linux", fakeHome, fakeStableDir);
    assert.equal(cleanupPaths.length, 3);
    assert.equal(cleanupPaths[0], path.join(fakeHome, ".mozilla", "native-messaging-hosts", "omp_firefox.json"));
    assert.equal(
      cleanupPaths[1],
      path.join(fakeHome, "snap", "firefox", "common", ".mozilla", "native-messaging-hosts", "omp_firefox.json")
    );
    assert.equal(
      cleanupPaths[2],
      path.join(fakeHome, ".var", "app", "org.mozilla.firefox", ".mozilla", "native-messaging-hosts", "omp_firefox.json")
    );
  });

  it("calculates Windows candidate paths correctly", () => {
    const paths = getCandidateManifestPaths("win32", fakeHome, fakeStableDir);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], path.join(fakeStableDir, "omp_firefox.json"));
  });
});

describe("shell escaping and wrapper generation", () => {
  it("escapes POSIX shell arguments safely", () => {
    assert.equal(escapeShArg("simple"), "'simple'");
    assert.equal(escapeShArg("foo'bar"), "'foo'\\''bar'");
    assert.equal(escapeShArg("has space and $VAR"), "'has space and $VAR'");
  });

  it("escapes Windows batch arguments safely", () => {
    assert.equal(escapeBatArg("simple"), '"simple"');
    assert.equal(escapeBatArg("foo%bar"), '"foo%%bar"');
    assert.equal(escapeBatArg('foo"bar'), '"foo""bar"');
  });

  it("builds POSIX wrapper script with exec and proper shebang", () => {
    const wrapper = buildWrapperContent({ path: "/usr/local/bin/node" }, "/opt/omp/host.mjs", "linux");
    assert.match(wrapper, /^#!\/bin\/sh\n/);
    assert.match(wrapper, /exec '\/usr\/local\/bin\/node' '\/opt\/omp\/host\.mjs'/);
  });

  it("builds Windows batch wrapper script", () => {
    const wrapper = buildWrapperContent({ path: "C:\\Node\\node.exe" }, "C:\\omp\\host.mjs", "win32");
    assert.match(wrapper, /^@echo off\r?\n/);
    assert.match(wrapper, /"C:\\Node\\node\.exe" "C:\\omp\\host\.mjs" %/);
  });
});

describe("manifest content generation", () => {
  it("creates valid native messaging JSON manifest", () => {
    const wrapperPath = "/home/user/.omp/firefox/host/omp-firefox-host";
    const extensionId = "omp-firefox-bridge@omairahmed";
    const raw = buildManifestContent(wrapperPath, extensionId);
    const parsed = JSON.parse(raw);

    assert.equal(parsed.name, "omp_firefox");
    assert.equal(parsed.type, "stdio");
    assert.equal(parsed.path, wrapperPath);
    assert.deepEqual(parsed.allowed_extensions, [extensionId]);
  });
});

describe("Windows registry helpers", () => {
  it("generates correct reg.exe path and arguments", () => {
    const regExe = getRegExePath("win32");
    assert.ok(regExe.endsWith("reg.exe"));

    const addArgs = getRegistryAddArgs("C:\\test\\omp_firefox.json");
    assert.deepEqual(addArgs, [
      "add",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox",
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      "C:\\test\\omp_firefox.json",
      "/f",
    ]);

    const delArgs = getRegistryDeleteArgs();
    assert.deepEqual(delArgs, [
      "delete",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox",
      "/f",
    ]);
  });
});

describe("isolated host installation and uninstallation lifecycle", () => {
  it("installs, checks status, and uninstalls cleanly in temp directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-host-test-"));
    const fakeHome = path.join(tmpDir, "home");
    const fakeCustomDir = path.join(tmpDir, "custom");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeCustomDir, { recursive: true });

    try {
      const installRes = await installHost({
        platform: process.platform,
        home: fakeHome,
        customDir: fakeCustomDir,
        silent: true,
        skipRegistry: true,
      });

      assert.equal(installRes.success, true);
      assert.ok(fs.existsSync(installRes.wrapperPath), "wrapper file exists");
      assert.ok(fs.existsSync(installRes.manifestPaths[0]), "manifest file exists");

      const manifestContent = JSON.parse(fs.readFileSync(installRes.manifestPaths[0], "utf8"));
      assert.equal(manifestContent.name, "omp_firefox");
      assert.equal(manifestContent.path, installRes.wrapperPath);

      const statusRes = checkHostStatus({
        platform: process.platform,
        home: fakeHome,
        customDir: fakeCustomDir,
      });
      assert.equal(statusRes.installed, true);
      assert.equal(statusRes.manifestPaths[0], installRes.manifestPaths[0]);

      const uninstallRes = await uninstallHost({
        platform: process.platform,
        home: fakeHome,
        customDir: fakeCustomDir,
        silent: true,
        skipRegistry: true,
      });
      assert.equal(uninstallRes.success, true);
      assert.ok(!fs.existsSync(installRes.manifestPaths[0]), "manifest removed after uninstall");

      const afterStatus = checkHostStatus({
        platform: process.platform,
        home: fakeHome,
        customDir: fakeCustomDir,
      });
      assert.equal(afterStatus.installed, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
