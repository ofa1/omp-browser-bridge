import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FirefoxBridge, getSocketDir } from "./client.ts";
import { checkHostStatus, installHost, uninstallHost } from "../scripts/install-host.mjs";

interface TabInfo {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  status?: string;
  agent: boolean;
  discarded?: boolean;
  loaded?: boolean;
}

interface Snapshot {
  title: string;
  url: string;
  text: string;
  offset: number;
  total: number;
  nextOffset: number | null;
  refs: number;
  scroll: { y: number; height: number; viewport: number };
}

interface ActResult {
  steps: string[];
  error?: string;
  tab: TabInfo;
}

interface Screenshot {
  dataUrl: string;
  rect: { width: number; height: number } | null;
}

const TOOL_NAMES = ["firefox_tabs", "firefox_navigate", "firefox_snapshot", "firefox_act", "firefox_eval", "firefox_screenshot"];
const MAX_OUTPUT = 40_000;
const STATUS_KEY = "firefox";
// Firefox caps host→extension messages at 1 MB, so uploads travel in chunks. A multiple of 3 bytes keeps base64 chunks concatenable.
const UPLOAD_CHUNK_BYTES = 510_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// H5: Sanitize tab titles and URLs (remove newlines and control characters)
function sanitizeText(str: string): string {
  // Replace newlines and ASCII control characters (0x00-0x1F, 0x7F) with space
  return str.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim();
}

