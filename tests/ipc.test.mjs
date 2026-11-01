import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
describe("host process IPC round-trip", () => {
  it("spawns host.mjs, receives clients frame for hello, routes socket round-trip, and shuts down on stdin end", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ipc-test-"));
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const hostScript = path.resolve(currentDir, "..", "host", "host.mjs");
    const le = os.endianness() === "LE";

    function encodeNativeFrame(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      const header = Buffer.alloc(4);
      if (le) header.writeUInt32LE(body.length, 0);
      else header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    }

    class NativeMessageReader {
      constructor(readableStream) {
        this.stream = readableStream;
        this.chunks = [];
        this.totalLen = 0;
        this.waiters = [];

        this.stream.on("data", (chunk) => {
          this.chunks.push(chunk);
          this.totalLen += chunk.length;
          this.flush();
        });
      }

      flush() {
        while (this.totalLen >= 4) {
          let len;
          if (this.chunks[0].length >= 4) {
            len = le ? this.chunks[0].readUInt32LE(0) : this.chunks[0].readUInt32BE(0);
          } else {
            const head = Buffer.concat(this.chunks, 4);
            len = le ? head.readUInt32LE(0) : head.readUInt32BE(0);
          }

          if (this.totalLen < 4 + len) break;

          const combined = Buffer.concat(this.chunks, 4 + len);
          const raw = combined.subarray(4, 4 + len);

          let toConsume = 4 + len;
          while (this.chunks.length > 0 && toConsume > 0) {
            if (this.chunks[0].length <= toConsume) {
              toConsume -= this.chunks[0].length;
              this.chunks.shift();
            } else {
              this.chunks[0] = this.chunks[0].subarray(toConsume);
              toConsume = 0;
            }
          }
          this.totalLen -= (4 + len);

          const parsed = JSON.parse(raw.toString("utf8"));
          const waiter = this.waiters.shift();
          if (waiter) waiter(parsed);
          else this.chunks.push({ parsed }); // fallback queue if needed
        }
      }

      nextMessage(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for native message")), timeoutMs);
          this.waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
          this.flush();
        });
      }
    }

    const hostProc = spawn(process.execPath, [hostScript], {
      env: { ...process.env, OMP_FIREFOX_DIR: tmpDir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const reader = new NativeMessageReader(hostProc.stdout);

    try {
      // 1. Send native-messaging hello frame
      hostProc.stdin.write(encodeNativeFrame({ type: "hello", version: "0.2.3" }));

      // 2. Expect host reply: { type: "clients", count: 0 }
      const helloReply = await reader.nextMessage();
      assert.deepEqual(helloReply, { type: "clients", count: 0 });

      // 3. Wait for host to write metadata file and listen on socket
      const metaPath = path.join(tmpDir, `${hostProc.pid}.json`);
      let endpoint = null;
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta?.endpoint) {
              endpoint = meta.endpoint;
              break;
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(endpoint, `Host failed to write metadata with endpoint in ${tmpDir}`);

      // 4. Connect to socket as an omp client
      const socket = net.createConnection(endpoint);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });

      // Host notifies extension about new client count: count: 1
      const clientConnectMsg = await reader.nextMessage();
      assert.deepEqual(clientConnectMsg, { type: "clients", count: 1 });

      // 5. Send RPC request from socket client
      socket.setEncoding("utf8");
      let socketBuffer = "";
      const socketResponsePromise = new Promise((resolve) => {
        socket.on("data", (chunk) => {
          socketBuffer += chunk;
          const nl = socketBuffer.indexOf("\n");
          if (nl >= 0) {
            resolve(JSON.parse(socketBuffer.slice(0, nl)));
          }
        });
      });

      socket.write(`${JSON.stringify({ id: 42, method: "ping", params: {} })}\n`);

      // Host forwards to extension as a native message { type: "request", id: <seq>, method: "ping", params: {} }
      const extRequest = await reader.nextMessage();
      assert.equal(extRequest.type, "request");
      assert.equal(extRequest.method, "ping");
      assert.ok(extRequest.id > 0);

      // Extension replies to host via stdin: { type: "response", id: <seq>, ok: true, result: { version: "0.2.3" } }
      hostProc.stdin.write(
        encodeNativeFrame({
          type: "response",
          id: extRequest.id,
          ok: true,
          result: { version: "0.2.3" },
        })
      );

      // Socket client receives reply
      const rpcReply = await socketResponsePromise;
      assert.deepEqual(rpcReply, { id: 42, ok: true, result: { version: "0.2.3" } });

      // Cleanly close socket
      socket.end();
      // Host sends updated client count: count: 0
      const clientDisconnectMsg = await reader.nextMessage();
      assert.deepEqual(clientDisconnectMsg, { type: "clients", count: 0 });

      // 6. Close host stdin -> triggers host shutdown
      hostProc.stdin.end();

      // Verify host process exits with 0
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          hostProc.kill();
          reject(new Error("Host did not exit within timeout"));
        }, 5000);
        hostProc.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0);
    } finally {
      if (hostProc.exitCode === null) {
        hostProc.kill();
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("spawns compiled Rust omp-firefox-host binary, receives clients frame for hello, routes socket round-trip, and shuts down on stdin end", async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const rustBinPath = path.resolve(currentDir, "..", "target", "debug", process.platform === "win32" ? "omp-firefox-host.exe" : "omp-firefox-host");
    if (!fs.existsSync(rustBinPath)) {
      return; // Skip if binary is not yet compiled
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-ipc-test-"));
    const le = os.endianness() === "LE";

    function encodeNativeFrame(msg) {
      const body = Buffer.from(JSON.stringify(msg));
      const header = Buffer.alloc(4);
      if (le) header.writeUInt32LE(body.length, 0);
      else header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    }

    class NativeMessageReader {
      constructor(readableStream) {
        this.stream = readableStream;
        this.chunks = [];
        this.totalLen = 0;
        this.waiters = [];

        this.stream.on("data", (chunk) => {
          this.chunks.push(chunk);
          this.totalLen += chunk.length;
          this.flush();
        });
      }

      flush() {
        while (this.totalLen >= 4) {
          let len;
          if (this.chunks[0].length >= 4) {
            len = le ? this.chunks[0].readUInt32LE(0) : this.chunks[0].readUInt32BE(0);
          } else {
            const head = Buffer.concat(this.chunks, 4);
            len = le ? head.readUInt32LE(0) : head.readUInt32BE(0);
          }

          if (this.totalLen < 4 + len) break;

          const combined = Buffer.concat(this.chunks, 4 + len);
          const raw = combined.subarray(4, 4 + len);

          let toConsume = 4 + len;
          while (this.chunks.length > 0 && toConsume > 0) {
            if (this.chunks[0].length <= toConsume) {
              toConsume -= this.chunks[0].length;
              this.chunks.shift();
            } else {
              this.chunks[0] = this.chunks[0].subarray(toConsume);
              toConsume = 0;
            }
          }
          this.totalLen -= (4 + len);

          const parsed = JSON.parse(raw.toString("utf8"));
          const waiter = this.waiters.shift();
          if (waiter) waiter(parsed);
          else this.chunks.push({ parsed });
        }
      }

      nextMessage(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for native message")), timeoutMs);
          this.waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
          this.flush();
        });
      }
    }

    const hostProc = spawn(rustBinPath, [], {
      env: { ...process.env, OMP_FIREFOX_DIR: tmpDir },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const reader = new NativeMessageReader(hostProc.stdout);

    try {
      // Send extension hello message
      const helloMsg = { type: "hello", version: "0.2.3", browserSession: "rust-session-uuid" };
      hostProc.stdin.write(encodeNativeFrame(helloMsg));

      // Extension should receive clients count frame
      const clientsFrame = await reader.nextMessage();
      assert.equal(clientsFrame.type, "clients");
      assert.equal(clientsFrame.count, 0);

      // Verify metadata file was created and contains browserSession and hostImpl: "rust"
      const metaPath = path.join(tmpDir, `${hostProc.pid}.json`);
      let meta;
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (meta.browserSession === "rust-session-uuid") break;
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(meta, "Metadata file exists");
      assert.equal(meta.pid, hostProc.pid);
      assert.equal(meta.hostImpl, "rust");
      assert.equal(meta.browserSession, "rust-session-uuid");

      // Connect client socket to the host endpoint
      const clientSocket = net.connect(meta.endpoint);
      await new Promise((resolve, reject) => {
        clientSocket.once("connect", resolve);
        clientSocket.once("error", reject);
      });

      // Extension should receive updated clients frame (count = 1)
      const clientConnectedFrame = await reader.nextMessage();
      assert.equal(clientConnectedFrame.type, "clients");
      assert.equal(clientConnectedFrame.count, 1);

      // Test ping directly answered by the host
      const pingPromise = new Promise((resolve) => {
        clientSocket.once("data", (data) => {
          const line = data.toString("utf8").trim();
          resolve(JSON.parse(line));
        });
      });
      clientSocket.write(`${JSON.stringify({ id: 101, method: "ping" })}\n`);
      const pingResp = await pingPromise;
      assert.equal(pingResp.id, 101);
      assert.equal(pingResp.ok, true);
      assert.equal(pingResp.result.pid, hostProc.pid);
      assert.equal(pingResp.result.extensionBrowserSession, "rust-session-uuid");

      // Test RPC routing to extension and response back
      const rpcReqPromise = reader.nextMessage();
      clientSocket.write(`${JSON.stringify({ id: 202, method: "tabs", params: { action: "list" } })}\n`);
      const rpcReq = await rpcReqPromise;
      assert.equal(rpcReq.method, "tabs");

      // Extension responds
      const rpcAnswerPromise = new Promise((resolve) => {
        clientSocket.once("data", (data) => {
          const line = data.toString("utf8").trim();
          resolve(JSON.parse(line));
        });
      });
      hostProc.stdin.write(encodeNativeFrame({ type: "response", id: rpcReq.id, ok: true, result: [{ id: 1, title: "Test" }] }));
      const rpcAnswer = await rpcAnswerPromise;
      assert.equal(rpcAnswer.id, 202);
      assert.equal(rpcAnswer.ok, true);
      assert.deepEqual(rpcAnswer.result, [{ id: 1, title: "Test" }]);

      clientSocket.destroy();
      hostProc.stdin.end();

      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          hostProc.kill();
          reject(new Error("Rust host did not exit within timeout"));
        }, 5000);
        hostProc.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0);
    } finally {
      if (hostProc.exitCode === null) {
        hostProc.kill();
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
