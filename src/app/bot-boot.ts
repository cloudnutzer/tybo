/**
 * Erster Schritt des Bots (Issue #344), vor jeder Initialisierung:
 *
 * 1. .env aus dem Projektordner laden (derselbe Pfad, den die
 *    Schlüssel-Seite der WebUI beschreibt). Danach gilt ein Profil aus der
 *    Befehlszeile (--profile server, so startet bun run vps und das
 *    Deploy-Skript, Issue #352) vor TYBO_PROFILE aus der .env: loadEnv
 *    überschreibt Prozessvariablen, ein vorangestelltes TYBO_PROFILE=server
 *    allein reicht deshalb nicht
 * 2. einmal ins Log: Grenze gleichzeitiger Aufträge (Issue #208), nicht
 *    vererbte Geheimnisse der Subprozesse (Issue #54), alte
 *    Datenbank-Adresse (Issue #324)
 * 3. Startmodus wählen: fehlt ein Kanal, läuft nur der Einrichtungsmodus im
 *    Browser (Issue #66, Entscheidung 0011) und der Prozess endet danach. Kein
 *    Telegram, keine Modellaufrufe, keine Sperre, keine WebUI
 */
import { join } from "node:path";
import type { StartMode } from "../setup/start-mode";

type Env = Record<string, string | undefined>;
type SetupMode = Extract<StartMode, { mode: "setup" }>;

export interface BootDeps {
  root: string;
  env: Env;
  loadEnv(path: string): Promise<unknown>;
  logCapacity(): void;
  logSubprocessEnv(): void;
  logLegacyDatabase(): void;
  chooseStartMode(env: Env): StartMode;
  /** Einrichtungsmodus bis „Fertig"; zurück kommt der Exit-Code */
  runSetup(startMode: SetupMode): Promise<number>;
  exit(code: number): void;
  /** Argumente nach dem Skriptpfad (process.argv.slice(2)) */
  args?: readonly string[];
  log?(message: string): void;
}

/**
 * Wert von --profile <name> oder --profile=<name>; null ohne die Option,
 * "" wenn der Wert fehlt
 */
export function profileFromArgs(args: readonly string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--profile=")) found = arg.slice("--profile=".length).trim();
    else if (arg === "--profile") {
      const next = args[i + 1] ?? "";
      found = next.startsWith("--") ? "" : next.trim();
    }
  }
  return found;
}

/** true: der Bot startet; false: der Einrichtungsmodus ist gelaufen und exit aufgerufen */
export async function bootBot(deps: BootDeps): Promise<boolean> {
  await deps.loadEnv(join(deps.root, ".env"));
  const log = deps.log ?? (message => console.log(message));
  const profile = profileFromArgs(deps.args ?? []);
  if (profile === "") {
    // Nie stillschweigend local: auf einem Server pollte sonst ein zweiter Bot
    log("[start] --profile ohne Wert, Abbruch (local oder server)");
    deps.exit(1);
    return false;
  }
  if (profile !== null) {
    const fromFile = (deps.env.TYBO_PROFILE ?? "").trim();
    if (fromFile && fromFile.toLowerCase() !== profile.toLowerCase()) {
      log(`[start] Profil ${profile} aus der Befehlszeile, TYBO_PROFILE=${fromFile} aus der .env gilt nicht`);
    }
    deps.env.TYBO_PROFILE = profile;
  }
  deps.logCapacity();
  deps.logSubprocessEnv();
  deps.logLegacyDatabase();
  const startMode = deps.chooseStartMode(deps.env);
  if (startMode.mode !== "setup") return true;
  deps.exit(await deps.runSetup(startMode));
  return false;
}
