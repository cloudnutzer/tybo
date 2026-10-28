/**
 * Issue #288, Checkbox 1: Pausieren, Fortsetzen und „Jetzt testen" in
 * src/lib/routines/actions.ts, nur mit der launchd-Attrappe
 * (tests/routine-actions-fixture.ts). Kein Test ruft echtes launchctl auf.
 */

import { describe, expect, test } from "bun:test";
import { ACTION_TEXT, menuActions, performRoutineAction } from "../src/lib/routines/actions";
import { listRoutines } from "../src/lib/routines/catalog";
import { fakeLaunchd, standardLaunchd } from "./routine-actions-fixture";
import { AGENTS } from "./routines-fixture";

const quiet = { log: () => {} };
const HC = "ai.tybo.health-check";

describe("Befehlsfolge je Aktion", () => {
  test("Pausieren: disable, dann bootout; Ergebnis aus dem neu gelesenen Zustand", async () => {
    const l = standardLaunchd();
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
    expect(r.status).toBe("done");
    expect(r.state).toBe("paused");
    expect(r.text).toBe("⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt.");
    // Nach der Aktion wurde neu gelesen: launchctl list kommt nach bootout noch einmal
    const lastBootout = l.calls.findLastIndex(c => c[1] === "bootout");
    expect(l.calls.slice(lastBootout + 1).some(c => c[1] === "list")).toBe(true);
    expect(l.calls.slice(lastBootout + 1).some(c => c[1] === "print-disabled")).toBe(true);
  });

  test("Fortsetzen: enable, dann bootstrap mit dem tatsächlichen Plist (nicht <label>.plist)", async () => {
    const l = standardLaunchd({ health: { disabled: true, loaded: false, file: "eigener-name.plist" } });
    const r = await performRoutineAction(l.deps, HC, "resume", { ...quiet, format: { now: Date.parse("2026-10-15T08:00:00Z"), timeZone: "Europe/Berlin" } });
    expect(l.mutations()).toEqual([`enable gui/501/${HC}`, `bootstrap gui/501 ${AGENTS}/eigener-name.plist`]);
    expect(r.status).toBe("done");
    expect(r.state).toBe("active");
    expect(r.text).toBe("▶️ health-check ist wieder aktiv. Nächster Lauf: morgen 03:30.");
  });

  test("Jetzt testen: kickstart ohne -k", async () => {
    const l = standardLaunchd();
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(l.mutations()).toEqual([`kickstart gui/501/${HC}`]);
    expect(l.calls.some(c => c.includes("-k"))).toBe(false);
    expect(r.status).toBe("done");
    expect(r.text).toContain("gestartet");
  });

  test("läuft gerade: kein kickstart, Antwort läuft gerade", async () => {
    const l = standardLaunchd({ health: { pid: 999 } });
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("busy");
    expect(r.text).toBe(ACTION_TEXT.running("health-check"));
    expect(l.mutations()).toEqual([]);
  });

  test("Testen einer pausierten oder nicht geladenen Routine ruft nichts auf", async () => {
    for (const health of [{ disabled: true, loaded: false }, { disabled: false, loaded: false }]) {
      const l = standardLaunchd({ health });
      const r = await performRoutineAction(l.deps, HC, "run", quiet);
      expect(r.status).toBe("wrong-state");
      expect(l.mutations()).toEqual([]);
    }
  });

  test("Zustand unbekannt (launchctl list scheitert): keine Aktion", async () => {
    for (const action of ["pause", "resume", "run"] as const) {
      const l = standardLaunchd();
      l.fail.add("list");
      const r = await performRoutineAction(l.deps, HC, action, quiet);
      expect(r.status).toBe("wrong-state");
      expect(r.text).toBe(ACTION_TEXT.stateUnknown("health-check"));
      expect(l.mutations()).toEqual([]);
    }
  });

  test("schon pausiert bzw. schon aktiv: nichts aufgerufen", async () => {
    const paused = standardLaunchd({ health: { disabled: true, loaded: false } });
    expect((await performRoutineAction(paused.deps, HC, "pause", quiet)).text).toBe("health-check ist schon pausiert.");
    expect(paused.mutations()).toEqual([]);
    const active = standardLaunchd();
    expect((await performRoutineAction(active.deps, HC, "resume", quiet)).status).toBe("already");
    expect(active.mutations()).toEqual([]);
  });
});

