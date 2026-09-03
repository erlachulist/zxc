#!/usr/bin/env python3
"""E2E harness: launches headless Chrome with an unpacked extension and drives
the fixture pages through CDP. Usage: run-e2e.py <ext_dir> <port> <shots_dir>"""
import asyncio, base64, json, os, subprocess, sys, time, urllib.request
import websockets

EXT, PORT, SHOTS = sys.argv[1], sys.argv[2], sys.argv[3]
CHROME = "/home/hoplite/.agent-browser/browsers/chrome-152.0.7977.42/chrome"
PROFILE = f"/tmp/chrome-prof-{PORT}"
FIX = "http://127.0.0.1:8765"
os.makedirs(SHOTS, exist_ok=True)


def launch():
    subprocess.run(["pkill", "-f", f"user-data-dir={PROFILE}"], check=False)
    time.sleep(0.5)
    subprocess.run(["rm", "-rf", PROFILE], check=False)
    os.makedirs(PROFILE, exist_ok=True)
    subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
         f"--load-extension={EXT}", f"--disable-extensions-except={EXT}",
         "--no-first-run", "--window-size=1280,900", "about:blank"],
        stdout=open("/tmp/chrome-e2e.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
            return
        except Exception:
            time.sleep(0.25)
    raise SystemExit("chrome did not start")


def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))


def ext_id():
    for _ in range(40):
        for t in targets():
            if t["type"] == "service_worker" and "background/service-worker.js" in t["url"]:
                return t["url"].split("/")[2]
        time.sleep(0.25)
    return None


class Page:
    def __init__(self, ws):
        self.ws, self.n, self.events = ws, 0, []

    async def call(self, method, params=None):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                return msg
            if "method" in msg:
                self.events.append(msg)

    async def drain(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.2))
                if "method" in msg:
                    self.events.append(msg)
            except asyncio.TimeoutError:
                pass
            except websockets.exceptions.ConnectionClosed:
                raise SystemExit("page websocket closed — chrome died? see /tmp/chrome-e2e.log")

    def exceptions(self):
        out = []
        for e in self.events:
            if e["method"] == "Runtime.exceptionThrown":
                d = e["params"]["exceptionDetails"]
                out.append((d.get("exception") or {}).get("description", d.get("text", ""))[:200])
            elif e["method"] == "Log.entryAdded" and e["params"]["entry"]["level"] == "error":
                t = e["params"]["entry"]["text"]
                if "favicon" not in t:
                    out.append("LOG " + t[:200])
        self.events = []
        return out

    async def nav(self, url, wait=3.0):
        await self.call("Page.navigate", {"url": url})
        await self.drain(wait)

    async def eval(self, expr):
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return {"__error": res["exceptionDetails"].get("exception", {}).get("description")}
        return res.get("result", {}).get("value")

    async def click(self, x, y):
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": t, "x": x, "y": y}
            if t != "mouseMoved":
                p.update({"button": "left", "clickCount": 1})
            await self.call("Input.dispatchMouseEvent", p)

    async def shot(self, name, w=1280, h=760):
        await self.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        await self.drain(0.5)
        r = await self.call("Page.captureScreenshot", {"format": "png"})
        path = os.path.join(SHOTS, name)
        open(path, "wb").write(base64.b64decode(r["result"]["data"]))
        return path


BTN_XY = """(() => { const hosts=[...document.documentElement.children].filter(e=>e.tagName==='DIV');
  const small=hosts.map(h=>h.getBoundingClientRect()).filter(r=>r.width>0 && r.width<100);
  return small.map(r=>({x:r.left+r.width/2, y:r.top+r.height/2})); })()"""
BANNER = """(() => { const hosts=[...document.documentElement.children].filter(e=>e.tagName==='DIV');
  const big=hosts.map(h=>h.getBoundingClientRect()).find(r=>r.width>200); return big ? {h: big.height} : null; })()"""
VALS = """({email: (document.getElementById('email')||{}).value||'', user: (document.getElementById('username')||{}).value||'',
  pw: ((document.getElementById('password')||{}).value||'').length, pw2: ((document.getElementById('password2')||{}).value||'').length,
  confirmEmail: (document.getElementById('confirm_email')||{}).value||''})"""


async def sw_eval(ext, expr):
    # SW may be asleep: any extension-page navigation wakes it; retry discovery
    t = None
    for _ in range(20):
        t = next((t for t in targets() if t["type"] == "service_worker" and ext in t["url"]), None)
        if t:
            break
        await asyncio.sleep(0.25)
    if not t:
        return "null"
    async with websockets.connect(t["webSocketDebuggerUrl"], max_size=80_000_000) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                return msg.get("result", {}).get("result", {}).get("value")


