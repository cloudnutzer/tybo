/**
 * Issue #286, Checkbox 2: tybo routinen einbinden und ausbinden mit
 * Attrappen für Dateien, plutil und launchctl. Kein Test ruft einen echten
 * Befehl auf und kein Test fasst eine echte Datei an.
 */

import { describe, expect, test } from "bun:test";
import { changeRoutineWrapper, EINBINDEN_TEXT } from "../src/lib/routines/einbinden";
import { WRAP_TEXT } from "../src/lib/routines/wrap";
import { AGENTS, daemonPlist, ROOT } from "./routines-fixture";
import { BUN, fake, LABEL, PATH, watchPlist, type Fake } from "./routines-wrap-fixture";

const backups = (fk: Fake) => [...fk.files.keys()].filter(p => p.startsWith(`${ROOT}/data/launchd-backup/`));
const touched = (fk: Fake) => fk.events.filter(e => e.startsWith("copy") || e.startsWith("rename") || e.startsWith("launchctl boot") || e.startsWith("plutil -replace"));
const tmpLeft = (fk: Fake) => [...fk.files.keys()].some(p => p.includes(".tybo-neu"));

describe("einbinden: Erfolg", () => {
  test("--ja: Sicherung vor jedem Schreiben, neue ProgramArguments, übrige Felder gleich, Dienst wieder geladen", async () => {
    const fk = fake();
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(0);
    expect(fk.asked).toEqual([]);

    const firstBackup = fk.events.findIndex(e => e.startsWith(`copy ${PATH} -> ${ROOT}/data/launchd-backup/`));
    const firstWrite = fk.events.findIndex(e => e.startsWith("plutil -replace") || e.startsWith("rename") || e.startsWith("launchctl boot"));
    expect(firstBackup).toBeGreaterThanOrEqual(0);
    expect(firstBackup).toBeLessThan(firstWrite);

    const after = fk.files.get(PATH)!;
    expect(after.ProgramArguments).toEqual([BUN, "--no-env-file", `${ROOT}/src/routine-run.ts`, "--id", LABEL, "--", ...(fk.original!.ProgramArguments as string[])]);
    const { ProgramArguments: _a, ...rest } = after;
    const { ProgramArguments: _b, ...restBefore } = fk.original!;
    expect(rest).toEqual(restBefore);

    expect(backups(fk)).toEqual([`${ROOT}/data/launchd-backup/${LABEL}.20261015-080000Z.plist`]);
    expect(fk.files.get(backups(fk)[0])).toEqual(fk.original!);
    expect(fk.loaded.has(LABEL)).toBe(true);
    expect(fk.events).toContain("launchctl bootout");
    expect(fk.events).toContain("launchctl bootstrap");
    expect(tmpLeft(fk)).toBe(false);
    expect(fk.out).toContain(EINBINDEN_TEXT.done(LABEL, "einbinden"));
  });

  test("zeigt alte und neue ProgramArguments, fragt und bindet nach „j“ ein", async () => {
    const fk = fake({ answers: ["j"] });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps)).toBe(0);
    expect(fk.asked).toEqual(["Einbinden? [j/N] "]);
    const text = fk.out.join("\n");
    expect(text).toContain("Bisherige ProgramArguments:\n  1. \"/usr/bin/python3\"\n  2. \"/Users/alex/Mein Ordner/run.py\"\n  3. \"--quiet\"");
    expect(text).toContain(`Neue ProgramArguments:\n  1. "${BUN}"\n  2. "--no-env-file"\n  3. "${ROOT}/src/routine-run.ts"\n  4. "--id"\n  5. "${LABEL}"\n  6. "--"\n  7. "/usr/bin/python3"`);
    expect(text).toContain(EINBINDEN_TEXT.unchangedFields);
  });

  test("RunAtLoad: Hinweis, dass das Neuladen sofort einen Lauf startet", async () => {
    const fk = fake({ plists: { [`${LABEL}.plist`]: watchPlist({ RunAtLoad: true }) } });
    await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true });
    expect(fk.out).toContain(EINBINDEN_TEXT.runAtLoad);
  });

  test("Zeitplan mit bedingtem KeepAlive (wie smart-checkin) wird eingebunden", async () => {
    const fk = fake({ plists: { [`${LABEL}.plist`]: watchPlist({ KeepAlive: { SuccessfulExit: false } }) } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(0);
  });

  test("eigene Routine ai.tybo.* ohne Eintrag in config/routines.json", async () => {
    const label = "ai.tybo.preis-watch";
    const fk = fake({ plists: { [`${label}.plist`]: watchPlist({ Label: label }) }, loaded: { [label]: null }, config: "{}" });
    expect(await changeRoutineWrapper("einbinden", label, fk.deps, { yes: true })).toBe(0);
    expect((fk.files.get(`${AGENTS}/${label}.plist`)!.ProgramArguments as string[]).slice(3, 6)).toEqual(["--id", label, "--"]);
  });

  test("Label aus config/routines.json (labels statt Präfix)", async () => {
    const fk = fake({ config: JSON.stringify({ labels: [LABEL] }) });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(0);
  });

  test("ohne Farben: keine Escape-Sequenz in der Ausgabe, auch mit NO_COLOR", async () => {
    const fk = fake({ answers: ["j"] });
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      await changeRoutineWrapper("einbinden", LABEL, fk.deps);
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
    expect([...fk.out, ...fk.err, ...fk.asked].join("\n")).not.toContain("\u001b");
  });
});