describe("Teilfehler: gemeldet wird der gelesene Zustand", () => {
  test("disable klappt, bootout scheitert: nur zum Teil pausiert, keine Erfolgsmeldung", async () => {
    const l = standardLaunchd();
    l.fail.add("bootout");
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(r.status).toBe("partial");
    expect(r.text).toBe(ACTION_TEXT.pausePartial("health-check"));
    expect(r.text).not.toContain("⏸️");
  });

  test("disable scheitert: kein bootout, Meldung weiter aktiv", async () => {
    const l = standardLaunchd();
    l.fail.add("disable");
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`]);
    expect(r.status).toBe("failed");
    expect(r.text).toBe("Pausieren hat nicht geklappt: health-check ist weiter aktiv.");
  });

  test("enable klappt, bootstrap scheitert: nur zum Teil fortgesetzt", async () => {
    const l = standardLaunchd({ health: { disabled: true, loaded: false } });
    l.fail.add("bootstrap");
    const r = await performRoutineAction(l.deps, HC, "resume", quiet);
    expect(r.status).toBe("partial");
    expect(r.state).toBe("not-loaded");
    expect(r.text).toBe(ACTION_TEXT.resumePartial("health-check"));
  });

  test("enable scheitert: kein bootstrap, ist weiter pausiert", async () => {
    const l = standardLaunchd({ health: { disabled: true, loaded: false } });
    l.fail.add("enable");
    const r = await performRoutineAction(l.deps, HC, "resume", quiet);
    expect(l.mutations()).toEqual([`enable gui/501/${HC}`]);
    expect(r.text).toBe("Fortsetzen hat nicht geklappt: health-check ist weiter pausiert.");
  });

  test("Zustand danach nicht lesbar: keine Erfolgsmeldung", async () => {
    const l = standardLaunchd();
    const run = l.deps.run;
    let after = false;
    l.deps.run = async cmd => {
      if (cmd[1] === "bootout") after = true;
      if (after && cmd[1] === "print-disabled") return { ok: false, stdout: "", stderr: "x" };
      return run(cmd);
    };
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(r.status).toBe("failed");
    expect(r.text).toBe(ACTION_TEXT.pauseUnknownAfter("health-check"));
  });

  test("kickstart scheitert: hat nicht geklappt", async () => {
    const l = standardLaunchd();
    l.fail.add("kickstart");
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("failed");
    expect(r.text).toBe(ACTION_TEXT.runFailed("health-check"));
  });
});

/** Lauf wie der Wrapper ihn festhält */
const wrapperRun = (startedAt: string, exitCode = 0) => ({ startedAt, endedAt: startedAt, durationMs: 800, exitCode, tail: [] });

describe("Jetzt testen: gemeldet wird der nachgelesene Zustand", () => {
  test("kickstart klappt, Nachlesen scheitert: kein „gestartet“, Ausgang unklar", async () => {
    const l = standardLaunchd();
    l.onKickstart = () => l.fail.add("list");
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("partial");
    expect(r.text).toBe(ACTION_TEXT.startedUnknownAfter("health-check"));
    expect(r.text).not.toBe(ACTION_TEXT.started("health-check"));
    expect(l.mutations()).toEqual([`kickstart gui/501/${HC}`]);
  });

  test("kickstart klappt, Routine überhaupt nicht mehr lesbar: kein „gestartet“", async () => {
    const l = standardLaunchd();
    const listDir = l.deps.listDir;
    let kicked = false;
    l.onKickstart = () => (kicked = true);
    l.deps.listDir = path => (kicked ? [] : listDir(path));
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("partial");
    expect(r.text).toBe(ACTION_TEXT.startedUnknownAfter("health-check"));
  });

  test("kickstart klappt, kurzer Lauf beim Nachlesen schon fertig: gestartet und fertig, mit Exit-Code", async () => {
    const l = standardLaunchd();
    l.addRun(HC, wrapperRun("2026-10-14T03:30:00.000Z"));
    l.onKickstart = (s, label) => {
      s.pid = null;
      l.addRun(label, wrapperRun("2026-10-15T08:00:00.000Z", 3));
    };
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("done");
    expect(r.text).toBe(ACTION_TEXT.startedFinished("health-check", 3));
  });

  test("kickstart klappt, läuft beim Nachlesen nicht mehr, kein neuer Lauf im Verlauf: kein „läuft“ behauptet", async () => {
    const l = standardLaunchd();
    l.addRun(HC, wrapperRun("2026-10-14T03:30:00.000Z"));
    l.onKickstart = s => (s.pid = null);
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("done");
    expect(r.text).toBe(ACTION_TEXT.startedNotSeen("health-check"));
  });

  test("kickstart scheitert, Dienst läuft beim Nachlesen: nicht „läuft nicht“", async () => {
    const l = standardLaunchd();
    l.fail.add("kickstart");
    l.onKickstart = s => (s.pid = 999);
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("busy");
    expect(r.text).toBe(ACTION_TEXT.runFailedButRunning("health-check"));
    expect(r.text).not.toContain("läuft nicht");
  });

  test("kickstart scheitert, kurzer Lauf ist trotzdem schon fertig: nicht „läuft nicht“", async () => {
    const l = standardLaunchd();
    l.fail.add("kickstart");
    l.onKickstart = (_s, label) => l.addRun(label, wrapperRun("2026-10-15T08:00:00.000Z", 0));
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("partial");
    expect(r.text).toBe(ACTION_TEXT.runFailedButFinished("health-check", 0));
    expect(r.text).not.toContain("läuft nicht");
  });

  test("kickstart scheitert, Nachlesen scheitert: Zustand unbekannt statt „läuft nicht“", async () => {
    const l = standardLaunchd();
    l.fail.add("kickstart");
    l.onKickstart = () => l.fail.add("list");
    const r = await performRoutineAction(l.deps, HC, "run", quiet);
    expect(r.status).toBe("failed");
    expect(r.text).toBe(ACTION_TEXT.runFailedUnknownAfter("health-check"));
  });
});

describe("Pausieren nur zum Teil geklappt, dann noch einmal pausieren", () => {
  test("disable klappt, bootout scheitert; zweites Pausieren entlädt nur noch, ohne zweites disable", async () => {
    const l = standardLaunchd();
    l.fail.add("bootout");
    expect((await performRoutineAction(l.deps, HC, "pause", quiet)).status).toBe("partial");
    l.fail.delete("bootout");
    const list = await listRoutines(l.deps);
    const partial = list.routines.find(r => r.id === HC)!;
    expect(partial.state).toBe("paused");
    expect(menuActions(partial)).toEqual(["resume", "pause"]);
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(r.status).toBe("done");
    expect(r.text).toBe(ACTION_TEXT.pauseCompleted("health-check"));
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("bootout scheitert auch beim zweiten Mal: wieder nur zum Teil, nie „schon pausiert“", async () => {
    const l = standardLaunchd();
    l.fail.add("bootout");
    await performRoutineAction(l.deps, HC, "pause", quiet);
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(r.status).toBe("partial");
    expect(r.text).toBe(ACTION_TEXT.pausePartial("health-check"));
    expect(r.text).not.toBe(ACTION_TEXT.alreadyPaused("health-check"));
  });

  test("Teil-Pause, dann scheitert Fortsetzen: deaktiviert, aber noch geladen bleibt sichtbar, nie „weiter pausiert“", async () => {
    for (const pid of [null, 999]) {
      const l = standardLaunchd({ health: { pid } });
      l.fail.add("bootout");
      expect((await performRoutineAction(l.deps, HC, "pause", quiet)).status).toBe("partial");
      l.services.get(HC)!.pid = pid;
      l.fail.add("enable");
      const r = await performRoutineAction(l.deps, HC, "resume", quiet);
      expect(l.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`, `enable gui/501/${HC}`]);
      expect(r.status).toBe("failed");
      expect(r.text).toBe(ACTION_TEXT.resumeFailedStillLoaded("health-check", pid !== null));
      expect(r.text).toContain("deaktiviert, aber noch geladen");
      expect(r.text).toContain(pid !== null ? "läuft gerade" : "kann bis zum nächsten Neustart weiterlaufen");
      if (pid === null) expect(r.text).not.toContain("läuft gerade");
      expect(r.text).not.toBe(ACTION_TEXT.resumeFailed("health-check"));
    }
  });
});

