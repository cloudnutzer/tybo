#!/usr/bin/env bun
/**
 * Echter Push-Test (Issue #225) mit Chrome und dem echten Push-Dienst von
 * Google (FCM), nicht Teil von bun run check (braucht Netz und Chrome):
 *
 *   bun run scripts/web-push-live-check.ts            # Chrome mit Fenster
 *   bun run scripts/web-push-live-check.ts --headless # ohne Fenster, falls Chrome es erlaubt
 *
 * Maßgeblich ist der Lauf mit Fenster: ohne Fenster schließt Chrome eine
 * Benachrichtigung manchmal sofort wieder, dann fehlt sie in
 * getNotifications(). Die erste Anmeldung eines frischen Profils bei FCM kann
 * dauern; bleibt „An" bei „Einen Moment …" hängen, den Lauf wiederholen.
 *
 * Startet die Demo der WebUI auf 127.0.0.1 (sicherer Kontext) mit frischen
 * Push-Schlüsseln nur im Speicher und echtem Versand, dazu Chrome mit
 * eigenem, temporärem Profil. Die Berechtigung erteilt der Durchlauf über
 * DevTools (Browser.grantPermissions), dann tippt er im Reiter
 * „Benachrichtigungen" auf „An" und „Test senden". Nachweis: der Service
 * Worker hat die Benachrichtigung „Test" angezeigt (registration.getNotifications()).
 * Danach wird der Tab der App geschlossen, der Server schickt noch einen Test
 * an dasselbe Gerät, und der Service Worker zeigt ihn ohne offene Seite.
 * Keine .env, kein data/, kein src/bot.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoServer } from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";
import { DEFAULT_PUSH_SUBJECT, generateVapidKeys } from "../src/web/push";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headless = process.argv.includes("--headless");
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

const dir = await mkdtemp(join(tmpdir(), "tybo-push-live-"));
const logs: string[] = [];
const demo = await startDemoServer(
  { host: "127.0.0.1", port: 0, password: "push-live-passwort", allowedHosts: [] },
  {
    chat: createFakeChat(),
    telegramChat: createFakeChat(),
    log: m => logs.push(m),
    push: { keys: await generateVapidKeys(), subject: DEFAULT_PUSH_SUBJECT },
  }
);
const origin = demo.server.url.replace(/\/$/, "");
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = Bun.spawn(
  [CHROME, ...(headless ? ["--headless=new"] : []), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1100,900", "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

type Conn = { send(method: string, params?: object, sessionId?: string): Promise<any>; close(): void };
async function connect(url: string): Promise<Conn> {
  const ws = new WebSocket(url);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let next = 1;
  const pending = new Map<number, (msg: any) => void>();
  ws.addEventListener("message", e => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = next++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) =>
        pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
      );
    },
    close: () => ws.close(),
  };
}

async function browserSocket(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      return ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as any).webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("Chrome nicht erreichbar");
}

const browser = await connect(await browserSocket());
try {
  await browser.send("Browser.grantPermissions", { origin, permissions: ["notifications"] });
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (expression: string) =>
    browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then(r => {
      if (r.exceptionDetails) throw new Error(`JS-Fehler: ${r.exceptionDetails.text} in ${expression}`);
      return r.result.value;
    });
  const waitFor = async (expression: string, timeoutMs = 15000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await page(`!!(${expression})`)) return true;
      } catch {
        // Seite lädt gerade
      }
      await Bun.sleep(100);
    }
    return false;
  };
  const click = (text: string) =>
    page(`(() => { const b = [...document.querySelectorAll("#settings button")].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (b) b.click(); return !!b; })()`);

  await browser.send("Page.navigate", { url: `${origin}/#/einstellungen/benachrichtigungen` }, sessionId);
  check("Service Worker aktiv", await waitFor(`navigator.serviceWorker.getRegistration().then(r => r && r.active && r.active.state === "activated")`));
  check("Reiter zeigt „Aus“ (Berechtigung schon erteilt)", await waitFor(`document.querySelector("#settings [data-push-state=off]")`));
  await click("An");
  const on = await waitFor(`document.querySelector("#settings [data-push-state=on]")`, 90000);
  check("„An“: echtes Abo beim Push-Dienst angelegt", on, on ? "" : await page(`Promise.race([
    navigator.serviceWorker.getRegistration().then(r => r.pushManager.permissionState({ userVisibleOnly: true }).then(p => "Berechtigung " + p + ", Abo " + "wartet")),
    new Promise(r => setTimeout(() => r("keine Antwort"), 3000)),
  ])`));
  if (on) {
    const endpointHost = await page(`navigator.serviceWorker.getRegistration().then(r => r.pushManager.getSubscription()).then(s => new URL(s.endpoint).hostname)`);
    check("Abo liegt bei einem bekannten Push-Dienst", /fcm\.googleapis\.com$/.test(endpointHost), endpointHost);
    await click("Test senden");
    check("„Test senden“: Server meldet angenommen", await waitFor(`document.getElementById("settings").innerText.includes("Test gesendet.")`));
    let shownList = "";
    for (let i = 0; i < 150 && !shownList.includes('"Test"'); i++) {
      shownList = await page(`navigator.serviceWorker.getRegistration().then(r => r.getNotifications()).then(n => JSON.stringify(n.map(x => ({ title: x.title, body: x.body, tag: x.tag, url: x.data && x.data.url }))))`);
      if (!shownList.includes('"Test"')) await Bun.sleep(200);
    }
    check("Benachrichtigung „Test“ vom Service Worker angezeigt (offene App)", shownList.includes('"Test"'), shownList);

    // App-Tab schließen, dann noch einmal senden: nur der Service Worker ist noch da
    const deviceId = await page(`localStorage.getItem("tybo-push-device")`);
    await page(`navigator.serviceWorker.getRegistration().then(r => r.getNotifications()).then(n => n.forEach(x => x.close()))`);
    await browser.send("Target.closeTarget", { targetId });
    await Bun.sleep(500);
    const res = await fetch(`${origin}/api/push/test`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ id: deviceId }),
    });
    check("App geschlossen: Server schickt Test an dasselbe Gerät", res.status === 200, String(res.status));
    let closedShown = "";
    for (let i = 0; i < 150 && !closedShown; i++) {
      const targets = (await browser.send("Target.getTargets")).targetInfos as any[];
      const worker = targets.find(t => t.type === "service_worker" && t.url.startsWith(origin));
      const pages = targets.filter(t => t.type === "page" && t.url.startsWith(origin));
      if (worker && pages.length === 0) {
        const attached = await browser.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
        const r = await browser.send("Runtime.evaluate", {
          expression: `self.registration.getNotifications().then(n => JSON.stringify(n.map(x => x.title)))`,
          awaitPromise: true,
          returnByValue: true,
        }, attached.sessionId);
        await browser.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
        if (String(r.result?.value ?? "").includes('"Test"')) closedShown = r.result.value;
      }
      if (!closedShown) await Bun.sleep(200);
    }
    check("App geschlossen: Service Worker zeigt die Benachrichtigung trotzdem", !!closedShown, closedShown);
  }
  check("Log ohne Endpunkt-Pfad", !logs.some(l => l.includes("/fcm/send/") || l.includes("/wp/")), logs.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  browser.close();
  chrome.kill();
  await chrome.exited;
  await demo.stop();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
