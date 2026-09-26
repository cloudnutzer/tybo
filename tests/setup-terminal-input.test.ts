/**
 * Issue #65, Checkbox 2: verdeckte Eingabe, Bestätigung und Abbruch.
 *
 * - Die echte Eingabe (src/setup/prompt.ts) an einem simulierten Terminal:
 *   geheime Werte erscheinen nicht, Raw-Modus wird immer zurückgestellt.
 * - Strg+C während Eingabe, Test und Schreiben; die .env bleibt beim Abbruch
 *   vor dem Schreiben Byte für Byte, wie sie war.
 * - Abgelehnte Bestätigung, Fehlschlag mit Wiederholen oder Überspringen.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import { createTerminalPrompter, SetupAbort } from "../src/setup/prompt";
import { terminalModes } from "../src/terminal/app";
import { backupsOf, cleanup, FAKE, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { CTRL_C, linuxCtx, runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Simuliertes Terminal
// ---------------------------------------------------------------------------

class FakeStdin extends EventEmitter {
  isTTY: boolean;
  modes: boolean[] = [];
  raw = false;
  constructor(tty: boolean) {
    super();
    this.isTTY = tty;
  }
  setRawMode(mode: boolean) {
    this.raw = mode;
    this.modes.push(mode);
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  type(text: string) {
    this.emit("data", Buffer.from(text));
  }
  /** Schickt Bytes in Paketen, die an den angegebenen Stellen getrennt sind */
  typeSplit(text: string, cuts: number[]) {
    const bytes = Buffer.from(text);
    let from = 0;
    for (const cut of [...cuts, bytes.length]) {
      this.emit("data", bytes.subarray(from, cut));
      from = cut;
    }
  }
}

function fakeTerminal(tty = true) {
  const stdin = new FakeStdin(tty);
  const writes: string[] = [];
  const stdout = { isTTY: tty, write: (t: string) => writes.push(t) };
  const prompter = createTerminalPrompter(stdin, stdout);
  return { stdin, writes, prompter, shown: () => writes.join("") };
}

describe("Eingabe am Terminal", () => {
  test("geheime Eingabe: kein Echo, auch keine Sternchen; Raw-Modus danach aus", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Bot-Token: ", { secret: true });
    expect(t.stdin.raw).toBe(true);
    expect(terminalModes.rawMode).toBe(true);
    t.stdin.type(FAKE.token.slice(0, 10));
    t.stdin.type(`${FAKE.token.slice(10)}\r`);
    expect(await answer).toBe(FAKE.token);
    expect(t.shown()).toBe("Bot-Token: \n");
    expect(t.stdin.raw).toBe(false);
    expect(terminalModes.rawMode).toBe(false);
  });

  test("sichtbare Eingabe mit Rücktaste und Pfeiltasten; \\r\\n zählt als ein Enter", async () => {
    const t = fakeTerminal();
    const first = t.prompter.ask("Name: ");
    t.stdin.type("Tesx\x7ft\x1b[Dperson\r\nEurope/Berlin\r");
    expect(await first).toBe("Testperson");
    // Rest der Eingabe (eingefügt) bleibt für die nächste Frage
    expect(await t.prompter.ask("Zeitzone: ")).toBe("Europe/Berlin");
    expect(t.shown()).toContain("Tesx\b \bt");
  });

  test("Strg+C mitten in der Eingabe: SetupAbort, Raw-Modus zurückgestellt", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Passwort: ", { secret: true });
    t.stdin.type(`${FAKE.webPassword.slice(0, 6)}\x03`);
    await expect(answer).rejects.toBeInstanceOf(SetupAbort);
    expect(t.stdin.modes).toEqual([true, false]);
    expect(terminalModes.rawMode).toBe(false);
    expect(t.shown()).not.toContain(FAKE.webPassword.slice(0, 6));
  });

  test("Signal (cancel) während einer Frage: ebenso Abbruch und Terminal zurück", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Frage: ");
    t.prompter.cancel();
    await expect(answer).rejects.toBeInstanceOf(SetupAbort);
    expect(t.stdin.raw).toBe(false);
    expect(terminalModes.rawMode).toBe(false);
  });

  test("Pipe: zeilenweise, keine Escape-Sequenz, kein Raw-Modus; Ende der Eingabe bricht ab", async () => {
    const t = fakeTerminal(false);
    const first = t.prompter.ask("A: ", { secret: true });
    t.stdin.type(`${FAKE.token}\nzwei`);
    expect(await first).toBe(FAKE.token);
    const second = t.prompter.ask("B: ");
    t.stdin.emit("end");
    expect(await second).toBe("zwei");
    await expect(t.prompter.ask("C: ")).rejects.toBeInstanceOf(SetupAbort);
    expect(t.stdin.modes).toEqual([]);
    expect(t.shown()).toBe("A: \nB: \nC: \n");
  });
});

