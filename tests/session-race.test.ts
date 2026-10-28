import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Issue #189: /new während eines laufenden Turns. Der Turn endet nach dem
// Zurücksetzen und darf seine (alte) Session nicht zurückschreiben. Echter
// Session-Speicher im Temp-Verzeichnis (Kindprozess, data/sessions.json).
test("/new während eines laufenden Turns: keine Rückkehr der alten Session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-session-race-"));
  try {
    const child = Bun.spawn([process.execPath, resolve("tests/session-race-child.ts")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SESSION_MODE: "resume", CLAUDE_EFFORT: "" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    const out = JSON.parse(stdout.trim().split("\n").pop()!);

    // A: der laufende Turn setzte S fort, nach /new bleibt der Schlüssel leer
    expect(out.a).toEqual({ resumed: "S-alt", stored: [], resumable: null });
    // B: auch ein erster Turn ohne gespeicherte Session speichert nichts
    expect(out.b).toEqual([]);
    // C: /new trifft alle Agenten des Schlüssels, auch den laufenden anderen
    expect(out.c).toEqual([]);
    // D: ohne /new wie bisher gespeichert
    expect(out.d).toEqual(["general=S-normal"]);
    // E: Neustart nach gescheitertem Resume im selben Turn bleibt erlaubt
    expect(out.e).toEqual(["general=S-frisch"]);
    // F: der nächste Turn nach /new speichert wieder
    expect(out.f).toEqual(["general=S-danach"]);
    // G: Topic aus der WebUI gelöscht: ebenso keine Rückkehr
    expect(out.g).toEqual([]);
    // H: /new während einer laufenden /routine: die Routine schreibt nichts zurück
    expect(out.h).toEqual({ resumed: "S-routine", text: "bericht", stored: [], resumable: null });
    // I: /new während der Startmeldung von /routine: die Zuordnung bleibt leer
    expect(out.i).toEqual({ resumed: "S-befehl", replies: 2, stored: [], resumable: null });
    // J: /new während der Startmeldung des Routine-Knopfs: die Zuordnung bleibt leer
    expect(out.j).toEqual({ resumed: "S-knopf", notices: 1, stored: [], resumable: null });
    // K: /new, während decideReview die Session auswählt: die Zuordnung bleibt leer
    expect(out.k).toEqual({ resumed: "S-wahl", stored: [], resumable: null });
    // L: dasselbe über einen alten rev|-Knopf ohne Rückfrage
    expect(out.l).toEqual({ resumed: "S-alt-knopf", stored: [], resumable: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
