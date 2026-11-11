const HOST = "com.omarchy.webapp_theme";
let currentTheme = null;

// Let the actual content scripts subscribe rather than discovering them by tab
// URL. Zen can omit tabs from tabs.query(), and Slack's huddle pop-outs can be
// reported as about:blank. Ports work in both cases without a "tabs" permission.
const themeClients = new Set();

chrome.runtime.onConnect.addListener((client) => {
  if (client.name !== "omarchy-theme") return;
  themeClients.add(client);
  client.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    themeClients.delete(client);
  });
  chrome.storage.local.get("theme", ({ theme }) => {
    const latest = currentTheme || theme;
    if (latest && themeClients.has(client)) sendTheme(client, latest);
  });
});

let port = null;
let reconnectTimer = null;

function connect() {
  // The service worker can reach this from three directions at once: the
  // module-level call below, onInstalled, and onStartup. Without this guard each
  // one opens its own port, and every port spawns a separate long-lived native
  // host — so the theme-set hook then signals N hosts and every theme change
  // gets broadcast to the same tabs N times.
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
    console.log("[omarchy] native port connected");
  } catch (e) {
    console.warn("[omarchy] connectNative threw:", e);
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((theme) => {
    if (!theme || theme.error) {
      console.warn("[omarchy] native host error:", theme && theme.error);
      return;
    }
    console.log("[omarchy] theme pushed by native host:", theme.theme_name, theme.bg);
    currentTheme = theme;
    chrome.storage.local.set({ theme });
    broadcast(theme);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn("[omarchy] native host disconnected:", err && err.message);
    port = null;
    scheduleReconnect();
  });

  // No request needed: the host is push-only. It emits the current theme as soon
  // as it starts, then again on every theme change (driven by omarchy's
  // theme-set hook). We never write to the port.
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function broadcast(theme) {
  console.log("[omarchy] broadcasting theme to", themeClients.size, "page(s)");
  for (const client of themeClients) sendTheme(client, theme);
}

function sendTheme(client, theme) {
  try {
    client.postMessage({ type: "omarchy-theme", theme });
  } catch (_) {
    themeClients.delete(client);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "request-theme") {
    chrome.storage.local.get("theme", ({ theme }) => sendResponse(currentTheme || theme || null));
    return true;
  }
  // Slack asks again before driving its Color Mode radio. Prefer the in-memory
  // push: storage writes are asynchronous and may still be in flight.
  if (msg && msg.type === "request-fresh-theme") {
    chrome.storage.local.get("theme", ({ theme }) => sendResponse(currentTheme || theme || null));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

connect();
