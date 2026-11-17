/**
 * tybo gedaechtnis bereinigen, archiv, zurueckholen (Issue #520). Eigener Prozess
 * neben dem Bot wie ziele-nachholen: Die Frage kommt ins Register
 * (data/choices.json) und in den Direktchat, mit Telegram dorthin und über die
 * Outbox in die WebUI, ohne Telegram nur in den Web-Direktchat. Den Klick
 * beantwortet der laufende Bot (fact-cleanup.ts). Archiv und Zurückholen
 * brauchen den Bot nicht.
 *
 * Die Ausgabe von bereinigen nennt nur Zahlen, nie Texte von Fakten. archiv
 * zeigt die Texte, danach fragt der Nutzer ausdrücklich; Geheimnisse darin sind
 * maskiert (Issue #524).
 */
import { readFile } from "node:fs/promises";
import { Api } from "grammy";
import { BRAND } from "../../brand";
import { dmChatId, telegramConfigured } from "../channels";
import { useChoicesFileIn } from "../choices";
import { getStore } from "../store";
import { createTelegramChoices, type ChoiceEditApi, type TelegramChoicesDeps } from "../telegram-choices";
import { maskSecrets } from "./secrets";
import { factCleanupFile, parseCleanupList, prepareCleanup, restoreCleanupFact, type RestoreOutcome } from "./fact-cleanup";

type Env = Record<string, string | undefined>;

export const FACT_CLEANUP_COMMANDS = ["bereinigen", "archiv", "zurueckholen"];

export interface FactCleanupCommandOptions {
  root: string;
  env: Env;
  out(line: string): void;
  err(line: string): void;
  /** Nur für Tests: Bot-API und Versand ersetzen */
  createApi?(token: string): ChoiceEditApi;
  send?: TelegramChoicesDeps["send"];
}

export function factCleanupUsage(): string {
  return [
    `${BRAND.cli} gedaechtnis bereinigen --datei <Pfad>   Fakten aus einer lokalen Liste per Knöpfen archivieren oder umschreiben`,
    `${BRAND.cli} gedaechtnis archiv                      archivierte Fakten mit Kennung zeigen`,
    `${BRAND.cli} gedaechtnis zurueckholen <Kennung> ...  die letzte Änderung zurücknehmen: aus dem Archiv holen, sonst den Text davor; --alle für das ganze Archiv`,
    "",
    "Ohne Bestätigung ändert sich nichts: Die Fragen kommen in den Direktchat, entschieden wird dort, solange der Bot läuft.",
    "Format der Liste: docs/troubleshooting.md, „Fakten aufräumen“. Ein wiederholter Aufruf fragt nichts doppelt.",
  ].join("\n");
}

const RESTORE_TEXT: Record<RestoreOutcome, string> = {
  aus_dem_archiv: "aus dem Archiv zurückgeholt",
  alter_text: "alter Text wiederhergestellt",
  nicht_gefunden: "nicht im Archiv oder inzwischen geändert, nichts geändert",
  gescheitert: "gescheitert, nichts geändert",
  geheimnis: "der alte Text enthält ein Geheimnis und kommt nicht zurück, nichts geändert. Der Wert gehört in die .env",
};

