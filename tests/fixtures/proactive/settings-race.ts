/**
 * Testprozess für die Einstellungsdatei über Prozesse (Issue #361).
 *
 * RACE_DIR   Ordner mit config/ und data/
 * RACE_TAG   Vorsatz für die Signaldateien (Standard leer), damit zwei
 *            Übernahmen getrennte Signale haben
 * RACE_MODE  migrate: Übernahme von config/schedule.json; hält zwischen
 *            Lesen und Schreiben der Einstellungen an, legt dann
 *            <RACE_DIR>/<tag>inside an und wartet auf <RACE_DIR>/<tag>go.
 *            Exit 0, wenn übernommen.
 *            migrate-late: Übernahme, die zu Beginn <tag>start anlegt, nach
 *            dem Lesen der Marken (unter der Sperre) diese in <tag>saw
 *            schreibt und dann auf <tag>go wartet. Ihr Bericht landet in
 *            <tag>report, Exit 0.
 *            write: setzt defaults.effort auf low, wie eine Änderung im Bot.
 *            remove-gap: entfernt proactive.checkin.minGapMinutes, wie der
 *            Nutzer auf der Einstellungsseite (dann gilt der Standard).
 */
import { existsSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { importLegacyProactive } from "../../../src/lib/proactive/migrate";
import { updateSettings } from "../../../src/lib/settings";

const dir = process.env.RACE_DIR!;
const tag = process.env.RACE_TAG ?? "";
const signal = (name: string) => join(dir, `${tag}${name}`);
// Signale mit Inhalt erst vollständig schreiben, dann umbenennen: der Test
// wartet nur auf das Vorhandensein und liest sonst eine halbe Datei
function writeSignal(name: string, content: string): void {
  writeFileSync(`${signal(name)}.tmp`, content);
  renameSync(`${signal(name)}.tmp`, signal(name));
}
const settings = join(dir, "config", "settings.json");
const paths = {
  schedule: join(dir, "config", "schedule.json"),
  checkinState: join(dir, "checkin-state.json"),
  settings,
  state: join(dir, "data", "proactive-state.json"),
};
const at = new Date("2026-10-19T12:00:00Z");

function waitForGo(): void {
  const deadline = Date.now() + 20_000;
  while (!existsSync(signal("go"))) {
    if (Date.now() > deadline) throw new Error("go fehlt");
    Bun.sleepSync(10);
  }
}

switch (process.env.RACE_MODE) {
  case "migrate": {
    const report = await importLegacyProactive(paths, at, {
      whileWritingSettings: () => {
        writeFileSync(signal("inside"), "");
        waitForGo();
      },
    });
    process.exit(report.schedule === "imported" ? 0 : 1);
  }
  case "migrate-late": {
    const report = await importLegacyProactive(paths, at, {
      onStart: () => writeFileSync(signal("start"), ""),
      afterReadMarks: marks => {
        writeSignal("saw", JSON.stringify(marks));
        waitForGo();
      },
    });
    writeSignal("report", JSON.stringify(report));
    process.exit(0);
  }
  case "remove-gap":
    await updateSettings(current => {
      delete current.proactive?.checkin?.minGapMinutes;
      return current;
    }, { path: settings });
    process.exit(0);
  default:
    await updateSettings(current => ({ ...current, defaults: { ...current.defaults, effort: "low" } }), { path: settings });
    process.exit(0);
}
