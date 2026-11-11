import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (name) => readFileSync(join(root, "extension", name), "utf8");
const manifest = JSON.parse(source("manifest.json"));
const hostName = "com.omarchy.webapp_theme";
const hookName = "omarchy-webapp-theme-firefox";
const tempRoot = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();

test("shared manifest supports both background environments and pins the native-host ID", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.background.scripts, ["background.js"]);
  const host = JSON.parse(readFileSync(join(root, "native-host", `${hostName}.firefox.json.template`)));
  assert.deepEqual(host.allowed_extensions, [manifest.browser_specific_settings.gecko.id]);
  assert.equal(host.allowed_origins, undefined);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  for (const entry of manifest.content_scripts) {
    for (const script of entry.js) assert.ok(existsSync(join(root, "extension", script)));
  }
});

for (const firefox of [false, true]) {
  test(`page bridge ${firefox ? "clones payloads for Firefox Xrays" : "works unchanged on Chromium"}`, () => {
    const events = [];
    const clones = [];
    const window = {};
    const context = vm.createContext({
      window,
      document: { dispatchEvent: (event) => events.push(event) },
      CustomEvent: class {
        constructor(type, { detail }) { this.type = type; this.detail = detail; }
      },
      chrome: {
        storage: { sync: { get() {} }, onChanged: { addListener() {} } },
        runtime: {
          onMessage: { addListener() {} }, sendMessage() {},
          connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
        },
      },
      ...(firefox ? {
        cloneInto(detail, target) {
          assert.equal(target, window);
          const clone = structuredClone(detail);
          clones.push(clone);
          return clone;
        },
      } : {}),
    });
    vm.runInContext(source("omarchy-runtime.js"), context);
    vm.runInContext(`
      OmarchyTheme.dispatchPageEvent("omarchy:set-color-scheme", { dark: true });
      OmarchyTheme.dispatchPageEvent("omarchy:react-click", { marker: "test-radio" });
    `, context);
    assert.equal(events[0].detail.dark, true);
    assert.equal(events[1].detail.marker, "test-radio");
    assert.equal(clones.length, firefox ? 2 : 0);
    if (firefox) assert.equal(events[0].detail, clones[0]);
  });
}

test("background supports callback-only chrome APIs and reconnects without duplicate hosts", () => {
  const listeners = {};
  const sent = [];
  const timers = [];
  const cache = {};
  let connects = 0;
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      getManifest: () => manifest,
      connectNative(name) {
        assert.equal(name, hostName);
        connects++;
        return { onMessage: event("nativeMessage"), onDisconnect: event("disconnect") };
      },
      onMessage: event("message"),
      onConnect: event("client"),
      onInstalled: event("install"),
      onStartup: event("startup"),
    },
    storage: { local: {
      get(_key, callback) { callback(cache); },
      set(value) { Object.assign(cache, value); },
    } },
  };
  vm.runInNewContext(source("background.js"), {
    chrome, URL, console: { log() {}, warn() {} },
    setTimeout(callback) { timers.push(callback); return timers.length; },
  });
  listeners.install();
  listeners.startup();
  assert.equal(connects, 1);
  const client = {
    name: "omarchy-theme",
    onDisconnect: event("clientDisconnect"),
    postMessage(message) { sent.push(message); },
  };
  listeners.client(client);
  const theme = { bg: "#123456", theme_name: "test" };
  listeners.nativeMessage(theme);
  assert.equal(cache.theme, theme);
  assert.equal(sent[0].theme, theme);
  for (const type of ["request-theme", "request-fresh-theme"]) {
    cache.theme = { bg: "#000000", theme_name: "stale storage" };
    let result;
    assert.equal(listeners.message({ type }, {}, (value) => { result = value; }), true);
    assert.equal(result, theme);
  }
  listeners.client(client); // New/restored pages receive the cached theme.
  assert.equal(sent.length, 2);
  listeners.clientDisconnect();
  listeners.nativeMessage(theme);
  assert.equal(sent.length, 2);
  listeners.disconnect();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(connects, 2);
});

