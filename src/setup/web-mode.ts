/**
 * Einrichtungsmodus (Issue #66, Entscheidung 0011): Lebenszyklus rund um den
 * Server aus ./web-server.ts.
 *
 * Wer startet ihn:
 * - src/bot.ts, wenn TELEGRAM_BOT_TOKEN oder TELEGRAM_USER_ID fehlt
 *   (./start-mode.ts), vor jeder Bot-Initialisierung: kein Telegram-Polling,
 *   keine Claude-Aufrufe, kein bot.lock.
 * - `tybo setup --web` (scripts/tybo.ts), bewusst auch bei vollständiger .env.
 *
 * Ablauf: Einmal-Code erzeugen, Server auf 127.0.0.1 und WEB_PORT (Standard
 * 3100) starten, Adresse und Code ins Terminal bzw. Log schreiben, dann auf
 * „Fertig“ oder Strg+C warten. Nach „Fertig“ schließt erst der Server (damit
 * der Port für die WebUI des Bots frei ist), dann:
 * - restart: der Prozess läuft unter launchd oder PM2; er endet, der
 *   Supervisor startet ihn neu, und diesmal startet der Bot normal. Ein
 *   Neustart-Marker (data/restart-requested) genügt hier nicht: den liest
 *   nur der laufende Bot.
 * - autostart: ohne Supervisor, aber gewünscht: jetzt erst richtet
 *   autostartStep den Dienst ein, der den Bot sofort startet.
 * - manual: der Startbefehl steht im Terminal bzw. Log.
 * Der Rückgabewert ist der Exit-Code; beenden muss der Aufrufer.
 *
 * Strg+C während eines Ablaufs (Issue #161): erst dessen signal auslösen und
 * höchstens 30 Sekunden auf sein Ende warten, ein angefangenes Schreiben der
 * .env läuft immer zu Ende; danach schließt der Server. Hört der Ablauf nicht
 * auf, steht das im Terminal, und die Einrichtung endet trotzdem. Auf
 * Schutzschritte (Portprüfung, Schutz-Stopp) wartet sie auch danach; deren
 * Ausgang steht vor dem Ende im Terminal, eine Warnung samt Stoppbefehl
 * eingeschlossen.
 *
 * Über den Cloudflare Tunnel ist der Einrichtungsmodus nie erreichbar (Issue
 * #99): der Server lehnt Anfragen mit Tunnel-Kopfzeilen selbst ab, unabhängig
 * von WEB_PUBLIC_ORIGIN. Deshalb wird hier nichts davon übergeben.
 */

import { BRAND } from "../brand";
import type { Supervisor } from "../lib/restart-request";
import { DEFAULT_WEB_PORT } from "../web/config";
import { createSetupContext, type SetupContext } from "./context";
import type { StartMode } from "./start-mode";
import { autostartStep } from "./steps/autostart";
import { pendingSafetyWarnings, takeSafetyOutcomes, waitForSafetyWork } from "./steps/common";
import { createSetupServer, formatSetupCode, generateSetupCode, type FinishPlan, type SetupServerOptions } from "./web-server";

type Env = Record<string, string | undefined>;

/** Exit-Code nach Strg+C, wie in tybo setup */
export const EXIT_INTERRUPTED = 130;

export interface SetupModeOptions {
  root: string;
  /** Umgebung für WEB_PORT */
  env: Env;
  startMode: Extract<StartMode, { mode: "setup" }>;
  supervisor(): Promise<Supervisor | null>;
  log?(line: string): void;
  /** Nur für Tests: Kontext mit Attrappen, fester Code, Port 0 */
  ctx?: SetupContext;
  code?: string;
  port?: number;
  /** Strg+C und Beenden; gibt die Abmeldung zurück. Standard: SIGINT und SIGTERM */
  onInterrupt?(handler: () => void): () => void;
  /** Zeit für die Antwort auf „Fertig“, bevor der Server schließt */
  graceMs?: number;
  /** Nur für Tests: Schonfrist nach Strg+C (Standard: RUN_GRACE_MS) */
  runGraceMs?: number;
  /** Nur für Tests: Server gestartet (Adresse, Code) */
  onReady?(info: { url: string; code: string }): void;
  /** Nur für Tests: eigener Schrittkatalog */
  steps?: SetupServerOptions["steps"];
}

/** So lange wartet der Einrichtungsmodus nach Strg+C auf das Ende eines Ablaufs */
export const RUN_GRACE_MS = 30_000;