describe("Pausieren scheitert bei einer nicht geladenen Routine", () => {
  test("nicht deaktiviert und nicht geladen: nie „weiter aktiv“, sondern nicht geladen ohne nächsten Lauf", async () => {
    const l = standardLaunchd({ health: { disabled: false, loaded: false } });
    l.fail.add("disable");
    const r = await performRoutineAction(l.deps, HC, "pause", quiet);
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`]);
    expect(r.status).toBe("failed");
    expect(r.state).toBe("not-loaded");
    expect(r.text).toBe(ACTION_TEXT.pauseFailedNotLoaded("health-check"));
    expect(r.text).not.toContain("weiter aktiv");
    expect(r.text).toContain("nicht geladen");
  });
});

describe("Sperren", () => {
  test("Bot-Dienst: keine Aktion, nicht einmal gelesen", async () => {
    for (const action of ["pause", "resume", "run"] as const) {
      const l = standardLaunchd();
      const r = await performRoutineAction(l.deps, "ai.tybo.telegram-relay", action, quiet);
      expect(r.status).toBe("blocked");
      expect(l.calls).toEqual([]);
    }
  });

  test("Dauerdienste: gesperrt, nichts aufgerufen", async () => {
    for (const action of ["pause", "resume", "run"] as const) {
      const l = standardLaunchd();
      const r = await performRoutineAction(l.deps, "ai.tybo.web-proxy", action, quiet);
      expect(r.status).toBe("blocked");
      expect(r.text).toBe(ACTION_TEXT.blockedDaemon("web-proxy"));
      expect(l.mutations()).toEqual([]);
    }
  });

  test("Routinen außerhalb des Katalogs (fremdes Label, nicht in config/routines.json): unbekannt", async () => {
    const l = fakeLaunchd([{ label: "com.other.app" }, { label: "ai.tybo.health-check" }]);
    for (const action of ["pause", "resume", "run"] as const) {
      const r = await performRoutineAction(l.deps, "com.other.app", action, quiet);
      expect(r.status).toBe("unknown");
    }
    expect(l.mutations()).toEqual([]);
  });

  test("Eintrag aus config/routines.json darf bedient werden", async () => {
    const l = fakeLaunchd([{ label: "com.example.backup" }], { config: JSON.stringify({ labels: ["com.example.backup"] }) });
    const r = await performRoutineAction(l.deps, "com.example.backup", "pause", quiet);
    expect(r.status).toBe("done");
    expect(l.mutations()).toEqual(["disable gui/501/com.example.backup", "bootout gui/501/com.example.backup"]);
  });

  test("PM2 und ohne launchd: nicht verfügbar, nichts aufgerufen", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const l = fakeLaunchd([{ label: HC }], { platform });
      for (const action of ["pause", "resume", "run"] as const) {
        const r = await performRoutineAction(l.deps, HC, action, quiet);
        expect(r.status).toBe("unavailable");
        expect(r.text).toBe("Pausieren, Fortsetzen und Testen sind auf diesem System nicht verfügbar.");
      }
      expect(l.calls).toEqual([]);
    }
  });
});

describe("Menü je Zustand", () => {
  test("aktiv: testen und pausieren; pausiert und nicht geladen: fortsetzen; Bot und Dauerdienst: nichts", async () => {
    const l = fakeLaunchd([
      { label: "ai.tybo.a" },
      { label: "ai.tybo.b", disabled: true, loaded: false },
      { label: "ai.tybo.c", loaded: false },
      { label: "ai.tybo.telegram-relay", daemon: true },
      { label: "ai.tybo.d", daemon: true },
    ]);
    const list = await listRoutines(l.deps);
    const menu = Object.fromEntries(list.routines.map(r => [r.id, menuActions(r)]));
    expect(menu).toEqual({
      "ai.tybo.a": ["run", "pause"],
      "ai.tybo.b": ["resume"],
      "ai.tybo.c": ["resume"],
      "ai.tybo.d": [],
      "ai.tybo.telegram-relay": [],
    });
  });
});

describe("Log", () => {
  test("nur Routinen-ID, Aktion und Kanal, kein Ergebnis", async () => {
    const lines: string[] = [];
    const l = standardLaunchd();
    await performRoutineAction(l.deps, HC, "pause", { log: line => lines.push(line), channel: "web" });
    l.fail.add("kickstart");
    await performRoutineAction(standardLaunchd().deps, HC, "run", { log: line => lines.push(line), channel: "telegram" });
    expect(lines).toEqual([`[routinen] ${HC} pause (web)`, `[routinen] ${HC} run (telegram)`]);
  });
});