test("content runtime subscribes to live pushes and reconnects after a port disconnect", () => {
  const timers = [];
  let connects = 0;
  let receive;
  let disconnect;
  const context = vm.createContext({
    chrome: {
      storage: { sync: { get() {} }, onChanged: { addListener() {} } },
      runtime: {
        id: "test-addon", onMessage: { addListener() {} }, sendMessage() {},
        connect({ name }) {
          assert.equal(name, "omarchy-theme");
          connects++;
          return {
            onMessage: { addListener(fn) { receive = fn; } },
            onDisconnect: { addListener(fn) { disconnect = fn; } },
          };
        },
      },
    },
    setTimeout(fn) { timers.push(fn); },
  });
  vm.runInContext(source("omarchy-runtime.js"), context);
  const theme = { bg: "#112233" };
  receive({ type: "omarchy-theme", theme });
  assert.equal(vm.runInContext("OmarchyTheme._pendingTheme", context), theme);
  disconnect();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(connects, 2);
});

function sandbox(t, unusualPath = false) {
  const temp = mkdtempSync(join(tempRoot, "webapp-firefox-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, "home");
  const repo = join(temp, unusualPath ? 'clone &|"\\ path' : "clone");
  mkdirSync(join(home, ".local/state/omarchy/current/theme"), { recursive: true });
  for (const path of ["install.sh", "native-host", "hooks", "extension"]) {
    cpSync(join(root, path), join(repo, path), { recursive: true });
  }
  const run = (...args) => {
    const result = spawnSync("bash", [join(repo, "install.sh"), ...args], {
      env: { ...process.env, HOME: home }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  return { home, repo, run };
}

test("Firefox setup is idempotent, preserves Chromium and unrelated hooks, and uninstalls", (t) => {
  const { home, repo, run } = sandbox(t);
  const hooks = join(home, ".config/omarchy/hooks/theme-set.d");
  mkdirSync(hooks, { recursive: true });
  const flags = join(home, ".config/chromium-flags.conf");
  writeFileSync(flags, "--load-extension=/keep/this\n");
  writeFileSync(join(hooks, "omarchy-webapp-theme"), "# existing Chromium hook\n");
  const output = run("--firefox");
  run("--firefox");
  const hostPath = join(home, ".mozilla/native-messaging-hosts", `${hostName}.json`);
  const host = JSON.parse(readFileSync(hostPath));
  assert.equal(host.path, join(repo, "native-host/omarchy-webapp-theme-host"));
  assert.equal(readlinkSync(join(hooks, hookName)), join(repo, "hooks/omarchy-webapp-theme"));
  assert.equal(readFileSync(flags, "utf8"), "--load-extension=/keep/this\n");
  assert.ok(!existsSync(join(home, ".config/chromium/NativeMessagingHosts")));
  assert.match(output, /Temporary add-ons disappear/);
  assert.match(output, /Mozilla-signed XPI/);
  run("--firefox", "--uninstall");
  run("--firefox", "--uninstall");
  assert.ok(!existsSync(hostPath));
  assert.ok(!existsSync(join(hooks, hookName)));
  assert.ok(existsSync(join(hooks, "omarchy-webapp-theme")));
  assert.equal(readFileSync(flags, "utf8"), "--load-extension=/keep/this\n");
});

test("Firefox setup escapes checkout paths containing JSON and sed metacharacters", (t) => {
  const { home, repo, run } = sandbox(t, true);
  run("--firefox");
  const hostPath = join(home, ".mozilla/native-messaging-hosts", `${hostName}.json`);
  assert.equal(JSON.parse(readFileSync(hostPath)).path, join(repo, "native-host/omarchy-webapp-theme-host"));
  run("--firefox", "--uninstall");
  assert.ok(!existsSync(hostPath));
});

test("Firefox uninstall preserves a native manifest belonging to another install", (t) => {
  const { home, run } = sandbox(t);
  run("--firefox");
  const path = join(home, ".mozilla/native-messaging-hosts", `${hostName}.json`);
  writeFileSync(path, JSON.stringify({ path: "/other/host" }));
  run("--firefox", "--uninstall");
  assert.ok(existsSync(path));
});

test("default Chromium setup still appends to existing flags and leaves Firefox alone", (t) => {
  const { home, repo, run } = sandbox(t);
  mkdirSync(join(home, ".config"), { recursive: true });
  const flags = join(home, ".config/chromium-flags.conf");
  writeFileSync(flags, "--load-extension=/keep/this\n");
  run();
  run();
  assert.equal(readFileSync(flags, "utf8"), `--load-extension=/keep/this,${repo}/extension\n`);
  assert.ok(!existsSync(join(home, ".mozilla")));
  run("--uninstall");
  assert.equal(readFileSync(flags, "utf8"), "--load-extension=/keep/this\n");
});
