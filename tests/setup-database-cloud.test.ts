/**
 * Issue #163, Checkbox 3: Schritt „datenbank“ mit dem Weg „Supabase in der
 * Cloud“. Auswahl, Felder, Weg vs. Laufzeit-Datenbank, Gesamtprüfung ohne
 * Token; dazu der ganze Weg im Terminal (`tybo setup datenbank`) und im
 * Einrichtungsmodus des Browsers, jeweils gegen die Attrappe der
 * Management-API. Das Zugangstoken darf nirgends auftauchen.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import { fieldDefinitionProblems, isTransientName, runsAsFlow } from "../src/setup/model";
import { checkStep, existingFieldValues } from "../src/setup/steps";
import { writeEnv } from "../src/setup/steps/common";
import { activeBackend, DATABASE_FIELDS, databaseStep, setupPath } from "../src/setup/steps/database";
import { SUPABASE_REGIONS } from "../src/setup/supabase-cloud";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";
import { fakeSupabaseApi, SB, type FakeApi, type FakeState } from "./supabase-api-fixture";
import { CTRL_C, runWith, scripted } from "./setup-terminal-fixture";
import { get, login, post, PROFILE, startSetup, type Started, type TestCtx } from "./setup-web-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
const CLOUD_URL = `https://${SB.ref}.supabase.co`;

async function cloudCtx(options: { env?: string; state?: Partial<FakeState>; overrides?: Partial<SetupContext> } = {}) {
  const api = fakeSupabaseApi(options.state);
  const ctx = (await makeCtx({ env: options.env ?? BASE_ENV, profile: PROFILE, overrides: { fetch: api.fetch, ...options.overrides } })) as TestCtx;
  await cp(join(REPO, "db"), join(ctx.root, "db"), { recursive: true });
  return { ctx, api };
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

const sleepUntilAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>(res => {
    if (signal?.aborted) return res();
    signal?.addEventListener("abort", () => res(), { once: true });
  });

describe("Felder und Auswahl", () => {
  test("Reihenfolge, Standard supabase-cloud, lokal an zweiter Stelle (#164), Convex ohne „empfohlen“", () => {
    const backend = DATABASE_FIELDS.find(f => f.name === "DB_BACKEND")!;
    expect(backend.default).toBe("supabase-cloud");
    expect(backend.choices!.map(c => c.value)).toEqual(["supabase-cloud", "supabase-lokal", "supabase", "convex"]);
    expect(backend.choices!.map(c => c.label)).toEqual([
      "Supabase in der Cloud, der Assistent richtet alles ein (Standard)",
      "Supabase auf diesem Rechner, in Docker, der Assistent richtet alles ein",
      "Supabase, Zugangsdaten selbst eintragen (vorhandenes Projekt)",
      "Convex (für Fortgeschrittene, eigener Token-Aussteller nötig)",
    ]);
    expect(JSON.stringify(DATABASE_FIELDS)).not.toContain("empfohlen");
    expect(fieldDefinitionProblems(DATABASE_FIELDS)).toEqual([]);
  });

  test("Cloud-Felder: Token transient und geheim, Organisation vom Anbieter, Name und Region mit Standard", () => {
    const f = (n: string) => DATABASE_FIELDS.find(x => x.name === n)!;
    const cloud = { DB_BACKEND: "supabase-cloud" };
    const token = f("SUPABASE_SETUP_TOKEN");
    expect(token.kind).toBe("secret");
    expect(token.transient).toBe(true);
    expect(token.link).toBe("https://supabase.com/dashboard/account/tokens");
    expect(token.help).toContain("Ablaufdatum setzen, nach der Einrichtung darfst du es löschen");
    expect(token.validate!("abc", cloud)).toContain("sbp_");
    expect(token.validate!(SB.token, cloud)).toBeNull();
    expect(typeof f("SUPABASE_ORG").choicesFrom).toBe("function");
    expect(f("SUPABASE_PROJECT_NAME").default).toBe("tybo");
    expect(f("SUPABASE_REGION").default).toBe("eu-central-1");
    for (const name of ["SUPABASE_SETUP_TOKEN", "SUPABASE_ORG", "SUPABASE_PROJECT_NAME", "SUPABASE_REGION"]) {
      expect(f(name).visible!(cloud)).toBe(true);
      expect(f(name).visible!({ DB_BACKEND: "supabase" })).toBe(false);
    }
    // writeEnv weist das Token ab
    expect(isTransientName("SUPABASE_SETUP_TOKEN")).toBe(true);
  });

  test("Regionen: EU zuerst, sonst genau die Aufzählung der OpenAPI (eingecheckte Kopie)", async () => {
    const openapi = JSON.parse(await readFile(join(REPO, "tests", "fixtures", "supabase-regions.json"), "utf8"));
    const values = SUPABASE_REGIONS.map(r => r.value);
    expect(values.slice(0, 6)).toEqual(["eu-central-1", "eu-central-2", "eu-west-1", "eu-west-3", "eu-north-1", "eu-west-2"]);
    expect([...values].sort()).toEqual([...openapi.enum].sort());
    const rest = openapi.enum.filter((r: string) => !r.startsWith("eu-"));
    expect(values.slice(6)).toEqual(rest);
    expect(SUPABASE_REGIONS[0].label).toContain("Frankfurt");
  });

  test("runWhen und Plan: nur Cloud ist ein Ablauf; Wechsel von Convex im Plan", () => {
    expect(runsAsFlow(databaseStep, { DB_BACKEND: "supabase-cloud" })).toBe(true);
    expect(runsAsFlow(databaseStep, { DB_BACKEND: "supabase" })).toBe(false);
    expect(runsAsFlow(databaseStep, { DB_BACKEND: "convex" })).toBe(false);
    expect(databaseStep.plan!({ DB_BACKEND: "supabase-cloud" }).join(" ")).not.toContain("CONVEX_URL");
    expect(databaseStep.plan!({ DB_BACKEND: "supabase-cloud", CONVEX_URL: FAKE.convexUrl }).join(" ")).toContain("CONVEX_URL");
    const convex = DATABASE_FIELDS.find(f => f.name === "DB_SWITCH_CONFIRM")!;
    expect(convex.visible!({ DB_BACKEND: "supabase-cloud", CONVEX_URL: FAKE.convexUrl })).toBe(true);
  });
});

describe("Weg und Laufzeit getrennt", () => {
  test("setupPath: *.supabase.co ist Cloud, andere Adresse selbst eingetragen; activeBackend bleibt convex/supabase", () => {
    expect(setupPath({ SUPABASE_URL: CLOUD_URL })).toBe("supabase-cloud");
    expect(setupPath({ SUPABASE_URL: "https://db.example.org" })).toBe("supabase");
    expect(setupPath({ SUPABASE_URL: CLOUD_URL, CONVEX_URL: FAKE.convexUrl })).toBe("convex");
    expect(setupPath({})).toBeNull();
    expect(activeBackend({ SUPABASE_URL: CLOUD_URL })).toBe("supabase");
  });

  test("existingFieldValues und Status nach dem Weg", async () => {
    const cloud = await makeCtx({ env: `SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n` });
    expect((await existingFieldValues(databaseStep, cloud)).DB_BACKEND).toBe("supabase-cloud");
    expect((await databaseStep.status(cloud)).detail).toBe("Supabase in der Cloud ist eingerichtet.");
    const own = await makeCtx({ env: `SUPABASE_URL=https://db.example.org\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n` });
    expect((await existingFieldValues(databaseStep, own)).DB_BACKEND).toBe("supabase");
    expect((await databaseStep.status(own)).detail).toBe("Supabase ist eingerichtet.");
    const half = await makeCtx({ env: `SUPABASE_URL=${CLOUD_URL}\n` });
    expect((await databaseStep.status(half)).state).toBe("teilweise");
  });

  test("Gesamtprüfung nach der Cloud-Einrichtung braucht kein Zugangstoken", async () => {
    const ctx = await makeCtx({ env: `SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n` });
    expect(await databaseStep.test!({}, ctx)).toEqual({ ok: true, message: "Supabase erreichbar." });
    expect(ctx.providers.calls).toEqual([{ method: "supabaseQuery", args: [CLOUD_URL, SB.secret] }]);
    const check = await checkStep.test!({}, ctx);
    expect(check.items!.find(i => i.label === "Datenbank")).toEqual({ label: "Datenbank", ok: true, detail: "Supabase erreichbar." });
  });

  test("Speichern ist beim Cloud-Weg gesperrt, der Ablauf schreibt; das Token nie", async () => {
    const ctx = await makeCtx({ env: BASE_ENV });
    const r = await databaseStep.apply!({ DB_BACKEND: "supabase-cloud", SUPABASE_SETUP_TOKEN: SB.token }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(SB.token);
    const w = await writeEnv(ctx, [["SUPABASE_SETUP_TOKEN", SB.token]]);
    expect(w.ok).toBe(false);
    expect(await envText(ctx)).toBe(BASE_ENV);
  });
});

describe("Terminal: tybo setup datenbank", () => {
  const ARGS = { mode: "step", step: "datenbank" } as const;

  test("Standard per Enter, eine Organisation vorausgewählt, Plan, Ablauf, .env; Token nirgends", async () => {
    const { ctx, api } = await cloudCtx();
    // Datenbank (Enter = Standard), Token, Organisation (Enter = einzige), Name (Enter), Region (Enter), Jetzt ausführen (Enter)
    const prompter = scripted(["", SB.token, "", "", "", ""]);
    const r = await runWith(ARGS, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual([
      "Datenbank [Supabase in der Cloud, der Assistent richtet alles ein (Standard)]: ",
      "Supabase-Zugangstoken: ",
      "Supabase-Organisation [Alpha]: ",
      "Projektname bei Supabase [tybo]: ",
      "Region [Frankfurt (eu-central-1)]: ",
      "Jetzt ausführen? [J/n] ",
    ]);
    expect(prompter.asked[1].secret).toBe(true);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("[4/9] Warte, bis das Projekt bereit ist");
    expect(r.out).toContain("Supabase-Projekt angelegt und eingerichtet.");
    const env = await envText(ctx);
    expect(env).toContain(`SUPABASE_URL=${CLOUD_URL}`);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.secret}`);
    expect(api.trail()).toContain("POST /v1/projects");
    expect(r.out).not.toContain(SB.token);
    expect(r.out).not.toContain(SB.secret);
    expect((await allFiles(ctx.root)).includes(SB.token)).toBe(false);
  });

  test("Fehler 401 beim Ablauf: klare Meldung, kein Token in der Ausgabe", async () => {
    const { ctx, api } = await cloudCtx();
    let n = 0;
    // Auswahl lädt noch, beim Ablauf ist das Token inzwischen widerrufen
    api.hooks.push(r => (r.path === "/v1/organizations" && ++n > 1 ? new Response(`{"message":"bad ${SB.token}"}`, { status: 401 }) : undefined));
    const r = await runWith(ARGS, ctx, scripted(["1", SB.token, "1", "", "", "", "ü"]));
    expect(r.out).toContain("Supabase lehnt das Zugangstoken ab");
    expect(r.out).not.toContain(SB.token);
    expect(await envText(ctx)).toBe(BASE_ENV);
    expect((await allFiles(ctx.root)).includes(SB.token)).toBe(false);
  });

  test("Strg+C beim Warten: Ablauf endet, .env unverändert, Hinweis auf den zweiten Lauf", async () => {
    let interrupt: () => void = () => {};
    let waits = 0;
    const { ctx } = await cloudCtx({
      overrides: {
        sleep: async (ms, signal) => {
          if (++waits === 1) setTimeout(() => interrupt(), 0);
          return sleepUntilAbort(ms, signal);
        },
      },
    });
    const r = await runWith(ARGS, ctx, scripted(["", SB.token, "", "", "", ""]), {
      onInterrupt(handler) {
        interrupt = handler;
        return () => {};
      },
    });
    expect(r.code).toBe(130);
    expect(r.out).toContain("Abgebrochen. Das Projekt bei Supabase bleibt bestehen, die .env ist unverändert.");
    expect(r.out).toContain("setup datenbank");
    expect(await envText(ctx)).toBe(BASE_ENV);
    expect(r.out).not.toContain(SB.token);
  });

  test("„Zugangsdaten selbst eintragen“ verhält sich wie bisher", async () => {
    const { ctx, api } = await cloudCtx();
    const r = await runWith(ARGS, ctx, scripted(["3", "https://db.example.org", FAKE.serviceKey, "", ""]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verbindungstest: bestanden.");
    expect(api.calls).toEqual([]);
    expect(await envText(ctx)).toContain("SUPABASE_URL=https://db.example.org");
  });
});

describe("Browser: Einrichtungsmodus", () => {
  async function open(options: { state?: Partial<FakeState>; overrides?: Partial<SetupContext> } = {}) {
    const { ctx, api } = await cloudCtx(options);
    const s = await startSetup({ ctx });
    running.push(s);
    return { s, api, cookie: await login(s) };
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

  const VALUES = { DB_BACKEND: "supabase-cloud", SUPABASE_SETUP_TOKEN: SB.token };

  test("Modus Ablauf, Organisationen laden, Einrichten; Token in keiner Antwort, keinem Log, keiner Datei", async () => {
    const { s, api, cookie } = await open();
    const texts: string[] = [];
    const view = await json(await post(s, "/api/setup/steps/datenbank/view", { values: { DB_BACKEND: "supabase-cloud" }, present: ["SUPABASE_SETUP_TOKEN"] }, cookie));
    texts.push(view.text);
    expect(view.data.mode).toBe("ablauf");
    expect(view.data.plan.join(" ")).toContain("nirgends gespeichert");
    const orgs = await json(await post(s, "/api/setup/steps/datenbank/choices/SUPABASE_ORG", { values: VALUES }, cookie));
    texts.push(orgs.text);
    expect(orgs.data.choices).toEqual([{ value: "org-alpha", label: "Alpha" }]);
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: { ...VALUES, SUPABASE_ORG: "org-alpha" } }, cookie));
    expect(started.status).toBe(202);
    const done = await untilDone(s, cookie, started.data.runId);
    texts.push(done.text);
    expect(done.data.state).toBe("fertig");
    expect(done.data.result.changed.sort()).toEqual(["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    expect(await envText(s.ctx)).toContain(`SUPABASE_URL=${CLOUD_URL}`);
    expect(api.trail()).toContain("POST /v1/projects");
    const step = await json(await get(s, "/api/setup/steps/datenbank", cookie));
    texts.push(step.text);
    for (const t of [...texts, s.logs.join("\n"), await allFiles(s.ctx.root)]) expect(t.includes(SB.token)).toBe(false);
  });

  test("Fehler im Ablauf (401): Meldung ohne Token, .env unverändert", async () => {
    const { s, api, cookie } = await open();
    await post(s, "/api/setup/steps/datenbank/choices/SUPABASE_ORG", { values: VALUES }, cookie);
    api.hooks.push(r => (r.path === "/v1/organizations" ? new Response(`{"message":"${SB.token}"}`, { status: 401 }) : undefined));
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: { ...VALUES, SUPABASE_ORG: "org-alpha" } }, cookie));
    const done = await untilDone(s, cookie, started.data.runId);
    expect(done.data.state).toBe("fehler");
    expect(done.data.result.message).toContain("lehnt das Zugangstoken ab");
    expect(done.text.includes(SB.token)).toBe(false);
    expect(s.logs.join("\n").includes(SB.token)).toBe(false);
    expect(await envText(s.ctx)).toBe(BASE_ENV);
    expect((await allFiles(s.ctx.root)).includes(SB.token)).toBe(false);
  });

  test("„Abbrechen“ beim Warten: Ablauf endet, .env unverändert", async () => {
    const { s, cookie } = await open({ overrides: { sleep: sleepUntilAbort } });
    await post(s, "/api/setup/steps/datenbank/choices/SUPABASE_ORG", { values: VALUES }, cookie);
    const started = await json(await post(s, "/api/setup/steps/datenbank/run", { values: { ...VALUES, SUPABASE_ORG: "org-alpha" } }, cookie));
    const runId = started.data.runId;
    for (let i = 0; i < 400; i++) {
      const res = await json(await get(s, `/api/setup/runs/${runId}`, cookie));
      if (res.data.events?.some((e: any) => e.at === 4)) break;
      await Bun.sleep(5);
    }
    expect((await post(s, `/api/setup/runs/${runId}/abbrechen`, {}, cookie)).status).toBe(200);
    const done = await untilDone(s, cookie, runId);
    expect(done.data.state).toBe("abgebrochen");
    expect(done.data.result.message).toContain("setup datenbank");
    expect(await envText(s.ctx)).toBe(BASE_ENV);
    expect(done.text.includes(SB.token)).toBe(false);
  });

  test("Ablauf ohne geladene Organisationen wird abgelehnt", async () => {
    const { s, api, cookie } = await open();
    const res = await json(await post(s, "/api/setup/steps/datenbank/run", { values: { ...VALUES, SUPABASE_ORG: "org-alpha" } }, cookie));
    expect(res.status).toBe(422);
    expect(api.calls).toEqual([]);
  });
});

// Terminal: Strg+C an einer Eingabe (nicht beim Warten) schreibt ebenfalls nichts
test("Strg+C bei der Eingabe: nichts angefragt, nichts geschrieben", async () => {
  const { ctx, api } = await cloudCtx();
  const r = await runWith({ mode: "step", step: "datenbank" }, ctx, scripted(["", SB.token, CTRL_C]));
  expect(r.code).toBe(130);
  expect(api.trail()).toEqual(["GET /v1/organizations", "GET /v1/organizations/org-alpha"]);
  expect(await envText(ctx)).toBe(BASE_ENV);
});
