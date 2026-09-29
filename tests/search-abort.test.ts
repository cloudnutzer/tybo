/**
 * Issue #166, Prüfrunden 1 und 3: Strg+C, während der Nachweis der
 * semantischen Suche seine Probe schon gespeichert hat. Der echte
 * CLI-Prozess (main() mit process.exit) muss den Abbruch an den Nachweis
 * weiterreichen, darf erst enden, wenn das Löschen der Probe fertig ist, und
 * muss vorher melden, wenn es gescheitert ist (samt „tybo setup suche“).
 * Abbruchwege: Gesamtprüfung (`tybo setup pruefung`), Ablauf `tybo setup
 * suche` innerhalb und nach der Schonfrist, Browser-Einrichtungsmodus
 * (`tybo setup --web`) innerhalb und nach der Schonfrist.
 * Kindprozess: tests/search-abort-child.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeRecord } from "../src/setup/search-record";
import { FAKE } from "./setup-fixture";
import { CODE } from "./setup-web-fixture";

const CHILD = resolve(import.meta.dir, "search-abort-child.ts");
const URL = "https://db.example.org";
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const LEFT = "Achtung: Die Probe der semantischen Suche ließ sich nicht löschen";
const NOT_DELETED = "Die Probe ließ sich nicht löschen";
const RETRY = "tybo setup suche";

/** Im Browser anmelden und den Ablauf „Semantische Suche“ starten */
async function runInBrowser(root: string) {
  let url = "";
  for (let i = 0; i < 400 && !url; i++) {
    url = await readFile(join(root, "url.txt"), "utf8").catch(() => "");
    if (!url) await Bun.sleep(25);
  }
  const post = (path: string, body: unknown, cookie = "") =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  const login = await post("/api/setup/code", { code: CODE });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const run = await post("/api/setup/steps/suche/run", { values: {} }, cookie);
  expect(run.status).toBe(202);
}

/**
 * Startet den Kindprozess, ruft beforeRun auf, sendet Strg+C, sobald
 * search-memory läuft (die Probe ist gespeichert), und wartet auf das Ende.
 */
