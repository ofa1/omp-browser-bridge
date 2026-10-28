import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidEndpointForPid } from "../scripts/install-host.mjs";

describe("IPC endpoint validation", () => {
  const baseDir = "/home/user/.omp/firefox";

  it("validates valid POSIX socket endpoint matching target PID", () => {
    const pid = 12345;
    const validEndpoint = path.resolve(baseDir, `${pid}.sock`);
    assert.equal(isValidEndpointForPid(pid, validEndpoint, baseDir, "linux"), true);
  });

  it("rejects mismatched PID socket endpoint", () => {
    const pid = 12345;
    const differentEndpoint = path.resolve(baseDir, "99999.sock");
    assert.equal(isValidEndpointForPid(pid, differentEndpoint, baseDir, "linux"), false);
  });

  it("rejects path traversal or socket outside base directory", () => {
    const pid = 12345;
    const traversalEndpoint = path.resolve(baseDir, "..", `${pid}.sock`);
    assert.equal(isValidEndpointForPid(pid, traversalEndpoint, baseDir, "linux"), false);

    const tmpEndpoint = path.resolve("/tmp", `${pid}.sock`);
    assert.equal(isValidEndpointForPid(pid, tmpEndpoint, baseDir, "linux"), false);
  });

  it("validates Windows named pipe endpoint format", () => {
    const pid = 12345;
    const validPipe = "\\\\.\\pipe\\omp-firefox-12345678-1234-1234-1234-123456789abc";
    assert.equal(isValidEndpointForPid(pid, validPipe, baseDir, "win32"), true);

    const invalidPipe = "\\\\.\\pipe\\other-service-pipe";
    assert.equal(isValidEndpointForPid(pid, invalidPipe, baseDir, "win32"), false);
  });
});

describe("file upload chunk invariant", () => {
  it("verifies UPLOAD_CHUNK_BYTES invariant from omp/index.ts", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.join(currentDir, "..", "omp", "index.ts");
    const content = fs.readFileSync(indexPath, "utf8");
    const match = content.match(/UPLOAD_CHUNK_BYTES\s*=\s*(\d[\d_]*)/);
    assert.ok(match, "UPLOAD_CHUNK_BYTES constant exists in omp/index.ts");

    const n = Number.parseInt(match[1].replace(/_/g, ""), 10);
    assert.equal(n % 3, 0, "UPLOAD_CHUNK_BYTES must be a multiple of 3 for clean base64 chunking");
    assert.ok(
      Math.ceil(n / 3) * 4 + 1024 < 1_000_000,
      "Base64 encoded chunk + JSON envelope must stay within Firefox 1MB native messaging limit"
    );
  });
});
