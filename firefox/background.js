// Persistent background page: holds the native-messaging port to the omp host and executes requests.
const HOST_NAME = "omp_firefox";
const VERSION = browser.runtime.getManifest().version;

let port = null;
let retryMs = 2000;
let clients = 0;
let paused = false;
let allowEval = false;
const PAUSE_ERROR = "The user paused agent control in Firefox (OMP Browser Bridge popup or Alt+Shift+O). Ask them to resume it.";
let hostConnected = false;
let lastDisconnectError = null;

browser.storage.local.get({ allowEval: false }).then((res) => {
  allowEval = !!res.allowEval;
}).catch(() => {});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "allowEval" in changes) {
    allowEval = !!changes.allowEval.newValue;
    broadcastState();
  }
});

const agentTabs = new Set();
const groupByWindow = new Map();
const activity = []; // in-memory ring buffer (max 50)
// Upload staging: omp streams files in base64 chunks (native messaging caps each message at 1 MB).
const staged = new Map(); // id -> { name, type, parts: string[], at }
const STAGE_TTL_MS = 120_000;
const MAX_STAGED_CHARS = 72 * 1024 * 1024; // ≈54 MB of file data

function broadcastState() {
  browser.runtime.sendMessage({ type: "state_changed" }).catch(() => {
    // Popup may not be open, ignore errors
  });
}

function updateBadge() {
  const text = !hostConnected ? "" : paused ? "II" : clients ? "ON" : "";
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color: paused ? "#D97706" : "#7C3AED" });
  const title = !hostConnected
    ? "OMP Browser Bridge: native host not connected"
    : paused
      ? "OMP Browser Bridge: paused"
      : clients
        ? `OMP Browser Bridge: controlling (${clients} session${clients > 1 ? "s" : ""})`
        : "OMP Browser Bridge: idle";
  browser.browserAction.setTitle({ title });
}

function summarizeUrl(raw) {
  try {
    const u = new URL(raw);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(raw || "").slice(0, 40);
  }
}

function summarizeMethod(method, params = {}) {
  switch (method) {
    case "navigate": {
      if (params.url) return summarizeUrl(params.url);
      if (params.action) return params.action;
      return "navigate";
    }
    case "act": {
      const steps = params.steps || [];
      const count = steps.length;
      if (count === 0) return "0 steps";
      const names = steps.map((s) => s.action || "step").slice(0, 3).join(", ");
      const more = count > 3 ? "…" : "";
      return `${count} step${count > 1 ? "s" : ""}: ${names}${more}`;
    }
    case "eval": {
      const len = typeof params.code === "string" ? params.code.length : 0;
      return `eval (${len} chars)`;
    }
    case "screenshot": {
      const mode = params.fullPage ? "full page" : (params.selector || params.ref !== undefined) ? "element" : "viewport";
      return `screenshot (${mode})`;
    }
    case "tabs": {
      const act = params.action || "list";
      if (act === "open") return `open tab${params.url ? ` ${summarizeUrl(params.url)}` : ""}`;
      if (act === "close") return `close tab ${params.tabId ?? ""}`.trim();
      if (act === "activate") return `focus tab ${params.tabId ?? ""}`.trim();
      return `${act} tabs`;
    }
    case "snapshot":
      return "page snapshot";
    default:
      return method;
  }
}

function recordActivity(method, summary, ok, error) {
  const item = {
    ts: Date.now(),
    method,
    summary,
    ok: !!ok,
  };
  if (error) item.error = String(error);
  activity.unshift(item);
  if (activity.length > 50) activity.length = 50;
  broadcastState();
}

browser.commands.onCommand.addListener((command) => {
  if (command === "toggle-pause") {
    paused = !paused;
    updateBadge();
    broadcastState();
  }
});

