/**
 * Issue #164, Prüfrunde 2 und 3: Strg+C während „Supabase auf diesem Rechner“
 * startet, im Terminal (`tybo setup datenbank`) und im Browser-
 * Einrichtungsmodus (`tybo setup --web`). Der echte CLI-Prozess (main() mit
 * process.exit) darf erst enden, wenn der Schutz-Stopp nachgeprüft ist, und
 * muss dessen Ausgang vorher ins Terminal schreiben; ein gescheiterter Stopp
 * erscheint als Warnung mit Befehl zum Anhalten. Kindprozess:
 * tests/local-supabase-abort-child.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guardText, stopHint } from "../src/setup/local-supabase";
import { FAKE } from "./setup-fixture";
import { CODE } from "./setup-web-fixture";

const CHILD = resolve(import.meta.dir, "local-supabase-abort-child.ts");
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PENDING = "Achtung: Noch nicht bestätigt, dass Supabase nur auf diesem Rechner erreichbar ist.";
/** Prüfung, Stopp, Nachprüfung, erst dann Prozessende */
const FULL_GUARD = ["start", "ps-anfang", "ps-ende", "stop-anfang", "stop-ende", "ps-anfang", "ps-ende", "exit 130"];

/**
 * Startet den Kindprozess, ruft beforeStart auf (etwa Anmeldung und Start im
 * Browser), sendet Strg+C, sobald supabase start läuft, und wartet auf das Ende.
 */
async function abortChild(args: string[], childEnv: Record<string, string>, beforeStart: (root: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "tybo-abort-"));
  dirs.push(root);
  const env = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
  await writeFile(join(root, ".env"), env, { mode: 0o600 });

  const proc = Bun.spawn([process.execPath, "--no-env-file", CHILD, root, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), NO_COLOR: "1", ...childEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout as ReadableStream).text();
  await beforeStart(root);

  // Strg+C, sobald supabase start läuft
  const trailText = () => readFile(join(root, "trail.log"), "utf8").catch(() => "");
  let sent = false;
  for (let i = 0; i < 400 && !sent; i++) {
    if ((await trailText()).includes(" start\n")) {
      proc.kill("SIGINT");
      sent = true;
    } else await Bun.sleep(25);
  }
  const code = await proc.exited;
  const events = (await trailText())
    .trim()
    .split("\n")
    .map(l => l.slice(l.indexOf(" ") + 1));
  return {
    root,
    sent,
    code,
    events,
    out: await stdout,
    stderr: await new Response(proc.stderr as ReadableStream).text(),
    envUnchanged: (await readFile(join(root, ".env"), "utf8")) === env,
  };
}

/** Im Browser anmelden und „Supabase auf diesem Rechner“ starten */
async function startInBrowser(root: string) {
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
  const run = await post("/api/setup/steps/datenbank/run", { values: { DB_BACKEND: "supabase-lokal" } }, cookie);
  expect(run.status).toBe(202);
}

test("Strg+C beim Start, docker ps und Schutz-Stopp länger als die Schonfrist: Warnung mit Stoppbefehl, Prozess endet erst nach dem nachgeprüften Stopp", async () => {
  const { root, sent, code, events, out, stderr, envUnchanged } = await abortChild(["setup", "datenbank"], {});
  expect(sent).toBe(true);
  expect(stderr).toBe("");
  expect(code).toBe(130);

  // Reihenfolge der Attrappen: Prüfung, Stopp, Nachprüfung, erst dann Prozessende
  expect(events).toEqual(FULL_GUARD);

  // Warnung samt Stoppbefehl, solange der sichere Zustand unbestätigt war
  const warning = out.indexOf(PENDING);
  expect(warning).toBeGreaterThan(-1);
  expect(out).toContain(stopHint(root));
  expect(out).toContain("nach 0.5 Sekunden noch nicht aufgehört");
  // Danach das Ergebnis des Schutz-Stopps, kein Ende ohne Ergebnis
  const stopped = out.indexOf("der Assistent hat sie wieder gestoppt");
  expect(stopped).toBeGreaterThan(warning);
  expect(out).not.toContain("Die Einrichtung endet trotzdem");
  expect(out).not.toContain("ohne dass der Ablauf aufgehört hat");
  expect(envUnchanged).toBe(true);
}, 30_000);

describe("tybo setup --web: Strg+C während des Starts, Schutz-Stopp scheitert", () => {
  const failed = (root: string) => guardText({ state: "stopp-gescheitert" }, root);

  for (const [stop, what] of [
    ["fehler", "supabase stop scheitert"],
    ["bleibt", "Nachprüfung zeigt weiter Container"],
  ] as const) {
    test(`außerhalb der Schonfrist, ${what}: erst Warnung, dann Ausgang mit Stoppbefehl im Terminal, dann Prozessende`, async () => {
      const r = await abortChild(["setup", "--web"], { CHILD_STOP: stop }, startInBrowser);
      expect(r.sent).toBe(true);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(130);
      expect(r.events).toEqual(FULL_GUARD);
      expect(r.out).toContain("nach 0.5 Sekunden noch nicht aufgehört");
      const pending = r.out.indexOf(PENDING);
      const alert = r.out.indexOf(failed(r.root));
      const end = r.out.indexOf("Einrichtung ohne Abschluss beendet");
      expect(pending).toBeGreaterThan(-1);
      expect(alert).toBeGreaterThan(pending);
      expect(end).toBeGreaterThan(alert);
      expect(r.out).toContain(stopHint(r.root));
      // Kein Satz, der einen sicheren Zustand bestätigt
      expect(r.out).not.toContain("Die Prüfung ist fertig");
      expect(r.envUnchanged).toBe(true);
    }, 30_000);

    test(`innerhalb der Schonfrist, ${what}: Ausgang mit Stoppbefehl im Terminal vor Prozessende`, async () => {
      const r = await abortChild(["setup", "--web"], { CHILD_SLOW: "0", CHILD_STOP: stop }, startInBrowser);
      expect(r.sent).toBe(true);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(130);
      expect(r.events).toEqual(FULL_GUARD);
      expect(r.out).not.toContain("noch nicht aufgehört");
      const alert = r.out.indexOf(failed(r.root));
      expect(alert).toBeGreaterThan(-1);
      expect(r.out.indexOf("Einrichtung ohne Abschluss beendet")).toBeGreaterThan(alert);
      expect(r.out).not.toContain("Die Prüfung ist fertig");
      expect(r.envUnchanged).toBe(true);
    }, 30_000);
  }

  test("außerhalb der Schonfrist, Stopp gelingt: Ausgang des Stopps, dann „Die Prüfung ist fertig“", async () => {
    const r = await abortChild(["setup", "--web"], {}, startInBrowser);
    expect(r.code).toBe(130);
    expect(r.events).toEqual(FULL_GUARD);
    const stopped = r.out.indexOf("der Assistent hat sie wieder gestoppt");
    expect(stopped).toBeGreaterThan(r.out.indexOf(PENDING));
    expect(r.out.indexOf("Die Prüfung ist fertig.")).toBeGreaterThan(stopped);
    expect(r.out).not.toContain(failed(r.root));
  }, 30_000);
});