export default function firefoxExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  let bridge: FirefoxBridge | null = null;
  let enabled = false;
  let currentTab: number | undefined;
  // Tabs the add-on reports as agent-owned. Reading any other tab (the user's own) needs exec approval.
  const agentTabs = new Set<number>();
  function noteTab(t: TabInfo): TabInfo {
    if (t.agent) agentTabs.add(t.id);
    else agentTabs.delete(t.id);
    return t;
  }
  function readIfAgentTab(id: number | undefined): "read" | "exec" {
    return id !== undefined && agentTabs.has(id) ? "read" : "exec";
  }

  async function getBridge(): Promise<FirefoxBridge> {
    if (!enabled) throw new Error("Firefox control is off; the user enables it with /firefox on");
    if (!bridge || bridge.closed) {
      agentTabs.clear();
      currentTab = undefined;
      bridge = await FirefoxBridge.connect();
    }
    return bridge;
  }

  async function rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const b = await getBridge();
    try {
      return await b.call<T>(method, params, { signal, timeoutMs });
    } catch (e) {
      if (params.tabId === currentTab && /No tab with id|Invalid tab ID/i.test(String(e))) currentTab = undefined;
      throw e;
    }
  }

  /** Streams local files to the extension in chunks; returns staging ids for an upload step. */
  async function stageFiles(files: string[] | undefined, cwd: string, signal?: AbortSignal): Promise<string[]> {
    if (!files?.length) throw new Error("upload needs files: [paths]");
    const resolved = await Promise.all(
      files.map(async (file) => {
        const full = path.resolve(cwd, file);
        const stat = await fs.stat(full);
        if (!stat.isFile()) throw new Error(`upload: ${file} is not a regular file`);
        return { full, size: stat.size };
      }),
    );
    const total = resolved.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_UPLOAD_BYTES) throw new Error(`upload: ${(total / 1048576).toFixed(1)} MB exceeds the ${MAX_UPLOAD_BYTES / 1048576} MB limit per step`);
    const ids: string[] = [];
    for (const { full } of resolved) {
      const data = await fs.readFile(full);
      const id = crypto.randomUUID();
      const name = path.basename(full);
      const type = MIME_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream";
      let offset = 0;
      do {
        const chunk = data.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString("base64");
        await rpc("stageFile", { id, name, type, data: chunk }, signal);
        offset += UPLOAD_CHUNK_BYTES;
      } while (offset < data.length);
      ids.push(id);
    }
    return ids;
  }

  function requireTab(tabId: number | undefined): number {
    const id = tabId ?? currentTab;
    if (id === undefined) {
      throw new Error('No current tab. Use firefox_navigate with a url (opens an agent tab) or firefox_tabs {action:"select", tabId}.');
    }
    return id;
  }

  function text(body: string, details: Record<string, unknown> = {}) {
    const clipped = body.length > MAX_OUTPUT ? `${body.slice(0, MAX_OUTPUT)}\n… [${body.length - MAX_OUTPUT} chars truncated]` : body;
    return { content: [{ type: "text" as const, text: clipped }], details };
  }

  function tabLine(t: TabInfo): string {
    const marks = [t.id === currentTab ? "*" : " ", t.agent ? "agent" : "", t.active ? "visible" : ""].filter(Boolean).join(" ");
    const cleanTitle = sanitizeText(t.title || "");
    const cleanUrl = sanitizeText(t.url || "");
    return `${marks} tab ${t.id} (win ${t.windowId}) ${JSON.stringify(cleanTitle)} ${cleanUrl}`;
  }

  function formatSnapshot(s: Snapshot, tabId: number): string {
    const range = s.nextOffset === null && s.offset === 0 ? `${s.total} chars` : `chars ${s.offset}-${s.offset + s.text.length} of ${s.total}`;
    const more = s.nextOffset === null ? "" : `; more with offset=${s.nextOffset}`;
    const scroll = `scrollY ${s.scroll.y}/${s.scroll.height}, viewport ${s.scroll.viewport}`;
    const cleanTitle = sanitizeText(s.title || "");
    const cleanUrl = sanitizeText(s.url || "");
    return `# ${cleanTitle}\n${cleanUrl}\n(tab ${tabId}; ${range}${more}; ${s.refs} refs; ${scroll})\n\n${s.text}`;
  }

  async function setEnabled(on: boolean, ctx: { ui: { setStatus(key: string, text: string | undefined): void } }): Promise<string> {
    const active = await pi.getActiveTools();
    if (on) {
      enabled = true;
      let info: { version: string; paused: boolean; userAgent: string };
      try {
        info = await rpc("ping", {}, undefined, 5000);
      } catch (e) {
        enabled = false;
        throw e;
      }
      await pi.setActiveTools([...new Set([...active, ...TOOL_NAMES])]);
      ctx.ui.setStatus(STATUS_KEY, info.paused ? "firefox: paused" : "firefox: on");
      return `Firefox control on (add-on ${info.version}${info.paused ? ", paused from toolbar" : ""}).`;
    }
    enabled = false;
    bridge?.close();
    bridge = null;
    currentTab = undefined;
    agentTabs.clear();
    await pi.setActiveTools(active.filter((n) => !TOOL_NAMES.includes(n)));
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return "Firefox control off.";
  }

  async function ensureHostInstalled(ctx: { ui: { notify(msg: string, type: "info" | "warning" | "error"): void } }): Promise<void> {
    const status = checkHostStatus();
    if (!status.installed || status.stale) {
      const res = await installHost({ silent: true });
      ctx.ui.notify(
        `Native host ${!status.installed ? "was not installed" : "was outdated"}; registered automatically at ${res.manifestPaths[0]}.`,
        "info",
      );
    }
  }

  pi.registerFlag("firefox", { description: "Enable Firefox browser control at startup", type: "boolean", default: false });

  pi.registerCommand("firefox", {
    description: "Control your Firefox browser: /firefox [on|off|status|setup|uninstall]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      try {
        if (arg === "setup") {
          const res = await installHost();
          ctx.ui.notify(
            `Native messaging host registered successfully:\n` +
              `• Wrapper: ${res.wrapperPath}\n` +
              `• Manifest(s): ${res.manifestPaths.join(", ")}\n` +
              `• Runtime: ${res.runtime.type} (${res.runtime.path})\n\n` +
              `Next step: Ensure "OMP Browser Bridge" is installed in Firefox (from AMO or GitHub releases), then run /firefox on.`,
            "info",
          );
          return;
        }

        if (arg === "uninstall") {
          if (enabled) await setEnabled(false, ctx);
          const res = await uninstallHost();
          ctx.ui.notify(
            `Native messaging host uninstalled:\n` +
              `• Removed manifests: ${res.removedManifests.join(", ") || "none"}\n` +
              `• Removed files: ${res.removedFiles.join(", ") || "none"}\n` +
              `• Host dir: ${res.stableHostDir} (${res.removedDir ? "removed" : "kept non-empty"})`,
            "info",
          );
          return;
        }

        if (arg === "status") {
          const status = checkHostStatus();
          const hostDesc = !status.installed
            ? "NOT installed (run /firefox setup)"
            : status.stale
              ? `installed but outdated (${status.reason})`
              : `ready (v${status.version})`;
          const tabDesc = currentTab !== undefined ? `, current tab ${currentTab}` : "";
          ctx.ui.notify(
            `Firefox control ${enabled ? "ON" : "OFF"}${tabDesc}.\nHost: ${hostDesc}.\nBridge dir: ${getSocketDir()}`,
            "info",
          );
          return;
        }

        if (arg === "on") {
          await ensureHostInstalled(ctx);
          ctx.ui.notify(await setEnabled(true, ctx), "info");
          return;
        }

        if (arg === "off") {
          ctx.ui.notify(await setEnabled(false, ctx), "info");
          return;
        }

        if (!arg) {
          const next = !enabled;
          if (next) await ensureHostInstalled(ctx);
          ctx.ui.notify(await setEnabled(next, ctx), "info");
          return;
        }

        ctx.ui.notify("Usage: /firefox [on|off|status|setup|uninstall]", "warning");
      } catch (e) {
        ctx.ui.notify(`Firefox: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("firefox")) return;
    try {
      await ensureHostInstalled(ctx);
      ctx.ui.notify(await setEnabled(true, ctx), "info");
    } catch (e) {
      ctx.ui.notify(`Firefox: ${e instanceof Error ? e.message : e}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    bridge?.close();
    bridge = null;
  });

  const tabId = z.number().int().optional().describe("Target tab id; defaults to the current agent tab");

  pi.registerTool({
    name: "firefox_tabs",
    label: "Firefox Tabs",
    description:
      "List or manage tabs in the user's real Firefox (logged-in sessions). " +
      "list: all tabs (* = current, agent = opened by you). open: new background agent tab (grouped under 'omp'). " +
      "select: make tabId the current tab for other firefox_* tools without focusing it. activate: bring tab to front. close: close a tab. " +
      "Only select/act on the user's own tabs when they asked you to.",
    parameters: z.object({
      action: z.enum(["list", "open", "select", "activate", "close"]).default("list"),
      tabId: z.number().int().optional().describe("Required for select/activate/close"),
      url: z.string().optional().describe("For open"),
      active: z.boolean().optional().describe("open: focus the new tab (default false)"),
    }),
    defaultInactive: true,
    approval: (args) => {
      const a = args as { action?: string; tabId?: number };
      return !a.action || a.action === "list" ? "read" : a.action === "select" ? readIfAgentTab(a.tabId) : "exec";
    },
    async execute(_id, params, signal) {
      const action = params.action ?? "list";
      if (action === "list") {
        const tabs = await rpc<TabInfo[]>("tabs", { action }, signal);
        for (const t of tabs) noteTab(t);
        return text(tabs.map(tabLine).join("\n"), { count: tabs.length });
      }
      if (action === "select") {
        const id = requireTab(params.tabId);
        const t = noteTab(await rpc<TabInfo>("tabs", { action: "info", tabId: id }, signal));
        currentTab = id;
        return text(`Current tab:\n${tabLine(t)}`);
      }
      if (action === "activate") {
        const id = requireTab(params.tabId);
        const t = noteTab(await rpc<TabInfo>("tabs", { action, tabId: id }, signal));
        currentTab = id;
        return text(tabLine(t));
      }
      if (action === "close") {
        const id = params.tabId ?? currentTab;
        if (id === undefined) throw new Error("close needs tabId");
        await rpc("tabs", { action, tabId: id }, signal);
        if (id === currentTab) currentTab = undefined;
        return text(`Closed tab ${id}`);
      }
      const t = noteTab(await rpc<TabInfo>("tabs", { action, tabId: params.tabId, url: params.url, active: params.active }, signal));
      currentTab = t.id;
      return text(tabLine(t));
    },
  });

  pi.registerTool({
    name: "firefox_navigate",
    label: "Firefox Navigate",
    description:
      "Navigate in the user's Firefox and (by default) return a page snapshot. With no current tab, or newTab:true, opens a background agent tab. " +
      "Never navigate a tab the user is reading unless they asked.",
    parameters: z.object({
      url: z.string().optional().describe("URL to load"),
      action: z.enum(["back", "forward", "reload"]).optional().describe("Instead of url"),
      tabId,
      newTab: z.boolean().optional().describe("Open url in a new agent tab"),
      snapshot: z.boolean().optional().describe("Return a page snapshot afterwards (default true)"),
      maxChars: z.number().int().optional().describe("Snapshot size cap (default 10000)"),
      timeoutMs: z.number().int().optional().describe("Load timeout (default 20000)"),
    }),
    defaultInactive: true,
    approval: "exec",
    async execute(_id, params, signal) {
      if (!params.url && !params.action) throw new Error("Pass url or action");
      const timeoutMs = params.timeoutMs ?? 20_000;
      let tab: TabInfo;
      if (params.url && (params.newTab || (params.tabId ?? currentTab) === undefined)) {
        tab = noteTab(await rpc<TabInfo>("tabs", { action: "open", url: params.url, timeoutMs }, signal, timeoutMs + 5000));
        currentTab = tab.id;
      } else {
        const id = requireTab(params.tabId);
        tab = noteTab(await rpc<TabInfo>("navigate", { tabId: id, url: params.url, action: params.action, timeoutMs }, signal, timeoutMs + 5000));
        currentTab = id;
      }
      const head = tab.loaded === false ? `(load not complete after ${timeoutMs}ms)\n` : "";
      if (params.snapshot === false) return text(`${head}${tabLine(tab)}`, { tabId: tab.id });
      const snap = await rpc<Snapshot>("snapshot", { tabId: tab.id, maxChars: params.maxChars ?? 10_000 }, signal);
      return text(head + formatSnapshot(snap, tab.id), { tabId: tab.id, url: snap.url });
    },
  });

  pi.registerTool({
    name: "firefox_snapshot",
    label: "Firefox Snapshot",
    description:
      "Read the current Firefox page as compact text. Interactive elements appear inline as `[N] role \"name\" …`; pass N as `ref` to firefox_act. " +
      "Refs stay valid until the page navigates. mode 'interactive' lists only refs (cheapest). scope 'viewport' limits to what is on screen. " +
      "Use selector to read part of the page, offset to page through long content.",
    parameters: z.object({
      tabId,
      mode: z.enum(["page", "interactive"]).optional().describe("page (default): text with inline refs; interactive: refs only"),
      scope: z.enum(["page", "viewport"]).optional(),
      selector: z.string().optional().describe("CSS selector of the subtree to read"),
      frameSelector: z.string().optional().describe("CSS selector of an iframe to read within (e.g. '#my-iframe')"),
      maxChars: z.number().int().optional().describe("Default 10000"),
      offset: z.number().int().optional().describe("Character offset for paging"),
    }),
    defaultInactive: true,
    approval: (args: unknown) => {
      const a = args as { tabId?: number } | undefined;
      return readIfAgentTab(a?.tabId ?? currentTab);
    },
    async execute(_id, params, signal) {
      const id = requireTab(params.tabId);
      const snap = await rpc<Snapshot>(
        "snapshot",
        { tabId: id, mode: params.mode, scope: params.scope, selector: params.selector, frameSelector: params.frameSelector, maxChars: params.maxChars ?? 10_000, offset: params.offset ?? 0 },
        signal,
      );
      currentTab = id;
      return text(formatSnapshot(snap, id), { tabId: id, url: snap.url });
    },
  });

  pi.registerTool({
    name: "firefox_act",
    label: "Firefox Act",
    description:
      "Run one or more UI steps on a Firefox page in order (batch steps like fill→fill→click in one call). Target elements by snapshot `ref` or CSS `selector`. " +
      "Actions: click, dblclick, hover, focus, fill (replace text), type (append keystrokes), press (value: key like Enter, Tab, Escape, Control+a; target defaults to focused element), " +
      "select (<select>; value = option text/value), check, uncheck, submit (enclosing form), scroll (value: up|down|top|bottom|pixels; page or element), " +
      "wait (selector/text to appear, or gone:true to disappear, or url substring), " +
      "upload (files: local paths, relative to the working directory; target a file input, its label, or a container holding one — hidden inputs work, " +
      "e.g. selector 'input[type=file]'; no page JavaScript needed). Stops at the first failing step. " +
      "Events are synthetic (isTrusted=false). Confirm with the user before purchases, sends, posts, deletions, uploading private files, or other consequential submits.",
    parameters: z.object({
      tabId,
      steps: z
        .array(
          z.object({
            action: z.enum(["click", "dblclick", "hover", "focus", "fill", "type", "press", "select", "check", "uncheck", "submit", "scroll", "wait", "upload"]),
            ref: z.number().int().optional(),
            selector: z.string().optional(),
            frameSelector: z.string().optional().describe("CSS selector of an iframe containing the target selector"),
            value: z.string().optional(),
            text: z.string().optional().describe("wait: text to appear"),
            url: z.string().optional().describe("wait: URL substring"),
            gone: z.boolean().optional().describe("wait: until selector/text disappears"),
            files: z.array(z.string()).optional().describe("upload: local file paths"),
            timeoutMs: z.number().int().optional().describe("wait timeout (default 10000)"),
          }),
        )
        .min(1),
      snapshot: z.boolean().optional().describe("Return a fresh snapshot after the steps (default false)"),
      maxChars: z.number().int().optional(),
    }),
    defaultInactive: true,
    approval: "exec",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const id = requireTab(params.tabId);
      const steps = [];
      for (const step of params.steps) {
        steps.push(step.action === "upload" ? { ...step, files: await stageFiles(step.files, ctx.cwd, signal) } : step);
      }
      const waitBudget = params.steps.reduce((sum, s) => sum + (s.timeoutMs ?? 10_000) + 15_000, 0);
      const res = await rpc<ActResult>("act", { tabId: id, steps }, signal, waitBudget + 10_000);
      currentTab = id;
      const lines = res.steps.map((s, i) => `${i + 1}. ${s}`);
      if (res.error) lines.push(`✗ ${res.error}`);
      const cleanTitle = sanitizeText(res.tab.title || "");
      const cleanUrl = sanitizeText(res.tab.url || "");
      lines.push(`now: ${JSON.stringify(cleanTitle)} ${cleanUrl}`);
      let body = lines.join("\n");
      if (params.snapshot) {
        const snap = await rpc<Snapshot>("snapshot", { tabId: id, maxChars: params.maxChars ?? 10_000 }, signal);
        body += `\n\n${formatSnapshot(snap, id)}`;
      }
      if (res.error && !params.snapshot) body += "\n(take a new snapshot if refs went stale)";
      return text(body, { tabId: id, error: res.error ?? null });
    },
  });

  pi.registerTool({
    name: "firefox_eval",
    label: "Firefox Eval",
    description:
      "Run JavaScript in a Firefox page (extension content-script world: full DOM access, not blocked by page CSP). " +
      "Requires the user to enable 'Allow page JavaScript' in the OMP Browser Bridge popup in Firefox (disabled by default). " +
      "`code` is an async function body; `return` a JSON-able value. " +
      "In scope: `document`, `window`, `page` (= window.wrappedJSObject, the page's own JS globals), `args`, `ref(n)` (element for snapshot ref n). " +
      "DOM nodes in results are summarized.",
    parameters: z.object({
      code: z.string().describe("Async function body, e.g. `return [...document.querySelectorAll('h2')].map(h => h.textContent)`"),
      args: z.array(z.unknown()).optional(),
      frameSelector: z.string().optional().describe("CSS selector of an iframe to evaluate within"),
      tabId,
      timeoutMs: z.number().int().optional().describe("Default 15000"),
    }),
    defaultInactive: true,
    approval: "exec",
    async execute(_id, params, signal) {
      const id = requireTab(params.tabId);
      const timeoutMs = params.timeoutMs ?? 15_000;
      const value = await rpc<unknown>("eval", { tabId: id, code: params.code, args: params.args ?? [], frameSelector: params.frameSelector, timeoutMs }, signal, timeoutMs + 5000);
      currentTab = id;
      const out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
      return text(out ?? "undefined", { tabId: id });
    },
  });

  pi.registerTool({
    name: "firefox_screenshot",
    label: "Firefox Screenshot",
    description:
      "Capture a Firefox tab as an image (works for background tabs). Default: visible viewport. fullPage, or crop to an element by ref/selector. " +
      "Prefer firefox_snapshot for reading; use screenshots for layout/visual questions.",
    parameters: z.object({
      tabId,
      fullPage: z.boolean().optional(),
      ref: z.number().int().optional(),
      selector: z.string().optional(),
      frameSelector: z.string().optional().describe("CSS selector of an iframe containing the target selector"),
      format: z.enum(["png", "jpeg"]).optional().describe("Default jpeg"),
    }),
    defaultInactive: true,
    approval: (args: unknown) => {
      const a = args as { tabId?: number } | undefined;
      return readIfAgentTab(a?.tabId ?? currentTab);
    },
    async execute(_id, params, signal) {
      const id = requireTab(params.tabId);
      const format = params.format ?? "jpeg";
      const shot = await rpc<Screenshot>("screenshot", { tabId: id, fullPage: params.fullPage, ref: params.ref, selector: params.selector, frameSelector: params.frameSelector, format }, signal);
      currentTab = id;
      const comma = shot.dataUrl.indexOf(",");
      const mimeType = shot.dataUrl.slice(5, shot.dataUrl.indexOf(";"));
      const size = shot.rect ? ` ${Math.round(shot.rect.width)}x${Math.round(shot.rect.height)}` : " viewport";
      return {
        content: [
          { type: "text" as const, text: `Screenshot of tab ${id}${size}` },
          { type: "image" as const, data: shot.dataUrl.slice(comma + 1), mimeType },
        ],
        details: { tabId: id },
      };
    },
  });
}
