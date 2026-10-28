#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const newVersion = process.argv[2]?.trim().replace(/^v/, "");

if (!newVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(newVersion)) {
  console.error("Usage: npm run bump <new-version>");
  console.error("Example: npm run bump 0.2.2");
  process.exit(1);
}

const pkgPath = path.join(root, "package.json");
const manifestPath = path.join(root, "firefox", "manifest.json");
const lockPath = path.join(root, "package-lock.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const oldVersion = pkg.version;

if (oldVersion === newVersion) {
  console.error(`Version is already ${newVersion}`);
  process.exit(1);
}

console.log(`Bumping version: ${oldVersion} -> ${newVersion}`);

// 1. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log("  ✓ Updated package.json");

// 2. Update firefox/manifest.json
manifest.version = newVersion;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("  ✓ Updated firefox/manifest.json");

// 3. Update package-lock.json
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
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
