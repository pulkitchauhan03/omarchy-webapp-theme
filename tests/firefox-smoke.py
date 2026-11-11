#!/usr/bin/env python3
"""Optional real-Gecko smoke test: python tests/firefox-smoke.py /usr/bin/zen-browser.

Uses only Python's standard library. All profiles, permissions, native-host
manifests, and theme files live in a disposable HOME. Never touches the user's
running browser. A localhost fixture exercises the shared GitHub pack without
logging into any website; the shipped match patterns are not changed.
"""

import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        page = b"""<!doctype html><meta name="route-controller" content="files">
        <title>Omarchy Gecko smoke test</title><body>
        <button data-omarchy-target="smoke">test</button>
        <script>
        document.querySelector('button').__reactProps$smoke = {
          onClick() { document.documentElement.dataset.bridgeClick = 'ok'; }
        };
        window.themeChanges = [];
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change',
          event => window.themeChanges.push(event.matches));
        </script></body>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, *_args):
        pass


class Marionette:
    def __init__(self, port):
        deadline = time.monotonic() + 30
        while True:
            try:
                self.socket = socket.create_connection(("127.0.0.1", port), timeout=1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Gecko's isolated Marionette instance did not start")
                time.sleep(0.1)
        self.socket.settimeout(30)
        self.stream = self.socket.makefile("rb")
        self.read()
        self.sequence = 0

    def read(self):
        length = bytearray()
        while (byte := self.stream.read(1)) != b":":
            if not byte:
                raise EOFError("Gecko closed the Marionette connection")
            length.extend(byte)
        return json.loads(self.stream.read(int(length)))

    def command(self, name, params=None):
        self.sequence += 1
        data = json.dumps([0, self.sequence, name, params or {}]).encode()
        self.socket.sendall(str(len(data)).encode() + b":" + data)
        _kind, sequence, error, result = self.read()
        assert sequence == self.sequence
        if error:
            raise RuntimeError(f"{name}: {error}")
        return result

    def evaluate(self, script):
        return self.command("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def wait_for(check):
    deadline = time.monotonic() + 15
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError("Expected extension state did not arrive")
        time.sleep(0.1)


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else "firefox"
    temp_root = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
    with tempfile.TemporaryDirectory(prefix="webapp-gecko-smoke-", dir=temp_root) as tmp:
        home = Path(tmp)
        profile = home / "profile"
        runtime = home / "runtime"
        profile.mkdir()
        runtime.mkdir(mode=0o700)
        theme = home / ".local/state/omarchy/current/theme"
        theme.mkdir(parents=True)
        (theme / "colors.toml").write_text('background = "#112233"\nforeground = "#eeeeee"\n')
        env = {**os.environ, "HOME": str(home), "XDG_RUNTIME_DIR": str(runtime),
               "XDG_CONFIG_HOME": str(home / ".config"), "MOZ_HEADLESS": "1",
               "XDG_CACHE_HOME": str(home / ".cache"),
               "XDG_DATA_HOME": str(home / ".local/share"),
               "XDG_STATE_HOME": str(home / ".local/state"),
               "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}
        subprocess.run(["bash", str(ROOT / "install.sh"), "--firefox"], env=env, check=True,
                       stdout=subprocess.DEVNULL)

        # Only the temporary test copy gains localhost access and a probe.
        extension = home / "extension"
        shutil.copytree(ROOT / "extension", extension)
        manifest = json.loads((extension / "manifest.json").read_text())
        localhost = "http://127.0.0.1/*"
        manifest["host_permissions"].append(localhost)
        manifest["content_scripts"][0]["matches"].append(localhost)
        pack = next(entry for entry in manifest["content_scripts"] if "github.js" in entry["js"])
        pack["matches"].append(localhost)
        pack["js"].append("smoke-probe.js")
        (extension / "manifest.json").write_text(json.dumps(manifest))
        (extension / "smoke-probe.js").write_text("""
          document.addEventListener('DOMContentLoaded', () => {
            OmarchyTheme.dispatchPageEvent('omarchy:react-click', { marker: 'smoke' });
          }, { once: true });
        """)
        xpi = home / "smoke.xpi"
        with zipfile.ZipFile(xpi, "w") as archive:
            for path in extension.iterdir():
                archive.write(path, path.name)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        prefs = {"marionette.port": port, "browser.shell.checkDefaultBrowser": False,
                 "browser.startup.page": 0, "browser.startup.homepage": "about:blank",
                 "zen.welcome-screen.seen": True, "zen.welcome-screen.enabled": False,
                 "datareporting.policy.dataSubmissionEnabled": False,
                 "toolkit.telemetry.enabled": False}
        (profile / "user.js").write_text("\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (home / "browser.log").open("w+") as log:
            process = subprocess.Popen([binary, "--headless", "--no-remote", "--profile", str(profile),
                                        "--marionette", "--remote-allow-system-access", "about:blank"],
                                       env=env, stdout=log, stderr=log)
            client = None
            try:
                client = Marionette(port)
                client.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
                client.command("Marionette:SetContext", {"value": "chrome"})
                directory = client.evaluate('return Services.dirsvc.get("XREUserNativeManifests", Ci.nsIFile).path;')
                assert directory == str(home / ".mozilla"), directory
                client.command("Marionette:SetContext", {"value": "content"})
                client.command("Addon:Install", {"path": str(xpi), "temporary": True})
                client.command("WebDriver:Navigate", {"url": f"http://127.0.0.1:{server.server_port}/smoke"})
                snapshot = """return {
                  mode: document.documentElement.style.colorScheme,
                  dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
                  bg: getComputedStyle(document.documentElement).getPropertyValue('--bgColor-default').trim(),
                  click: document.documentElement.dataset.bridgeClick,
                  changes: window.themeChanges
                };"""
                def state_for(mode):
                    state = client.evaluate(snapshot)
                    return state if state["mode"] == mode else None

                dark = wait_for(lambda: state_for("dark"))
                assert dark["dark"] is True and dark["bg"] == "#112233", dark
                assert dark["click"] == "ok", dark
                (theme / "colors.toml").write_text('background = "#f6f5f4"\nforeground = "#222222"\n')
                subprocess.run(["bash", str(ROOT / "hooks/omarchy-webapp-theme")], env=env, check=True)
                light = wait_for(lambda: state_for("light"))
                assert light["dark"] is False and light["bg"] == "#f6f5f4", light
                assert light["changes"] and light["changes"][-1] is False, light
                print(json.dumps({"browser": binary, "dark": dark, "light": light, "result": "PASS"}, indent=2))
            except Exception:
                if client:
                    try:
                        print("Last page state:", client.evaluate(snapshot), file=sys.stderr)
                        client.command("Marionette:SetContext", {"value": "chrome"})
                        print("Browser errors:", client.evaluate(
                            'return Services.console.getMessageArray().slice(-20).map(m => m.message);'
                        ), file=sys.stderr)
                    except Exception:
                        pass
                log.seek(0)
                print(log.read()[-12000:], file=sys.stderr)
                raise
            finally:
                if client:
                    client.stream.close()
                    client.socket.close()
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                server.shutdown()


if __name__ == "__main__":
    main()
