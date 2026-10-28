import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isValidEndpointForPid } from "../scripts/install-host.mjs";
export { isValidEndpointForPid };

export function getSocketDir(): string {
  return process.env.OMP_FIREFOX_DIR || path.join(os.homedir(), ".omp", "firefox");
}
export const SOCKET_DIR = getSocketDir();
const isWin = process.platform === "win32";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Reply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface EndpointCandidate {
  endpoint: string;
  mtime: number;
  pid?: number;
  file: string;
}

// V4: Validate bridge directory ownership and permissions (POSIX)
async function validateBridgeDir(targetDir: string): Promise<void> {
  const stat = await fs.lstat(targetDir);
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
}

export async function explainBridgeAbsence(hadCandidates: boolean): Promise<string> {
  const home = os.homedir();
  let primaryManifest: string;
  if (process.platform === "darwin") {
    primaryManifest = path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "omp_firefox.json");
  } else if (process.platform === "linux") {
    primaryManifest = path.join(home, ".mozilla", "native-messaging-hosts", "omp_firefox.json");
  } else {
    primaryManifest = path.join(getSocketDir(), "host", "omp_firefox.json");
  }

  try {
    await fs.stat(primaryManifest);
  } catch {
    return "Firefox native messaging host is not installed. Run '/firefox setup' (or 'npm run install-host') to register it with Firefox.";
  }

  let wrapperPath: string | undefined;
  try {
    const raw = await fs.readFile(primaryManifest, "utf8");
    const parsed = JSON.parse(raw);
    wrapperPath = parsed?.path;
  } catch {
    return `Native messaging host manifest at "${primaryManifest}" is corrupted or unreadable. Run '/firefox setup' to restore it.`;
  }

  if (wrapperPath) {
    try {
      await fs.stat(wrapperPath);
    } catch {
      return `Native messaging host manifest points to a missing wrapper at "${wrapperPath}". Run '/firefox setup' to recreate it.`;
    }
  }

  const hostMjs = path.join(getSocketDir(), "host", "host.mjs");
  try {
    await fs.stat(hostMjs);
  } catch {
    return `Host script is missing at "${hostMjs}". Run '/firefox setup' to restore it.`;
  }

  if (hadCandidates) {
    return (
      `Found recent bridge endpoint(s) in ${getSocketDir()}, but connection was refused. ` +
      `The host process may have terminated or Firefox was restarted. Ensure Firefox is running.`
    );
  }

  return (
    `Native host is registered, but Firefox has not connected to it. ` +
    `Ensure Firefox is running and the "OMP Browser Bridge" add-on is installed and enabled (from AMO or loaded in about:debugging). ` +
    `The bridge starts automatically once Firefox loads the add-on.`
  );
}

/** Newline-delimited JSON RPC over the unix socket or named pipe exposed by the native messaging host. */
export class FirefoxBridge {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;
  #buffer = "";
  closed = false;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("close", () => this.#fail(new Error("Firefox bridge disconnected (Firefox closed or add-on reloaded)")));
    socket.on("error", () => {});
  }

  /** Connects to the most recently started live host (one per running Firefox instance). */
  static async connect(): Promise<FirefoxBridge> {
    const socketDir = getSocketDir();
    // V4: Validate bridge dir first
    try {
      await validateBridgeDir(socketDir);
    } catch (e: unknown) {
      throw new Error(`Insecure or invalid bridge directory: ${e instanceof Error ? e.message : e}`);
    }

    let entries: string[] = [];
    try {
      entries = await fs.readdir(socketDir);
    } catch {}

    const candidates = new Map<string, EndpointCandidate>();

    // 1. Check for <pid>.json descriptor files (cross-platform endpoint metadata)
    for (const f of entries) {
      const m = /^(\d+)\.json$/.exec(f);
      if (!m) continue;
      const pid = Number(m[1]);

      // V3: Skip candidates whose PID is dead BEFORE connecting
      try {
        process.kill(pid, 0);
      } catch (e: unknown) {
        if (e && typeof e === "object" && "code" in e && e.code === "ESRCH") {
          // Dead process, clean up stale files
          try {
            await fs.unlink(path.join(socketDir, f));
          } catch {}
          if (!isWin) {
            try {
              await fs.unlink(path.join(socketDir, `${pid}.sock`));
            } catch {}
          }
          continue;
        }
      }

      const fullPath = path.join(socketDir, f);
      try {
        const stat = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, "utf8");
        const data = JSON.parse(content);
        if (data && typeof data.endpoint === "string") {
          // V4: Validate endpoint matching expected value for that pid
          if (!isValidEndpointForPid(pid, data.endpoint, socketDir)) {
            continue;
          }
          candidates.set(data.endpoint, {
            endpoint: data.endpoint,
            mtime: stat.mtimeMs,
            pid,
            file: fullPath,
          });
        }
      } catch {}
    }

    // 2. Check for <pid>.sock files (POSIX backwards-compatibility)
    if (!isWin) {
      for (const f of entries) {
        const m = /^(\d+)\.sock$/.exec(f);
        if (!m) continue;
        const pid = Number(m[1]);

        // V3: Check if PID is alive before connecting
        try {
          process.kill(pid, 0);
        } catch (e: unknown) {
          if (e && typeof e === "object" && "code" in e && e.code === "ESRCH") {
            try {
              await fs.unlink(path.join(socketDir, f));
            } catch {}
            try {
              await fs.unlink(path.join(socketDir, `${pid}.json`));
            } catch {}
            continue;
          }
        }

        const fullPath = path.join(socketDir, f);
        if (!candidates.has(fullPath)) {
          try {
            const stat = await fs.stat(fullPath);
            candidates.set(fullPath, {
              endpoint: fullPath,
              mtime: stat.mtimeMs,
              pid,
              file: fullPath,
            });
          } catch {}
        }
      }
    }

    const sorted = [...candidates.values()].sort((a, b) => b.mtime - a.mtime);

    for (const cand of sorted) {
      const socket = net.createConnection(cand.endpoint);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      socket.once("connect", resolve);
      socket.once("error", reject);
      try {
        await promise;
        socket.removeListener("error", reject);
        return new FirefoxBridge(socket);
      } catch {
        socket.destroy();
        // Stale cleanup if process is confirmed dead
        if (cand.pid !== undefined) {
          try {
            process.kill(cand.pid, 0);
          } catch (e: unknown) {
            if (e && typeof e === "object" && "code" in e && e.code === "ESRCH") {
              try {
                await fs.unlink(cand.file);
              } catch {}
              if (cand.file.endsWith(".json")) {
                try {
                  await fs.unlink(cand.file.replace(/\.json$/, ".sock"));
                } catch {}
              }
            }
          }
        }
      }
    }

    const explanation = await explainBridgeAbsence(sorted.length > 0);
    throw new Error(`Cannot connect to Firefox bridge in ${socketDir}. ${explanation}`);
  }

  call<T>(method: string, params: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Firefox bridge is closed"));
    const id = ++this.#seq;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => settle(new Error(`Firefox did not answer ${method} within ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => settle(new Error("Cancelled"));
    const settle = (error: Error | null, value?: unknown) => {
      clearTimeout(timer);
      this.#pending.delete(id);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    this.#pending.set(id, { resolve: (v) => settle(null, v), reject: (e) => settle(e) });
    if (opts.signal?.aborted) {
      onAbort();
      return promise;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  close(): void {
    this.closed = true;
    this.#socket.destroy();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Reply;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Firefox request failed"));
    }
  }

  #fail(error: Error): void {
    this.closed = true;
    for (const p of [...this.#pending.values()]) p.reject(error);
  }
}
