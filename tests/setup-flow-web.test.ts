/**
 * Issue #161, Checkbox 4: Auswahl vom Anbieter und Abläufe im
 * Einrichtungsmodus des Browsers, mit dem Test-Schritt aus
 * setup-flow-fixture.ts. Echter Server auf 127.0.0.1 (Port 0) im
 * temporären Projekt; Anbieter, Ablauf und Warten sind Attrappen.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import type { SetupContext } from "../src/setup/context";
import type { ChoicesResult, SetupStep } from "../src/setup/model";
import { checkStep, SETUP_STEPS } from "../src/setup/steps";
import { envValues, writeEnv } from "../src/setup/steps/common";
import { runSetupMode } from "../src/setup/web-mode";
import { REDACTED_NAME, RUN_ACTIVE_TEXT } from "../src/setup/web-server";
import { cleanup, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { ABORTED_MESSAGE, FLOW, FLOW_ID, makeFlowStep, type FlowOptions } from "./setup-flow-fixture";
import { CODE, get, login, post, PROFILE, startSetup, type Started, type TestCtx } from "./setup-web-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

function catalog(step: SetupStep): SetupStep[] {
  return [...SETUP_STEPS.filter(s => s.id !== "pruefung"), step, checkStep];
}

const sleepUntilAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });

async function start(options: FlowOptions = {}, extra: { env?: string; overrides?: Partial<SetupContext> } = {}) {
  const ctx = (await makeCtx({ env: extra.env ?? FULL_ENV, profile: PROFILE, overrides: extra.overrides })) as TestCtx;
  const step = makeFlowStep(options);
  const s = await startSetup({ ctx, steps: catalog(step) });
  running.push(s);
  return { s, step, cookie: await login(s) };
}

async function body(res: Response) {
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text) };
}

async function envOf(s: Started) {
  return parseEnvContent(await readFile(s.ctx.envPath, "utf8").catch(() => ""));
}

const NEW_VALUES = { FLOW_MODE: "neu", FLOW_TOKEN: FLOW.token, FLOW_ORG: FLOW.org, FLOW_PASSWORD: FLOW.password };

async function loadOrgs(s: Started, cookie: string, values: Record<string, string> = { FLOW_TOKEN: FLOW.token }) {
  return body(await post(s, `/api/setup/steps/${FLOW_ID}/choices/FLOW_ORG`, { values }, cookie));
}

async function startRun(s: Started, cookie: string, values: Record<string, string> = NEW_VALUES) {
  return body(await post(s, `/api/setup/steps/${FLOW_ID}/run`, { values }, cookie));
}

/** Fragt ab, bis der Ablauf nicht mehr läuft */
async function untilDone(s: Started, cookie: string, runId: string) {
  for (let i = 0; i < 400; i++) {
    const res = await body(await get(s, `/api/setup/runs/${runId}`, cookie));
    if (res.data.state !== "laeuft") return res;
    await Bun.sleep(5);
  }
  throw new Error("Ablauf endet nicht");
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function noLeak(text: string) {
  expect(text).not.toContain(FLOW.token);
  expect(text).not.toContain(FLOW.password);
  expect(leakedSecrets(text)).toEqual([]);
}

describe("Schritt und view", () => {
  test("Felder mit Standard, geladener Auswahl und transientem Feld; Modus und Plan", async () => {
    const { s, cookie } = await start({}, { env: `${FULL_ENV}FLOW_PASSWORD=${FLOW.password}\n` });
    const { text, data } = await body(await get(s, `/api/setup/steps/${FLOW_ID}`, cookie));
    const byName = Object.fromEntries(data.fields.map((f: any) => [f.name, f]));
    expect(byName.FLOW_NAME).toMatchObject({ default: "tybo", set: false, visible: true });
    expect(byName.FLOW_MODE).toMatchObject({ default: "neu" });
    expect(byName.FLOW_ORG).toMatchObject({ loadChoices: true, kind: "choice" });
    expect(byName.FLOW_ORG).not.toHaveProperty("choicesFrom");
    // Transient: nie gesetzt, auch wenn der Name in der .env steht
    expect(byName.FLOW_PASSWORD).toMatchObject({ transient: true, set: false });
    expect(data).toMatchObject({ canRun: true, mode: "ablauf", canApply: true });
    expect(data.plan).toEqual(["Projekt beim Anbieter anlegen.", "Warten, bis das Projekt bereit ist.", "Zugangsdaten in die .env schreiben."]);
    noLeak(text);

    const other = await body(await post(s, `/api/setup/steps/${FLOW_ID}/view`, { values: { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.token } }, cookie));
    expect(other.data.mode).toBe("felder");
    expect(other.data.plan).toEqual([]);
    expect(other.data.fields.find((f: any) => f.name === "FLOW_ORG").visible).toBe(false);
    noLeak(other.text);
  });

  test("ein aufgelöster Stand für Sichtbarkeit, Modus und Plan: Text, vorhandene Werte und eingegebene Geheimnisse", async () => {
    const options: FlowOptions = {
      fields: fields => fields.map(f => (f.name === "FLOW_PASSWORD" ? { ...f, visible: (v: Record<string, string>) => v.FLOW_NAME === "prod" } : f)),
      runWhen: v => v.FLOW_NAME === "prod" && !!v.FLOW_TOKEN,
      plan: v => [v.FLOW_NAME === "prod" ? "Produktion anlegen." : "Etwas anderes anlegen."],
    };
    const { s, cookie } = await start(options);
    const view = async (payload: Record<string, unknown>) => body(await post(s, `/api/setup/steps/${FLOW_ID}/view`, payload, cookie));
    const visible = (data: any) => data.fields.find((f: any) => f.name === "FLOW_PASSWORD").visible;

    // Text bestimmt die Sichtbarkeit mit; ohne Token kein Ablauf
    let res = await view({ values: { FLOW_NAME: "prod" } });
    expect(visible(res.data)).toBe(true);
    expect(res.data.mode).toBe("felder");
    // Eingegebenes Token nur als Name: zählt für den Modus
    res = await view({ values: { FLOW_NAME: "prod" }, present: ["FLOW_TOKEN"] });
    expect(res.data).toMatchObject({ mode: "ablauf", plan: ["Produktion anlegen."] });
    // present gilt nur für geheime und transiente Felder dieses Schritts
    res = await view({ values: {}, present: ["FLOW_NAME", "GIBTS_NICHT"] });
    expect(visible(res.data)).toBe(false);
    expect(res.data.mode).toBe("felder");
    res = await view({ values: { FLOW_NAME: "test" }, present: ["FLOW_TOKEN"] });
    expect(visible(res.data)).toBe(false);
    expect(res.data.mode).toBe("felder");

    // Vorhandene Werte mit ihrem Inhalt, wie im Terminal
    const stored = await start(options, { env: `${FULL_ENV}FLOW_NAME=prod\nFLOW_TOKEN=${FLOW.token}\n` });
    res = await body(await post(stored.s, `/api/setup/steps/${FLOW_ID}/view`, { values: {} }, stored.cookie));
    expect(visible(res.data)).toBe(true);
    expect(res.data).toMatchObject({ mode: "ablauf", plan: ["Produktion anlegen."] });
    noLeak(res.text);
  });

  test("transienter Name in der .env zählt nie als vorhanden", async () => {
    const { s, cookie } = await start({ runWhen: v => !!v.FLOW_PASSWORD }, { env: `${FULL_ENV}FLOW_PASSWORD=${FLOW.password}\n` });
    let res = await body(await post(s, `/api/setup/steps/${FLOW_ID}/view`, { values: {} }, cookie));
    expect(res.data.mode).toBe("felder");
    res = await body(await post(s, `/api/setup/steps/${FLOW_ID}/view`, { values: {}, present: ["FLOW_PASSWORD"] }, cookie));
    expect(res.data.mode).toBe("ablauf");
    noLeak(res.text);
  });

  test("bestehende Schritte antworten wie bisher, ohne mode und plan", async () => {
    const { s, cookie } = await start();
    const view = await body(await post(s, "/api/setup/steps/telegram/view", { values: {} }, cookie));
    expect(Object.keys(view.data)).toEqual(["fields"]);
    const step = await body(await get(s, "/api/setup/steps/telegram", cookie));
    expect(step.data).not.toHaveProperty("mode");
    expect(step.data).not.toHaveProperty("canRun");
  });
});

describe("Auswahl vom Anbieter", () => {
  test("Liste als Auswahl, geladen mit den Eingaben davor", async () => {
    const { s, step, cookie } = await start();
    const res = await loadOrgs(s, cookie, { FLOW_TOKEN: FLOW.token, FLOW_PASSWORD: FLOW.password });
    expect(res.status).toBe(200);
    expect(res.data.choices).toEqual([{ value: FLOW.org, label: FLOW.orgLabel }, { value: "org-beta", label: "Beta AG" }]);
    // Standard der Art greift, Passwort (nach dem Feld) geht nicht mit
    expect(step.log.choicesCalls).toEqual([{ FLOW_MODE: "neu", FLOW_TOKEN: FLOW.token }]);
  });

  test("Ladefehler geschwärzt, Ausnahme als fester Text, leere Liste als Fehler", async () => {
    let mode: "error" | "throw" | "empty" = "error";
    const { s, cookie } = await start({
      async choices(values): Promise<ChoicesResult> {
        if (mode === "throw") throw new Error(`HTTP 401 ${values.FLOW_TOKEN}`);
        if (mode === "empty") return { choices: [] };
        return { error: `Token ${values.FLOW_TOKEN} abgelehnt.` };
      },
    });
    let res = await loadOrgs(s, cookie);
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("Token *** abgelehnt.");
    mode = "throw";
    res = await loadOrgs(s, cookie);
    expect(res.data.error).toBe("Die Auswahl ließ sich nicht laden.");
    expect(s.logs.join("\n")).not.toContain("HTTP 401");
    mode = "empty";
    res = await loadOrgs(s, cookie);
    expect(res.data.error).toBe("Der Anbieter hat keine Auswahl geliefert.");
    noLeak(JSON.stringify(s.logs));
  });

  test("unbekanntes Feld 404, Feld ohne Anbieter-Auswahl 409", async () => {
    const { s, cookie } = await start();
    expect((await post(s, `/api/setup/steps/${FLOW_ID}/choices/GIBTS_NICHT`, { values: {} }, cookie)).status).toBe(404);
    expect((await post(s, `/api/setup/steps/${FLOW_ID}/choices/FLOW_MODE`, { values: {} }, cookie)).status).toBe(409);
  });

  test("verspätete Antwort ersetzt keine neuere", async () => {
    const gates: Array<() => void> = [];
    const { s, cookie } = await start({
      async choices(values) {
        await new Promise<void>(r => gates.push(r));
        const org = values.FLOW_TOKEN === FLOW.token ? "org-alt" : "org-neu";
        return { choices: [{ value: org, label: org }] };
      },
    });
    const first = loadOrgs(s, cookie, { FLOW_TOKEN: FLOW.token });
    await until(() => gates.length === 1);
    const second = loadOrgs(s, cookie, { FLOW_TOKEN: FLOW.otherToken });
    await until(() => gates.length === 2);
    gates[1]();
    expect((await second).data.choices[0].value).toBe("org-neu");
    gates[0]();
    expect((await first).data).toMatchObject({ stale: true });
    // Gilt: die Liste zum zweiten Token
    const bad = await startRun(s, cookie, { ...NEW_VALUES, FLOW_TOKEN: FLOW.token, FLOW_ORG: "org-alt" });
    expect(bad.status).toBe(422);
    const ok = await startRun(s, cookie, { ...NEW_VALUES, FLOW_TOKEN: FLOW.otherToken, FLOW_ORG: "org-neu" });
    expect(ok.status).toBe(202);
  });
});

describe("Ablauf starten", () => {
  test("202 mit runId, Abfrage liefert Ereignisse in Reihenfolge und Ergebnis; transientes Feld nie in der .env", async () => {
    const { s, step, cookie } = await start();
    await loadOrgs(s, cookie);
    const started = await startRun(s, cookie);
    expect(started.status).toBe(202);
    expect(started.data.runId).toMatch(/^[A-Za-z0-9_-]+$/);
    const done = await untilDone(s, cookie, started.data.runId);
    expect(done.data.state).toBe("fertig");
    expect(done.data.events.map((e: any) => `${e.at}/${e.total} ${e.label}${e.waitedMs !== undefined ? ` ${e.waitedMs}` : ""}`)).toEqual([
      "1/3 Lege das Projekt an",
      ...Array.from({ length: 9 }, (_, i) => `2/3 Warte, bis das Projekt bereit ist ${i * 5000}`),
      "3/3 Schreibe die Zugangsdaten",
    ]);
    expect(done.data.result).toEqual({ ok: true, message: "Projekt angelegt und eingetragen.", changed: ["FLOW_TOKEN", "FLOW_ORG", "FLOW_NAME"] });
    // Standardwert erreicht run(), Passwort nur im Aufruf
    expect(step.log.runs[0]).toEqual({ ...NEW_VALUES, FLOW_NAME: "tybo" });
    const env = await envOf(s);
    expect(env).toMatchObject({ FLOW_TOKEN: FLOW.token, FLOW_ORG: FLOW.org, FLOW_NAME: "tybo" });
    expect(env).not.toHaveProperty("FLOW_PASSWORD");
    noLeak(done.text);
    // Terminal von tybo setup --web: Beginn und Ende, ohne Werte
    expect(s.logs).toContain(`Ablauf ${FLOW_ID} gestartet`);
    expect(s.logs).toContain(`Ablauf ${FLOW_ID} beendet: fertig (geändert: FLOW_TOKEN, FLOW_ORG, FLOW_NAME)`);
    noLeak(JSON.stringify(s.logs));
    // Nach dem Ende wieder frei
    const overview = await body(await get(s, "/api/setup/overview", cookie));
    expect(overview.data.running).toBeNull();
  });

  test("ohne geladene Liste, mit veralteter Liste oder Auswahl außerhalb: 422, nichts läuft", async () => {
    const { s, step, cookie } = await start();
    let res = await startRun(s, cookie);
    expect(res.status).toBe(422);
    expect(res.data.error).toContain("Organisation: Auswahl bitte erst laden");
    await loadOrgs(s, cookie);
    res = await startRun(s, cookie, { ...NEW_VALUES, FLOW_ORG: "org-gibts-nicht" });
    expect(res.data.error).toContain("Organisation: keine gültige Auswahl");
    // Token gewechselt: alte Liste gilt nicht mehr
    res = await startRun(s, cookie, { ...NEW_VALUES, FLOW_TOKEN: FLOW.otherToken });
    expect(res.status).toBe(422);
    expect(res.data.error).toContain("Auswahl bitte erst laden");
    expect(step.log.runs).toEqual([]);
    noLeak(JSON.stringify(res));
  });

  test("Liste gilt nur für die eigene Sitzung", async () => {
    const { s, cookie } = await start();
    await loadOrgs(s, cookie);
    const other = await login(s, CODE);
    expect((await startRun(s, other)).status).toBe(422);
    expect((await startRun(s, cookie)).status).toBe(202);
  });

  test("gespeicherte Auswahl: ohne Liste und außerhalb der Liste 422, in der Liste 202", async () => {
    const { s, step, cookie } = await start({}, { env: `${FULL_ENV}FLOW_TOKEN=${FLOW.token}\nFLOW_ORG=org-alt\n` });
    const values = { FLOW_MODE: "neu", FLOW_PASSWORD: FLOW.password };
    let res = await startRun(s, cookie, values);
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("Organisation: Auswahl bitte erst laden");
    await loadOrgs(s, cookie, {});
    res = await startRun(s, cookie, values);
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("Organisation: keine gültige Auswahl");
    expect(step.log.runs).toEqual([]);
    // Gespeicherte Auswahl steht in der geladenen Liste: gilt
    await writeEnv(s.ctx, [["FLOW_ORG", "org-beta"]]);
    res = await startRun(s, cookie, values);
    expect(res.status).toBe(202);
    await untilDone(s, cookie, res.data.runId);
    noLeak(JSON.stringify(res));
  });

  test("gespeicherter Tokenwechsel macht die geladene Liste ungültig", async () => {
    const { s, step, cookie } = await start({}, { env: `${FULL_ENV}FLOW_TOKEN=${FLOW.token}\n` });
    expect((await loadOrgs(s, cookie, {})).status).toBe(200);
    // Token woanders gespeichert (Modus „vorhanden“ speichert ohne Ablauf)
    const saved = await body(await post(s, `/api/setup/steps/${FLOW_ID}/apply`, { values: { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.otherToken } }, cookie));
    expect(saved.status).toBe(200);
    let res = await startRun(s, cookie, { FLOW_MODE: "neu", FLOW_ORG: FLOW.org });
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("Organisation: Auswahl bitte erst laden");
    expect(step.log.runs).toEqual([]);
    // Neu geladen zum gespeicherten Token: gilt wieder
    await loadOrgs(s, cookie, {});
    res = await startRun(s, cookie, { FLOW_MODE: "neu", FLOW_ORG: FLOW.org });
    expect(res.status).toBe(202);
    await untilDone(s, cookie, res.data.runId);
  });

  test("Modus wird beim Start geprüft: ohne runWhen-Treffer 409; Speichern im Ablauf-Modus 409", async () => {
    const { s, step, cookie } = await start();
    const res = await startRun(s, cookie, { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.token });
    expect(res.status).toBe(409);
    const apply = await body(await post(s, `/api/setup/steps/${FLOW_ID}/apply`, { values: { FLOW_MODE: "neu", FLOW_TOKEN: FLOW.token } }, cookie));
    expect(apply.status).toBe(409);
    expect(step.log.runs).toEqual([]);
    // Ohne Ablauf wie bisher: Speichern
    const saved = await body(await post(s, `/api/setup/steps/${FLOW_ID}/apply`, { values: { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.token } }, cookie));
    expect(saved.data).toMatchObject({ ok: true, changed: ["FLOW_TOKEN"] });
  });

  test("Schritt ohne Ablauf: run 409", async () => {
    const { s, cookie } = await start();
    expect((await post(s, "/api/setup/steps/telegram/run", { values: {} }, cookie)).status).toBe(409);
  });
});

describe("Während ein Ablauf läuft", () => {
  async function blocked() {
    const t = await start({}, { overrides: { sleep: sleepUntilAbort } });
    await loadOrgs(t.s, t.cookie);
    const started = await startRun(t.s, t.cookie);
    expect(started.status).toBe(202);
    await until(() => t.step.log.events.length >= 2);
    return { ...t, runId: started.data.runId as string };
  }

  test("zweiter Start, Speichern und Fertig: 409; Abfrage, Test und Übersicht gehen weiter", async () => {
    const { s, step, cookie, runId } = await blocked();
    expect((await startRun(s, cookie)).status).toBe(409);
    const apply = await body(await post(s, "/api/setup/steps/profil/apply", { values: { USER_NAME: "Alex" } }, cookie));
    expect(apply).toMatchObject({ status: 409, data: { error: RUN_ACTIVE_TEXT } });
    const finish = await body(await post(s, "/api/setup/finish", {}, cookie));
    expect(finish).toMatchObject({ status: 409, data: { error: RUN_ACTIVE_TEXT } });
    expect(s.server.isFinished()).toBe(false);

    const poll = await body(await get(s, `/api/setup/runs/${runId}`, cookie));
    expect(poll.data.state).toBe("laeuft");
    expect(poll.data.events.length).toBeGreaterThanOrEqual(2);
    expect((await post(s, "/api/setup/steps/telegram/test", { values: {} }, cookie)).status).toBe(200);
    const overview = await body(await get(s, "/api/setup/overview", cookie));
    expect(overview.data.running).toEqual({ runId, step: FLOW_ID });

    // abbrechen setzt signal, der Ablauf endet mit seiner Meldung
    const cancel = await body(await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie));
    expect(cancel.status).toBe(200);
    expect(step.log.signals[0].aborted).toBe(true);
    const done = await untilDone(s, cookie, runId);
    expect(done.data).toMatchObject({ state: "abgebrochen", result: { ok: false, message: ABORTED_MESSAGE } });
    expect(s.logs).toContain(`Ablauf ${FLOW_ID} beendet: abgebrochen`);
    expect((await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie)).status).toBe(409);
    // Danach wieder frei
    expect((await post(s, "/api/setup/steps/profil/apply", { values: { USER_NAME: "Alex" } }, cookie)).status).toBe(200);
  });

  test("gleichzeitige Starts: genau einer läuft", async () => {
    const { s, cookie } = await start({}, { overrides: { sleep: sleepUntilAbort } });
    await loadOrgs(s, cookie);
    const results = await Promise.all([startRun(s, cookie), startRun(s, cookie), startRun(s, cookie)]);
    expect(results.map(r => r.status).sort()).toEqual([202, 409, 409]);
    const runId = results.find(r => r.status === 202)!.data.runId;
    await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie);
    await untilDone(s, cookie, runId);
  });

  test("Speichern und Start gleichzeitig: nie beides mittendrin", async () => {
    const { s, cookie } = await start({}, { overrides: { sleep: sleepUntilAbort } });
    await loadOrgs(s, cookie);
    // Beide Anfragen wirklich gleichzeitig unterwegs (kein await vor dem zweiten Start)
    const [apply, run] = await Promise.all([
      post(s, "/api/setup/steps/profil/apply", { values: { USER_NAME: "Mia" } }, cookie).then(body),
      startRun(s, cookie),
    ]);
    expect(run.status).toBe(202);
    // Entweder vor der Reservierung gespeichert oder danach abgelehnt
    expect([200, 409]).toContain(apply.status);
    await post(s, `/api/setup/runs/${run.data.runId}/abbrechen`, {}, cookie);
    await untilDone(s, cookie, run.data.runId);
  });

  test("Tokenwechsel per Speichern und Start gleichzeitig: nie Start mit alter Liste", async () => {
    const { s, step, cookie } = await start({}, { env: `${FULL_ENV}FLOW_TOKEN=${FLOW.token}\n`, overrides: { sleep: sleepUntilAbort } });
    // Liste zum gespeicherten Token
    expect((await loadOrgs(s, cookie, {})).status).toBe(200);
    const [apply, run] = await Promise.all([
      post(s, `/api/setup/steps/${FLOW_ID}/apply`, { values: { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.otherToken } }, cookie).then(body),
      startRun(s, cookie, { FLOW_MODE: "neu", FLOW_ORG: FLOW.org }),
    ]);
    if (apply.status === 200) {
      // Erst gespeichert: die Liste gehört zum alten Token
      expect(run.status).toBe(422);
      expect(run.data.error).toContain("Auswahl bitte erst laden");
      expect(step.log.runs).toEqual([]);
    } else {
      expect(apply.status).toBe(409);
      expect(run.status).toBe(202);
      await post(s, `/api/setup/runs/${run.data.runId}/abbrechen`, {}, cookie);
      await untilDone(s, cookie, run.data.runId);
    }
    noLeak(apply.text + run.text);
  });

  test("Tokenwechsel mit angehaltenem Speichern davor: alte Liste gilt weder zum Testen noch zum Speichern", async () => {
    let entered!: () => void;
    const reached = new Promise<void>(r => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const applied: Record<string, string>[] = [];
    const { s, cookie } = await start(
      {
        // „neu“ ohne Passwort bleibt im Felder-Modus, so gibt es Testen und Speichern mit Auswahl
        runWhen: v => v.FLOW_MODE === "neu" && !!v.FLOW_PASSWORD,
        async apply(values, ctx) {
          applied.push({ ...values });
          if (values.FLOW_TOKEN === FLOW.otherToken) {
            entered();
            await gate;
          }
          return writeEnv(ctx, values.FLOW_TOKEN ? [["FLOW_TOKEN", values.FLOW_TOKEN]] : []);
        },
      },
      { env: `${FULL_ENV}FLOW_TOKEN=${FLOW.token}\n` },
    );
    const pick = { FLOW_MODE: "neu", FLOW_ORG: FLOW.org };
    const send = (action: string, values: Record<string, string>) => post(s, `/api/setup/steps/${FLOW_ID}/${action}`, { values }, cookie).then(body);
    expect((await loadOrgs(s, cookie, {})).status).toBe(200);
    // Vor dem Wechsel gilt die Liste
    expect((await send("test", pick)).status).toBe(200);

    const saving = send("apply", { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.otherToken });
    await reached;
    // Beide kommen an, solange das Speichern angehalten ist, und warten dahinter
    const testing = send("test", pick);
    const applying = send("apply", pick);
    await until(() => s.server.queued() === 3);
    release();
    const [saved, tested, stored] = await Promise.all([saving, testing, applying]);
    expect(saved.status).toBe(200);
    expect(tested).toMatchObject({ status: 422, data: { error: "Organisation: Auswahl bitte erst laden" } });
    expect(stored).toMatchObject({ status: 422, data: { error: "Organisation: Auswahl bitte erst laden" } });
    expect(applied.map(v => v.FLOW_TOKEN)).toEqual([FLOW.otherToken]);
    expect((await envOf(s)).FLOW_TOKEN).toBe(FLOW.otherToken);

    // Neu geladen zum neuen Token: gilt wieder
    expect((await loadOrgs(s, cookie, {})).status).toBe(200);
    expect((await send("test", pick)).status).toBe(200);
    for (const text of [saved.text, tested.text, stored.text, s.logs.join("\n")]) {
      expect(text).not.toContain(FLOW.otherToken);
      noLeak(text);
    }
  });

  test("Schutzregeln: fremder Origin 403, Tunnel-Kopfzeilen 403, ohne Sitzung 401, unbekannter Ablauf 404", async () => {
    const { s, cookie, runId } = await blocked();
    const foreign = (path: string) =>
      fetch(`${s.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example", Cookie: cookie }, body: "{}" });
    expect((await foreign(`/api/setup/runs/${runId}/abbrechen`)).status).toBe(403);
    expect((await foreign(`/api/setup/steps/${FLOW_ID}/run`)).status).toBe(403);
    expect((await foreign(`/api/setup/steps/${FLOW_ID}/choices/FLOW_ORG`)).status).toBe(403);
    const tunnel = { "Cf-Connecting-Ip": "203.0.113.9", Cookie: cookie };
    expect((await fetch(`${s.base}/api/setup/runs/${runId}`, { headers: tunnel })).status).toBe(403);
    expect((await fetch(`${s.base}/api/setup/runs/${runId}/abbrechen`, { method: "POST", headers: { ...tunnel, Origin: s.origin } })).status).toBe(403);
    expect((await fetch(`${s.base}/api/setup/steps/${FLOW_ID}/choices/FLOW_ORG`, { method: "POST", headers: { ...tunnel, Origin: s.origin }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${s.base}/api/setup/steps/${FLOW_ID}/run`, { method: "POST", headers: { ...tunnel, Origin: s.origin }, body: "{}" })).status).toBe(403);
    expect((await get(s, `/api/setup/runs/${runId}`)).status).toBe(401);
    expect((await post(s, `/api/setup/runs/${runId}/abbrechen`, {})).status).toBe(401);
    expect((await post(s, `/api/setup/steps/${FLOW_ID}/choices/FLOW_ORG`, { values: {} })).status).toBe(401);
    expect((await get(s, "/api/setup/runs/unbekannt", cookie)).status).toBe(404);
    // Weiterhin läuft er
    expect((await body(await get(s, `/api/setup/runs/${runId}`, cookie))).data.state).toBe("laeuft");
    await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie);
    await untilDone(s, cookie, runId);
  });

  test("abbrechen während des Schreibens: das Schreiben läuft zu Ende, cancelRuns wartet darauf", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(r => (releaseWrite = r));
    let renaming = false;
    const { rename } = await import("node:fs/promises");
    const { s, cookie } = await start(
      {
        async run(values, c) {
          await writeEnv(c, [["FLOW_TOKEN", values.FLOW_TOKEN]]);
          // Hört danach nicht auf: cancelRuns läuft in die Frist
          return new Promise(() => {});
        },
      },
      {
        overrides: {
          sleep: async () => {},
          envIo: {
            async rename(from, to) {
              renaming = true;
              await writeGate;
              await rename(from, to);
            },
          },
        },
      },
    );
    await loadOrgs(s, cookie);
    const runId = (await startRun(s, cookie)).data.runId;
    await until(() => renaming);
    expect((await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie)).status).toBe(200);
    let cancelled: string | null = null;
    const cancelling = s.server.cancelRuns(30_000).then(r => (cancelled = r));
    await Bun.sleep(30);
    // Frist ist um (sleep sofort), aber das Schreiben ist noch nicht fertig
    expect(cancelled).toBeNull();
    releaseWrite();
    await cancelling;
    expect(cancelled).toBe("frist");
    expect((await envOf(s)).FLOW_TOKEN).toBe(FLOW.token);
  });

  test("cancelRuns: Abbruch mit Frist, frist wenn der Ablauf nicht aufhört", async () => {
    const { s } = await blocked();
    expect(s.server.runningStep()).toBe(FLOW_ID);
    expect(await s.server.cancelRuns(1_000)).toBe("beendet");
    expect(s.server.runningStep()).toBeNull();
    expect(await s.server.cancelRuns(1_000)).toBe("keiner");

    const stuck = await start({ run: () => new Promise(() => {}) }, { overrides: { sleep: async () => {} } });
    await loadOrgs(stuck.s, stuck.cookie);
    expect((await startRun(stuck.s, stuck.cookie)).status).toBe(202);
    expect(await stuck.s.server.cancelRuns(30_000)).toBe("frist");
  });
});

