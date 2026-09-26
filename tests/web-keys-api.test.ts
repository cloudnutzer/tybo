/**
 * Issue #62, Checkbox 3: Schlüssel-API über den echten Server mit
 * createBotKeys und einer .env im temporären Ordner (nie die echte .env).
 * Belegt die Schutzregeln aus SPEC.md: Anmeldung, Host/Origin, Opt-in,
 * gesperrte Namen, Namensprüfung, Werte nie in Antworten (außer den letzten
 * 4 Zeichen) und nie im Log.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBotKeys } from "../src/web/bot-keys";
import { KEYS_TEXT } from "../src/web/keys";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-keys-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

// Erfundene Werte, lang und eindeutig, damit sie nirgends zufällig vorkommen
const OLD_ANTHROPIC = "sk-ant-test-Keys-Api-alt-7Q2w";
const MAIN_TOKEN = "999888777:AAtest-hauptbot-Keys-Api-X1y2";
const WEB_PASSWORD = "test-web-passwort-Keys-Api-R5t6";
const NEW_VALUE = "sk-or-test-Keys-Api-neu-Z9u8";
const SHORT = "kurz-123";

function envContent(allowSwitch: boolean): string {
  return [
    "# tybo",
    "",
    "# --- Telegram ---",
    `TELEGRAM_BOT_TOKEN=${MAIN_TOKEN}`,
    "TELEGRAM_USER_ID=12345",
    "",
    "# --- LLM ---",
    `ANTHROPIC_API_KEY=${OLD_ANTHROPIC}`,
    `XAI_API_KEY=${SHORT}`,
    "",
    "# --- WebUI ---",
    "WEB_ENABLED=true",
    `WEB_PASSWORD=${WEB_PASSWORD}`,
    ...(allowSwitch ? ["WEB_ALLOW_KEY_EDIT=true"] : []),
    "lower_case=ignoriert",
    "EIGENER_WERT=eigener-wert-lang-1234",
    "",
  ].join("\n");
}

const SECRETS = [OLD_ANTHROPIC, MAIN_TOKEN, WEB_PASSWORD, NEW_VALUE, SHORT, "eigener-wert-lang-1234"];

let counter = 0;

/** Server mit eigener .env; atStart: WEB_ALLOW_KEY_EDIT beim Start, inFile: in der Datei */
async function setup(options: { atStart?: boolean; inFile?: boolean; io?: Parameters<typeof createBotKeys>[1]["io"] } = {}) {
  const atStart = options.atStart ?? true;
  const inFile = options.inFile ?? true;
  const dir = join(root, `case-${++counter}`);
  await mkdir(dir, { recursive: true });
  const envPath = join(dir, ".env");
  const content = envContent(inFile);
  await writeFile(envPath, content, { mode: 0o600 });
  // Laufender Prozess: Stand beim Start
  const running: Record<string, string> = {
    ANTHROPIC_API_KEY: OLD_ANTHROPIC,
    XAI_API_KEY: SHORT,
    ...(atStart ? { WEB_ALLOW_KEY_EDIT: "true" } : {}),
  };
  const keys = createBotKeys(running, { envPath, io: options.io });
  const ctx = await topicServer(root, servers, null, { keys });
  return { ...ctx, envPath, content, dir };
}

async function backupCount(dir: string): Promise<number> {
  return (await readdir(join(dir, "data", "backups")).catch(() => [])).length;
}

function expectNoSecrets(text: string, allowed: string[] = []) {
  for (const s of SECRETS) if (!allowed.includes(s)) expect(text).not.toContain(s);
}

