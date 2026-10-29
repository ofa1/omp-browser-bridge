// OMP Browser Bridge - Popup Script

const statusCard = document.getElementById("status-card");
const statusTitle = document.getElementById("status-title");
const statusDesc = document.getElementById("status-desc");
const setupHint = document.getElementById("setup-hint");
const versionBadge = document.getElementById("version");

const pauseToggle = document.getElementById("pause-toggle");
const pauseSubtext = document.getElementById("pause-toggle-subtext");
const evalToggle = document.getElementById("eval-toggle");

const tabsCount = document.getElementById("tabs-count");
const tabList = document.getElementById("tab-list");
const tabsEmpty = document.getElementById("tabs-empty");
const closeTabsBtn = document.getElementById("close-tabs-btn");

const activityList = document.getElementById("activity-list");
const activityEmpty = document.getElementById("activity-empty");
const setupDocLink = document.getElementById("setup-doc-link");

let pollTimer = null;
let isUpdating = false;
let pendingRefresh = false;
let lastTabsKey = null;
let lastActivityKey = null;
function formatHost(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    return u.protocol === "about:" ? rawUrl : u.host;
  } catch {
    return rawUrl;
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function renderStatus(state) {
  if (state.version && versionBadge) {
    versionBadge.textContent = `v${state.version}`;
  }

  statusCard.className = "card status-card";

  if (!state.hostConnected) {
    statusCard.classList.add("status-state-error");
    statusTitle.textContent = "Host not installed";
    statusDesc.textContent = state.lastDisconnectError || "Native host disconnected with error.";
    setupHint.hidden = false;
  } else if (state.paused) {
    statusCard.classList.add("status-state-paused");
    statusTitle.textContent = "Agent control paused";
    statusDesc.textContent = "Incoming actions from omp will be rejected.";
    setupHint.hidden = true;
  } else if (state.clients > 0) {
    statusCard.classList.add("status-state-connected");
    const count = state.clients;
    statusTitle.textContent = `Connected (${count} active session${count > 1 ? "s" : ""})`;
    statusDesc.textContent = "Active and receiving commands from omp.";
    setupHint.hidden = true;
  } else {
    statusCard.classList.add("status-state-idle");
    statusTitle.textContent = "Host running, no session";
    statusDesc.textContent = "Native host is running. Start an omp session to connect.";
    setupHint.hidden = true;
  }

  const isEnabled = !state.paused;
  pauseToggle.checked = isEnabled;
  pauseToggle.setAttribute("aria-checked", String(isEnabled));
  pauseSubtext.textContent = isEnabled
    ? "Active — omp can inspect and drive tabs"
    : "Paused — omp requests are blocked";

  if (evalToggle) {
    const isEvalAllowed = !!state.allowEval;
    evalToggle.checked = isEvalAllowed;
    evalToggle.setAttribute("aria-checked", String(isEvalAllowed));
  }
}

function renderTabs(tabs = []) {
  tabs = tabs.filter((t) => !t.url || !t.url.startsWith("moz-extension://"));
  tabsCount.textContent = String(tabs.length);
  closeTabsBtn.disabled = tabs.length === 0;

  const key = JSON.stringify(tabs);
  if (key === lastTabsKey) return;
  lastTabsKey = key;

  while (tabList.firstChild) {
    tabList.removeChild(tabList.firstChild);
  }

  if (tabs.length === 0) {
    tabsEmpty.hidden = false;
    tabList.hidden = true;
    return;
  }

  tabsEmpty.hidden = true;
  tabList.hidden = false;

  for (const tab of tabs) {
    const li = document.createElement("li");
    li.className = "tab-item";
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-label", `Focus tab: ${tab.title || "Untitled"}`);

    const info = document.createElement("div");
    info.className = "tab-info";

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "Untitled";

    const host = document.createElement("span");
    host.className = "tab-host";
    host.textContent = formatHost(tab.url);

    info.append(title, host);
    li.append(info);

    if (tab.active) {
      const activePill = document.createElement("span");
      activePill.className = "tab-active-pill";
      activePill.textContent = "active";
      li.append(activePill);
    }

    const focusHandler = () => {
      browser.runtime.sendMessage({ type: "focusTab", tabId: tab.id }).catch(() => {});
      window.close();
    };

    li.addEventListener("click", focusHandler);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusHandler();
      }
    });

    tabList.append(li);
  }
}

function renderActivity(activities = []) {
  const visible = activities.slice(0, 10);
  const key = JSON.stringify(visible);
  if (key === lastActivityKey) return;
  lastActivityKey = key;

  while (activityList.firstChild) {
    activityList.removeChild(activityList.firstChild);
  }

  if (visible.length === 0) {
    activityEmpty.hidden = false;
    activityList.hidden = true;
    return;
  }
  for (const item of visible) {
    const li = document.createElement("li");
    li.className = "activity-item";

    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = formatTime(item.ts);

    const badge = document.createElement("span");
    badge.className = `activity-badge method-${item.method}`;
    badge.textContent = item.method;

    const summary = document.createElement("span");
    summary.className = "activity-summary";
    summary.textContent = item.summary || item.method;
    summary.title = item.summary || item.method;

    const status = document.createElement("span");
    if (item.ok) {
      status.className = "activity-status ok";
      status.textContent = "✓";
      status.setAttribute("aria-label", "Success");
    } else {
      status.className = "activity-status err";
      status.textContent = "✗";
      const errText = item.error ? `Failed: ${item.error}` : "Failed";
      status.title = errText;
      status.setAttribute("aria-label", errText);
    }

    li.append(time, badge, summary, status);
    activityList.append(li);
  }
}

async function refreshState() {
  if (isUpdating) {
    pendingRefresh = true;
    return;
  }
  isUpdating = true;
  try {
    const state = await browser.runtime.sendMessage({ type: "state" });
    if (state) {
      renderStatus(state);
      renderTabs(state.agentTabs);
      renderActivity(state.activity);
    }
  } catch (e) {
    console.warn("Failed to fetch state from background:", e);
  } finally {
    isUpdating = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshState();
    }
  }
}

// Event Listeners
pauseToggle.addEventListener("change", async () => {
  const willBePaused = !pauseToggle.checked;
  try {
    await browser.runtime.sendMessage({ type: "setPaused", paused: willBePaused });
    await refreshState();
  } catch (e) {
    console.error("Failed to toggle pause:", e);
  }
});

if (evalToggle) {
  evalToggle.addEventListener("change", async () => {
    const allowEval = evalToggle.checked;
    try {
      await browser.runtime.sendMessage({ type: "setAllowEval", allowEval });
      await refreshState();
    } catch (e) {
      console.error("Failed to toggle allowEval:", e);
    }
  });
}

closeTabsBtn.addEventListener("click", async () => {
  closeTabsBtn.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "closeAgentTabs" });
    await refreshState();
  } catch (e) {
    console.error("Failed to close agent tabs:", e);
  }
});

if (setupDocLink) {
  setupDocLink.addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: setupDocLink.href }).catch(() => {});
    window.close();
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state_changed") {
    refreshState();
  }
});

window.addEventListener("pagehide", () => {
  clearInterval(pollTimer);
});

window.addEventListener("unload", () => {
  clearInterval(pollTimer);
});

// Initial load + interval polling
refreshState();
pollTimer = setInterval(refreshState, 1000);
