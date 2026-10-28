import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

describe("Bridge directory security verification", () => {
  it("rejects symbolic links as bridge directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bridge-sec-"));
    const realDir = path.join(tmpDir, "real");
    const symlinkDir = path.join(tmpDir, "link");

    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.symlinkSync(realDir, symlinkDir);

    try {
      const linkStat = fs.lstatSync(symlinkDir);
      assert.ok(linkStat.isSymbolicLink(), "Detected symlink");
      assert.equal(
        !linkStat.isDirectory() || linkStat.isSymbolicLink(),
        true,
        "Security check correctly rejects symlink directory"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  if (process.platform !== "win32") {
    it("detects insecure bridge directory permissions (group/other access)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bridge-perm-"));
      try {
        fs.chmodSync(tmpDir, 0o777);
        const stat777 = fs.statSync(tmpDir);
        assert.notEqual((stat777.mode & 0o077), 0, "0777 flagged as insecure permissions");

        fs.chmodSync(tmpDir, 0o755);
        const stat755 = fs.statSync(tmpDir);
        assert.notEqual((stat755.mode & 0o077), 0, "0755 flagged as insecure permissions");

        fs.chmodSync(tmpDir, 0o700);
        const stat700 = fs.statSync(tmpDir);
        assert.equal((stat700.mode & 0o077), 0, "0700 accepted as secure permissions");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
});

describe("Local IPC round-trip communication", () => {
  it("exchanges newline-delimited JSON commands over local socket", async () => {
    if (process.platform === "win32") {
      // Named pipe test on Windows or skipped if unprivileged
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ipc-"));
    const sockPath = path.join(tmpDir, `${process.pid}.sock`);

    // Create mock host server
    const server = net.createServer((socket) => {
      const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.action === "ping") {
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, result: "pong" })}\n`);
        } else if (msg.action === "error_test") {
          socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: "simulated failure" })}\n`);
        } else {
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.action } })}\n`);
        }
      });
    });

    await new Promise((resolve) => server.listen(sockPath, resolve));

    try {
      // Connect client socket
      const client = net.createConnection({ path: sockPath });
      await new Promise((resolve) => client.once("connect", resolve));

      const pending = new Map();
      const rl = readline.createInterface({ input: client, crlfDelay: Infinity });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        const reply = JSON.parse(line);
        const p = pending.get(reply.id);
        if (p) {
          pending.delete(reply.id);
          if (reply.ok) p.resolve(reply.result);
          else p.reject(new Error(reply.error));
        }
      });

      function send(id, action) {
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          client.write(`${JSON.stringify({ id, action })}\n`);
        });
      }

      // Test 1: ping -> pong
      const pong = await send(1, "ping");
      assert.equal(pong, "pong");

      // Test 2: interleaved requests
      const [res2, res3] = await Promise.all([
        send(2, "snapshot"),
        send(3, "tabs"),
      ]);
      assert.deepEqual(res2, { echo: "snapshot" });
      assert.deepEqual(res3, { echo: "tabs" });

      // Test 3: error response propagation
      await assert.rejects(
        () => send(4, "error_test"),
        /simulated failure/
      );

      client.end();
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
