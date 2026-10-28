/**
 * Issue #378: Abschnitt „Ports und Firewall“ in docs/troubleshooting.md.
 *
 * - Die Abhilfe „Bindung korrigieren“ wirkt auch dann, wenn der Prozess
 *   HEALTH_HOST, TELEGRAM_WEBHOOK_HOST und WEB_HOST mit 0.0.0.0 geerbt hat
 *   (etwa aus der Umgebung, die PM2 bei jedem Neustart und Deploy
 *   weitergibt). Nachgestellt mit Attrappen: geerbte Umgebung, eine .env in
 *   einem Temp-Ordner und der Startpfad bootBot mit dem echten loadEnv; kein
 *   Bot, kein Netz, src/bot.ts wird nie importiert.
 * - Nur die drei Zeilen zu löschen bindet weiter an 0.0.0.0; der Abschnitt
 *   darf das nicht als Abhilfe nennen.
 * - Der Neustart nennt die Prozessnamen aus dem Code: Setup
 *   (tybo-telegram-relay) und Deploy (Standard aus deploy.sh).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootBot } from "../src/app/bot-boot";
import { healthAddress } from "../src/app/health-server";
import { loadEnv } from "../src/lib/env";
import { resolveRuntimeProfile } from "../src/lib/runtime-profile";
import { BOT_SERVICE, pm2Name, systemdUnit } from "../src/lib/service-names";
import { loadWebConfig } from "../src/web/config";
import { snapshotEnv } from "./env-snapshot";

const ROOT = resolve(import.meta.dir, "..");
const DOC = readFileSync(join(ROOT, "docs/troubleshooting.md"), "utf8");
const SECTION = DOC.slice(DOC.indexOf("### Ports und Firewall"), DOC.indexOf("### SSH-Zugang zum Server verloren"));
const STEP_1 = SECTION.slice(SECTION.indexOf("1. **Bindung korrigieren.**"), SECTION.indexOf("2. **Neu starten**"));
const STEP_2 = SECTION.slice(SECTION.indexOf("2. **Neu starten**"), SECTION.indexOf("3. **Öffentliche Freigaben"));

const HOSTS = ["HEALTH_HOST", "TELEGRAM_WEBHOOK_HOST", "WEB_HOST"] as const;
/** Server-Profil und WebUI, damit alle drei Ports eine Bindung bekommen */
const SERVER_ENV = [
  "TYBO_PROFILE=server",
  "TELEGRAM_WEBHOOK_SECRET=webhook-secret-fuer-tests_0123456789",
  "WEB_ENABLED=true",
  "WEB_PASSWORD=ein-langes-test-passwort",
];

/** Die .env-Zeilen aus dem Befehlsblock von Schritt 1 */
function stepOneLines(): string[] {
  const block = STEP_1.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
  return block.split("\n").map(line => line.trim()).filter(Boolean);
}

let restore: (() => void) | null = null;
let dir: string | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Startet den Startpfad mit geerbtem 0.0.0.0 und der gegebenen .env; Rückgabe: die drei Bindungen */
async function bindingsAfterStart(envLines: string[]): Promise<Record<(typeof HOSTS)[number], string>> {
  restore = snapshotEnv();
  for (const name of HOSTS) process.env[name] = "0.0.0.0";
  dir = mkdtempSync(join(tmpdir(), "ports-firewall-"));
  writeFileSync(join(dir, ".env"), [...SERVER_ENV, ...envLines].join("\n") + "\n");

  const started = await bootBot({
    root: dir,
    env: process.env,
    loadEnv,
    logCapacity: () => {},
    logSubprocessEnv: () => {},
    logLegacyDatabase: () => {},
    chooseStartMode: () => ({ mode: "normal" }),
    runSetup: async () => 1,
    exit: () => {},
    log: () => {},
  });
  expect(started).toBe(true);

  const profile = resolveRuntimeProfile(process.env);
  if (!profile.ok || profile.profile.telegram.mode !== "webhook") throw new Error("Server-Profil erwartet");
  const web = loadWebConfig(process.env);
  if (web.status !== "ok") throw new Error("WebUI erwartet");
  return {
    HEALTH_HOST: healthAddress(process.env).hostname,
    TELEGRAM_WEBHOOK_HOST: profile.profile.telegram.webhook.hostname,
    WEB_HOST: web.config.host,
  };
}

describe("Ports und Firewall: Bindung korrigieren", () => {
  test("Schritt 1 setzt alle drei Werte ausdrücklich auf 127.0.0.1", () => {
    expect(stepOneLines()).toEqual(HOSTS.map(name => `${name}=127.0.0.1`));
  });

  test("mit den Zeilen aus Schritt 1 lauscht nach dem Start alles auf 127.0.0.1, trotz geerbtem 0.0.0.0", async () => {
    expect(await bindingsAfterStart(stepOneLines())).toEqual({
      HEALTH_HOST: "127.0.0.1",
      TELEGRAM_WEBHOOK_HOST: "127.0.0.1",
      WEB_HOST: "127.0.0.1",
    });
  });

  test("nur löschen reicht nicht: ohne die Zeilen bleibt das geerbte 0.0.0.0", async () => {
    expect(await bindingsAfterStart([])).toEqual({
      HEALTH_HOST: "0.0.0.0",
      TELEGRAM_WEBHOOK_HOST: "0.0.0.0",
      WEB_HOST: "0.0.0.0",
    });
    expect(STEP_1).toContain("nur zu löschen reicht nicht");
    expect(SECTION).not.toMatch(/löschen oder auf `127\.0\.0\.1` setzen/);
  });
});

describe("Ports und Firewall: Neustart des laufenden Prozesses", () => {
  const deployDefault = readFileSync(join(ROOT, "deploy.sh"), "utf8").match(/app="\$\{DEPLOY_APP:-([^}]+)\}"/)?.[1];

  test("deploy.sh hat einen Standardnamen", () => {
    expect(deployDefault).toBeTruthy();
  });

  test("Setup und Deploy stehen getrennt, mit den Namen aus dem Code", () => {
    expect(STEP_2).toContain(`systemctl --user restart ${systemdUnit(BOT_SERVICE)}   # Setup, Linux mit systemd`);
    expect(STEP_2).toContain(`pm2 restart ${pm2Name(BOT_SERVICE)}                # Setup mit PM2`);
    expect(STEP_2).toMatch(new RegExp(`pm2 restart ${deployDefault} +# Deploy; mit DEPLOY_APP dieser Name`));
  });

  test("die Tabelle nennt je Betrieb den Namen und wie man ihn prüft", () => {
    expect(SECTION).toContain(`| Setup (\`tybo setup autostart\`), Linux mit systemd | \`${systemdUnit(BOT_SERVICE)}\` |`);
    expect(SECTION).toContain(`| Setup (\`tybo setup autostart\`) mit PM2 | \`${pm2Name(BOT_SERVICE)}\` |`);
    expect(SECTION).toContain(`| Deploy (\`deploy.sh\`, auch über \`/deploy\`) | \`${deployDefault}\`, mit \`DEPLOY_APP\``);
  });
});
