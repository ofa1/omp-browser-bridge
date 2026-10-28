#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const newVersion = process.argv[2]?.trim().replace(/^v/, "");
const SEMVER_STRICT = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/;

if (!newVersion || !SEMVER_STRICT.test(newVersion)) {
  console.error("Usage: npm run bump <new-version>");
  console.error("Version must match /^(0|[1-9]\\d*)(\\.(0|[1-9]\\d*)){2}$/ (e.g. 0.2.2)");
  process.exit(1);
}

const pkgPath = path.join(root, "package.json");
const manifestPath = path.join(root, "firefox", "manifest.json");
const lockPath = path.join(root, "package-lock.json");

if (!fs.existsSync(pkgPath) || !fs.existsSync(manifestPath)) {
  console.error("Required configuration files missing (package.json or firefox/manifest.json)");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifestRaw = fs.readFileSync(manifestPath, "utf8");
const oldVersion = pkg.version;

if (!SEMVER_STRICT.test(oldVersion)) {
  console.error(`Current package.json version is invalid: ${oldVersion}`);
  process.exit(1);
}

function parseParts(v) {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

function isStrictlyGreater(newVer, oldVer) {
  const [newMaj, newMin, newPatch] = parseParts(newVer);
  const [oldMaj, oldMin, oldPatch] = parseParts(oldVer);
  if (newMaj !== oldMaj) return newMaj > oldMaj;
  if (newMin !== oldMin) return newMin > oldMin;
  return newPatch > oldPatch;
}

if (!isStrictlyGreater(newVersion, oldVersion)) {
  console.error(`New version ${newVersion} must be strictly greater than current version ${oldVersion}`);
  process.exit(1);
}

if (!/"version":\s*"[^"]+"/.test(manifestRaw)) {
  console.error("Could not find 'version' property in firefox/manifest.json");
  process.exit(1);
}

let lock;
if (fs.existsSync(lockPath)) {
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (e) {
    console.error(`Invalid package-lock.json: ${e.message}`);
    process.exit(1);
  }
}

console.log(`Bumping version: ${oldVersion} -> ${newVersion}`);

// 1. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log("  ✓ Updated package.json");

// 2. Update firefox/manifest.json (replace only version line to preserve exact formatting)
const updatedManifestRaw = manifestRaw.replace(
  /("version":\s*)"[^"]+"/,
  `$1"${newVersion}"`
);
fs.writeFileSync(manifestPath, updatedManifestRaw, "utf8");
console.log("  ✓ Updated firefox/manifest.json (formatting preserved)");

// 3. Update package-lock.json (both top-level and packages[""])
if (lock) {
  lock.version = newVersion;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = newVersion;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  console.log("  ✓ Updated package-lock.json");
}

// 4. Run verification
console.log("\nRunning validation suite...");
try {
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["--test", "tests/manifest-sync.test.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("  ✓ Version sync & tests passed");
} catch {
  console.error("Validation failed after version bump.");
  process.exit(1);
}

console.log(`\nVersion bumped to v${newVersion} successfully!`);
console.log("\nNext steps:");
console.log(`  1. Update CHANGELOG.md for v${newVersion}`);
console.log(`  2. git commit -am "chore: release v${newVersion}"`);
console.log(`  3. git tag v${newVersion}`);
console.log(`  4. git push origin main --tags`);
