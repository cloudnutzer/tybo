/**
 * Issue #164, Checkbox 3 und 4: Schritt „datenbank“ mit dem Weg „Supabase
 * auf diesem Rechner“. Auswahl, Adressregel (http:// nur zu diesem Rechner,
 * nur für Supabase), Wiedererkennen, Status, Gesamtprüfung, gesperrtes
 * Speichern; dazu der ganze Weg im Terminal (`tybo setup datenbank`) und im
 * Einrichtungsmodus des Browsers, mit Abbruch und Wiederaufnahme. docker,
 * die Supabase-CLI und Postgres sind Attrappen (tests/local-supabase-fixture.ts).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import { AUSGELASSEN, LOCAL_SUPABASE_URL, SUPABASE_CLI_VERSION } from "../src/setup/local-supabase";
import { runsAsFlow } from "../src/setup/model";
import { checkStep, existingFieldValues } from "../src/setup/steps";
import { DATABASE_FIELDS, databaseStep, isLocalSupabaseUrl, setupPath, supabaseUrlRule } from "../src/setup/steps/database";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";
import { fakeLocal, LOCAL, LOCAL_SECRETS, type FakeLocal } from "./local-supabase-fixture";
import { CTRL_C, runWith, scripted } from "./setup-terminal-fixture";
import { get, login, post, PROFILE, startSetup, type Started, type TestCtx } from "./setup-web-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
const LOCAL_ENV = `${BASE_ENV}SUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}\n`;

async function localCtx(options: { env?: string; f?: FakeLocal; overrides?: Partial<SetupContext> } = {}) {
  const f = options.f ?? fakeLocal();
  const ctx = (await makeCtx({ env: options.env ?? BASE_ENV, profile: PROFILE, overrides: { run: f.run as any, localSupabase: f.deps, ...options.overrides } })) as TestCtx;
  await cp(join(REPO, "db"), join(ctx.root, "db"), { recursive: true });
  return { ctx, f };
}

async function allFiles(dir: string): Promise<string> {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out += await allFiles(p);
    else if ((await stat(p)).size < 5_000_000) out += await readFile(p, "utf8");
  }
  return out;
}

const envText = (ctx: SetupContext) => readFile(ctx.envPath, "utf8").catch(() => "");

/** Keine Schlüssel und keine DB_URL in einem Text (die .env selbst ausgenommen) */
function noLocalSecrets(text: string) {
  for (const secret of LOCAL_SECRETS) expect(text.includes(secret)).toBe(false);
  expect(text).not.toContain("postgresql://");
}

const hangUntilAbort = (_cmd: string[], options: { signal?: AbortSignal }) =>
  new Promise<{ code: number; aborted: boolean }>(res => {
    if (options.signal?.aborted) return res({ code: -1, aborted: true });
    options.signal?.addEventListener("abort", () => res({ code: -1, aborted: true }), { once: true });
  });

