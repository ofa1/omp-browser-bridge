import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests");
const testFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs") || f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join("tests", f));

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: root,
});

process.exit(result.status ?? 1);
