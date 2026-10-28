/**
 * Testprozess für den Exit-Code der proaktiven Meldungen (Issue #361):
 * führt proactiveMain mit Attrappen aus und endet mit dessen Exit-Code.
 * Alles kommt aus der Umgebung, nichts geht ins Netz.
 *
 * PROACTIVE_DIR      Ordner für Zustand, Einstellungen und alte Dateien
 * PROACTIVE_KIND     briefing oder checkin
 * PROACTIVE_NOW      Zeitpunkt der Uhr-Attrappe (ISO)
 * PROACTIVE_COMPOSE  text, null, throw oder snooze (während des Bauens setzt
 *                    ein eigener Prozess, wie der Bot nach einem Knopfdruck,
 *                    Snooze für die Art bis eine Stunde nach PROACTIVE_NOW)
 * PROACTIVE_NOW_AFTER Uhr nach dem Bauen des Texts (ISO), etwa nach dem
 *                    Fensterende; fehlt: PROACTIVE_NOW
 * PROACTIVE_SEND     telegram, web-only, telegram-unrecorded, fail, throw
 * PROACTIVE_DELAY_MS Wartezeit im Absender (für gleichzeitige Läufe)
 * PROACTIVE_LOCK_WAIT window oder disabled: am Ende des Bauens hält der Prozess
 *                    die Sperre des Zustands 300 ms lang; kurz vor dem Lösen
 *                    springt die Uhr auf PROACTIVE_NOW_LOCKED (window) bzw.
 *                    wird der Check-in abgeschaltet (disabled)
 * Jeder Aufruf des Absenders hängt eine Zeile an <PROACTIVE_DIR>/sent.log.
 */
import { appendFileSync } from "fs";
import { join } from "path";
import { proactiveMain } from "../../../src/lib/proactive/deliver";
import { acquireFileLock, releaseFileLock } from "../../../src/lib/file-lock";
import type { Settings } from "../../../src/lib/settings";
import type { OutboxSender } from "../../../src/lib/outbox";

const dir = process.env.PROACTIVE_DIR!;
const kind = process.env.PROACTIVE_KIND === "briefing" ? "briefing" : "checkin";
const now = new Date(process.env.PROACTIVE_NOW!);
const nowAfter = new Date(process.env.PROACTIVE_NOW_AFTER ?? process.env.PROACTIVE_NOW!);
let composed = false;
const statePath = join(dir, "data", "proactive-state.json");
const mode = process.env.PROACTIVE_SEND ?? "telegram";
const delay = Number(process.env.PROACTIVE_DELAY_MS ?? "0");
const lockWait = process.env.PROACTIVE_LOCK_WAIT;
const nowLocked = new Date(process.env.PROACTIVE_NOW_LOCKED ?? process.env.PROACTIVE_NOW!);
// Gilt erst kurz vor dem Lösen der Sperre, also während die Bestätigung schon wartet
let lockChanged = false;

const send: OutboxSender = async input => {
  appendFileSync(join(dir, "sent.log"), `${input.source}\n`);
  if (delay > 0) await new Promise(r => setTimeout(r, delay));
  switch (mode) {
    case "telegram":
      return { sent: true, recorded: true };
    case "web-only":
      return { sent: false, recorded: true };
    case "telegram-unrecorded":
      return { sent: true, recorded: false };
    case "throw":
      throw new Error("Netz weg");
    default:
      return { sent: false, recorded: false, error: { kind: "send", message: "abgelehnt" } };
  }
};

const code = await proactiveMain(
  kind,
  async () => {
    composed = true;
    if (process.env.PROACTIVE_COMPOSE === "throw") throw new Error("Quelle kaputt");
    if (process.env.PROACTIVE_COMPOSE === "null") return null;
    if (process.env.PROACTIVE_COMPOSE === "snooze") {
      const until = new Date(now.getTime() + 3_600_000).toISOString();
      const state = join(import.meta.dir, "..", "..", "..", "src", "lib", "proactive", "state.ts");
      const code = `const { snoozeKind } = await import(${JSON.stringify(state)}); await snoozeKind(${JSON.stringify(statePath)}, ${JSON.stringify(kind)}, new Date(${JSON.stringify(until)}));`;
      const child = Bun.spawnSync(["bun", "-e", code]);
      if (child.exitCode !== 0) throw new Error("Snooze gescheitert");
    }
    if (lockWait) {
      const lockPath = `${statePath}.lock`;
      const owner = await acquireFileLock(lockPath);
      setTimeout(() => {
        lockChanged = true;
        void releaseFileLock(lockPath, owner);
      }, 300);
    }
    return { text: "Wie läuft's?" };
  },
  {
    send,
    now: () => (lockChanged && lockWait === "window" ? nowLocked : composed ? nowAfter : now),
    env: { USER_TIMEZONE: process.env.USER_TIMEZONE },
    get settings(): Settings {
      return lockChanged && lockWait === "disabled" ? { proactive: { checkin: { enabled: false } } } : {};
    },
    statePath,
    legacy: {
      schedule: join(dir, "config", "schedule.json"),
      checkinState: join(dir, "checkin-state.json"),
      settings: join(dir, "config", "settings.json"),
      state: join(dir, "data", "proactive-state.json"),
    },
  },
);
process.exit(code);