describe("GET /api/keys", () => {
  test("ohne Anmeldung 401", async () => {
    const ctx = await setup();
    expect((await fetch(`${ctx.origin}/api/keys`)).status).toBe(401);
  });

  test("ohne Opt-in lesbar, aber nichts änderbar; nie Werte, nur letzte 4 Zeichen", async () => {
    const ctx = await setup({ atStart: false, inFile: false });
    const res = await ctx.api("/api/keys");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expectNoSecrets(raw);
    const body = JSON.parse(raw);
    expect(body.editAllowed).toBe(false);
    expect(body.keys.every((k: any) => k.editable === false)).toBe(true);
    const byName = Object.fromEntries(body.keys.map((k: any) => [k.name, k]));
    expect(byName.ANTHROPIC_API_KEY).toEqual({
      name: "ANTHROPIC_API_KEY",
      group: "LLM-Anbieter",
      description: expect.any(String),
      set: true,
      last4: OLD_ANTHROPIC.slice(-4),
      editable: false,
      locked: false,
      restartPending: false,
    });
    // Kurze Werte: keine letzten Zeichen
    expect(byName.XAI_API_KEY.set).toBe(true);
    expect(byName.XAI_API_KEY.last4).toBeNull();
    // Gesperrte: nur gesetzt, keine Zeichen
    expect(byName.TELEGRAM_BOT_TOKEN).toMatchObject({ set: true, last4: null, group: "Telegram" });
    expect(byName.WEB_PASSWORD).toMatchObject({ set: true, last4: null, group: "WebUI" });
    expect(byName.OPENAI_API_KEY).toMatchObject({ set: false, last4: null });
    // Unbekannte Variablen aus der .env unter „Weitere", ungültige Namen gar nicht
    expect(byName.EIGENER_WERT).toMatchObject({ group: "Weitere", set: true, last4: "1234", description: null });
    expect(byName.lower_case).toBeUndefined();
  });

  test("mit Opt-in: änderbar außer den gesperrten", async () => {
    const ctx = await setup();
    const body = await (await ctx.api("/api/keys")).json();
    expect(body.editAllowed).toBe(true);
    const byName = Object.fromEntries(body.keys.map((k: any) => [k.name, k]));
    expect(byName.ANTHROPIC_API_KEY.editable).toBe(true);
    expect(byName.TELEGRAM_BOT_TOKEN_RESEARCH.editable).toBe(true);
    for (const n of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID", "WEB_PASSWORD", "WEB_ALLOW_KEY_EDIT", "WEB_ENABLED"]) {
      expect(byName[n].editable).toBe(false);
      expect(byName[n].locked).toBe(true);
    }
    // Agentenbots sind nicht gesperrt (Issue #63 unterscheidet gesperrt und schreibgeschützt)
    expect(byName.TELEGRAM_BOT_TOKEN_RESEARCH.locked).toBe(false);
    expect(byName.ANTHROPIC_API_KEY.locked).toBe(false);
  });

  test("zeigt nach Setzen und Löschen den gespeicherten Stand und dass ein Neustart aussteht", async () => {
    const ctx = await setup();
    expect((await ctx.api("/api/keys/OPENROUTER_API_KEY", "PUT", { value: NEW_VALUE })).status).toBe(200);
    expect((await ctx.api("/api/keys/ANTHROPIC_API_KEY", "DELETE")).status).toBe(200);
    const body = await (await ctx.api("/api/keys")).json();
    const byName = Object.fromEntries(body.keys.map((k: any) => [k.name, k]));
    expect(byName.OPENROUTER_API_KEY).toMatchObject({ set: true, last4: NEW_VALUE.slice(-4), restartPending: true });
    expect(byName.ANTHROPIC_API_KEY).toMatchObject({ set: false, last4: null, restartPending: true });
    expect(byName.XAI_API_KEY.restartPending).toBe(false);
  });
});

