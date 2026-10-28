/**
 * Issue #161, Checkbox 3: Standardwerte, geladene Auswahlen und Abläufe in
 * `tybo setup` im Terminal, mit dem Test-Schritt aus setup-flow-fixture.ts.
 * Simulierte Eingaben, Anbieter und Warten sind Attrappen.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import type { SetupContext } from "../src/setup/context";
import { RUN_GRACE_MS } from "../src/setup/terminal";
import { writeEnv } from "../src/setup/steps/common";
import { cleanup, makeCtx } from "./setup-fixture";
import { ABORTED_MESSAGE, FLOW, FLOW_ID, makeFlowStep, type FlowOptions } from "./setup-flow-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

const ARGS = { mode: "step", step: FLOW_ID } as const;

async function envOf(ctx: SetupContext) {
  return parseEnvContent(await readFile(ctx.envPath, "utf8").catch(() => ""));
}

/** Wartet nie von selbst, nur bis signal ausgelöst ist */
const sleepUntilAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });

async function setup(options: FlowOptions = {}, env = "# leer\n", overrides: Partial<SetupContext> = {}) {
  const ctx = await makeCtx({ env, overrides });
  const step = makeFlowStep(options);
  return { ctx, step };
}

/** Standard-Eingaben bis zur Rückfrage: Art (Enter = Vorschlag), Token, Organisation 1, Name (Enter), Passwort */
const INPUTS = ["", FLOW.token, "1", "", FLOW.password];

function noLeak(out: string) {
  expect(out).not.toContain(FLOW.token);
  expect(out).not.toContain(FLOW.password);
}