describe("Endzustände und Schwärzung", () => {
  test("Ausnahme im Ablauf: Zustand fehler, Meldung ohne Werte, Sperre frei", async () => {
    let calls = 0;
    const { s, cookie } = await start({
      async run(values) {
        calls++;
        throw new Error(`kaputt ${values.FLOW_PASSWORD}`);
      },
    });
    await loadOrgs(s, cookie);
    const first = await untilDone(s, cookie, (await startRun(s, cookie)).data.runId);
    expect(first.data).toMatchObject({ state: "fehler", result: { ok: false, message: "Der Ablauf ist mit einem internen Fehler stehen geblieben (Error)." } });
    noLeak(first.text);
    expect((await startRun(s, cookie)).status).toBe(202);
    await until(() => calls === 2);
  });

  test("Werte in Fortschritt und Meldung werden schon beim Speichern geschwärzt, auch kurze", async () => {
    const { s, cookie } = await start({
      async run(values, _ctx, report) {
        report({ at: 1, total: 1, label: `Passwort ${values.FLOW_PASSWORD}`, detail: `Token ${values.FLOW_TOKEN}` });
        report({ at: 1, total: 1, label: "Kurz", detail: values.FLOW_NAME });
        return { ok: true, message: `fertig mit ${encodeURIComponent(values.FLOW_PASSWORD)}`, changed: [] };
      },
    });
    await loadOrgs(s, cookie);
    const res = await startRun(s, cookie, { ...NEW_VALUES, FLOW_PASSWORD: `${FLOW.password} /x`, FLOW_NAME: "ab" });
    const done = await untilDone(s, cookie, res.data.runId);
    expect(done.data.events).toEqual([
      { at: 1, total: 1, label: "Passwort ***", detail: "Token ***" },
      { at: 1, total: 1, label: "Kurz", detail: "***" },
    ]);
    expect(done.data.result.message).toBe("fertig mit ***");
    noLeak(done.text);
  });

  test("geänderte Namen mit transientem Wert: geschwärzt in Ergebnis, Log und jeder späteren Abfrage", async () => {
    const transient = "transient-demo-4711";
    const { s, cookie } = await start({
      async run(values) {
        return { ok: true, message: `fertig ${values.FLOW_PASSWORD}`, changed: [`config/${values.FLOW_PASSWORD}.json`, `config/x${values.FLOW_NAME}x.json`, "FLOW_TOKEN"] };
      },
    });
    await loadOrgs(s, cookie);
    const res = await startRun(s, cookie, { ...NEW_VALUES, FLOW_PASSWORD: transient, FLOW_NAME: "q7" });
    const done = await untilDone(s, cookie, res.data.runId);
    expect(done.data.result).toEqual({ ok: true, message: "fertig ***", changed: ["config/***.json", REDACTED_NAME, "FLOW_TOKEN"] });
    const again = await body(await get(s, `/api/setup/runs/${res.data.runId}`, cookie));
    expect(again.text).toBe(done.text);
    for (const text of [done.text, again.text, s.logs.join("\n")]) {
      expect(text).not.toContain(transient);
      expect(text).not.toContain("q7");
      noLeak(text);
    }
    expect(s.logs).toContain(`Ablauf ${FLOW_ID} beendet: fertig (geändert: config/***.json, ${REDACTED_NAME}, FLOW_TOKEN)`);
  });

  test("Speichern im Felder-Modus: geänderte Namen mit transientem Wert geschwärzt in Antwort und Log", async () => {
    const transient = "transient-apply-4711";
    const { s, cookie } = await start({
      async apply(values) {
        return { ok: true, message: `gespeichert ${values.FLOW_PASSWORD}`, changed: [`config/${values.FLOW_PASSWORD}.json`, "FLOW_TOKEN"] };
      },
    });
    const res = await body(await post(s, `/api/setup/steps/${FLOW_ID}/apply`, { values: { FLOW_MODE: "vorhanden", FLOW_TOKEN: FLOW.token, FLOW_PASSWORD: transient } }, cookie));
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true, message: "gespeichert ***", changed: ["config/***.json", "FLOW_TOKEN"] });
    expect(s.logs).toContain(`Schritt ${FLOW_ID} gespeichert: config/***.json, FLOW_TOKEN`);
    for (const text of [res.text, s.logs.join("\n")]) {
      expect(text).not.toContain(transient);
      noLeak(text);
    }
  });

  test("Tokenwechsel im Ablauf: altes und neues Token geschwärzt in Fortschritt, Ergebnis, changed, späteren Abfragen und Log", async () => {
    const { s, cookie } = await start(
      {
        async run(_values, ctx, report) {
          // Gespeichertes Token, nicht neu eingegeben
          const old = (await envValues(ctx, ["FLOW_TOKEN"])).FLOW_TOKEN;
          report({ at: 1, total: 2, label: `Alt ${old}` });
          const written = await writeEnv(ctx, [["FLOW_TOKEN", FLOW.otherToken]]);
          report({ at: 2, total: 2, label: `Alt ${old}`, detail: `Neu ${FLOW.otherToken}` });
          return {
            ok: written.ok,
            message: `ersetzt ${old} durch ${FLOW.otherToken}`,
            changed: [...written.changed, `config/${old}.json`, `config/${FLOW.otherToken}.json`],
          };
        },
      },
      { env: `${FULL_ENV}FLOW_TOKEN=${FLOW.token}\n` },
    );
    await loadOrgs(s, cookie, {});
    const res = await startRun(s, cookie, { FLOW_MODE: "neu", FLOW_ORG: FLOW.org });
    expect(res.status).toBe(202);
    const done = await untilDone(s, cookie, res.data.runId);
    expect(done.data.events).toEqual([
      { at: 1, total: 2, label: "Alt ***" },
      { at: 2, total: 2, label: "Alt ***", detail: "Neu ***" },
    ]);
    expect(done.data.result).toEqual({ ok: true, message: "ersetzt *** durch ***", changed: ["FLOW_TOKEN", "config/***.json", "config/***.json"] });
    expect((await envOf(s)).FLOW_TOKEN).toBe(FLOW.otherToken);
    const again = await body(await get(s, `/api/setup/runs/${res.data.runId}`, cookie));
    expect(again.text).toBe(done.text);
    expect(s.logs).toContain(`Ablauf ${FLOW_ID} beendet: fertig (geändert: FLOW_TOKEN, config/***.json, config/***.json)`);
    for (const text of [done.text, again.text, s.logs.join("\n")]) {
      expect(text).not.toContain(FLOW.otherToken);
      noLeak(text);
    }
  });

  test("Ablauf will das transiente Feld schreiben: Fehler, .env unverändert", async () => {
    const { s, cookie } = await start({
      async run(values, ctx) {
        return writeEnv(ctx, [["FLOW_TOKEN", values.FLOW_TOKEN], ["FLOW_PASSWORD", values.FLOW_PASSWORD]]);
      },
    });
    const before = await readFile(s.ctx.envPath, "utf8");
    await loadOrgs(s, cookie);
    const done = await untilDone(s, cookie, (await startRun(s, cookie)).data.runId);
    expect(done.data.state).toBe("fehler");
    expect(done.data.result.message).toContain("gilt nur für diesen Lauf");
    expect(await readFile(s.ctx.envPath, "utf8")).toBe(before);
    noLeak(done.text);
  });

  test("nach „Fertig“ gelten Ablauf-Aufrufe nicht mehr", async () => {
    const { s, cookie } = await start();
    await loadOrgs(s, cookie);
    const runId = (await startRun(s, cookie)).data.runId;
    await untilDone(s, cookie, runId);
    expect((await post(s, "/api/setup/finish", {}, cookie)).status).toBe(200);
    expect((await startRun(s, cookie)).status).toBe(401);
    expect((await get(s, `/api/setup/runs/${runId}`, cookie)).status).toBe(401);
    expect((await loadOrgs(s, cookie)).status).toBe(401);
  });
});