describe("PUT und DELETE /api/keys/<name>", () => {
  test("Setzen: nur die Zeile ändert sich, Antwort nennt Neustart und nur die letzten 4 Zeichen, Log nur den Namen", async () => {
    const ctx = await setup();
    const res = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: `  ${NEW_VALUE}  ` });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expectNoSecrets(raw);
    expect(JSON.parse(raw)).toEqual({
      name: "ANTHROPIC_API_KEY",
      set: true,
      last4: NEW_VALUE.slice(-4),
      restartRequired: true,
      message: KEYS_TEXT.saved,
    });
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content.replace(OLD_ANTHROPIC, NEW_VALUE));
    expect(await backupCount(ctx.dir)).toBe(1);
    expect(ctx.logs.some(l => l.includes("ANTHROPIC_API_KEY") && l.includes("gesetzt"))).toBe(true);
    expectNoSecrets(ctx.logs.join("\n"));
  });

  test("neue Variable landet in ihrer Gruppe, unbekannte am Dateiende", async () => {
    const ctx = await setup();
    expect((await ctx.api("/api/keys/OPENAI_API_KEY", "PUT", { value: NEW_VALUE })).status).toBe(200);
    expect((await ctx.api("/api/keys/MEIN_NEUER_KEY", "PUT", { value: "wert mit # und leerzeichen" })).status).toBe(200);
    const content = await readFile(ctx.envPath, "utf8");
    expect(content).toContain(`XAI_API_KEY=${SHORT}\nOPENAI_API_KEY=${NEW_VALUE}\n`);
    expect(content.endsWith("EIGENER_WERT=eigener-wert-lang-1234\nMEIN_NEUER_KEY='wert mit # und leerzeichen'\n")).toBe(true);
  });

  test("Löschen: Zeile weg, sonst identisch; nicht gesetzt 404", async () => {
    const ctx = await setup();
    const res = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "DELETE");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expectNoSecrets(raw);
    expect(JSON.parse(raw)).toMatchObject({ name: "ANTHROPIC_API_KEY", set: false, restartRequired: true, message: KEYS_TEXT.removed });
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content.replace(`ANTHROPIC_API_KEY=${OLD_ANTHROPIC}\n`, ""));
    const again = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "DELETE");
    expect(again.status).toBe(404);
    expect(ctx.logs.some(l => l.includes("ANTHROPIC_API_KEY") && l.includes("gelöscht"))).toBe(true);
    expectNoSecrets(ctx.logs.join("\n"));
  });

  test.each([
    ["ohne Opt-in", { atStart: false, inFile: false }],
    ["nur in der Datei, nicht beim Start (wirkt erst nach Neustart)", { atStart: false, inFile: true }],
    ["nur beim Start, aus der Datei entfernt (aus wirkt sofort)", { atStart: true, inFile: false }],
  ])("%s: PUT und DELETE 403, Datei unverändert", async (_label, opts) => {
    const ctx = await setup(opts);
    const put = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: NEW_VALUE });
    expect(put.status).toBe(403);
    expect((await put.json()).error).toBe(KEYS_TEXT.readOnly);
    expect((await ctx.api("/api/keys/ANTHROPIC_API_KEY", "DELETE")).status).toBe(403);
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
    expect(await backupCount(ctx.dir)).toBe(0);
  });

  test.each(["WEB_PASSWORD", "WEB_ALLOW_KEY_EDIT", "WEB_ENABLED", "WEB_UNBEKANNT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"])(
    "%s ist gesperrt, mit und ohne Opt-in",
    async name => {
      for (const opts of [{}, { atStart: false, inFile: false }]) {
        const ctx = await setup(opts);
        const put = await ctx.api(`/api/keys/${name}`, "PUT", { value: NEW_VALUE });
        expect(put.status).toBe(403);
        expect((await put.json()).error).toBe(KEYS_TEXT.locked);
        expect((await ctx.api(`/api/keys/${name}`, "DELETE")).status).toBe(403);
        expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
      }
    }
  );

  test("ungültige Namen 400, auch kodierte oder verkleidete gesperrte Namen", async () => {
    const ctx = await setup();
    for (const name of ["web_password", "%57EB_PASSWORD", "WEB%5FPASSWORD", "A", "1ABC", "AB-C", "X_KEY%0AWEB_PASSWORD", "TELEGRAM_BOT_TOKEN%20", `A${"B".repeat(64)}`, "", "%C3%84_KEY"]) {
      const put = await ctx.api(`/api/keys/${name}`, "PUT", { value: NEW_VALUE });
      expect(put.status).toBe(400);
      expect((await put.json()).error).toBe(KEYS_TEXT.invalidName);
      expect((await ctx.api(`/api/keys/${name}`, "DELETE")).status).toBe(400);
    }
    // Tiefer verschachtelt: gar keine Schlüssel-Route
    expect((await ctx.api("/api/keys/A/B", "PUT", { value: NEW_VALUE })).status).toBe(404);
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
  });

  test("ungültige Anfragen 400, ohne den Wert zu nennen; Datei unverändert", async () => {
    const ctx = await setup();
    const bodies: unknown[] = [
      "kein json",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ value: 12345 }),
      JSON.stringify({ value: null }),
      JSON.stringify({ value: ["x"] }),
      JSON.stringify({ value: "" }),
      JSON.stringify({ value: "   " }),
      JSON.stringify({ value: `${NEW_VALUE}\nTELEGRAM_USER_ID=1` }),
      JSON.stringify({ value: `${NEW_VALUE}\rX` }),
      JSON.stringify({ value: `${NEW_VALUE}\u0000` }),
      JSON.stringify({ value: "x".repeat(9000) }),
    ];
    for (const body of bodies) {
      const res = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", body as string);
      expect(res.status).toBe(400);
      expectNoSecrets(await res.text());
    }
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
    expect(await backupCount(ctx.dir)).toBe(0);
    expectNoSecrets(ctx.logs.join("\n"));
  });

  test.each([
    ["LF vorn", `\n${NEW_VALUE}`],
    ["LF hinten", `${NEW_VALUE}\n`],
    ["CR vorn", `\r${NEW_VALUE}`],
    ["CR hinten", `${NEW_VALUE}\r`],
    ["CRLF vorn", `\r\n${NEW_VALUE}`],
    ["CRLF hinten", `${NEW_VALUE}\r\n`],
  ])("Zeilenumbruch am Rand (%s): 400, Datei unverändert, keine Sicherung, kein Wert", async (_, value) => {
    const ctx = await setup();
    const res = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value });
    expect(res.status).toBe(400);
    expectNoSecrets(await res.text());
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
    expect(await backupCount(ctx.dir)).toBe(0);
    expectNoSecrets(ctx.logs.join("\n"));
  });

  test("Schreibfehler: 500 ohne Wert in Antwort und Log, Datei unverändert", async () => {
    const ctx = await setup({ io: { rename: async () => { throw new Error(`kaputt ${NEW_VALUE}`); } } });
    const res = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: NEW_VALUE });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expectNoSecrets(raw);
    expect(JSON.parse(raw).error).toBe(KEYS_TEXT.notSaved);
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
    expectNoSecrets(ctx.logs.join("\n"));
    expect(ctx.logs.some(l => l.includes("ANTHROPIC_API_KEY nicht gespeichert"))).toBe(true);
  });

  test("Origin: fremd oder fehlend 403, Datei unverändert", async () => {
    const ctx = await setup();
    const foreign = await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: NEW_VALUE }, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    const none = await fetch(`${ctx.origin}/api/keys/ANTHROPIC_API_KEY`, {
      method: "DELETE",
      headers: { cookie: ctx.cookie },
    });
    expect(none.status).toBe(403);
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
  });

  test("Host: fremder Host-Header 421", async () => {
    const ctx = await setup();
    const port = new URL(ctx.origin).port;
    const res = await ctx.api("/api/keys", "GET", undefined, { host: `evil.example:${port}` });
    expect(res.status).toBe(421);
  });

  test("ohne Anmeldung 401, auch für PUT und DELETE", async () => {
    const ctx = await setup();
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetch(`${ctx.origin}/api/keys/ANTHROPIC_API_KEY`, {
        method,
        headers: { origin: ctx.origin, "content-type": "application/json" },
        body: JSON.stringify({ value: NEW_VALUE }),
      });
      expect(res.status).toBe(401);
    }
    expect(await readFile(ctx.envPath, "utf8")).toBe(ctx.content);
  });

  test("falsche Methoden 405", async () => {
    const ctx = await setup();
    expect((await ctx.api("/api/keys", "POST", {})).status).toBe(405);
    expect((await ctx.api("/api/keys/ANTHROPIC_API_KEY")).status).toBe(405);
    expect((await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PATCH", { value: "x" })).status).toBe(405);
  });

  test("ohne KeysPort 503", async () => {
    const ctx = await topicServer(root, servers, null, {});
    expect((await ctx.api("/api/keys")).status).toBe(503);
    expect((await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: NEW_VALUE })).status).toBe(503);
  });

  test("Werte bis vier Zeichen erscheinen nie, auch nicht direkt nach dem Setzen", async () => {
    const ctx = await setup();
    const res = await ctx.api("/api/keys/NOTION_DATABASE_ID", "PUT", { value: "abcd" });
    expect(await res.json()).toMatchObject({ set: true, last4: null });
    const list = await (await ctx.api("/api/keys")).json();
    expect(list.keys.find((k: any) => k.name === "NOTION_DATABASE_ID")).toMatchObject({ set: true, last4: null });
  });

  test("GET /api/status liefert weiterhin nur gesetzt/fehlt (unverändert)", async () => {
    const { createDemoStatus } = await import("../src/web/demo");
    const ctx = await topicServer(root, servers, null, { status: createDemoStatus() });
    const body = await (await ctx.api("/api/status")).json();
    for (const k of body.keys) expect(Object.keys(k).sort()).toEqual(["group", "name", "set"]);
  });

  test("Sicherung liegt neben der .env in data/backups, Rechte 0600", async () => {
    const ctx = await setup();
    await ctx.api("/api/keys/ANTHROPIC_API_KEY", "PUT", { value: NEW_VALUE });
    const dir = join(dirname(ctx.envPath), "data", "backups");
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^env-\d{4}-\d{2}-\d{2}T/);
    expect((await Bun.file(join(dir, files[0])).stat()).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, files[0]), "utf8")).toBe(ctx.content);
  });
});