describe("einbinden: Abbruch ändert nichts", () => {
  for (const answer of ["N", "n", "", "nein", "x", null]) {
    test(`Antwort ${JSON.stringify(answer)}`, async () => {
      const fk = fake({ answers: [answer] });
      expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps)).toBe(1);
      expect(fk.out).toContain(EINBINDEN_TEXT.aborted);
      expect(touched(fk)).toEqual([]);
      expect(fk.files.get(PATH)).toEqual(fk.original!);
      expect(backups(fk)).toEqual([]);
    });
  }
});

describe("einbinden: abgelehnt, nichts angefasst", () => {
  async function rejected(fk: Fake, label = LABEL): Promise<string> {
    expect(await changeRoutineWrapper("einbinden", label, fk.deps, { yes: true })).toBe(1);
    expect(touched(fk)).toEqual([]);
    expect(backups(fk)).toEqual([]);
    return fk.err.join("\n");
  }

  test("Label außerhalb des Katalogs", async () => {
    const fk = fake({ config: "{}" });
    expect(await rejected(fk)).toBe(EINBINDEN_TEXT.notInCatalog(LABEL));
  });

  test("Bot-Dienst ai.tybo.telegram-relay", async () => {
    const label = "ai.tybo.telegram-relay";
    const fk = fake({ plists: { [`${label}.plist`]: daemonPlist(label) }, loaded: { [label]: 4711 } });
    expect(await rejected(fk, label)).toBe(WRAP_TEXT.botService(label));
  });

  test("Dauerdienst aus config/routines.json", async () => {
    const fk = fake({ plists: { [`${LABEL}.plist`]: daemonPlist(LABEL) } });
    expect(await rejected(fk)).toBe(WRAP_TEXT.daemon(LABEL));
  });

  test("schon eingebunden", async () => {
    const wrapped = watchPlist({ ProgramArguments: [BUN, "--no-env-file", `${ROOT}/src/routine-run.ts`, "--id", LABEL, "--", "/usr/bin/true"] });
    const fk = fake({ plists: { [`${LABEL}.plist`]: wrapped } });
    expect(await rejected(fk)).toBe(WRAP_TEXT.alreadyWrapped(LABEL));
  });

  test("Program statt ProgramArguments", async () => {
    const fk = fake({ plists: { [`${LABEL}.plist`]: watchPlist({ Program: "/usr/bin/python3" }) } });
    expect(await rejected(fk)).toBe(WRAP_TEXT.program(LABEL));
  });

  test("pausiert, nicht geladen, läuft gerade", async () => {
    expect(await rejected(fake({ disabled: [LABEL], loaded: {} }))).toBe(EINBINDEN_TEXT.paused(LABEL));
    expect(await rejected(fake({ loaded: {} }))).toBe(EINBINDEN_TEXT.notLoaded(LABEL));
    expect(await rejected(fake({ loaded: { [LABEL]: 4711 } }))).toBe(EINBINDEN_TEXT.running(LABEL));
  });

  test("Symlink in LaunchAgents", async () => {
    const fk = fake({ symlinks: [PATH] });
    expect(await rejected(fk)).toBe(EINBINDEN_TEXT.symlink(LABEL));
  });

  test("Label in zwei Plists", async () => {
    const fk = fake({ plists: { [`${LABEL}.plist`]: watchPlist(), "kopie.plist": watchPlist() } });
    expect(await rejected(fk)).toBe(EINBINDEN_TEXT.ambiguous(LABEL, [`${LABEL}.plist`, "kopie.plist"]));
  });

  test("Plist liegt unter anderem Dateinamen (Label passt nicht zum Pfad)", async () => {
    const fk = fake({ plists: { "watch.plist": watchPlist() } });
    expect(await rejected(fk)).toBe(EINBINDEN_TEXT.notInAgents(LABEL));
  });

  test("Label mit Pfadteilen", async () => {
    const fk = fake();
    expect(await rejected(fk, "com.example.watch/../../x")).toBe(EINBINDEN_TEXT.badLabel("com.example.watch/../../x"));
  });

  test("bun nicht gefunden", async () => {
    const fk = fake({ bunPath: null });
    expect(await rejected(fk)).toBe(EINBINDEN_TEXT.noBun);
  });

  for (const platform of ["linux", "win32"] as const) {
    test(`unter ${platform}: kein Befehl, keine Datei`, async () => {
      const fk = fake({ platform });
      expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
      expect(fk.err).toEqual([EINBINDEN_TEXT.macOnly]);
      expect(fk.events).toEqual([]);
      expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps, { yes: true })).toBe(1);
      expect(fk.events).toEqual([]);
    });
  }
});