async function bereinigen(args: string[], o: FactCleanupCommandOptions): Promise<number> {
  const path = args.length === 2 && args[0] === "--datei" ? args[1] : undefined;
  if (!path) {
    o.err(`Aufruf: ${BRAND.cli} gedaechtnis bereinigen --datei <Pfad>`);
    return 2;
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    o.err(`Liste nicht lesbar (${(e as { code?: string }).code ?? "Fehler"}), nichts vorgelegt.`);
    return 1;
  }
  const parsed = parseCleanupList(raw);
  if ("problems" in parsed) {
    o.err("Die Liste wurde nicht angenommen, nichts vorgelegt:");
    for (const problem of parsed.problems) o.err(`  ${problem}`);
    return 2;
  }

  const memory = () => getStore().memory;
  try {
    // Prüft nebenbei, ob die Migration eingespielt ist; sonst scheiterte später jeder Klick
    await memory().archivedFacts();
  } catch (e) {
    o.err(`Das Archiv ist nicht erreichbar, nichts vorgelegt. Ist die Migration 20261031_memory_archive.sql eingespielt? (${e instanceof Error ? e.name : "Fehler"})`);
    return 1;
  }

  useChoicesFileIn(o.root);
  const telegram = telegramConfigured(o.env);
  const createApi = o.createApi ?? ((token: string) => new Api(token));
  const choices = createTelegramChoices({
    ...(telegram ? { api: createApi(o.env.TELEGRAM_BOT_TOKEN!.trim()), owner: o.env.TELEGRAM_USER_ID!.trim() } : {}),
    ...(o.send ? { send: o.send } : {}),
    telegram: () => telegramConfigured(o.env),
  });

  try {
    const report = await prepareCleanup(
      parsed.entries,
      { type: "telegram", chatId: dmChatId(o.env) },
      { file: factCleanupFile(o.root), memory, sendChoice: choice => choices.sendChoice(choice) },
    );
    o.out(
      `Einträge: ${report.entries} · neu aufgenommen: ${report.added} · schon bekannt: ${report.known} · ` +
        `Fakt nicht mehr da: ${report.missing} · Text geändert, übersprungen: ${report.changed}`,
    );
    if (report.present === "nicht_zugestellt") {
      o.err("Die Frage kam nicht an, nichts geändert. Derselbe Befehl kann gefahrlos wiederholt werden.");
      return 1;
    }
    if (report.present === "vorgelegt" || report.present === "besetzt") {
      o.out(`Offene Gruppen: ${report.waitingGroups}. Die Fragen stehen nacheinander im Direktchat, entschieden wird dort, solange der Bot läuft, je Frage höchstens 7 Tage lang.`);
    } else {
      o.out("Nichts vorzulegen.");
    }
    return 0;
  } catch (e) {
    o.err(`Fakten oder Vermerk nicht lesbar, nichts vorgelegt (${e instanceof Error ? e.name : "Fehler"}).`);
    return 1;
  }
}

async function archiv(o: FactCleanupCommandOptions): Promise<number> {
  try {
    const facts = await getStore().memory.archivedFacts();
    if (facts.length === 0) o.out("Das Archiv ist leer.");
    for (const fact of facts) o.out(`${fact.id}  ${(fact.archived_at ?? "").slice(0, 10)}  ${maskSecrets(fact.content).replace(/\s+/g, " ")}`);
    return 0;
  } catch (e) {
    o.err(`Archiv nicht lesbar (${e instanceof Error ? e.name : "Fehler"}).`);
    return 1;
  }
}

async function zurueckholen(args: string[], o: FactCleanupCommandOptions): Promise<number> {
  if (args.length === 0 || (args.includes("--alle") && args.length > 1)) {
    o.err(`Aufruf: ${BRAND.cli} gedaechtnis zurueckholen <Kennung> ... oder --alle`);
    return 2;
  }
  const memory = () => getStore().memory;
  try {
    const ids = args[0] === "--alle" ? (await memory().archivedFacts()).map(fact => String(fact.id)) : args;
    let failed = 0;
    for (const id of ids) {
      const outcome = await restoreCleanupFact(id, { file: factCleanupFile(o.root), memory });
      if (outcome === "nicht_gefunden" || outcome === "gescheitert" || outcome === "geheimnis") failed++;
      o.out(`${id}: ${RESTORE_TEXT[outcome]}`);
    }
    if (ids.length === 0) o.out("Das Archiv ist leer.");
    return failed > 0 ? 1 : 0;
  } catch (e) {
    o.err(`Archiv oder Vermerk nicht lesbar (${e instanceof Error ? e.name : "Fehler"}).`);
    return 1;
  }
}

export function runFactCleanupCommand(args: string[], o: FactCleanupCommandOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "bereinigen") return bereinigen(rest, o);
  if (sub === "archiv" && rest.length === 0) return archiv(o);
  if (sub === "zurueckholen") return zurueckholen(rest, o);
  o.err(`Unbekannter Aufruf: ${BRAND.cli} gedaechtnis ${args.join(" ")}`);
  o.err(factCleanupUsage());
  return Promise.resolve(2);
}
