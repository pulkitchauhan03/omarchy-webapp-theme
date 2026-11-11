// Omarchy web-app theming — generic engine runtime (app-agnostic).
//
// Owns the theme channel to the native host (via background.js) and drives
// whichever app pack registered itself with OmarchyTheme.register(). Only the
// pack matching the current site ever loads (each pack's manifest
// content_scripts entry matches just its own site), so one registry slot is
// enough. An app pack provides any of:
//   cssVars(theme, surfaces)    — declarative tier: return a map of the APP'S
//                                 OWN CSS custom properties → values; the
//                                 engine writes them inline-important on
//                                 <html> and <body> on every theme apply.
//                                 Enough by itself for apps that theme through
//                                 CSS variables.
//   apply(theme, surfaces)      — full tier: arbitrary painting (CSS
//                                 injection, inline overrides, observers)
//   onColorMode(isDark, theme)  — flip the app's own light/dark mode
// This file knows nothing about any specific app; all app-specific DOM work
// lives behind register().

const OmarchyTheme = {
  _pack: null,
  _lastKey: null, // JSON of the last applied theme; de-dups repeat pushes
  _lastIsDark: null, // last light/dark state; onColorMode fires only on a crossing
  _settings: null, // disabledSites map from the options page; null until loaded
  _pendingTheme: null, // theme held until pack + settings both exist
  current: null, // { theme, surfaces } — app packs read this for re-paints

  // Firefox isolates extension-owned objects from page scripts (Xrays).
  // Clone only our tiny bridge payload into the page compartment so the
  // MAIN-world shim can read CustomEvent.detail. Chromium needs no clone.
  dispatchPageEvent(type, detail) {
    const pageDetail = typeof cloneInto === "function" ? cloneInto(detail, window) : detail;
    document.dispatchEvent(new CustomEvent(type, { detail: pageDetail }));
  },

  register(pack) {
    this._pack = pack;
    // Packs load in a separate content-script entry from the engine, so the
    // initial theme (request-theme response, or even a live push) can land in
    // the gap before the pack registers. When that happens apply() has already
    // run pack-less and armed the de-dup key — replay the theme now so the
    // pack always gets it.
    if (this.current) {
      this._lastKey = null;
      this.apply(this.current.theme);
    } else {
      this._flushPending();
    }
  },

  _flushPending() {
    if (!this._pendingTheme) return;
    const theme = this._pendingTheme;
    this._pendingTheme = null;
    this._lastKey = null;
    this.apply(theme);
  },

  // Re-run the current theme, bypassing the de-dup guard. App packs call this
  // when something has clobbered their paint and they need a fresh apply.
  reapply() {
    if (!this.current) return;
    this._lastKey = null;
    this.apply(this.current.theme);
  },

  apply(theme) {
    if (!theme || !theme.bg) return;
    // Hold the theme until both the pack and the settings have arrived — the
    // pack loads in a separate content-script entry and the settings read is
    // async, so any arrival order is possible.
    if (!this._pack || this._settings === null) {
      this._pendingTheme = theme;
      return;
    }
    if (this._pack.id && this._settings[this._pack.id]) {
      // Site toggled off: keep the theme so a live re-enable can paint it,
      // and produce no side effects — no colorScheme, no shim event, no pack.
      this._pendingTheme = theme;
      return;
    }
    const surfaces = deriveSurfaces(theme);
    if (!surfaces) return;

    // Skip if nothing changed since last apply.
    const key = JSON.stringify(theme);
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.current = { theme, surfaces };

    const isDark = surfaces.isDark;
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";

    // Harmless if an app ever adds an OS-sync option.
    this.dispatchPageEvent("omarchy:set-color-scheme", { dark: isDark });

    // Drive the app's own Color Mode only when the mode crosses light↔dark.
    if (this._lastIsDark !== isDark) {
      this._lastIsDark = isDark;
      // Re-read the last pushed theme before touching the app — guards against
      // acting on a stale in-page value when the user switches omarchy themes
      // just before/during a reload. The native host pushes on omarchy's
      // theme-set hook, so what the service worker holds is already current.
      chrome.runtime.sendMessage({ type: "request-fresh-theme" }, (freshTheme) => {
        if (freshTheme && freshTheme.bg) {
          const freshRgb = hexToRgb(freshTheme.bg);
          if (freshRgb) {
            const freshIsDark = relLuminance(freshRgb) < 0.5;
            if (freshIsDark !== isDark) {
              console.log(
                "[omarchy] stale theme; fresh says",
                freshIsDark ? "dark" : "light",
                "(was",
                isDark ? "dark" : "light",
                ") — re-applying"
              );
              // Re-run with the fresh data; that re-triggers onColorMode.
              this._lastKey = null;
              this._lastIsDark = null;
              this.apply(freshTheme);
              return;
            }
          }
        }
        if (this._pack && this._pack.onColorMode) {
          this._pack.onColorMode(isDark, theme);
        }
      });
    }

    if (this._pack && this._pack.cssVars) {
      // Define the vars with !important on EVERY element, not just the root.
      // Apps commonly (re)define their theme tokens on a wrapper element below
      // <html> (WhatsApp does), which would shadow a root-level value for the
      // whole subtree that matters. An author-!important declaration on each
      // element beats the app's non-important definitions wherever they live,
      // with zero selector knowledge.
      const vars = this._pack.cssVars(theme, surfaces);
      let css = "html, html * {";
      for (const [name, value] of Object.entries(vars || {})) {
        if (value == null) continue;
        css += `${name}: ${value} !important;`;
      }
      css += "}";
      let style = document.getElementById("omarchy-webapp-vars");
      if (!style) {
        style = document.createElement("style");
        style.id = "omarchy-webapp-vars";
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = css;
    }
    if (this._pack && this._pack.apply) {
      this._pack.apply(theme, surfaces);
    }
  },
};

// Per-site enable/disable from the options page. The read is async — apply()
// pends until it lands. On a live disable we stop repainting and drop the var
// sheet immediately; inline styles a full-tier pack already painted stay until
// the next tab load. A live re-enable repaints from the pended theme.
try {
  chrome.storage.sync.get({ disabledSites: {} }, (data) => {
    OmarchyTheme._settings = (data && data.disabledSites) || {};
    OmarchyTheme._flushPending();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.disabledSites) return;
    OmarchyTheme._settings = changes.disabledSites.newValue || {};
    const pack = OmarchyTheme._pack;
    if (pack && pack.id && OmarchyTheme._settings[pack.id]) {
      const vars = document.getElementById("omarchy-webapp-vars");
      if (vars) vars.remove();
      document.documentElement.style.removeProperty("color-scheme");
      if (OmarchyTheme.current) OmarchyTheme._pendingTheme = OmarchyTheme.current.theme;
      OmarchyTheme.current = null;
      OmarchyTheme._lastKey = null;
      OmarchyTheme._lastIsDark = null;
    } else {
      OmarchyTheme._flushPending();
    }
  });
} catch (_) {
  // No storage access (shouldn't happen) — fail open so theming still works.
  OmarchyTheme._settings = {};
}

// Subscribe directly: Firefox/Zen and about:blank pop-outs need not expose a
// discoverable tab URL. Reconnect if an event page is unloaded or a page is
// restored from the back-forward cache while its old port is disconnected.
function connectThemeChannel() {
  try {
    const channel = chrome.runtime.connect({ name: "omarchy-theme" });
    channel.onMessage.addListener((msg) => {
      if (msg && msg.type === "omarchy-theme") OmarchyTheme.apply(msg.theme);
    });
    channel.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (chrome.runtime.id) setTimeout(connectThemeChannel, 3000);
    });
  } catch (_) {
    // An extension reload invalidates old content-script contexts. Refresh the
    // tab in that case; don't create a timer loop in an invalid context.
  }
}
connectThemeChannel();

// Keep the one-shot request and legacy message receiver for startup races and
// compatibility. All paths funnel through apply(), which de-dups and waits for
// the pack and settings before painting.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "omarchy-theme") OmarchyTheme.apply(msg.theme);
});
chrome.runtime.sendMessage({ type: "request-theme" }, (theme) => {
  if (theme) OmarchyTheme.apply(theme);
});
