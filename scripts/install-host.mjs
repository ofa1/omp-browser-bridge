// Registers the native messaging host with Firefox for the current user.
// Supports macOS, Linux, and Windows, copying host files into a stable per-user location.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_EXTENSION_ID = "omp-firefox-bridge@omairahmed";

export function resolveRoot() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}

export function getExtensionId(root = resolveRoot()) {
  try {
    const manifestPath = path.join(root, "firefox", "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return data.browser_specific_settings?.gecko?.id || DEFAULT_EXTENSION_ID;
    }
  } catch {}
  return DEFAULT_EXTENSION_ID;
}

export function getPackageVersion(root = resolveRoot()) {
  try {
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      const data = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return data.version || "0.2.0";
    }
  } catch {}
  return "0.2.0";
}

// The native manifest is per-user and global, so the host install location must not follow
// OMP_FIREFOX_DIR (a socket-dir override for isolated sessions/tests).
export function getStableHostDir(customDir, home = os.homedir()) {
  return path.join(customDir || path.join(home, ".omp", "firefox"), "host");
}
/**
 * @param {number} pid
 * @param {string} endpoint
 * @param {string} [baseDir]
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isValidEndpointForPid(pid, endpoint, baseDir = path.join(os.homedir(), ".omp", "firefox"), platform = process.platform) {
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\omp-firefox-[0-9a-fA-F-]+$/.test(endpoint);
  }
  const expectedPath = path.resolve(baseDir, `${pid}.sock`);
  return path.resolve(endpoint) === expectedPath;
}


export function getCandidateManifestPaths(platform = process.platform, home = os.homedir(), stableDir = getStableHostDir(undefined, home)) {
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "omp_firefox.json")];
  }
  if (platform === "linux") {
    const paths = [path.join(home, ".mozilla", "native-messaging-hosts", "omp_firefox.json")];
    const snapDir = path.join(home, "snap", "firefox", "common", ".mozilla");
    if (fs.existsSync(snapDir)) {
      paths.push(path.join(snapDir, "native-messaging-hosts", "omp_firefox.json"));
    }
    const flatpakDir = path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla");
    if (fs.existsSync(flatpakDir)) {
      paths.push(path.join(flatpakDir, "native-messaging-hosts", "omp_firefox.json"));
    }
    return paths;
  }
  if (platform === "win32") {
    return [path.join(stableDir, "omp_firefox.json")];
  }
  return [];
}

export function getAllManifestLocationsForCleanup(platform = process.platform, home = os.homedir(), stableDir = getStableHostDir(undefined, home)) {
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "omp_firefox.json")];
  }
  if (platform === "linux") {
    return [
      path.join(home, ".mozilla", "native-messaging-hosts", "omp_firefox.json"),
      path.join(home, "snap", "firefox", "common", ".mozilla", "native-messaging-hosts", "omp_firefox.json"),
      path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "native-messaging-hosts", "omp_firefox.json"),
    ];
  }
  if (platform === "win32") {
    return [path.join(stableDir, "omp_firefox.json")];
  }
  return [];
}

function checkNodeBinary(binPath) {
  try {
    if (!fs.existsSync(binPath)) return null;
    const stat = fs.statSync(binPath);
    if (!stat.isFile()) return null;
    const output = execFileSync(binPath, ["-v"], { encoding: "utf8", timeout: 3000 }).trim();
    const m = /^v?(\d+)\./.exec(output);
    if (m && Number(m[1]) >= 18) {
      return { type: "node", path: path.resolve(binPath), version: output };
    }
  } catch {}
  return null;
}

function checkOmpBinary(binPath) {
  try {
    if (!fs.existsSync(binPath)) return null;
    const stat = fs.statSync(binPath);
    if (!stat.isFile()) return null;
    const output = execFileSync(binPath, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, BUN_BE_BUN: "1" },
      timeout: 3000,
    }).trim();
    return { type: "omp", path: path.resolve(binPath), version: output };
  } catch {}
  return null;
}

export function findOnPath(binaryName, platform = process.platform, pathEnv = process.env.PATH || "") {
  const delimiter = platform === "win32" ? ";" : ":";
  const isAbsolute = platform === "win32"
    ? (p) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p)
    : (p) => path.isAbsolute(p);

  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const fullPath = path.join(dir, binaryName.endsWith(ext) ? binaryName : `${binaryName}${ext}`);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) return fullPath;
        }
      } catch {}
    }
  }
  return null;
}

export function resolveRuntime(options = {}, platform = process.platform, home = os.homedir()) {
  const forced = options.runtime || process.env.OMP_BRIDGE_RUNTIME;

  if (forced) {
    if (forced.toLowerCase() === "node") {
      const found = findNodeRuntime(platform, home);
      if (!found) throw new Error("OMP_BRIDGE_RUNTIME=node requested, but no Node.js >= 18 was found.");
      return found;
    }
    if (forced.toLowerCase() === "omp") {
      const found = findOmpRuntime(platform, home);
      if (!found) throw new Error("OMP_BRIDGE_RUNTIME=omp requested, but no runnable omp binary was found.");
      return found;
    }
    // Explicit custom path
    const resolvedPath = path.resolve(forced);
    const asNode = checkNodeBinary(resolvedPath);
    if (asNode) return asNode;
    const asOmp = checkOmpBinary(resolvedPath);
    if (asOmp) return asOmp;
    throw new Error(`Custom runtime at "${forced}" is neither a valid Node.js (>= 18) binary nor a valid omp binary.`);
  }

  // 1. Prefer Node.js >= 18
  const nodeRuntime = findNodeRuntime(platform, home);
  if (nodeRuntime) return nodeRuntime;

  // 2. Fall back to omp binary (BUN_BE_BUN=1)
  const ompRuntime = findOmpRuntime(platform, home);
  if (ompRuntime) return ompRuntime;

  throw new Error(
    "Could not locate Node.js (>= 18) or the 'omp' binary. " +
    "Please install Node.js >= 18 or ensure omp is on your PATH, or set OMP_BRIDGE_RUNTIME."
  );
}

function findNodeRuntime(platform = process.platform, home = os.homedir()) {
  // Check process.execPath only if running in real Node, not Bun/omp
  if (process.versions?.node && !process.versions?.bun && !process.env.BUN_BE_BUN) {
    const current = checkNodeBinary(process.execPath);
    if (current) return current;
  }

  // Check PATH without shell
  const fromPath = findOnPath(platform === "win32" ? "node.exe" : "node", platform);
  if (fromPath) {
    const checked = checkNodeBinary(fromPath);
    if (checked) return checked;
  }

  // Common locations
  const candidates = [];
  if (platform === "darwin" || platform === "linux") {
    candidates.push(
      path.join(home, ".local", "bin", "node"),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
      path.join(home, ".fnm", "current", "bin", "node"),
      path.join(home, ".volta", "bin", "node")
    );
    // Scan nvm versions if present
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    try {
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        for (const v of versions) {
          candidates.push(path.join(nvmDir, v, "bin", "node"));
        }
      }
    } catch {}
  } else if (platform === "win32") {
    const progFiles = process.env.ProgramFiles || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(
      path.join(progFiles, "nodejs", "node.exe"),
      path.join(progFilesX86, "nodejs", "node.exe"),
      path.join(localAppData, "Programs", "node", "node.exe"),
      path.join(home, ".fnm", "current", "node.exe")
    );
  }

  for (const cand of candidates) {
    const checked = checkNodeBinary(cand);
    if (checked) return checked;
  }
  return null;
}

function findOmpRuntime(platform = process.platform, home = os.homedir()) {
  const fromPath = findOnPath(platform === "win32" ? "omp.exe" : "omp", platform);
  if (fromPath) {
    const checked = checkOmpBinary(fromPath);
    if (checked) return checked;
  }

  const candidates = [];
  if (platform === "darwin" || platform === "linux") {
    candidates.push(
      "/opt/homebrew/bin/omp",
      "/usr/local/bin/omp",
      path.join(home, ".local", "bin", "omp"),
      path.join(home, ".omp", "bin", "omp")
    );
  } else if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(
      path.join(localAppData, "Programs", "omp", "omp.exe"),
      path.join(home, ".omp", "bin", "omp.exe")
    );
  }

  for (const cand of candidates) {
    const checked = checkOmpBinary(cand);
    if (checked) return checked;
  }
  return null;
}

export function escapeShArg(arg) {
  return `'${String(arg).replaceAll("'", "'\\''")}'`;
}

export function escapeBatArg(arg) {
  return `"${String(arg).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function buildWrapperContent(runtime, hostMjsPath, platform = process.platform) {
  if (platform === "win32") {
    const qBin = escapeBatArg(runtime.path);
    const qHost = escapeBatArg(hostMjsPath);
    if (runtime.type === "omp") {
      return `@echo off\r\nset BUN_BE_BUN=1\r\n${qBin} ${qHost} %*\r\n`;
    }
    return `@echo off\r\n${qBin} ${qHost} %*\r\n`;
  }

  const qBin = escapeShArg(runtime.path);
  const qHost = escapeShArg(hostMjsPath);
  if (runtime.type === "omp") {
    return `#!/bin/sh\nexport BUN_BE_BUN=1\nexec ${qBin} ${qHost} "$@"\n`;
  }
  return `#!/bin/sh\nexec ${qBin} ${qHost} "$@"\n`;
}

export function buildManifestContent(wrapperPath, extensionId) {
  return `${JSON.stringify(
    {
      name: "omp_firefox",
      description: "omp browser bridge native host",
      path: wrapperPath,
      type: "stdio",
      allowed_extensions: [extensionId],
    },
    null,
    2
  )}\n`;
}

export function getRegExePath(platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path;
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  return p.join(sysRoot, "System32", "reg.exe");
}

export function getRegistryAddArgs(manifestPath) {
  return ["add", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox", "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

export function getRegistryDeleteArgs() {
  return ["delete", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\omp_firefox", "/f"];
}

export async function installHost(options = {}) {
  const root = resolveRoot();
  const extensionId = options.extensionId || getExtensionId(root);
  const version = getPackageVersion(root);
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const stableHostDir = getStableHostDir(options.customDir, home);

  const runtime = resolveRuntime(options, platform, home);

  fs.mkdirSync(stableHostDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      fs.chmodSync(stableHostDir, 0o700);
    } catch {}
  }

  // Copy host/host.mjs to stableHostDir/host.mjs
  const sourceHostMjs = path.join(root, "host", "host.mjs");
  const destHostMjs = path.join(stableHostDir, "host.mjs");
  fs.copyFileSync(sourceHostMjs, destHostMjs);

  // Write version metadata
  const metaVersionPath = path.join(stableHostDir, "host-version.json");
  const metaVersion = {
    version,
    runtimeType: runtime.type,
    runtimePath: runtime.path,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaVersionPath, `${JSON.stringify(metaVersion, null, 2)}\n`, { mode: 0o600 });

  // Write wrapper
  const wrapperName = platform === "win32" ? "omp-firefox-host.bat" : "omp-firefox-host";
  const wrapperPath = path.join(stableHostDir, wrapperName);
  const wrapperContent = buildWrapperContent(runtime, destHostMjs, platform);
  fs.writeFileSync(wrapperPath, wrapperContent, { mode: platform === "win32" ? 0o666 : 0o755 });

  // Write manifest(s)
  const manifestPaths = getCandidateManifestPaths(platform, home, stableHostDir);
  const manifestContent = buildManifestContent(wrapperPath, extensionId);

  for (const mPath of manifestPaths) {
    const parentDir = path.dirname(mPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(mPath, manifestContent);
  }

  // Windows registry via execFileSync (no shell)
  if (platform === "win32" && !options.skipRegistry) {
    const primaryManifest = manifestPaths[0];
    const regExe = getRegExePath();
    const regArgs = getRegistryAddArgs(primaryManifest);
    try {
      execFileSync(regExe, regArgs, { stdio: "ignore" });
    } catch (e) {
      if (!options.silent) {
        console.warn(`Warning: failed to add Windows registry key: ${e.message}`);
      }
    }
  }

  const result = {
    success: true,
    version,
    extensionId,
    runtime,
    stableHostDir,
    wrapperPath,
    manifestPaths,
  };

  if (!options.silent) {
    console.log(`Registered native messaging host for Firefox:`);
    console.log(`  Stable dir: ${stableHostDir}`);
    console.log(`  Wrapper:    ${wrapperPath}`);
    console.log(`  Runtime:    ${runtime.type} (${runtime.path})`);
    console.log(`  Add-on ID:  ${extensionId}`);
    console.log(`  Manifest(s):`);
    for (const m of manifestPaths) {
      console.log(`    - ${m}`);
    }
  }

  return result;
}

export async function uninstallHost(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const stableHostDir = getStableHostDir(options.customDir, home);

  const manifestLocations = getAllManifestLocationsForCleanup(platform, home, stableHostDir);
  const removedManifests = [];

  for (const mPath of manifestLocations) {
    try {
      if (fs.existsSync(mPath)) {
        fs.rmSync(mPath, { force: true });
        removedManifests.push(mPath);
      }
    } catch {}
  }

  if (platform === "win32" && !options.skipRegistry) {
    const regExe = getRegExePath();
    const regArgs = getRegistryDeleteArgs();
    try {
      execFileSync(regExe, regArgs, { stdio: "ignore" });
    } catch {}
  }

  // H2: Delete ONLY the files the installer wrote, then rmdir if empty
  const installerFiles = [
    path.join(stableHostDir, "host.mjs"),
    path.join(stableHostDir, "host-version.json"),
    path.join(stableHostDir, "omp-firefox-host"),
    path.join(stableHostDir, "omp-firefox-host.bat"),
    path.join(stableHostDir, "omp_firefox.json"),
  ];

  const removedFiles = [];
  for (const f of installerFiles) {
    try {
      if (fs.existsSync(f)) {
        fs.rmSync(f, { force: true });
        removedFiles.push(f);
      }
    } catch {}
  }

  let removedDir = false;
  try {
    if (fs.existsSync(stableHostDir)) {
      const remaining = fs.readdirSync(stableHostDir);
      if (remaining.length === 0) {
        fs.rmdirSync(stableHostDir);
        removedDir = true;
      }
    }
  } catch {}

  const result = {
    success: true,
    removedManifests,
    removedFiles,
    removedDir,
    stableHostDir,
  };

  if (!options.silent) {
    console.log(`Uninstalled native messaging host:`);
    console.log(`  Removed manifests: ${removedManifests.join(", ") || "none"}`);
    console.log(`  Removed files:     ${removedFiles.join(", ") || "none"}`);
    console.log(`  Host dir:          ${stableHostDir} (${removedDir ? "removed" : "kept non-empty"})`);
  }

  return result;
}

export function checkHostStatus(options = {}) {
  const root = resolveRoot();
  const currentVersion = getPackageVersion(root);
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const stableHostDir = getStableHostDir(options.customDir, home);
  const manifestPaths = getCandidateManifestPaths(platform, home, stableHostDir);

  const primaryManifest = manifestPaths[0];
  if (!primaryManifest || !fs.existsSync(primaryManifest)) {
    return {
      installed: false,
      stale: true,
      reason: "Native messaging host manifest does not exist.",
      manifestPaths,
      stableHostDir,
      version: null,
    };
  }

  // Check wrapper path in manifest
  let manifestData;
  try {
    manifestData = JSON.parse(fs.readFileSync(primaryManifest, "utf8"));
  } catch {
    return {
      installed: false,
      stale: true,
      reason: "Native messaging host manifest is unreadable or invalid JSON.",
      manifestPaths,
      stableHostDir,
      version: null,
    };
  }

  const wrapperPath = manifestData.path;
  if (!wrapperPath || !fs.existsSync(wrapperPath)) {
    return {
      installed: false,
      stale: true,
      reason: `Wrapper script at "${wrapperPath}" does not exist.`,
      manifestPaths,
      stableHostDir,
      version: null,
    };
  }

  const hostMjs = path.join(stableHostDir, "host.mjs");
  if (!fs.existsSync(hostMjs)) {
    return {
      installed: false,
      stale: true,
      reason: `Host script at "${hostMjs}" does not exist.`,
      manifestPaths,
      stableHostDir,
      version: null,
    };
  }

  // Check version
  const metaVersionPath = path.join(stableHostDir, "host-version.json");
  let installedVersion = null;
  if (fs.existsSync(metaVersionPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaVersionPath, "utf8"));
      installedVersion = meta.version;
    } catch {}
  }

  if (installedVersion && installedVersion !== currentVersion) {
    return {
      installed: true,
      stale: true,
      reason: `Installed host version (${installedVersion}) is older than package version (${currentVersion}).`,
      manifestPaths,
      wrapperPath,
      stableHostDir,
      version: installedVersion,
    };
  }

  return {
    installed: true,
    stale: false,
    manifestPaths,
    wrapperPath,
    stableHostDir,
    version: installedVersion || currentVersion,
  };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const isUninstall = process.argv.includes("--uninstall");
  const runtimeIdx = process.argv.indexOf("--runtime");
  const runtimeArg = runtimeIdx !== -1 && process.argv[runtimeIdx + 1] ? process.argv[runtimeIdx + 1] : undefined;

  if (isUninstall) {
    uninstallHost().catch((err) => {
      console.error(`Uninstall failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    installHost({ runtime: runtimeArg }).catch((err) => {
      console.error(`Installation failed: ${err.message}`);
      process.exit(1);
    });
  }
}