async function getState() {
  const tabList = [];
  const extPrefix = browser.runtime.getURL("");
  for (const tabId of Array.from(agentTabs)) {
    try {
      const t = await browser.tabs.get(tabId);
      if (t.url && (t.url.startsWith("moz-extension://") || t.url.startsWith(extPrefix))) {
        continue;
      }
      tabList.push({
        id: t.id,
        title: t.title || "Untitled",
        url: t.url || "",
        windowId: t.windowId,
        active: !!t.active,
      });
    } catch {
      agentTabs.delete(tabId);
    }
  }

  return {
    version: VERSION,
    hostConnected,
    clients,
    paused,
    allowEval,
    agentTabs: tabList,
    activity: [...activity],
    lastDisconnectError,
  };
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  const popupPrefix = browser.runtime.getURL("popup/");
  if (
    sender.id !== browser.runtime.id ||
    (sender.tab && !sender.url?.startsWith(popupPrefix)) ||
    !sender.url ||
    !sender.url.startsWith(popupPrefix)
  ) {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "state":
      return getState();
    case "setPaused":
      paused = typeof msg.paused === "boolean" ? msg.paused : !paused;
      updateBadge();
      broadcastState();
      return { ok: true, paused };
    case "setAllowEval":
      allowEval = !!msg.allowEval;
      await browser.storage.local.set({ allowEval });
      broadcastState();
      return { ok: true, allowEval };
    case "closeAgentTabs": {
      const ids = Array.from(agentTabs);
      agentTabs.clear();
      if (ids.length) {
        try {
          await browser.tabs.remove(ids);
        } catch {
          // ignore error removing already-closed tabs
        }
      }
      broadcastState();
      return { ok: true, closed: ids.length };
    }
    case "focusTab": {
      const tabId = msg.tabId;
      if (!tabId) return { ok: false, error: "Missing tabId" };
      try {
        const t = await browser.tabs.update(tabId, { active: true });
        if (t.windowId) {
          await browser.windows.update(t.windowId, { focused: true });
        }
        broadcastState();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
});

function connect() {
  try {
    port = browser.runtime.connectNative(HOST_NAME);
    hostConnected = true;
    lastDisconnectError = null;
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener((p) => {
      const err = p.error?.message || "Host process disconnected";
      console.warn("omp host disconnected:", err);
      port = null;
      hostConnected = false;
      lastDisconnectError = err;
      clients = 0;
      updateBadge();
      broadcastState();
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60000);
    });
    port.postMessage({ type: "hello", version: VERSION });
    updateBadge();
    broadcastState();
  } catch (e) {
    port = null;
    hostConnected = false;
    lastDisconnectError = String(e?.message || e);
    updateBadge();
    broadcastState();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60000);
  }
}