describe("tybo setup --web und Strg+C", () => {
  test("bricht den laufenden Ablauf ab, wartet auf sein Ende, dann schließt der Server", async () => {
    const ctx = (await makeCtx({ env: FULL_ENV, profile: PROFILE, overrides: { sleep: sleepUntilAbort } })) as TestCtx;
    const step = makeFlowStep();
    const logs: string[] = [];
    let interrupt: () => void = () => {};
    let ready!: (info: { url: string; code: string }) => void;
    const readyP = new Promise<{ url: string; code: string }>(r => (ready = r));
    const done = runSetupMode({
      root: ctx.root,
      env: {},
      startMode: { mode: "setup", reason: "forced" } as any,
      supervisor: async () => null,
      ctx,
      code: CODE,
      port: 0,
      graceMs: 20,
      log: l => logs.push(l),
      onInterrupt: h => ((interrupt = h), () => {}),
      onReady: ready,
      steps: catalog(step),
    });
    const { url } = await readyP;
    const s = { base: url, origin: url } as Started;
    const cookie = await login(s);
    await loadOrgs(s, cookie);
    expect((await startRun(s, cookie)).status).toBe(202);
    await until(() => step.log.events.length >= 2);
    interrupt();
    expect(await done).toBe(130);
    expect(step.log.signals[0].aborted).toBe(true);
    expect(logs).toContain("Ein Ablauf läuft noch, breche ihn ab und warte höchstens 30 Sekunden …");
    expect(logs).toContain(`Ablauf ${FLOW_ID} beendet: abgebrochen`);
    expect(logs.join("\n")).not.toContain("nicht aufgehört");
    await expect(fetch(`${url}/code`)).rejects.toThrow();
    noLeak(logs.join("\n"));
  });
});