RECORDS = """chrome.storage.local.get(null).then(d => JSON.stringify({bl: d.ar_domainBlacklist, rot: d.ar_rotationIndex,
  recs: (d.ar_records||[]).map(r => ({status: r.status, email: r.email, url: (r.url||'').split('/').pop(), pw: (r.password||'').length,
  attempts: (r.attempts||[]).map(a => a.errorType + ': ' + a.error)}))}))"""


async def main():
    launch()
    ext = ext_id()
    print("EXT", ext)
    page = next(t for t in targets() if t["type"] == "page")
    results = {}
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=80_000_000) as ws:
        p = Page(ws)
        for m in ("Runtime.enable", "Log.enable", "Page.enable"):
            await p.call(m)

        # 1. plain registration form
        await p.nav(f"{FIX}/register.html", 4)
        results["1.load_errors"] = p.exceptions()
        btns = await p.eval(BTN_XY)
        results["1.buttons"] = btns
        await p.shot("v31-register-before.png")
        if btns:
            await p.click(btns[0]["x"], btns[0]["y"])
            await p.drain(9)
        results["1.filled"] = await p.eval(VALS)
        await p.shot("v31-register-filled.png")
        # submit -> polling
        await p.eval("document.querySelector('#reg button[type=submit]').click()")
        await p.drain(4)
        results["1.after_submit"] = json.loads(await sw_eval(ext, RECORDS))

        # 2. static 'disposable not allowed' hint page -> no false retries
        await p.nav(f"{FIX}/register-hint.html", 4)
        btns = await p.eval(BTN_XY)
        if btns:
            await p.click(btns[0]["x"], btns[0]["y"])
            await p.drain(12)
        results["2.filled"] = await p.eval(VALS)
        results["2.store"] = json.loads(await sw_eval(ext, RECORDS))

        # 3. two-step (email first)
        await p.nav(f"{FIX}/step1.html", 4)
        btns = await p.eval(BTN_XY)
        results["3.buttons"] = btns
        if btns:
            await p.click(btns[0]["x"], btns[0]["y"])
            await p.drain(9)
        results["3.step1"] = await p.eval(VALS)
        await p.shot("v31-step1-filled.png", 1280, 420)
        await p.eval("document.querySelector('#step1 button').click()")
        await p.drain(4)
        results["3.step2"] = await p.eval(VALS)
        await p.shot("v31-step2-autofilled.png", 1280, 520)
        await p.eval("document.querySelector('#step2 button').click()")
        await p.drain(3)
        results["3.store"] = json.loads(await sw_eval(ext, RECORDS))

        # 4. confirm-email form: one button, both email fields filled
        await p.nav(f"{FIX}/register-confirm-email.html", 4)
        btns = await p.eval(BTN_XY)
        results["4.buttons"] = btns
        if btns:
            await p.click(btns[0]["x"], btns[0]["y"])
            await p.drain(9)
        results["4.filled"] = await p.eval(VALS)

        # 5. login page: banner offer + fill from journal
        await p.nav(f"{FIX}/login.html", 5)
        results["5.banner"] = await p.eval(BANNER)
        await p.shot("v31-login-banner.png", 1280, 500)
        # button "Заполнить логин" sits right side of banner; find via shadow-less geometry: click banner button area
        await p.click(786, 48)
        await p.drain(5)
        results["5.filled"] = await p.eval(VALS)
        results["5.errors"] = p.exceptions()
        await p.shot("v31-login-filled.png", 1280, 500)

        # 6. strict CSP page: modules still load
        await p.nav(f"{FIX}/register-csp.html", 4)
        results["6.buttons"] = await p.eval(BTN_XY)
        results["6.errors"] = p.exceptions()

        # 7. popup renders providers by name + journal
        await p.nav(f"chrome-extension://{ext}/popup/popup.html", 3)
        results["7.popup_text"] = (await p.eval("document.body.innerText")).replace("\n", " | ")[:600]
        results["7.popup_errors"] = p.exceptions()
        await p.shot("v31-popup.png", 400, 640)

        # 8. options page loads without errors
        await p.nav(f"chrome-extension://{ext}/options/options.html", 3)
        results["8.options_errors"] = p.exceptions()
        results["8.providers_text"] = await p.eval("(() => { document.querySelector('[data-tab=providers].nav-item').click(); return [...document.querySelectorAll('#provider-list .prov-name, #provider-list strong, #provider-list .line-title')].map(e => e.textContent).join(' | '); })()")
        await p.shot("v31-options-providers.png", 1100, 700)

    print(json.dumps(results, ensure_ascii=False, indent=1))


asyncio.run(main())