describe("Felder, Adressregel, Weg", () => {
  test("lokal an zweiter Stelle, ohne eigene Pflichtfelder, als Ablauf", () => {
    const backend = DATABASE_FIELDS.find(f => f.name === "DB_BACKEND")!;
    expect(backend.choices![1]).toEqual({ value: "supabase-lokal", label: "Supabase auf diesem Rechner, in Docker, der Assistent richtet alles ein" });
    const lokal = { DB_BACKEND: "supabase-lokal" };
    expect(DATABASE_FIELDS.filter(f => f.name !== "DB_BACKEND" && f.visible?.(lokal)).map(f => f.name)).toEqual([]);
    expect(runsAsFlow(databaseStep, lokal)).toBe(true);
    expect(runsAsFlow(databaseStep, { DB_BACKEND: "supabase" })).toBe(false);
    const plan = databaseStep.plan!(lokal).join(" ");
    expect(plan).toContain("Docker");
    expect(plan).toContain(`${SUPABASE_CLI_VERSION}`);
    expect(plan).toContain("Installiert wird nichts");
    expect(plan).not.toContain("CONVEX_URL");
    expect(databaseStep.plan!({ ...lokal, CONVEX_URL: FAKE.convexUrl }).join(" ")).toContain("CONVEX_URL");
    // Wechsel von Convex fragt auch beim lokalen Weg
    const confirm = DATABASE_FIELDS.find(f => f.name === "DB_SWITCH_CONFIRM")!;
    expect(confirm.visible!({ ...lokal, CONVEX_URL: FAKE.convexUrl })).toBe(true);
  });

  test("http:// nur für 127.0.0.1 und localhost, sonst https://; Convex bleibt bei https://", () => {
    const rule = supabaseUrlRule("Supabase-Adresse");
    for (const ok of ["https://abc.supabase.co", "https://db.example.org", "http://127.0.0.1:54421", "http://localhost:54321", "http://localhost", "http://127.0.0.1:8000/"]) {
      expect(rule(ok)).toBeNull();
    }
    for (const bad of ["http://192.168.1.20:54421", "http://db.example.org", "http://localhost.example.com", "http://127.0.0.1@example.com", "http://127.0.0.1.example.com", "ftp://127.0.0.1", "127.0.0.1:54421"]) {
      expect(rule(bad)).toContain("https://");
    }
    const supabaseUrl = DATABASE_FIELDS.find(f => f.name === "SUPABASE_URL")!;
    expect(supabaseUrl.validate!("http://127.0.0.1:54421", { DB_BACKEND: "supabase" })).toBeNull();
    expect(supabaseUrl.validate!("http://10.0.0.1:54421", { DB_BACKEND: "supabase" })).toContain("https://");
    const convexUrl = DATABASE_FIELDS.find(f => f.name === "CONVEX_URL")!;
    expect(convexUrl.validate!("http://127.0.0.1:3210", { DB_BACKEND: "convex" })).toContain("https://");
  });

  test("setupPath: genau die lokale Adresse ist lokal, ein eigener Server auf 127.0.0.1 bleibt „selbst eintragen“", () => {
    expect(setupPath({ SUPABASE_URL: LOCAL_SUPABASE_URL })).toBe("supabase-lokal");
    expect(setupPath({ SUPABASE_URL: "http://localhost:54421" })).toBe("supabase-lokal");
    expect(setupPath({ SUPABASE_URL: "http://127.0.0.1:54321" })).toBe("supabase");
    expect(setupPath({ SUPABASE_URL: LOCAL_SUPABASE_URL, CONVEX_URL: FAKE.convexUrl })).toBe("convex");
    expect(isLocalSupabaseUrl("https://127.0.0.1:54421")).toBe(false);
  });

  test("selbst eingetragener Server auf localhost lässt sich speichern (Zugangsdaten selbst eintragen)", async () => {
    const { ctx, f } = await localCtx();
    const r = await databaseStep.apply!({ DB_BACKEND: "supabase", SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey }, ctx);
    expect(r.ok).toBe(true);
    expect(await envText(ctx)).toContain("SUPABASE_URL=http://127.0.0.1:54321");
    expect(f.run.calls).toEqual([]);
    const lan = await databaseStep.apply!({ DB_BACKEND: "supabase", SUPABASE_URL: "http://192.168.1.20:54321", SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey }, ctx);
    expect(lan.ok).toBe(false);
  });
});

