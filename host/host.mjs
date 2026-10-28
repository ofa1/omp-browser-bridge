// Native messaging host launched by Firefox. Bridges the add-on (stdio, length-prefixed JSON)
// to omp sessions (unix socket or named pipe, newline-delimited JSON). One host per Firefox instance.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const dir = process.env.OMP_FIREFOX_DIR || path.join(os.homedir(), ".omp", "firefox");
const isWin = process.platform === "win32";

function ensureSecureBridgeDir(targetDir) {
  if (fs.existsSync(targetDir)) {
    const stat = fs.lstatSync(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Bridge directory "${targetDir}" is not a real directory or is a symlink.`);
    }
    if (!isWin) {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (currentUid !== null && stat.uid !== currentUid) {
        throw new Error(`Bridge directory "${targetDir}" is not owned by current user (owner UID: ${stat.uid}, expected: ${currentUid}).`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(`Bridge directory "${targetDir}" has insecure permissions (${(stat.mode & 0o777).toString(8)}). Must not allow group/other access.`);
      }
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    if (!isWin) {
      try {
        fs.chmodSync(targetDir, 0o700);
      } catch {}
    }
  }
}

try {
  ensureSecureBridgeDir(dir);
} catch (err) {
  console.error(`Failed to secure bridge directory: ${err.message}`);
  process.exit(1);
}

// Clean up stale sockets and endpoint metadata from dead processes
try {
  for (const f of fs.readdirSync(dir)) {
    if (f === "host-version.json") continue;
    const m = /^(\d+)\.(sock|json)$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") {
        try {
          fs.rmSync(path.join(dir, f), { force: true });
        } catch {}
      }
    }
  }
} catch {}

// V3: Random unguessable named pipe on Windows
const pipeName = `omp-firefox-${crypto.randomUUID()}`;
const sockPath = isWin
  ? `\\\\.\\pipe\\${pipeName}`
  : path.join(dir, `${process.pid}.sock`);
const metaPath = path.join(dir, `${process.pid}.json`);

// H3: Remove own stale socket before listen if it exists
if (!isWin) {
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {}
}

const le = os.endianness() === "LE";

function sendToExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  if (le) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

const pending = new Map();
const clients = new Set();
let seq = 0;

// V5: Accumulate stdin chunks without quadratic concat
const stdinChunks = [];
let stdinTotalLen = 0;

process.stdin.on("data", (chunk) => {
  stdinChunks.push(chunk);
  stdinTotalLen += chunk.length;

  while (stdinTotalLen >= 4) {
    // Read the 4-byte length prefix
    let len;
    if (stdinChunks[0].length >= 4) {
      len = le ? stdinChunks[0].readUInt32LE(0) : stdinChunks[0].readUInt32BE(0);
    } else {
      // Span across first chunks
      const head = Buffer.concat(stdinChunks, 4);
      len = le ? head.readUInt32LE(0) : head.readUInt32BE(0);
    }

    if (stdinTotalLen < 4 + len) break;

    // We have a full frame (4 + len bytes)
    const combined = Buffer.concat(stdinChunks, 4 + len);
    const raw = combined.subarray(4, 4 + len);

    // Consume 4 + len bytes from stdinChunks
    let toConsume = 4 + len;
    while (stdinChunks.length > 0 && toConsume > 0) {
      if (stdinChunks[0].length <= toConsume) {
        toConsume -= stdinChunks[0].length;
        stdinChunks.shift();
      } else {
        stdinChunks[0] = stdinChunks[0].subarray(toConsume);
        toConsume = 0;
      }
    }
    stdinTotalLen -= (4 + len);

    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    if (msg.type !== "response") continue;
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (!p.socket.destroyed) {
      p.socket.write(`${JSON.stringify({ id: p.id, ok: msg.ok, result: msg.result, error: msg.error })}\n`);
    }
  }
});
process.stdin.on("end", shutdown);

const MAX_LINE_BUFFER = 64 * 1024 * 1024; // 64 MB
const MAX_NATIVE_MSG_SIZE = 1_000_000; // 1 MB limit for Firefox native messaging

const server = net.createServer((socket) => {
  clients.add(socket);
  sendToExtension({ type: "clients", count: clients.size });
  socket.setEncoding("utf8");
  let linebuf = "";
  socket.on("data", (data) => {
    linebuf += data;
    if (linebuf.length > MAX_LINE_BUFFER) {
      try {
        socket.write(`${JSON.stringify({ ok: false, error: "Line buffer exceeded 64 MB limit." })}\n`);
      } catch {}
      socket.destroy();
      return;
    }
    let nl;
    while ((nl = linebuf.indexOf("\n")) >= 0) {
      const line = linebuf.slice(0, nl);
      linebuf = linebuf.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }

      // V5: Check request size before forwarding to extension
      const extMsg = { type: "request", id: 0, method: req.method, params: req.params ?? {} };
      const serialized = JSON.stringify(extMsg);
      const byteLen = Buffer.byteLength(serialized, "utf8");

      if (byteLen > MAX_NATIVE_MSG_SIZE) {
        // Contract 4: Oversize reply
        socket.write(
          `${JSON.stringify({
            id: req.id,
            ok: false,
            error: `Request too large for Firefox native messaging (${byteLen} bytes; limit 1 MB).`,
          })}\n`
        );
        continue;
      }

      const id = ++seq;
      extMsg.id = id;
      pending.set(id, { socket, id: req.id });
      sendToExtension(extMsg);
    }
  });
  socket.on("close", () => {
    clients.delete(socket);
    for (const [id, p] of pending) if (p.socket === socket) pending.delete(id);
    sendToExtension({ type: "clients", count: clients.size });
  });
  socket.on("error", () => {});
});

// V3: Clean shutdown on server listen error
server.on("error", (err) => {
  console.error(`Native host server error: ${err.message}`);
  shutdown();
});

function writeMetadata() {
  const meta = {
    pid: process.pid,
    endpoint: sockPath,
    platform: process.platform,
    created: Date.now(),
    version: 1,
  };
  try {
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

server.listen(sockPath, () => {
  if (!isWin) {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {}
  }
  writeMetadata();
});

let isShuttingDown = false;
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    fs.rmSync(metaPath, { force: true });
  } catch {}
  if (!isWin) {
    try {
      fs.rmSync(sockPath, { force: true });
    } catch {}
  }
  try {
    server.close();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", () => {
  try {
    fs.rmSync(metaPath, { force: true });
  } catch {}
  if (!isWin) {
    try {
      fs.rmSync(sockPath, { force: true });
    } catch {}
  }
});