describe("Ablauf im Terminal", () => {
  test("Plan, Rückfrage, Fortschritt in Reihenfolge, Ergebnis; transientes Feld nie in der .env", async () => {
    const { ctx, step } = await setup();
    const prompter = scripted([...INPUTS, ""]);
    const { code, out, lines } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(code).toBe(0);

    const asked = prompter.asked.map(a => a.question);
    expect(asked).toEqual([
      "Art [Neu anlegen]: ",
      "Zugangstoken: ",
      "Organisation: ",
      "Projektname [tybo]: ",
      "Datenbank-Passwort: ",
      "Jetzt ausführen? [J/n] ",
    ]);
    expect(prompter.asked[4].secret).toBe(true);
    // Auswahl vom Anbieter nummeriert, geladen mit den Eingaben davor
    expect(out).toContain("    1) Alpha GmbH");
    expect(out).toContain("    2) Beta AG");
    expect(step.log.choicesCalls).toEqual([{ FLOW_MODE: "neu", FLOW_TOKEN: FLOW.token }]);

    const plan = lines.indexOf("  Das passiert jetzt:");
    expect(lines.slice(plan + 1, plan + 4)).toEqual([
      "    - Projekt beim Anbieter anlegen.",
      "    - Warten, bis das Projekt bereit ist.",
      "    - Zugangsdaten in die .env schreiben.",
    ]);
    // Höchstens alle 15 s eine Zeile beim Warten
    expect(lines.filter(l => l.startsWith("  ["))).toEqual([
      "  [1/3] Lege das Projekt an",
      "  [2/3] Warte, bis das Projekt bereit ist (0:00)",
      "  [2/3] Warte, bis das Projekt bereit ist (0:15)",
      "  [2/3] Warte, bis das Projekt bereit ist (0:30)",
      "  [3/3] Schreibe die Zugangsdaten",
    ]);
    expect(out).toContain("  Projekt angelegt und eingetragen.");
    expect(out).toContain("  Geändert: FLOW_TOKEN, FLOW_ORG, FLOW_NAME");
    expect(out).toContain("Testablauf: gespeichert.");
    // Kein Verbindungstest und kein „Speichern?“ im Ablauf
    expect(out).not.toContain("Teste");
    expect(asked).not.toContain("Speichern? [J/n] ");

    // run() bekommt Standardwerte und das transiente Feld, die .env nie
    expect(step.log.runs).toEqual([{ FLOW_MODE: "neu", FLOW_TOKEN: FLOW.token, FLOW_ORG: FLOW.org, FLOW_NAME: "tybo", FLOW_PASSWORD: FLOW.password }]);
    const env = await envOf(ctx);
    expect(env).toMatchObject({ FLOW_TOKEN: FLOW.token, FLOW_ORG: FLOW.org, FLOW_NAME: "tybo" });
    expect(env).not.toHaveProperty("FLOW_PASSWORD");
    expect(env).not.toHaveProperty("FLOW_MODE");
    noLeak(out);
  });

  test("Plan abgelehnt: nichts läuft, nichts geschrieben", async () => {
    const { ctx, step } = await setup();
    const { out } = await runWith(ARGS, ctx, scripted([...INPUTS, "n"]), { steps: [step] });
    expect(out).toContain("  Nicht ausgeführt.");
    expect(step.log.runs).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toBe("# leer\n");
  });

  test("runWhen trifft nicht zu: Test und Speichern wie bisher", async () => {
    const { ctx, step } = await setup();
    const prompter = scripted(["2", FLOW.token, ""]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(prompter.asked.map(a => a.question)).toEqual(["Art [Neu anlegen]: ", "Zugangstoken: ", "Speichern? [J/n] "]);
    expect(out).toContain("Verbindungstest: bestanden.");
    expect(step.log.runs).toEqual([]);
    expect((await envOf(ctx)).FLOW_TOKEN).toBe(FLOW.token);
  });

  test("Strg+C während des Ablaufs setzt signal, die Meldung von run() erscheint", async () => {
    let interrupt: () => void = () => {};
    const { ctx, step } = await setup(
      {
        async run(_values, c, report, signal) {
          report({ at: 1, total: 2, label: "Lege das Projekt an" });
          setTimeout(() => interrupt(), 0);
          await c.sleep(60_000, signal);
          return signal.aborted ? { ok: false, message: ABORTED_MESSAGE, changed: [] } : { ok: true, message: "fertig", changed: [] };
        },
      },
      "# leer\n",
      { sleep: sleepUntilAbort },
    );
    const { code, out } = await runWith(ARGS, ctx, scripted([...INPUTS, ""]), {
      steps: [step],
      onInterrupt(handler) {
        interrupt = handler;
        return () => {};
      },
    });
    expect(code).toBe(130);
    expect(step.log.signals[0].aborted).toBe(true);
    expect(out).toContain("  Breche ab, warte auf das Ende des Ablaufs …");
    expect(out).toContain(`  ${ABORTED_MESSAGE}`);
    expect(out).toContain("Abgebrochen. Was der Ablauf schon erledigt hat, steht oben");
    expect(out).not.toContain("nicht aufgehört");
  });

  test("Strg+C während des Schreibens: das Schreiben der .env läuft zu Ende", async () => {
    let interrupt: () => void = () => {};
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(r => (releaseWrite = r));
    let renaming = false;
    const { rename } = await import("node:fs/promises");
    const { ctx, step } = await setup(
      {
        async run(values, c, report) {
          report({ at: 1, total: 1, label: "Schreibe die Zugangsdaten" });
          // Kein Blick auf signal: ein angefangenes Schreiben endet nicht mittendrin
          return writeEnv(c, [["FLOW_TOKEN", values.FLOW_TOKEN]]);
        },
      },
      "# leer\n",
      {
        sleep: sleepUntilAbort,
        envIo: {
          async rename(from, to) {
            renaming = true;
            interrupt();
            await writeGate;
            await rename(from, to);
          },
        },
      },
    );
    const pending = runWith(ARGS, ctx, scripted([...INPUTS, ""]), {
      steps: [step],
      onInterrupt(handler) {
        interrupt = handler;
        return () => {};
      },
    });
    for (let i = 0; i < 200 && !renaming; i++) await Bun.sleep(2);
    expect(step.log.signals[0].aborted).toBe(true);
    releaseWrite();
    const { code, out } = await pending;
    expect(code).toBe(130);
    expect((await envOf(ctx)).FLOW_TOKEN).toBe(FLOW.token);
    expect(out).toContain("  Gespeichert.");
    expect(out).toContain("  Geändert: FLOW_TOKEN");
    noLeak(out);
  });

  test("Hört der Ablauf nach 30 s nicht auf: Hinweis, Einrichtung endet", async () => {
    let interrupt: () => void = () => {};
    const sleeps: number[] = [];
    const { ctx, step } = await setup(
      {
        async run(_values, _c, report) {
          report({ at: 1, total: 2, label: "Lege das Projekt an" });
          setTimeout(() => interrupt(), 0);
          return new Promise(() => {});
        },
      },
      "# leer\n",
      {
        sleep: async (ms, signal) => {
          sleeps.push(ms);
          if (ms !== RUN_GRACE_MS) await sleepUntilAbort(ms, signal);
        },
      },
    );
    const { code, out } = await runWith(ARGS, ctx, scripted([...INPUTS, ""]), {
      steps: [step],
      onInterrupt(handler) {
        interrupt = handler;
        return () => {};
      },
    });
    expect(code).toBe(130);
    expect(sleeps).toEqual([RUN_GRACE_MS]);
    expect(out).toContain("nach 30 Sekunden noch nicht aufgehört");
    expect(out).toContain("Abgebrochen, ohne dass der Ablauf aufgehört hat.");
  });

  test("Transienter Wert, den der Ablauf versehentlich schreiben will: Fehler, .env unverändert, nirgends in der Ausgabe", async () => {
    const { ctx, step } = await setup({
      async run(values, c, report) {
        // Fehler im Schritt: Wert in einer Zeile und in der .env
        report({ at: 1, total: 1, label: `Schreibe ${values.FLOW_PASSWORD}` });
        return writeEnv(c, [["FLOW_TOKEN", values.FLOW_TOKEN], ["FLOW_PASSWORD", values.FLOW_PASSWORD]]);
      },
    });
    const prompter = scripted([...INPUTS, "", "ü"]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(out).toContain("  [1/1] Schreibe ***");
    expect(out).toContain("gilt nur für diesen Lauf und gehört nicht in die .env");
    expect(prompter.asked.at(-1)!.question).toBe("Erneut eingeben [E] oder überspringen [ü]? ");
    expect(await readFile(ctx.envPath, "utf8")).toBe("# leer\n");
    noLeak(out);
  });

  test("Kurze transiente Werte bleiben ebenfalls draußen", async () => {
    const { ctx, step } = await setup({
      async run(values, _c, report) {
        report({ at: 1, total: 1, label: "Passwort", detail: values.FLOW_PASSWORD });
        return { ok: true, message: `ok ${values.FLOW_PASSWORD}`, changed: [] };
      },
    });
    const { out } = await runWith(ARGS, ctx, scripted(["", FLOW.token, "1", "", "q7", ""]), { steps: [step] });
    expect(out).toContain("  [1/1] Passwort: ***");
    expect(out).toContain("  ok ***");
    expect(out).not.toMatch(/\bq7\b/);
  });

  test("Interner Fehler im Ablauf: Meldung ohne Werte, dann erneut oder überspringen", async () => {
    const { ctx, step } = await setup({
      async run(values) {
        throw new Error(`kaputt ${values.FLOW_PASSWORD}`);
      },
    });
    const prompter = scripted([...INPUTS, "", "ü"]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(out).toContain("Der Ablauf ist mit einem internen Fehler stehen geblieben (Error).");
    expect(prompter.asked.at(-1)!.question).toBe("Erneut eingeben [E] oder überspringen [ü]? ");
    expect(out).toContain("Testablauf: übersprungen.");
    noLeak(out);
  });
});

describe("Standardwerte im Terminal", () => {
  test("vorhandener Wert hat Vorrang: kein Vorschlag, Enter behält", async () => {
    const { ctx, step } = await setup({}, "FLOW_NAME=eigenes-projekt\n");
    const prompter = scripted([...INPUTS, ""]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(prompter.asked.map(a => a.question)).toContain("Projektname: ");
    expect(prompter.asked.map(a => a.question)).not.toContain("Projektname [tybo]: ");
    expect(out).toContain("Ist gesetzt. Enter behält den bisherigen Wert.");
    expect(step.log.runs[0]).not.toHaveProperty("FLOW_NAME");
    expect((await envOf(ctx)).FLOW_NAME).toBe("eigenes-projekt");
  });

  test("eigene Eingabe ersetzt den Vorschlag", async () => {
    const { ctx, step } = await setup();
    await runWith(ARGS, ctx, scripted(["", FLOW.token, "1", "mein-name", FLOW.password, ""]), { steps: [step] });
    expect((await envOf(ctx)).FLOW_NAME).toBe("mein-name");
  });
});

describe("Auswahl vom Anbieter im Terminal", () => {
  test("Eingabe außerhalb der Liste wird abgelehnt", async () => {
    const { ctx, step } = await setup();
    const { out } = await runWith(ARGS, ctx, scripted(["", FLOW.token, "7", "", "org-beta", "", FLOW.password, ""]), { steps: [step] });
    expect(out).toContain("  Organisation: keine gültige Auswahl");
    expect(step.log.runs[0].FLOW_ORG).toBe("org-beta");
  });

  test("Ladefehler ohne Werte; Nochmal eingeben lädt mit neuer Eingabe", async () => {
    const { ctx, step } = await setup({
      async choices(values) {
        if (values.FLOW_TOKEN === FLOW.token) return { error: `Token ${values.FLOW_TOKEN} abgelehnt.` };
        return { choices: [{ value: FLOW.org, label: FLOW.orgLabel }] };
      },
    });
    const prompter = scripted(["", FLOW.token, "e", "", FLOW.otherToken, "1", "", FLOW.password, ""]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(out).toContain("  Organisation: Token *** abgelehnt.");
    expect(prompter.asked[2].question).toBe("Nochmal eingeben [E] oder überspringen [ü]? ");
    // Von vorn: Enter übernimmt die Art vom vorigen Versuch
    expect(prompter.asked[3].question).toBe("Art: ");
    expect(step.log.choicesCalls.map(c => c.FLOW_TOKEN)).toEqual([FLOW.token, FLOW.otherToken]);
    expect(step.log.runs[0].FLOW_TOKEN).toBe(FLOW.otherToken);
    noLeak(out);
  });

  test("Ladefehler und überspringen; leere Liste zählt als Fehler", async () => {
    const { ctx, step } = await setup({ choices: async () => ({ choices: [] }) });
    const { out } = await runWith(ARGS, ctx, scripted(["", FLOW.token, "ü"]), { steps: [step] });
    expect(out).toContain("  Organisation: Der Anbieter hat keine Auswahl geliefert.");
    expect(out).toContain("Testablauf: übersprungen.");
    expect(step.log.runs).toEqual([]);
  });

  test("Ausnahme beim Laden: fester Text, nie die Fehlermeldung", async () => {
    const { ctx, step } = await setup({
      async choices(values) {
        throw new Error(`HTTP 401 für ${values.FLOW_TOKEN}`);
      },
    });
    const { out } = await runWith(ARGS, ctx, scripted(["", FLOW.token, "ü"]), { steps: [step] });
    expect(out).toContain("  Organisation: Die Auswahl ließ sich nicht laden.");
    expect(out).not.toContain("HTTP 401");
  });
});

describe("Kurze Werte mitten in anderen Zeichen (Terminal)", () => {
  const SHORT_TOKEN = "k3";
  const SHORT_PASSWORD = "q7";

  test("Ladefehler: eingebettetes kurzes Token bleibt draußen", async () => {
    const { ctx, step } = await setup({
      async choices(values) {
        return { error: `Fehler bei x${values.FLOW_TOKEN}y` };
      },
    });
    const { out } = await runWith(ARGS, ctx, scripted(["", SHORT_TOKEN, "ü"]), { steps: [step] });
    expect(out).toContain("  Organisation: Fehler bei x***y");
    expect(out).not.toContain(SHORT_TOKEN);
  });

  test("Fortschritt, Ergebnis und geänderte Namen: eingebettetes kurzes Passwort bleibt draußen", async () => {
    const { ctx, step } = await setup({
      async run(values, _c, report) {
        report({ at: 1, total: 2, label: `Passwort=x${values.FLOW_PASSWORD}x`, detail: `pfad/a${values.FLOW_PASSWORD}b` });
        report({ at: 2, total: 2, label: `Token${values.FLOW_TOKEN}` });
        return { ok: true, message: `ok${values.FLOW_PASSWORD}ok`, changed: [`config/x${values.FLOW_PASSWORD}x.json`] };
      },
    });
    const { out } = await runWith(ARGS, ctx, scripted(["", SHORT_TOKEN, "1", "", SHORT_PASSWORD, ""]), { steps: [step] });
    expect(out).toContain("  [1/2] Passwort=x***x: pfad/a***b");
    expect(out).toContain("  [2/2] Token***");
    expect(out).toContain("  ok***ok");
    expect(out).toContain("  Geändert: config/x***x.json");
    expect(out).not.toContain(SHORT_PASSWORD);
    expect(out).not.toContain(SHORT_TOKEN);
  });
});

describe("Aufgelöster Feldstand im Terminal", () => {
  const byName = (fields: import("../src/setup/model").SetupField[]) =>
    fields.map(f => (f.name === "FLOW_PASSWORD" ? { ...f, visible: (v: Record<string, string>) => v.FLOW_MODE === "neu" && v.FLOW_NAME === "prod" } : f));
  const options: FlowOptions = {
    fields: byName,
    runWhen: v => v.FLOW_MODE === "neu" && v.FLOW_NAME === "prod",
    plan: v => [v.FLOW_NAME === "prod" ? "Produktion anlegen." : "Etwas anderes anlegen."],
  };

  test("vorhandener Wert zählt mit seinem Inhalt für Sichtbarkeit, runWhen und plan", async () => {
    const { ctx, step } = await setup(options, "FLOW_NAME=prod\n");
    const prompter = scripted(["", FLOW.token, "1", "", FLOW.password, ""]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(prompter.asked.map(a => a.question)).toEqual(["Art [Neu anlegen]: ", "Zugangstoken: ", "Organisation: ", "Projektname: ", "Datenbank-Passwort: ", "Jetzt ausführen? [J/n] "]);
    expect(out).toContain("    - Produktion anlegen.");
    expect(step.log.runs).toHaveLength(1);
    noLeak(out);
  });

  test("anderer vorhandener Wert: Feld unsichtbar, kein Ablauf", async () => {
    const { ctx, step } = await setup(options, "FLOW_NAME=test\n");
    const prompter = scripted(["", FLOW.token, "1", "", ""]);
    await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(prompter.asked.map(a => a.question)).toEqual(["Art [Neu anlegen]: ", "Zugangstoken: ", "Organisation: ", "Projektname: ", "Speichern? [J/n] "]);
    expect(step.log.runs).toEqual([]);
  });

  test("gespeicherte Auswahl außerhalb der neu geladenen Liste: Enter behält sie nicht", async () => {
    const { ctx, step } = await setup(
      { fields: fields => fields.map(f => (f.name === "FLOW_ORG" ? { ...f, required: false } : f)) },
      `FLOW_TOKEN=${FLOW.token}\nFLOW_ORG=org-alt\n`,
    );
    const prompter = scripted(["", "", "", "", "1", "", FLOW.password, ""]);
    const { out } = await runWith(ARGS, ctx, prompter, { steps: [step] });
    expect(out).toContain("  Organisation: keine gültige Auswahl");
    expect(step.log.runs[0].FLOW_ORG).toBe(FLOW.org);
    noLeak(out);
  });
});