describe("Unicode an Paketgrenzen", () => {
  const PASSWORT = "Jörg-mag-Äpfel-🙂-ß";
  /** Schnitte mitten im ö (2 Bytes), im Ä und im Emoji (4 Bytes) */
  function cuts(text: string): number[] {
    const at = (ch: string) => Buffer.byteLength(text.slice(0, text.indexOf(ch)));
    return [at("ö") + 1, at("Ä") + 1, at("🙂") + 1, at("🙂") + 3];
  }

  test("Terminal: geteilte Umlaute und Emoji kommen unverändert an, ohne Echo", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Passwort der WebUI: ", { secret: true });
    t.stdin.typeSplit(`${PASSWORT}\r`, cuts(PASSWORT));
    expect(await answer).toBe(PASSWORT);
    expect(t.shown()).toBe("Passwort der WebUI: \n");
  });

  test("Terminal, sichtbar: Echo zeigt die Zeichen, keine Ersatzzeichen", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Name: ");
    t.stdin.typeSplit(`${PASSWORT}\r`, cuts(PASSWORT));
    expect(await answer).toBe(PASSWORT);
    expect(t.shown()).toBe(`Name: ${PASSWORT}\n`);
    expect(t.shown()).not.toContain("\uFFFD");
  });

  test("Pipe: geteilte Umlaute und Emoji, auch in der letzten Zeile ohne Zeilenumbruch", async () => {
    const t = fakeTerminal(false);
    const first = t.prompter.ask("A: ", { secret: true });
    const text = `${PASSWORT}\n${PASSWORT}`;
    const c = cuts(PASSWORT);
    const offset = Buffer.byteLength(`${PASSWORT}\n`);
    // Zweite Zeile endet mitten im letzten Zeichen, der Rest kommt erst mit dem Ende
    t.stdin.typeSplit(text.slice(0, -1), [...c, ...c.map(n => n + offset)]);
    expect(await first).toBe(PASSWORT);
    const second = t.prompter.ask("B: ");
    const last = Buffer.from("ß");
    t.stdin.emit("data", last.subarray(0, 1));
    t.stdin.emit("data", last.subarray(1));
    t.stdin.emit("end");
    expect(await second).toBe(PASSWORT);
  });
});