describe("einbinden: Fehler stellen den alten Zustand her", () => {
  function expectOldState(fk: Fake) {
    expect(fk.files.get(PATH)).toEqual(fk.original!);
    expect(fk.loaded.has(LABEL)).toBe(true);
    expect(fk.loadedConfig.get(LABEL)).toEqual(fk.original!);
    expect(tmpLeft(fk)).toBe(false);
  }

  test("Sicherung scheitert: nichts geschrieben, Dienst nicht angefasst", async () => {
    const fk = fake({ fail: { backupCopy: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toStartWith("Sicherung gescheitert");
    expect(touched(fk)).toEqual([]);
    expectOldState(fk);
  });

  test("Kopie, plutil -replace oder -lint scheitert: Dienst nicht angefasst, Kopie weg", async () => {
    for (const fail of [{ tmpCopy: true }, { replace: true }, { lint: true }]) {
      const fk = fake({ fail });
      expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
      expect(fk.err[0]).toStartWith("Neue Plist nicht erstellt");
      expect(fk.events.filter(e => e.startsWith("launchctl boot") || e.startsWith("rename"))).toEqual([]);
      expect(backups(fk)).toHaveLength(1);
      expectOldState(fk);
    }
  });

  test("bootout scheitert, Dienst bleibt geladen: nichts geändert", async () => {
    const fk = fake({ fail: { bootout: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toStartWith("launchctl bootout ist gescheitert, nichts geändert");
    expect(fk.events).not.toContain("launchctl bootstrap");
    expectOldState(fk);
  });

  test("bootout scheitert, Dienst ist trotzdem entladen: alter Dienst wieder geladen", async () => {
    const fk = fake({ fail: { bootout: true, bootoutUnloads: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("Alter Zustand wiederhergestellt");
    expectOldState(fk);
  });

  test("Schreiben (rename) scheitert: alte Plist, alter Dienst wieder geladen", async () => {
    const fk = fake({ fail: { rename: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("Alter Zustand wiederhergestellt");
    expectOldState(fk);
  });

  test("Laden der neuen Plist scheitert: Sicherung zurück, alter Dienst geladen", async () => {
    const fk = fake({ fail: { bootstrap: "changed" } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("launchctl bootstrap der neuen Plist ist gescheitert. Alter Zustand wiederhergestellt");
    expectOldState(fk);
    expect(backups(fk)).toHaveLength(1);
  });

  test("Nachkontrolle scheitert (nach bootstrap nicht geladen): alter Zustand", async () => {
    const fk = fake({ fail: { vanishChanged: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("Nach dem Neuladen ist der Dienst nicht geladen. Alter Zustand wiederhergestellt");
    expectOldState(fk);
  });

  test("Wiederherstellung scheitert beim Laden: Sicherung bleibt, Meldung nennt den Zustand", async () => {
    const fk = fake({ fail: { bootstrap: "all" } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("Wiederherstellung unvollständig: die Plist ist wieder die alte, der Dienst ist nicht geladen.");
    expect(fk.err[1]).toBe(`Sicherung: ${backups(fk)[0]}`);
    expect(fk.files.get(backups(fk)[0])).toEqual(fk.original!);
    expect(fk.files.get(PATH)).toEqual(fk.original!);
  });

  test("neue Plist geladen, bootout und bootstrap der Wiederherstellung scheitern: nicht als wiederhergestellt gemeldet", async () => {
    const fk = fake({ fail: { bootstrapChangedLoadsButFails: true, restoreLaunchctl: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    // Datei ist wieder die alte, geladen ist aber weiter die geänderte Konfiguration
    expect(fk.files.get(PATH)).toEqual(fk.original!);
    expect(fk.loaded.has(LABEL)).toBe(true);
    expect(fk.loadedConfig.get(LABEL)).not.toEqual(fk.original!);
    expect(fk.err.join("\n")).not.toContain("Alter Zustand wiederhergestellt");
    expect(fk.err[0]).toContain(
      "Wiederherstellung unvollständig: die Plist ist wieder die alte, der Dienst ist geladen, aber nicht nachweislich mit der alten Plist (womöglich noch mit der geänderten).",
    );
    expect(fk.err[1]).toBe(`Sicherung: ${backups(fk)[0]}`);
    expect(fk.err[2]).toStartWith("Von Hand zurück:");
    expect(fk.files.get(backups(fk)[0])).toEqual(fk.original!);
  });

  test("Wiederherstellung scheitert beim Zurückkopieren: Meldung sagt „noch die geänderte“", async () => {
    const fk = fake({ fail: { bootstrap: "changed", restoreCopy: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err[0]).toContain("die Plist ist noch die geänderte");
    expect(fk.files.get(backups(fk)[0])).toEqual(fk.original!);
  });

  test("rename und Zurückkopieren scheitern: Original liegt noch, Meldung folgt dem tatsächlichen Inhalt", async () => {
    const fk = fake({ fail: { rename: true, restoreCopy: true } });
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    // Die geänderte Plist kam nie an ihren Platz, geladen ist wieder das Original
    expect(fk.files.get(PATH)).toEqual(fk.original!);
    expect(fk.loaded.has(LABEL)).toBe(true);
    expect(fk.loadedConfig.get(LABEL)).toEqual(fk.original!);
    expect(tmpLeft(fk)).toBe(false);
    const text = fk.err.join("\n");
    expect(text).not.toContain("geänderte");
    expect(fk.err[0]).toBe(`Neue Plist nicht geschrieben (EPERM). Alter Zustand wiederhergestellt: alte Plist an ihrem Platz, Dienst wieder geladen. Sicherung: ${backups(fk)[0]}`);
  });
});

describe("einbinden: Zustand ändert sich während der Rückfrage", () => {
  const cases: Array<[string, (s: { loaded: Map<string, number | null>; disabled: Set<string> }) => void, string]> = [
    ["Lauf beginnt", s => void s.loaded.set(LABEL, 4711), EINBINDEN_TEXT.running(LABEL)],
    ["Dienst wird pausiert", s => void s.disabled.add(LABEL), EINBINDEN_TEXT.paused(LABEL)],
    ["Dienst wird entladen", s => void s.loaded.delete(LABEL), EINBINDEN_TEXT.notLoaded(LABEL)],
  ];
  for (const [name, duringAsk, reason] of cases) {
    test(`${name}: Abbruch vor dem Eingriff, Plist und Dienst unverändert`, async () => {
      const fk = fake({ answers: ["j"], duringAsk });
      expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps)).toBe(1);
      expect(fk.err).toHaveLength(1);
      expect(fk.err[0]).toStartWith(reason);
      expect(fk.events.filter(e => e.startsWith("launchctl boot") || e.startsWith("rename"))).toEqual([]);
      expect(fk.files.get(PATH)).toEqual(fk.original!);
      expect(tmpLeft(fk)).toBe(false);
      expect(fk.out).not.toContain(EINBINDEN_TEXT.done(LABEL, "einbinden"));
    });
  }
});

describe("ausbinden", () => {
  test("nach einbinden ergibt ausbinden Zeichen für Zeichen die alte Plist", async () => {
    const fk = fake();
    expect(await changeRoutineWrapper("einbinden", LABEL, fk.deps, { yes: true })).toBe(0);
    expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps, { yes: true })).toBe(0);
    expect(fk.files.get(PATH)!.ProgramArguments).toEqual(fk.original!.ProgramArguments);
    expect(fk.files.get(PATH)).toEqual(fk.original!);
    expect(backups(fk)).toHaveLength(2);
    expect(fk.loaded.has(LABEL)).toBe(true);
    expect(fk.out).toContain(EINBINDEN_TEXT.done(LABEL, "ausbinden"));
  });

  test("fragt „Ausbinden? [j/N]“", async () => {
    const wrapped = watchPlist({ ProgramArguments: [BUN, "--no-env-file", "src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"] });
    const fk = fake({ plists: { [`${LABEL}.plist`]: wrapped }, answers: ["ja"] });
    expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps)).toBe(0);
    expect(fk.asked).toEqual(["Ausbinden? [j/N] "]);
    expect(fk.files.get(PATH)!.ProgramArguments).toEqual(["/usr/bin/true"]);
  });

  test("Plist ohne Wrapper bleibt unberührt", async () => {
    const fk = fake();
    expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps, { yes: true })).toBe(0);
    expect(fk.out).toEqual([WRAP_TEXT.notWrapped(LABEL)]);
    expect(touched(fk)).toEqual([]);
    expect(backups(fk)).toEqual([]);
  });

  test("Wrapper mit fremder --id: abgelehnt", async () => {
    const wrapped = watchPlist({ ProgramArguments: [BUN, "--no-env-file", "src/routine-run.ts", "--id", "com.example.andere", "--", "/usr/bin/true"] });
    const fk = fake({ plists: { [`${LABEL}.plist`]: wrapped } });
    expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.err).toEqual([WRAP_TEXT.foreignWrapper(LABEL)]);
    expect(touched(fk)).toEqual([]);
  });

  test("Fehler beim Laden stellt auch beim Ausbinden die Sicherung wieder her", async () => {
    const wrapped = watchPlist({ ProgramArguments: [BUN, "--no-env-file", "src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"] });
    const fk = fake({ plists: { [`${LABEL}.plist`]: wrapped }, fail: { bootstrap: "changed" } });
    expect(await changeRoutineWrapper("ausbinden", LABEL, fk.deps, { yes: true })).toBe(1);
    expect(fk.files.get(PATH)).toEqual(wrapped);
    expect(fk.loaded.has(LABEL)).toBe(true);
  });
});