async function onHostMessage(msg) {
  if (msg.type === "clients") {
    retryMs = 2000;
    clients = msg.count;
    hostConnected = true;
    lastDisconnectError = null;
    updateBadge();
    broadcastState();
    return;
  }
  if (msg.type !== "request") return;

  const isPing = msg.method === "ping";
  // Chunk transfers are part of the following act call; don't flood the activity log with them.
  const quiet = isPing || msg.method === "stageFile";
  const summary = quiet ? "" : summarizeMethod(msg.method, msg.params);
  let reply;
  try {
    const fn = Object.hasOwn(methods, msg.method) ? methods[msg.method] : null;
    if (!fn) throw new Error(`Unknown method ${msg.method}`);
    if (paused && !isPing) throw new Error(PAUSE_ERROR);
    const result = await fn(msg.params || {});
    reply = { type: "response", id: msg.id, ok: true, result };
    if (!quiet) {
      recordActivity(msg.method, summary, true);
    }
  } catch (e) {
    const errorMsg = String(e?.message || e);
    reply = { type: "response", id: msg.id, ok: false, error: errorMsg };
    if (!quiet) {
      recordActivity(msg.method, summary, false, errorMsg);
    }
  }
  port?.postMessage(reply);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function scriptError(e) {
  const m = String(e?.message || e);
  if (/Missing host permission|cannot be scripted|privileged/i.test(m)) {
    return new Error("This page cannot be scripted by extensions (privileged Firefox or AMO page)");
  }
  return e instanceof Error ? e : new Error(m);
}

function isNavigationError(e) {
  return /Message manager disconnected|context unloaded|navigat|No matching message handler|Actor .* destroyed|Could not establish connection|Receiving end does not exist/i.test(String(e?.message || e));
}

// Sends an operation to the tab's content script via tabs.sendMessage after injecting content.js.
async function sendTab(tabId, op, args, timeoutMs = 15000) {
  const run = async () => {
    try {
      await browser.tabs.executeScript(tabId, { file: "/content.js", frameId: 0 });
      return await browser.tabs.sendMessage(tabId, { op, args }, { frameId: 0 });
    } catch (e) {
      throw scriptError(e);
    }
  };
  const res = await withTimeout(run(), timeoutMs, "Page script");
  if (!res) throw new Error("Page script returned nothing (page may be navigating)");
  if (!res.ok) throw new Error(res.e);
  return res.v;
}

function takeStaged(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("upload needs files");
  return ids.map((id) => {
    const entry = staged.get(id);
    if (!entry) throw new Error("Staged upload expired or missing; retry the step");
    return { name: entry.name, type: entry.type, data: entry.parts.join("") };
  });
}

async function runActSteps(tabId, steps, timeoutMs) {
  const done = [];
  for (const [i, step] of steps.entries()) {
    try {
      if (paused) throw new Error(PAUSE_ERROR);
      if (step.action === "wait") {
        await waitFor(tabId, step);
        done.push(`wait ✓`);
        continue;
      }
      const load = trackLoad(tabId, timeoutMs);
      let desc;
      try {
        desc = step.action === "upload"
          ? await sendTab(tabId, "act", { ...step, files: takeStaged(step.files) }, 60000)
          : await sendTab(tabId, "act", step);
      } catch (e) {
        if (!isNavigationError(e)) {
          load.cancel();
          throw e;
        }
        desc = "(page unloaded during action)";
      }
      await sleep(200);
      let note = "";
      if (load.sawLoading) note = (await load.promise) ? " → page loaded" : " → page still loading";
      else load.cancel();
      done.push(`${step.action} ${desc}${note}`.trim());
    } catch (e) {
      return { steps: done, error: `step ${i + 1} (${step.action}) failed: ${e.message}`, tab: await tabInfo(tabId) };
    }
  }
  return { steps: done, tab: await tabInfo(tabId) };
}

// Only eval (when allowed) may use executeScript({ code }).
async function executeEval(tabId, code, args = [], timeoutMs = 15000) {
  const body = `(async () => { const page = window.wrappedJSObject; const args = ${JSON.stringify(args)}; const ref = (n) => window.__omp.resolve({ ref: n });\n${code}\n})()`;
  const evalCode = `Promise.resolve().then(() => ${body}).then(v => ({ ok: true, v: window.__omp.toJSONSafe(v) }), e => ({ ok: false, e: String(e && e.message || e) }))`;
  const run = async () => {
    try {
      await browser.tabs.executeScript(tabId, { file: "/content.js", frameId: 0 });
      const [res] = await browser.tabs.executeScript(tabId, { code: evalCode, frameId: 0 });
      return res;
    } catch (e) {
      throw scriptError(e);
    }
  };
  const res = await withTimeout(run(), timeoutMs, "Page script");
  if (!res) throw new Error("Page script returned nothing (page may be navigating)");
  if (!res.ok) throw new Error(res.e);
  return res.v;
}

// Tracks a load started after creation. Resolves true on load complete, false on timeout.
function trackLoad(tabId, timeoutMs) {
  let sawLoading = false;
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  const listener = (id, info, tab) => {
    if (id !== tabId) return;
    if (info.status === "loading") sawLoading = true;
    else if (info.status === "complete" && sawLoading && tab.url !== "about:blank") finish(true);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  let idle;
  function finish(loaded) {
    clearTimeout(timer);
    clearTimeout(idle);
    browser.tabs.onUpdated.removeListener(listener);
    settle(loaded);
  }
  browser.tabs.onUpdated.addListener(listener, { tabId, properties: ["status"] });
  return {
    promise,
    get sawLoading() {
      return sawLoading;
    },
    cancel: () => finish(false),
    // Same-document navigations never report "loading"; resolve once the tab looks settled.
    settleIfIdle(afterMs) {
      idle = setTimeout(async () => {
        if (sawLoading) return;
        const tab = await browser.tabs.get(tabId).catch(() => null);
        if (!tab || tab.status === "complete") finish(true);
      }, afterMs);
      return promise;
    },
  };
}

async function tabInfo(tabId) {
  const t = await browser.tabs.get(tabId);
  return { id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status, agent: agentTabs.has(t.id) };
}

async function groupAgentTab(tabId) {
  if (!browser.tabs.group) return;
  const { windowId } = await browser.tabs.get(tabId);
  const existing = groupByWindow.get(windowId);
  try {
    if (existing !== undefined) {
      await browser.tabs.group({ tabIds: [tabId], groupId: existing });
      return;
    }
  } catch {
    groupByWindow.delete(windowId);
  }
  try {
    const groupId = await browser.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    groupByWindow.set(windowId, groupId);
    await browser.tabGroups?.update(groupId, { title: "omp", color: "purple", collapsed: false });
  } catch (e) {
    console.warn("omp: tab grouping failed", e);
  }
}

browser.tabs.onRemoved.addListener((id) => {
  if (agentTabs.delete(id)) {
    broadcastState();
  }
});

browser.tabs.onUpdated.addListener((id, changeInfo) => {
  if (agentTabs.has(id) && (changeInfo.title || changeInfo.url)) {
    broadcastState();
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  if (agentTabs.has(activeInfo.tabId)) {
    broadcastState();
  }
});

async function navigate({ tabId, url, action, timeoutMs = 20000 }) {
  const load = trackLoad(tabId, timeoutMs);
  try {
    if (url) await browser.tabs.update(tabId, { url });
    else if (action === "back") await browser.tabs.goBack(tabId);
    else if (action === "forward") await browser.tabs.goForward(tabId);
    else if (action === "reload") await browser.tabs.reload(tabId);
    else throw new Error("navigate needs url or action back|forward|reload");
  } catch (e) {
    load.cancel();
    throw e;
  }
  const loaded = await load.settleIfIdle(1500);
  broadcastState();
  return { ...(await tabInfo(tabId)), loaded };
}

async function waitFor(tabId, { selector, text, url, gone, timeoutMs = 10000 }) {
  if (!selector && !text && !url) throw new Error("wait needs selector, text, or url");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (paused) throw new Error(PAUSE_ERROR);
    let ok = false;
    if (url) {
      const t = await browser.tabs.get(tabId);
      ok = t.url.includes(url) !== !!gone;
    }
    if ((selector || text) && (!url || ok)) {
      try {
        ok = await sendTab(tabId, "check", { selector, text, gone: !!gone }, 3000);
      } catch (e) {
        if (!isNavigationError(e) && !/timed out|returned nothing/.test(e.message)) throw e;
        ok = false;
      }
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`wait timed out after ${timeoutMs}ms`);
    await sleep(250);
  }
}

const methods = {
  async ping() {
    return { version: VERSION, paused, userAgent: navigator.userAgent };
  },

  async stageFile({ id, name, type, data }) {
    if (typeof id !== "string" || typeof data !== "string") throw new Error("stageFile needs id and data");
    const now = Date.now();
    let stagedChars = 0;
    for (const [key, entry] of staged) {
      if (now - entry.at > STAGE_TTL_MS) staged.delete(key);
      else stagedChars += entry.parts.reduce((sum, p) => sum + p.length, 0);
    }
    if (stagedChars + data.length > MAX_STAGED_CHARS) throw new Error("Upload too large for the browser bridge (limit ≈54 MB)");
    let entry = staged.get(id);
    if (!entry) {
      entry = { name: String(name || "file"), type: String(type || "application/octet-stream"), parts: [], at: now };
      staged.set(id, entry);
    }
    entry.parts.push(data);
    entry.at = now;
    return { parts: entry.parts.length };
  },

  async tabs({ action = "list", tabId, url, active = false, timeoutMs }) {
    switch (action) {
      case "list": {
        const tabs = await browser.tabs.query({});
        return tabs.map((t) => ({
          id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, agent: agentTabs.has(t.id), discarded: t.discarded,
        }));
      }
      case "open": {
        const tab = await browser.tabs.create({ url: "about:blank", active: !!active });
        agentTabs.add(tab.id);
        await groupAgentTab(tab.id);
        broadcastState();
        if (url) return navigate({ tabId: tab.id, url, timeoutMs });
        return tabInfo(tab.id);
      }
      case "close":
        agentTabs.delete(tabId);
        broadcastState();
        await browser.tabs.remove(tabId);
        return { closed: tabId };
      case "activate": {
        const t = await browser.tabs.update(tabId, { active: true });
        await browser.windows.update(t.windowId, { focused: true });
        broadcastState();
        return tabInfo(tabId);
      }
      case "info":
        return tabInfo(tabId);
      default:
        throw new Error(`Unknown tabs action ${action}`);
    }
  },

  navigate,

  async snapshot({ tabId, ...opts }) {
    return sendTab(tabId, "snapshot", opts);
  },

  async act({ tabId, steps, timeoutMs = 15000 }) {
    try {
      return await runActSteps(tabId, steps, timeoutMs);
    } finally {
      // Staged uploads are single-use; drop them even when an earlier step failed.
      for (const step of steps) if (step.action === "upload") for (const id of step.files || []) staged.delete(id);
    }
  },

  async eval({ tabId, code, args = [], timeoutMs = 15000 }) {
    if (!allowEval) {
      throw new Error('firefox_eval is disabled. Ask the user to turn on "Allow page JavaScript" in the OMP Browser Bridge popup in Firefox.');
    }
    return executeEval(tabId, code, args, timeoutMs);
  },

  async screenshot({ tabId, fullPage, ref, selector, format = "png", quality = 80, scale = 1 }) {
    let rect;
    if (ref !== undefined || selector) rect = await sendTab(tabId, "rectOf", { ref, selector });
    else if (fullPage) rect = await sendTab(tabId, "pageRect");
    const opts = { format, scale };
    if (format === "jpeg") opts.quality = quality;
    if (rect) opts.rect = rect;
    const dataUrl = await browser.tabs.captureTab(tabId, opts);
    return { dataUrl, rect: rect || null };
  },
};

connect();