describe("Pfeiltasten an Paketgrenzen", () => {
  const PASSWORT = "Geheim-Passwort-42";
  /** Pfeil links mitten im Passwort; die Folge wird nach ESC bzw. nach ESC+[ getrennt */
  const EINGABE = `Geheim-\x1b[DPasswort-42\r`;
  const nachEsc = [Buffer.byteLength("Geheim-\x1b")];
  const nachEscKlammer = [Buffer.byteLength("Geheim-\x1b[")];

  for (const [name, cuts] of [
    ["nach ESC", nachEsc],
    ["nach ESC+[", nachEscKlammer],
  ] as const) {
    test(`geheim, getrennt ${name}: Wert unverändert, kein Echo`, async () => {
      const t = fakeTerminal();
      const answer = t.prompter.ask("Passwort der WebUI: ", { secret: true });
      t.stdin.typeSplit(EINGABE, [...cuts]);
      expect(await answer).toBe(PASSWORT);
      expect(t.shown()).toBe("Passwort der WebUI: \n");
    });

    test(`sichtbar, getrennt ${name}: Wert und Echo ohne Reste der Folge`, async () => {
      const t = fakeTerminal();
      const answer = t.prompter.ask("Name: ");
      t.stdin.typeSplit(EINGABE, [...cuts]);
      expect(await answer).toBe(PASSWORT);
      expect(t.shown()).toBe(`Name: ${PASSWORT}\n`);
    });
  }

  test("SS3-Folge (ESC O A) über drei Pakete: nichts landet im Wert", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Passwort der WebUI: ", { secret: true });
    t.stdin.typeSplit(`ab\x1bOAcd\r`, [3, 4]);
    expect(await answer).toBe("abcd");
  });

  test("Strg+C nach angefangener Folge bricht trotzdem ab", async () => {
    const t = fakeTerminal();
    const answer = t.prompter.ask("Passwort der WebUI: ", { secret: true });
    t.stdin.type("abc\x1b[");
    t.stdin.type("\x03");
    await expect(answer).rejects.toBeInstanceOf(SetupAbort);
    expect(t.stdin.raw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bestätigung und Abbruch im Ablauf
// ---------------------------------------------------------------------------

describe("Bestätigung", () => {
  test("Zusammenfassung ohne Werte; abgelehnt: nichts geschrieben", async () => {
    const ctx = await makeCtx({ env: "# leer\n" });
    const before = await readFile(ctx.envPath, "utf8");
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([FAKE.token, FAKE.userId, "n"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Zusammenfassung (ohne Werte):");
    expect(r.out).toContain("Neu gesetzt: Bot-Token, Deine Telegram-Nutzer-ID");
    expect(r.out).toContain("Nicht gespeichert.");
    expect(r.out).not.toContain(FAKE.userId);
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("Autostart: ausdrückliche Warnung, Standard ist Nein, ohne Ja startet nichts", async () => {
    const ctx = await linuxCtx();
    const prompter = scripted([""]);
    const r = await runWith({ mode: "step", step: "autostart" }, ctx, prompter);
    expect(prompter.asked.at(-1)?.question).toBe("Autostart jetzt einrichten? [j/N] ");
    expect(r.out).toContain("startet dann sofort im Hintergrund");
    expect(r.out).toContain("Nicht gespeichert.");
    expect(ctx.run.calls.some(c => c[0] === "pm2" && c[1] === "start")).toBe(false);
  });
});

describe("Fehlschlag: erneut eingeben oder überspringen", () => {
  test("Test schlägt fehl, erneut eingeben, dann klappt es", async () => {
    const ctx = await makeCtx({ env: "" });
    let calls = 0;
    const getMe = ctx.providers.telegramGetMe;
    ctx.providers.telegramGetMe = async token => {
      calls++;
      return calls === 1 ? { ok: false, message: "Telegram kennt dieses Token nicht." } : getMe(token);
    };
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([FAKE.token, FAKE.userId, "e", FAKE.token, "", "j"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verbindungstest: fehlgeschlagen. Telegram kennt dieses Token nicht.");
    expect(r.out).toContain("Verbindungstest: bestanden.");
    expect(r.out).toContain("Telegram: gespeichert.");
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).TELEGRAM_BOT_TOKEN).toBe(FAKE.token);
  });

  test("Test schlägt fehl, überspringen: nichts geschrieben", async () => {
    const ctx = await makeCtx({ env: "" });
    ctx.providers.results.convexQuery = { ok: false, message: "Convex antwortet nicht." };
    const r = await runWith({ mode: "step", step: "datenbank" }, ctx, scripted(["convex", FAKE.convexUrl, FAKE.convexToken, "ü"]));
    expect(r.out).toContain("Datenbank: übersprungen.");
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
  });

  test("ungültige Eingabe: Fehler ohne Wert, nochmal fragen", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted(["kein-token-geheim", "j", FAKE.token, FAKE.userId, ""]));
    expect(r.out).toContain("Bot-Token hat nicht das erwartete Format");
    expect(r.out).not.toContain("kein-token-geheim");
    expect(r.out).toContain("Telegram: gespeichert.");
  });

  test("Wechsel Convex zu Supabase nicht bestätigt: Schritt übersprungen, CONVEX_URL bleibt", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const before = await readFile(ctx.envPath, "utf8");
    const r = await runWith(
      { mode: "step", step: "datenbank" },
      ctx,
      scripted(["2", FAKE.supabaseUrl, FAKE.serviceKey, "", "n", "n"]),
    );
    expect(r.out).toContain("Wechsel zu Supabase ist nicht bestätigt");
    expect(r.out).toContain("Datenbank: übersprungen.");
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    expect(leakedSecrets(r.out)).toEqual([]);
  });
});

describe("Abbrechen mit Strg+C", () => {
  test("mitten im Schritt: .env unverändert, Exit 130, klare Meldung", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const before = await readFile(ctx.envPath, "utf8");
    // Neues Token eingegeben, dann Strg+C bei der Nutzer-ID
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([`${FAKE.token}x`, CTRL_C]));
    expect(r.code).toBe(130);
    expect(r.out).toContain("Abgebrochen. Im laufenden Schritt wurde nichts geschrieben");
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    expect(await backupsOf(ctx)).toEqual([]);
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("bei der Bestätigung: nichts geschrieben", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const before = await readFile(ctx.envPath, "utf8");
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([FAKE.token, "999", CTRL_C]));
    expect(r.code).toBe(130);
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
  });

  test("während des Verbindungstests (Signal): sofort Ende, nichts geschrieben", async () => {
    const ctx = await makeCtx({ env: "" });
    let fire = () => {};
    ctx.providers.telegramGetMe = () => {
      fire();
      return new Promise(() => {}); // antwortet nie
    };
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([FAKE.token, FAKE.userId]), {
      onInterrupt: handler => {
        fire = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
  });

  test("während des Schreibens (Signal): Schreiben läuft zu Ende, danach Schluss", async () => {
    let fire = () => {};
    const ctx = await linuxCtx({
      overrides: {
        envIo: {
          rename: async (from, to) => {
            fire(); // Strg+C genau zwischen temporärer Datei und Ersetzen
            const { rename } = await import("node:fs/promises");
            await rename(from, to);
          },
        },
      },
    });
    const prompter = scripted(["", FAKE.token, FAKE.userId, ""]);
    const r = await runWith({ mode: "all" }, ctx, prompter, {
      onInterrupt: handler => {
        fire = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(r.out).toContain("Abgebrochen. Der laufende Schritt wurde vorher noch fertig gespeichert");
    // Telegram ist vollständig gespeichert, der nächste Schritt wurde nicht mehr begonnen
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env.TELEGRAM_BOT_TOKEN).toBe(FAKE.token);
    expect(env.TELEGRAM_USER_ID).toBe(FAKE.userId);
    expect(r.out).not.toContain("Forum-Gruppe (optional)\n  Optional");
    expect(prompter.asked.length).toBe(4);
  });

  test("Profil: .env geschrieben, profile.md scheitert, dann Strg+C: meldet den Teil", async () => {
    const ctx = await makeCtx({ env: "" });
    const configDir = ctx.profilePath.replace(/\/profile\.md$/, "");
    await chmod(configDir, 0o500);
    try {
      const r = await runWith({ mode: "step", step: "profil" }, ctx, scripted(["Testperson", "Europe/Berlin", "", "", CTRL_C]));
      expect(r.code).toBe(130);
      expect(r.out).toContain("config/profile.md konnte nicht geschrieben werden");
      expect(r.out).toContain("Im laufenden Schritt wurde nur ein Teil gespeichert (USER_NAME, USER_TIMEZONE)");
      expect(r.out).not.toContain("nichts geschrieben");
      expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).USER_NAME).toBe("Testperson");
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  /** Modelle: settings.json gelingt, die .env scheitert beim Ersetzen */
  const MODELS_RUN = ["claude-test-modell", "", FAKE.openrouterKey, "", "", "", ""];
  function failingRename(onRename = () => {}) {
    return {
      envIo: {
        rename: async () => {
          onRename();
          throw new Error("Platte voll");
        },
      },
    };
  }

  test("Modelle: settings.json gespeichert, .env scheitert, dann Strg+C: meldet den Teil", async () => {
    const ctx = await makeCtx({ env: "", overrides: failingRename() });
    const r = await runWith({ mode: "step", step: "modelle" }, ctx, scripted([...MODELS_RUN, CTRL_C]));
    expect(r.code).toBe(130);
    expect(r.out).toContain("Schon gespeichert und nicht zurückgenommen: config/settings.json");
    expect(r.out).toContain("Im laufenden Schritt wurde nur ein Teil gespeichert (config/settings.json)");
    expect(r.out).not.toContain("nichts geschrieben");
    expect(JSON.parse(await readFile(ctx.settingsPath, "utf8")).defaults.model).toBe("claude-test-modell");
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Signal während eines teilweise fehlgeschlagenen Schreibens: nie „fertig gespeichert“", async () => {
    let fire = () => {};
    const ctx = await makeCtx({ env: "", overrides: failingRename(() => fire()) });
    const prompter = scripted(MODELS_RUN);
    const r = await runWith({ mode: "step", step: "modelle" }, ctx, prompter, {
      onInterrupt: handler => {
        fire = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(r.out).not.toContain("fertig gespeichert");
    expect(r.out).toContain("Im laufenden Schritt wurde nur ein Teil gespeichert (config/settings.json)");
    // Nach dem Signal keine Frage mehr (auch nicht erneut oder überspringen)
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.length).toBe(MODELS_RUN.length);
  });

  test("Signal während eines fehlgeschlagenen Schreibens ohne jede Änderung", async () => {
    let fire = () => {};
    const ctx = await makeCtx({ env: "", overrides: failingRename(() => fire()) });
    const r = await runWith({ mode: "step", step: "telegram" }, ctx, scripted([FAKE.token, FAKE.userId, ""]), {
      onInterrupt: handler => {
        fire = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(r.out).not.toContain("fertig gespeichert");
    expect(r.out).toContain("Das Speichern im laufenden Schritt ist fehlgeschlagen, geschrieben wurde nichts");
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
  });

  test("bisher Gespeichertes bleibt nach Abbruch im nächsten Schritt", async () => {
    const ctx = await linuxCtx();
    // Telegram speichern, Gruppe überspringen, Strg+C bei der Datenbank
    const r = await runWith({ mode: "all" }, ctx, scripted(["", FAKE.token, FAKE.userId, "", "n", CTRL_C]));
    expect(r.code).toBe(130);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).TELEGRAM_USER_ID).toBe(FAKE.userId);
  });
});
