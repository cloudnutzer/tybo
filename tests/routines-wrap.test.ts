/**
 * Issue #286, Checkbox 1: Wrapper vor ProgramArguments setzen und wieder
 * entfernen, als reine Funktion ohne Dateien und Befehle.
 */

import { describe, expect, test } from "bun:test";
import { isWrapped } from "../src/lib/routines/sources/launchd";
import { unwrapProgramArguments, wrapperPrefix, wrapperPrefixLength, wrapProgramArguments, WRAP_TEXT } from "../src/lib/routines/wrap";

const BUN = "/Users/alex/.bun/bin/bun";
const ROOT = "/Users/alex/tybo";
const LABEL = "com.example.watch";

function plist(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Label: LABEL,
    ProgramArguments: ["/usr/bin/python3", "/Users/alex/watch/run.py", "--quiet"],
    WorkingDirectory: "/Users/alex/watch",
    EnvironmentVariables: { PATH: "/usr/bin:/bin", TOKEN_FILE: "/Users/alex/.watch" },
    StartCalendarInterval: { Hour: 9, Minute: 0 },
    StandardOutPath: "/Users/alex/watch/log.txt",
    StandardErrorPath: "/Users/alex/watch/err.txt",
    ...extra,
  };
}

describe("wrapProgramArguments", () => {
  test("einfache Plist: Vorsatz mit --no-env-file und absolutem Wrapper, alte Argumente dahinter", () => {
    const plan = wrapProgramArguments(plist(), LABEL, BUN, ROOT);
    expect(plan).toEqual({
      ok: true,
      changed: true,
      before: ["/usr/bin/python3", "/Users/alex/watch/run.py", "--quiet"],
      after: [BUN, "--no-env-file", `${ROOT}/src/routine-run.ts`, "--id", LABEL, "--", "/usr/bin/python3", "/Users/alex/watch/run.py", "--quiet"],
    });
    if (plan.ok && plan.changed) expect(isWrapped(plan.after, LABEL)).toBe(true);
  });

  test("Pfade mit Leerzeichen bleiben je ein Argument, Zeichen für Zeichen", () => {
    const args = ["/Users/alex/Mein Ordner/bin/bun", "run", "/Users/alex/Mein Ordner/src/preis watch.ts", "--name", "a b  c"];
    const root = "/Users/alex/Meine Projekte/tybo";
    const plan = wrapProgramArguments(plist({ ProgramArguments: args }), LABEL, "/Users/alex/Mein Ordner/bin/bun", root);
    if (!plan.ok || !plan.changed) throw new Error("erwartet: Änderung");
    expect(plan.after.slice(6)).toEqual(args);
    expect(plan.after[2]).toBe("/Users/alex/Meine Projekte/tybo/src/routine-run.ts");
    expect(wrapperPrefixLength(plan.after, LABEL)).toBe(6);
  });

  test("schon eingebunden: abgelehnt, egal ob Vorlage (relativ) oder einbinden (absolut)", () => {
    const fromTemplate = [BUN, "--no-env-file", "src/routine-run.ts", "--id", LABEL, "--", BUN, "run", "src/x.ts"];
    const fromEinbinden = [...wrapperPrefix(BUN, ROOT, LABEL), "/usr/bin/true"];
    for (const args of [fromTemplate, fromEinbinden]) {
      expect(wrapProgramArguments(plist({ ProgramArguments: args }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.alreadyWrapped(LABEL) });
    }
  });

  test("Wrapper mit fremder --id oder nicht am Anfang: abgelehnt, nichts doppelt", () => {
    const wrongId = [BUN, "--no-env-file", "src/routine-run.ts", "--id", "com.example.andere", "--", "/usr/bin/true"];
    const inside = ["/bin/sh", "-c", "x", BUN, "src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"];
    for (const args of [wrongId, inside]) {
      expect(wrapProgramArguments(plist({ ProgramArguments: args }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.foreignWrapper(LABEL) });
    }
  });

  test("Dauerdienst (KeepAlive ohne Zeitplan) wird abgelehnt", () => {
    for (const keepAlive of [true, { SuccessfulExit: false }]) {
      const p = plist({ KeepAlive: keepAlive });
      delete p.StartCalendarInterval;
      expect(wrapProgramArguments(p, LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.daemon(LABEL) });
    }
  });

  test("Zeitplan mit bedingtem KeepAlive (wie smart-checkin) bleibt zeitgesteuert und wird eingebunden", () => {
    const plan = wrapProgramArguments(plist({ KeepAlive: { SuccessfulExit: false }, RunAtLoad: true }), LABEL, BUN, ROOT);
    expect(plan.ok && plan.changed).toBe(true);
  });

  test("Bot-Dienst und Supabase-Start werden nie eingebunden", () => {
    const bot = { ...plist(), Label: "ai.tybo.telegram-relay", ProgramArguments: [BUN, "run", "src/bot.ts"] };
    delete bot.StartCalendarInterval;
    expect(wrapProgramArguments(bot, "ai.tybo.telegram-relay", BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.botService("ai.tybo.telegram-relay") });
    // auch mit Zeitplan, also nicht nur über KeepAlive erkannt
    expect(wrapProgramArguments({ ...plist(), Label: "ai.tybo.telegram-relay" }, "ai.tybo.telegram-relay", BUN, ROOT).ok).toBe(false);
    const supa = { ...plist(), Label: "ai.tybo.supabase", RunAtLoad: true };
    expect(wrapProgramArguments(supa, "ai.tybo.supabase", BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.supabaseService("ai.tybo.supabase") });
  });

  test("Program, fehlende oder ungültige ProgramArguments: abgelehnt", () => {
    expect(wrapProgramArguments(plist({ Program: "/usr/bin/python3" }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.program(LABEL) });
    for (const args of [undefined, [], "x", ["/usr/bin/true", 3], ["", "x"]]) {
      expect(wrapProgramArguments(plist({ ProgramArguments: args }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.noArguments(LABEL) });
    }
  });

  test("leere Argumente nach dem Programm sind gültig und bleiben erhalten", () => {
    const old = ["/usr/bin/printf", "%s", ""];
    const plan = wrapProgramArguments(plist({ ProgramArguments: old }), LABEL, BUN, ROOT);
    expect(plan).toEqual({ ok: true, changed: true, before: old, after: [...wrapperPrefix(BUN, ROOT, LABEL), ...old] });
  });

  test("Label der Plist muss genau stimmen", () => {
    expect(wrapProgramArguments(plist({ Label: "com.example.andere" }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.labelMismatch(LABEL, "com.example.andere") });
    expect(wrapProgramArguments(plist({ Label: undefined }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.labelMismatch(LABEL, null) });
  });

  test("relative Pfade für bun oder Projekt werden abgelehnt", () => {
    expect(wrapProgramArguments(plist(), LABEL, "bun", ROOT).ok).toBe(false);
    expect(wrapProgramArguments(plist(), LABEL, BUN, "tybo").ok).toBe(false);
  });
});

describe("unwrapProgramArguments", () => {
  test("ausbinden ergibt Zeichen für Zeichen die alten ProgramArguments", () => {
    const old = ["/Users/alex/Mein Ordner/bin/tool", "--flag=ä ö", "", "x"];
    const wrapped = wrapProgramArguments(plist({ ProgramArguments: old }), LABEL, BUN, ROOT);
    if (!wrapped.ok || !wrapped.changed) throw new Error("erwartet: Änderung");
    const back = unwrapProgramArguments(plist({ ProgramArguments: wrapped.after }), LABEL);
    expect(back).toEqual({ ok: true, changed: true, before: wrapped.after, after: old });
  });

  test("Rundlauf mit leerem letztem Argument: ['/usr/bin/printf', '%s', '']", () => {
    const old = ["/usr/bin/printf", "%s", ""];
    const wrapped = wrapProgramArguments(plist({ ProgramArguments: old }), LABEL, BUN, ROOT);
    if (!wrapped.ok || !wrapped.changed) throw new Error("erwartet: Änderung");
    expect(unwrapProgramArguments(plist({ ProgramArguments: wrapped.after }), LABEL)).toEqual({ ok: true, changed: true, before: wrapped.after, after: old });
  });

  test("Vorsatz aus den Vorlagen (relativ) und mit run wird ebenfalls entfernt", () => {
    const template = [BUN, "--no-env-file", "src/routine-run.ts", "--id", LABEL, "--", BUN, "run", "src/x.ts"];
    expect(unwrapProgramArguments(plist({ ProgramArguments: template }), LABEL)).toMatchObject({ ok: true, changed: true, after: [BUN, "run", "src/x.ts"] });
    const withRun = [BUN, "run", `${ROOT}/src/routine-run.ts`, "--id", LABEL, "--", "/usr/bin/true"];
    expect(unwrapProgramArguments(plist({ ProgramArguments: withRun }), LABEL)).toMatchObject({ ok: true, changed: true, after: ["/usr/bin/true"] });
  });

  test("Plist ohne Wrapper bleibt unberührt", () => {
    expect(unwrapProgramArguments(plist(), LABEL)).toEqual({ ok: true, changed: false, reason: WRAP_TEXT.notWrapped(LABEL) });
  });

  test("fremde --id oder Wrapper in der Mitte: abgelehnt statt geraten", () => {
    const wrongId = [BUN, "--no-env-file", "src/routine-run.ts", "--id", "com.example.andere", "--", "/usr/bin/true"];
    expect(unwrapProgramArguments(plist({ ProgramArguments: wrongId }), LABEL)).toEqual({ ok: false, reason: WRAP_TEXT.foreignWrapper(LABEL) });
    const noSeparator = [BUN, "--no-env-file", "src/routine-run.ts", "--id", LABEL, "/usr/bin/true"];
    expect(unwrapProgramArguments(plist({ ProgramArguments: noSeparator }), LABEL).ok).toBe(false);
  });

  test("fremdes Programm statt bun: kein Wrapper, nichts entfernt", () => {
    const tail = ["src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"];
    for (const starter of ["/bin/echo", "/usr/bin/env", "/Users/alex/.bun/bin/bunx", "/opt/bun/bin/notbun", "bun.exe", "/bin/sh"]) {
      const args = [starter, ...tail];
      expect(wrapperPrefixLength(args, LABEL)).toBeNull();
      expect(unwrapProgramArguments(plist({ ProgramArguments: args }), LABEL)).toEqual({ ok: false, reason: WRAP_TEXT.foreignWrapper(LABEL) });
      expect(wrapProgramArguments(plist({ ProgramArguments: args }), LABEL, BUN, ROOT)).toEqual({ ok: false, reason: WRAP_TEXT.foreignWrapper(LABEL) });
    }
  });

  test("ungültige Flagkombinationen zwischen bun und Wrapper: kein Wrapper, nichts entfernt", () => {
    const tail = ["src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"];
    for (const flags of [["run", "run"], ["--no-env-file", "--no-env-file"], ["run", "--no-env-file"], ["--hot"], ["--no-env-file", "--hot"], ["-e", "x"], ["--no-env-file", "run", "run"]]) {
      const args = [BUN, ...flags, ...tail];
      expect(wrapperPrefixLength(args, LABEL)).toBeNull();
      expect(unwrapProgramArguments(plist({ ProgramArguments: args }), LABEL)).toEqual({ ok: false, reason: WRAP_TEXT.foreignWrapper(LABEL) });
    }
  });

  test("erlaubte Vorsatzformen: ohne Flag, --no-env-file, run, --no-env-file run; bun auch als Name", () => {
    const tail = ["src/routine-run.ts", "--id", LABEL, "--", "/usr/bin/true"];
    for (const flags of [[], ["--no-env-file"], ["run"], ["--no-env-file", "run"]]) {
      for (const bun of [BUN, "bun"]) {
        expect(unwrapProgramArguments(plist({ ProgramArguments: [bun, ...flags, ...tail] }), LABEL)).toMatchObject({ ok: true, changed: true, after: ["/usr/bin/true"] });
      }
    }
  });

  test("Befehl hinter dem Vorsatz beginnt mit leerem Programm: abgelehnt", () => {
    expect(unwrapProgramArguments(plist({ ProgramArguments: [...wrapperPrefix(BUN, ROOT, LABEL), "", "x"] }), LABEL)).toEqual({ ok: false, reason: WRAP_TEXT.noArguments(LABEL) });
  });

  test("nur Vorsatz ohne Befehl dahinter: abgelehnt", () => {
    expect(unwrapProgramArguments(plist({ ProgramArguments: wrapperPrefix(BUN, ROOT, LABEL) }), LABEL).ok).toBe(false);
  });

  test("Bot-Dienst und Dauerdienst werden auch beim Ausbinden nicht angefasst", () => {
    const bot = { ...plist(), Label: "ai.tybo.telegram-relay" };
    expect(unwrapProgramArguments(bot, "ai.tybo.telegram-relay").ok).toBe(false);
    const daemon = plist({ KeepAlive: true });
    delete daemon.StartCalendarInterval;
    expect(unwrapProgramArguments(daemon, LABEL)).toEqual({ ok: false, reason: WRAP_TEXT.daemon(LABEL) });
  });
});