/** WEB_PORT, wenn gültig; sonst 3100 mit Hinweis */
export function setupPort(env: Env): { port: number; note?: string } {
  const raw = (env.WEB_PORT ?? "").trim();
  if (!raw) return { port: DEFAULT_WEB_PORT };
  if (/^\d{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535) return { port: Number(raw) };
  return { port: DEFAULT_WEB_PORT, note: `WEB_PORT ist kein gültiger Port, der Einrichtungsmodus nutzt ${DEFAULT_WEB_PORT}` };
}

/** Für sh/zsh/bash: in einfache Anführungszeichen, ' als '\'' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Startbefehl ohne Supervisor, wie `tybo` ihn nennt; Pfad für die Shell quotiert */
export function startCommandFor(root: string): string {
  return `cd ${shellQuote(root)} && bun run start`;
}

function defaultInterrupt(handler: () => void): () => void {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function reasonLine(startMode: SetupModeOptions["startMode"]): string {
  if (startMode.reason === "forced") return `${BRAND.name} setup --web: Einrichtung im Browser.`;
  return `Einrichtungsmodus: in der .env fehlt ${startMode.missing.join(" und ")}. ${BRAND.name} startet deshalb nur den Assistenten, ohne Telegram.`;
}

export async function runSetupMode(options: SetupModeOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(`[setup] ${line}`));
  const ctx = options.ctx ?? createSetupContext({ root: options.root });
  const { port, note } = setupPort(options.env);
  if (note) log(note);
  const code = options.code ?? generateSetupCode();
  // Ausgänge aus früheren Einrichtungen in diesem Prozess gehören nicht hierher
  takeSafetyOutcomes();
  const startCommand = startCommandFor(options.root);

  let server;
  try {
    server = await createSetupServer({
      ctx,
      code,
      port: options.port ?? port,
      supervisor: options.supervisor,
      startCommand,
      log,
      steps: options.steps,
    });
  } catch (e) {
    const reason = (e as NodeJS.ErrnoException)?.code === "EADDRINUSE" ? "der Port ist belegt" : e instanceof Error ? e.name : "unbekannter Fehler";
    log(`Einrichtungsmodus startet nicht auf 127.0.0.1:${options.port ?? port}: ${reason}. Läuft schon ein ${BRAND.name}? Sonst WEB_PORT in der .env ändern.`);
    return 1;
  }

  log(reasonLine(options.startMode));
  log(`Im Browser auf diesem Rechner öffnen: ${server.url}`);
  log(`Einmal-Code: ${formatSetupCode(code)}  (gilt bis „Fertig“)`);
  options.onReady?.({ url: server.url, code });

  let off: () => void = () => {};
  const interrupted = new Promise<"interrupted">(resolve => {
    off = (options.onInterrupt ?? defaultInterrupt)(() => resolve("interrupted"));
  });
  const outcome: FinishPlan | "interrupted" = await Promise.race([server.finished, interrupted]);
  off();

  if (outcome === "interrupted") {
    const runGraceMs = options.runGraceMs ?? RUN_GRACE_MS;
    // Warnungen früherer Abläufe gelten weiter; ihre übrigen Ausgänge standen schon im Browser
    const earlier = takeSafetyOutcomes().filter(o => o.alert);
    if (server.runningStep()) log(`Ein Ablauf läuft noch, breche ihn ab und warte höchstens ${runGraceMs / 1000} Sekunden …`);
    const result = await server.cancelRuns(runGraceMs);
    let waited = false;
    if (result === "frist") {
      log(`Der Ablauf hat nach ${runGraceMs / 1000} Sekunden noch nicht aufgehört.`);
      // Schutzschritte (Portprüfung, Schutz-Stopp) nie abschneiden: erst warnen, dann abwarten
      const warnings = pendingSafetyWarnings();
      if (warnings.length) {
        for (const w of warnings) log(w);
        log("Warte, bis diese Prüfung fertig ist …");
        await waitForSafetyWork();
        waited = true;
      }
    }
    // Ausgang der Schutzschritte hier ausgeben: das Ergebnis des Ablaufs ruft kein Browser mehr ab
    const outcomes = [...earlier, ...takeSafetyOutcomes()];
    for (const text of new Set(outcomes.map(o => o.text))) log(text);
    if (waited && !outcomes.some(o => o.alert)) log("Die Prüfung ist fertig.");
    if (result === "frist") log("Die Einrichtung endet trotzdem.");
    await server.stop();
    log(`Einrichtung ohne Abschluss beendet. Gespeicherte Schritte bleiben; weiter mit: ${BRAND.name} setup`);
    return EXIT_INTERRUPTED;
  }

  // Erst die Antwort auf „Fertig“ ausliefern, dann den Port freigeben
  await Bun.sleep(options.graceMs ?? 300);
  await server.stop();

  if (outcome.kind === "restart") {
    log(`Einrichtung abgeschlossen, ${outcome.supervisor === "launchd" ? "launchd" : "PM2"} startet ${BRAND.name} neu.`);
    return 0;
  }
  if (outcome.kind === "autostart") {
    const result = await autostartStep.apply!({}, ctx);
    log(result.message);
    if (!result.ok) {
      log(`Von Hand starten mit: ${startCommand}`);
      return 1;
    }
    return 0;
  }
  log(`Einrichtung abgeschlossen. Starten mit: ${outcome.command}`);
  return 0;
}