describe("Status, Gesamtprüfung, Speichern", () => {
  test("Wiederaufruf erkennt den lokalen Weg; Status läuft bzw. antwortet nicht (mit Startbefehl)", async () => {
    const { ctx } = await localCtx({ env: LOCAL_ENV });
    expect((await existingFieldValues(databaseStep, ctx)).DB_BACKEND).toBe("supabase-lokal");
    const up = await databaseStep.status(ctx);
    expect(up.state).toBe("erledigt");
    expect(up.detail).toBe("Supabase läuft lokal auf diesem Rechner.");
    ctx.providers.results.supabaseQuery = { ok: false, message: "Supabase nicht erreichbar." };
    const down = await databaseStep.status(ctx);
    expect(down.state).toBe("teilweise");
    expect(down.detail).toBe(`Supabase auf diesem Rechner ist eingetragen, antwortet aber nicht: bunx --bun supabase@${SUPABASE_CLI_VERSION} start --workdir ${ctx.root} -x ${AUSGELASSEN}`);
    noLocalSecrets(JSON.stringify([up, down]));
  });

  test("Gesamtprüfung nutzt die gespeicherten Werte; ohne Einrichtung klare Meldung", async () => {
    const { ctx } = await localCtx({ env: LOCAL_ENV });
    expect(await databaseStep.test!({}, ctx)).toEqual({ ok: true, message: "Supabase erreichbar." });
    expect(ctx.providers.calls.at(-1)).toEqual({ method: "supabaseQuery", args: [LOCAL_SUPABASE_URL, LOCAL.secret] });
    const check = await checkStep.test!({}, ctx);
    expect(check.items!.find(i => i.label === "Datenbank")!.ok).toBe(true);
    const empty = await localCtx();
    const r = await databaseStep.test!({ DB_BACKEND: "supabase-lokal" }, empty.ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Supabase auf diesem Rechner ist noch nicht eingerichtet");
  });

  test("Speichern ist beim lokalen Weg gesperrt", async () => {
    const { ctx, f } = await localCtx();
    const r = await databaseStep.apply!({ DB_BACKEND: "supabase-lokal" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("richtet der Ablauf ein");
    expect(await envText(ctx)).toBe(BASE_ENV);
    expect(f.run.calls).toEqual([]);
  });
});

describe("Terminal: tybo setup datenbank", () => {
  const ARGS = { mode: "step", step: "datenbank" } as const;

  test("Auswahl 2, Plan, Ablauf, .env; keine Schlüssel in der Ausgabe", async () => {
    const { ctx, f } = await localCtx();
    const prompter = scripted(["2", ""]);
    const r = await runWith(ARGS, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual(["Datenbank [Supabase in der Cloud, der Assistent richtet alles ein (Standard)]: ", "Jetzt ausführen? [J/n] "]);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("[2/7] Lade und starte Supabase (beim ersten Mal einige Minuten)");
    expect(r.out).toContain("Supabase läuft auf diesem Rechner und ist eingerichtet.");
    expect(f.trail()).toContain("supabase start");
    const env = await envText(ctx);
    expect(env).toContain(`SUPABASE_URL=${LOCAL_SUPABASE_URL}`);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}`);
    noLocalSecrets(r.out);
  });

  test("Docker fehlt: Erklärung, nichts gestartet, nichts geschrieben", async () => {
    const { ctx, f } = await localCtx({ f: fakeLocal({ "docker --version": { code: -1 } }) });
    const r = await runWith(ARGS, ctx, scripted(["2", ""]));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Docker fehlt");
    expect(f.trail()).toEqual(["docker --version"]);
    expect(await envText(ctx)).toBe(BASE_ENV);
  });

  test("Strg+C beim Start: Abbruch reicht bis zum Befehl, .env unverändert; der nächste Lauf macht weiter", async () => {
    let interrupt: () => void = () => {};
    const f = fakeLocal({
      "supabase start": (cmd, options) => {
        setTimeout(() => interrupt(), 0);
        return hangUntilAbort(cmd, options);
      },
    });
    // Schonfrist mit echter Zeit: nach dem Abbruch prüft der Ablauf noch, was schon läuft
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>(res => {
        const t = setTimeout(res, Math.min(ms, 500));
        signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
      });
    const { ctx } = await localCtx({ f, overrides: { sleep } });
    const r = await runWith(ARGS, ctx, scripted(["2", ""]), {
      onInterrupt(handler) {
        interrupt = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(r.out).toContain("Abgebrochen.");
    expect(await envText(ctx)).toBe(BASE_ENV);
    // Wiederaufnahme: derselbe Befehl, diesmal ohne Abbruch
    f.answers["supabase start"] = { stdout: "Started" };
    const again = await runWith(ARGS, ctx, scripted(["2", ""]));
    expect(again.code).toBe(0);
    expect(await envText(ctx)).toContain(`SUPABASE_URL=${LOCAL_SUPABASE_URL}`);
  });

  test("zweiter Lauf: Stand zeigt den lokalen Weg, dieselben Befehle, .env unverändert", async () => {
    const { ctx, f } = await localCtx();
    expect((await runWith(ARGS, ctx, scripted(["2", ""]))).code).toBe(0);
    const env = await envText(ctx);
    const firstTrail = f.trail();
    f.run.calls.length = 0;
    f.onQuery = text => (text.includes("storage.buckets") ? [{ public: false }] : []);
    const r = await runWith(ARGS, ctx, scripted(["2", ""]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Stand: Supabase läuft lokal auf diesem Rechner.");
    expect(f.trail()).toEqual(firstTrail);
    expect(r.out).toContain("alles war schon eingerichtet");
    expect(await envText(ctx)).toBe(env);
  });

  test("Wechsel von Convex: Bestätigung wird gefragt, Nein startet nichts", async () => {
    const env = `${BASE_ENV}CONVEX_URL=${FAKE.convexUrl}\nCONVEX_AUTH_TOKEN=${FAKE.convexToken}\n`;
    const { ctx, f } = await localCtx({ env });
    const r = await runWith(ARGS, ctx, scripted(["2", "n", CTRL_C]));
    expect(r.code).not.toBe(0);
    expect(f.run.calls).toEqual([]);
    expect(await envText(ctx)).toBe(env);
    const ok = await runWith(ARGS, ctx, scripted(["2", "j", ""]));
    expect(ok.code).toBe(0);
    expect(await envText(ctx)).not.toContain("CONVEX_URL=");
  });
});

describe("Browser: Einrichtungsmodus", () => {
  async function open(options: { f?: FakeLocal } = {}) {
    const { ctx, f } = await localCtx(options);
    const s = await startSetup({ ctx });
    running.push(s);
    return { s, f, cookie: await login(s) };
  }

  async function json(res: Response) {
    const text = await res.text();
    return { status: res.status, text, data: JSON.parse(text) };
  }

  async function untilDone(s: Started, cookie: string, runId: string) {
    for (let i = 0; i < 400; i++) {
      const res = await json(await get(s, `/api/setup/runs/${runId}`, cookie));
      if (res.data.state !== "laeuft") return res;
      await Bun.sleep(5);
    }
    throw new Error("Ablauf endet nicht");
  }

  const VALUES = { DB_BACKEND: "supabase-lokal" };

  test("Modus Ablauf, Einrichten; keine Schlüssel in Antworten, Log oder Dateien außer der .env", async () => {
    const { s, f, cookie } = await open();
    const texts: string[] = [];
    const view = await json(await post(s, "/api/setup/steps/datenbank/view", { values: VALUES, present: [] }, cookie));
    texts.push(view.text);
    expect(view.data.mode).toBe("ablauf");
    expect(view.data.plan.join(" ")).toContain("Docker");
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: VALUES }, cookie));
    expect(started.status).toBe(202);
    const done = await untilDone(s, cookie, started.data.runId);
    texts.push(done.text);
    expect(done.data.state).toBe("fertig");
    expect(done.data.result.changed.sort()).toEqual(["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    expect(f.trail()).toContain("supabase start");
    expect(await envText(s.ctx)).toContain(`SUPABASE_URL=${LOCAL_SUPABASE_URL}`);
    const step = await json(await get(s, "/api/setup/steps/datenbank", cookie));
    texts.push(step.text);
    for (const t of [...texts, s.logs.join("\n")]) noLocalSecrets(t);
    // Außerhalb der .env und ihrer Sicherungen steht kein Schlüssel
    const env = await envText(s.ctx);
    const others = (await allFiles(s.ctx.root)).split(env).join("");
    expect(others.includes(LOCAL.dbPassword)).toBe(false);
  });

  test("„Abbrechen“ beim Start: Signal erreicht den Befehl, .env unverändert; erneutes Einrichten macht weiter", async () => {
    const f = fakeLocal({ "supabase start": hangUntilAbort });
    const { s, cookie } = await open({ f });
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: VALUES }, cookie));
    const runId = started.data.runId;
    for (let i = 0; i < 400; i++) {
      const res = await json(await get(s, `/api/setup/runs/${runId}`, cookie));
      if (res.data.events?.some((e: any) => e.at === 2)) break;
      await Bun.sleep(5);
    }
    expect((await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie)).status).toBe(200);
    const done = await untilDone(s, cookie, runId);
    expect(done.data.state).toBe("abgebrochen");
    expect(f.run.calls.find(c => c.cmd.includes("start"))!.options.signal!.aborted).toBe(true);
    expect(await envText(s.ctx)).toBe(BASE_ENV);
    f.answers["supabase start"] = { stdout: "Started" };
    const again = await json(await post(s, "/api/setup/steps/datenbank/run", { values: VALUES }, cookie));
    const second = await untilDone(s, cookie, again.data.runId);
    expect(second.data.state).toBe("fertig");
  });

  test("Fehler (Docker läuft nicht): Meldung, .env unverändert", async () => {
    const { s, cookie } = await open({ f: fakeLocal({ "docker info": { code: 1, stderr: "Cannot connect" } }) });
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: VALUES }, cookie));
    const done = await untilDone(s, cookie, started.data.runId);
    expect(done.data.state).toBe("fehler");
    expect(done.data.result.message).toContain("Docker läuft nicht");
    expect(await envText(s.ctx)).toBe(BASE_ENV);
  });
});