async function abortChild(args: string[], childEnv: Record<string, string>, beforeRun: (root: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "tybo-search-abort-"));
  dirs.push(root);
  const env = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\nSUPABASE_URL=${URL}\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_testschluessel_nur_fuer_tests\nOPENAI_API_KEY=sk-test-openai-schluessel-geheim-4242\n`;
  await writeFile(join(root, ".env"), env, { mode: 0o600 });
  // Die Suche war nachgewiesen aktiv, die Gesamtprüfung wiederholt den Nachweis
  await writeRecord({ root, now: () => new Date() }, URL, "aktiv");

  const proc = Bun.spawn([process.execPath, "--no-env-file", CHILD, root, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), NO_COLOR: "1", ...childEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout as ReadableStream).text();
  await beforeRun(root);
  const trailText = () => readFile(join(root, "trail.log"), "utf8").catch(() => "");

  let sent = false;
  for (let i = 0; i < 400 && !sent; i++) {
    if ((await trailText()).includes(" search\n")) {
      proc.kill("SIGINT");
      sent = true;
    } else await Bun.sleep(25);
  }
  const code = await proc.exited;
  const events = (await trailText())
    .trim()
    .split("\n")
    .map(l => l.slice(l.indexOf(" ") + 1));
  const at = (e: string) => events.indexOf(e);
  return { sent, code, events, at, out: await stdout, stderr: await new Response(proc.stderr as ReadableStream).text() };
}

/** Abbruch erreicht die Probe; das Löschen beginnt danach und endet vor dem Prozessende */
function expectCleanupBeforeExit(r: Awaited<ReturnType<typeof abortChild>>) {
  expect(r.sent).toBe(true);
  expect(r.code).toBe(130);
  expect(r.events).toContain("search-abgebrochen");
  expect(r.at("delete-probe-anfang")).toBeGreaterThan(r.at("search-abgebrochen"));
  expect(r.at("delete-probe-ende")).toBeGreaterThan(r.at("delete-probe-anfang"));
  expect(r.events[r.events.length - 1]).toBe("exit 130");
  expect(r.at("delete-probe-ende")).toBeLessThan(r.at("exit 130"));
}

describe("tybo setup pruefung", () => {
  test("Strg+C während des Nachweises: Abbruch erreicht die Probe, das Löschen läuft vor dem Prozessende zu Ende", async () => {
    const r = await abortChild(["setup", "pruefung"], { CHILD_DELETE_MS: "400" });
    expectCleanupBeforeExit(r);
    expect(r.out).toContain("räume vorher die Probe der semantischen Suche auf");
    expect(r.out).toContain("Abgebrochen");
    expect(r.out).not.toContain(LEFT);
  }, 30_000);

  test("Löschen scheitert: Warnung über die verbliebene Probe und Wiederholungshinweis vor dem Prozessende", async () => {
    const r = await abortChild(["setup", "pruefung"], { CHILD_DELETE_MS: "400", CHILD_DELETE_FAIL: "1" });
    expectCleanupBeforeExit(r);
    const warning = r.out.indexOf(LEFT);
    expect(warning).toBeGreaterThan(-1);
    expect(r.out.slice(warning)).toContain(RETRY);
    // Vor der Abschlusszeile des Abbruchs
    expect(warning).toBeLessThan(r.out.lastIndexOf("Abgebrochen"));
  }, 30_000);
});

describe("tybo setup suche: Strg+C während des Nachweises im Ablauf", () => {
  test("Löschen dauert länger als die Schonfrist und scheitert: Warnung samt Wiederholungshinweis", async () => {
    const r = await abortChild(["setup", "suche"], { CHILD_DELETE_MS: "1500", CHILD_GRACE_MS: "300", CHILD_DELETE_FAIL: "1" });
    expectCleanupBeforeExit(r);
    expect(r.out).toContain("nach 0.3 Sekunden noch nicht aufgehört");
    expect(r.out).toContain("ohne dass der Ablauf aufgehört hat");
    const warning = r.out.indexOf(LEFT);
    expect(warning).toBeGreaterThan(r.out.indexOf("nach 0.3 Sekunden"));
    expect(r.out.slice(warning)).toContain(RETRY);
  }, 30_000);

  test("Löschen dauert länger als die Schonfrist und gelingt: keine Warnung", async () => {
    const r = await abortChild(["setup", "suche"], { CHILD_DELETE_MS: "1500", CHILD_GRACE_MS: "300" });
    expectCleanupBeforeExit(r);
    expect(r.out).toContain("räume vorher die Probe der semantischen Suche auf");
    expect(r.out).not.toContain(LEFT);
    expect(r.out).not.toContain(NOT_DELETED);
  }, 30_000);

  test("innerhalb der Schonfrist, Löschen scheitert: das Ergebnis des Ablaufs nennt es samt Wiederholungshinweis", async () => {
    const r = await abortChild(["setup", "suche"], { CHILD_DELETE_MS: "200", CHILD_DELETE_FAIL: "1" });
    expectCleanupBeforeExit(r);
    const line = r.out.indexOf(NOT_DELETED);
    expect(line).toBeGreaterThan(-1);
    expect(r.out.slice(line)).toContain(RETRY);
  }, 30_000);
});

describe("tybo setup --web: Strg+C während des Nachweises im Ablauf", () => {
  for (const [what, extra] of [
    ["nach der Schonfrist", { CHILD_DELETE_MS: "1500", CHILD_GRACE_MS: "300" }],
    ["innerhalb der Schonfrist", { CHILD_DELETE_MS: "200" }],
  ] as const) {
    test(`${what}, Löschen scheitert: Warnung samt Wiederholungshinweis im Terminal vor dem Prozessende`, async () => {
      const r = await abortChild(["setup", "--web"], { ...extra, CHILD_DELETE_FAIL: "1" }, runInBrowser);
      expectCleanupBeforeExit(r);
      const warning = r.out.indexOf(LEFT);
      expect(warning).toBeGreaterThan(-1);
      expect(r.out.slice(warning)).toContain(RETRY);
      expect(warning).toBeLessThan(r.out.indexOf("Einrichtung ohne Abschluss beendet"));
    }, 30_000);

    test(`${what}, Löschen gelingt: keine Warnung`, async () => {
      const r = await abortChild(["setup", "--web"], extra, runInBrowser);
      expectCleanupBeforeExit(r);
      expect(r.out).not.toContain(LEFT);
      expect(r.out).toContain("Einrichtung ohne Abschluss beendet");
    }, 30_000);
  }
});
