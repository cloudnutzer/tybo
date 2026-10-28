#!/usr/bin/env bun
/**
 * Echter Durchlauf der Push-Auslöser (Issue #226) mit Chrome und dem echten
 * Push-Dienst von Google (FCM), nicht Teil von bun run check (braucht Netz
 * und Chrome):
 *
 *   bun run scripts/web-push-trigger-live-check.ts
 *
 * Demo der WebUI auf 127.0.0.1 mit FakeChat (Antwort nach wenigen Sekunden),
 * frischen Push-Schlüsseln nur im Speicher und echtem Versand. Ablauf: Push
 * einschalten, ein neues Web-Gespräch über den Direktlink öffnen, eine Frage
 * stellen und den Tab sichtbar lassen (kein Push), dann eine Frage stellen und
 * in einen anderen Tab wechseln: der Service Worker zeigt die Benachrichtigung
 * (Titel = Gespräch, Text „Antwort von General", ohne Antworttext). Danach
 * wechselt der App-Tab zu einem anderen Gespräch, und ein Klick auf die
 * Benachrichtigung (im Service Worker ausgelöst, wie ein Tipp) führt ihn
 * zurück zum Gespräch. Den Tipp auf die echte Benachrichtigung des
 * Betriebssystems kann das Skript nicht auslösen.
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

const dir = await mkdtemp(join(tmpdir(), "tybo-push-trigger-live-"));
const logs: string[] = [];
const demo = await startDemoServer(
  { host: "127.0.0.1", port: 0, password: "push-live-passwort", allowedHosts: [] },
  {
    chat: createFakeChat({ delayMs: 2500, stepMs: 300 }),
    telegramChat: createFakeChat({ delayMs: 2500, stepMs: 300 }),
    log: m => logs.push(m),
    push: { keys: await generateVapidKeys(), subject: DEFAULT_PUSH_SUBJECT },
  }
);
const origin = demo.server.url.replace(/\/$/, "");
const debugPort = 9800 + Math.floor(Math.random() * 400);
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
  const notifications = () =>
    page(`navigator.serviceWorker.getRegistration().then(r => r.getNotifications()).then(n => n.map(x => ({ title: x.title, body: x.body, tag: x.tag, data: x.data })))`) as Promise<any[]>;
  const ask = (text: string) =>
    page(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("composer").requestSubmit(); return true; })()`);
  const replies = () => page(`document.querySelectorAll(".msg-assistant").length`) as Promise<number>;

  await browser.send("Page.navigate", { url: `${origin}/#/einstellungen/benachrichtigungen` }, sessionId);
  check("Service Worker aktiv", await waitFor(`navigator.serviceWorker.getRegistration().then(r => r && r.active && r.active.state === "activated")`));
  check("Reiter zeigt „Aus“", await waitFor(`document.querySelector("#settings [data-push-state=off]")`));
  await click("An");
  const on = await waitFor(`document.querySelector("#settings [data-push-state=on]")`, 90000);
  check("„An“: echtes Abo beim Push-Dienst angelegt", on);
  check("Reiter zeigt die vier Schalter", await waitFor(`document.querySelectorAll("#settings [data-push-setting]").length === 4`));
  if (on) {
    // Neues Web-Gespräch mit eigenem Titel
    const created = await page(`fetch("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "general" }) }).then(r => r.json())`);
    const id = created.conversation.id as string;
    await page(`fetch("/api/conversations/${id}", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Urlaub planen" }) }).then(r => r.status)`);
    await browser.send("Page.navigate", { url: `${origin}/#/gespraech/${id}` }, sessionId);
    check("Direktlink öffnet das neue Gespräch", await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === ${JSON.stringify(id)}`));
    await browser.send("Target.activateTarget", { targetId });
    await Bun.sleep(1000);

    // 1. Sichtbar offen: kein Push
    await ask("Wie wird das Wetter? (sichtbar)");
    check("sichtbar: Antwort kommt im Tab", await waitFor(`document.querySelectorAll(".msg-assistant").length >= 1`, 20000));
    await Bun.sleep(4000);
    const visibleList = await notifications();
    check("sichtbar: keine Benachrichtigung", !visibleList.some(n => n.data?.conversationId === id), JSON.stringify(visibleList));

    // 2. Frage stellen, dann Tab wechseln: Push
    const before = await replies();
    await ask("Und am Sonntag? (verdeckt)");
    await Bun.sleep(300);
    const other = await browser.send("Target.createTarget", { url: "about:blank" });
    await browser.send("Target.activateTarget", { targetId: other.targetId });
    let shown: any = null;
    for (let i = 0; i < 150 && !shown; i++) {
      shown = (await notifications()).find(n => n.data?.conversationId === id) ?? null;
      if (!shown) await Bun.sleep(200);
    }
    check("verdeckt: Benachrichtigung vom Service Worker angezeigt", !!shown, JSON.stringify(shown));
    check("verdeckt: Titel = Gespräch, Text ohne Antwortinhalt, tag je Gespräch, Direktlink",
      !!shown && shown.title === "Urlaub planen" && shown.body === "Antwort von General" && shown.tag === `c-${id}`
        && shown.data?.category === "reply" && shown.data?.url === `${origin}/#/gespraech/${id}`, JSON.stringify(shown));
    check("verdeckt: die Antwort ist trotzdem im Verlauf", (await replies()) > before);
    await browser.send("Target.closeTarget", { targetId: other.targetId });
    await browser.send("Target.activateTarget", { targetId });

    // 3. App zeigt ein anderes Gespräch; Klick auf die Benachrichtigung führt zurück
    await page(`document.querySelector('.conversation[data-id="dm"]').click()`);
    check("App zeigt jetzt den Direktchat", await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === "dm"`));
    await page(`window.__ohneNeuladen = true`);
    // Die Benachrichtigung zum Gespräch schließt die App beim Wechsel nicht (sie gehört zu einem anderen Gespräch)
    const targets = (await browser.send("Target.getTargets")).targetInfos as any[];
    const worker = targets.find(t => t.type === "service_worker" && t.url.startsWith(origin));
    check("Service Worker erreichbar", !!worker);
    if (worker) {
      const attached = await browser.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
      const r = await browser.send("Runtime.evaluate", {
        expression: `self.registration.getNotifications().then(list => {
          const n = list.find(x => x.data && x.data.conversationId === ${JSON.stringify(id)});
          if (!n) return "keine";
          self.dispatchEvent(new NotificationEvent("notificationclick", { notification: n }));
          return "geklickt";
        })`,
        awaitPromise: true,
        returnByValue: true,
      }, attached.sessionId);
      await browser.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
      check("Klick auf die Benachrichtigung ausgelöst", r.result?.value === "geklickt", String(r.result?.value));
      check("Klick: App-Tab wechselt ohne Neuladen zum Gespräch",
        (await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === ${JSON.stringify(id)}`)) && (await page(`window.__ohneNeuladen === true`)));
      check("Klick: Benachrichtigung zum jetzt sichtbaren Gespräch geschlossen",
        await waitFor(`navigator.serviceWorker.getRegistration().then(r => r.getNotifications()).then(n => !n.some(x => x.data && x.data.conversationId === ${JSON.stringify(id)}))`));
    }
  }
  check("Log: Push mit Kategorie, Gerät und Ergebnis", logs.some(l => /^Push \(Antwort\) an .+: ok$/.test(l)), logs.join(" | "));
  check("Log ohne Endpunkt-Pfad und ohne Antworttext", !logs.some(l => l.includes("/fcm/send/") || l.includes("Attrappe")), logs.join(" | "));
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
