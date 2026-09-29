/**
 * Befehl `tybo suche` (Issue #168): Neuberechnung der Embeddings nach einem
 * Anbieterwechsel, nur für Supabase.
 *
 *   tybo suche neu-berechnen                Neuberechnung im Vordergrund (setzt nach Abbruch fort)
 *   tybo suche neu-berechnen --hintergrund  dasselbe losgelöst, Ausgabe in logs/embedding-reindex.log
 *   tybo suche status                       Stand der Umstellung
 *
 * Intern: --inhaber=<id> übernimmt den Lauf, den tybo setup suche vor seinen
 * Änderungen reserviert hat (gleicher Inhaber, embedding_reindex_start).
 *
 * Begonnen wird die Umstellung nur in tybo setup suche nach Rückfrage; dieser
 * Befehl rechnet einen begonnenen Lauf zu Ende (src/lib/embedding-reindex.ts).
 * Danach: Funktionsnachweis (Probe speichern, finden, löschen; mehrere
 * Versuche, weil Functions die Umstellung bis zu einer Minute zwischenspeichern)
 * und eine Meldung über sendAndRecord als reine Anzeige-Meldung
 * (Entscheidung 0006), auch bei Fehler oder Abbruch. Kein automatischer
 * Neustart des Bots: die Meldung sagt, dass er die neue .env erst danach nutzt.
 *
 * Ausgaben sind feste Sätze ohne Schlüssel und ohne Texte aus der Datenbank.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describeConfig, embeddingConfig, readStoredProvider, type EmbeddingConfig, type FetchLike } from "../../supabase/functions/_shared/embedding";
import { BRAND } from "../brand";
import { registryTarget } from "../lib/embedding";
import { REINDEX_TABLES, restReindexStore, runReindex, TABLE_SPECS, type ReindexOutcome, type ReindexProgress, type ReindexStore } from "../lib/embedding-reindex";
import { createSetupContext, defaultSleep, defaultStartBackground } from "./context";

/** Ausgabe der Neuberechnung im Hintergrund, relativ zum Projektordner */
export const REINDEX_LOG_FILE = join("logs", "embedding-reindex.log");
/** Absender der Meldung (metadata.source) */
export const NOTIFY_SOURCE = "suche";
/** Versuche des Funktionsnachweises nach dem Umschalten und Pause dazwischen (länger als UNREADABLE_TTL_MS) */
export const PROBE_ATTEMPTS = 3;
export const PROBE_PAUSE_MS = 70_000;

export type ProbeOutcome = { state: "aktiv" | "textsuche" | "fehler" | "abgebrochen"; text: string };

export interface SearchCommandDeps {
  root: string;
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  signal?: AbortSignal;
  fetch?: FetchLike;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  store?: ReindexStore;
  holder?: string;
  /** Funktionsnachweis nach dem Umschalten; Standard: probeSearch aus semantic-search.ts, Ergebnis gemerkt */
  probe?(config: EmbeddingConfig, signal: AbortSignal): Promise<ProbeOutcome>;
  /** Meldung an Telegram und WebUI (nur Anzeige); Standard: sendAndRecord */
  notify?(text: string): Promise<boolean>;
  /** Losgelöster Start (--hintergrund) */
  startBackground?(cmd: string[], options: { cwd: string; logFile: string }): Promise<boolean>;
}

export const SEARCH_USAGE = [
  `${BRAND.cli} suche neu-berechnen                Embeddings nach einem Anbieterwechsel neu berechnen (setzt nach Abbruch fort)`,
  `${BRAND.cli} suche neu-berechnen --hintergrund  dasselbe im Hintergrund, Ausgabe in ${REINDEX_LOG_FILE}`,
  `${BRAND.cli} suche status                       Stand der Umstellung`,
  `Begonnen wird ein Wechsel mit ${BRAND.cli} setup suche (mit Rückfrage).`,
].join("\n");

const envReader = (env: SearchCommandDeps["env"]) => (name: string) => env[name];

async function defaultProbe(root: string, env: SearchCommandDeps["env"], config: EmbeddingConfig, signal: AbortSignal): Promise<ProbeOutcome> {
  const { probeSearch, probeText, writeRecord } = await import("./semantic-search");
  const ctx = createSetupContext({ root });
  const url = (env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const probe = await probeSearch(url, key, ctx, signal, config);
  if (probe.state === "aktiv" || probe.state === "textsuche") await writeRecord(ctx, url, probe.state, config).catch(() => {});
  return { state: probe.state, text: probeText(probe) };
}

async function defaultNotify(root: string, text: string): Promise<boolean> {
  const { loadEnv } = await import("../lib/env");
  await loadEnv(join(root, ".env"));
  const { defaultOutboxDeps, sendAndRecord } = await import("../lib/outbox");
  const result = await sendAndRecord({ source: NOTIFY_SOURCE, text, format: "plain" }, defaultOutboxDeps(process.env));
  return result.sent;
}

function progressLine(p: ReindexProgress): string {
  const label = TABLE_SPECS[p.table].label;
  if (p.phase === "warten") return `Warte ${Math.ceil((p.waitMs ?? 0) / 1000)} s, bis alle Prozesse die Umstellung sehen (dann entstehen die neuen Vektoren).`;
  if (p.phase === "pause") return `Pause ${Math.ceil((p.waitMs ?? 0) / 1000)} s (Ratenlimit des Anbieters), ${label}: ${p.done} von ${p.total}.`;
  if (p.phase === "nachzug") return `${label}: ${p.done} während der Neuberechnung geänderte Einträge nachgezogen.`;
  return `${label}: ${p.done} von ${p.total}.`;
}

const RESTART = `Der Bot nutzt die neue Einstellung aus der .env erst nach einem Neustart (in der WebUI: Neustart anfordern).`;

/** Text der Meldung am Ende, ohne Werte aus der Datenbank */
export function finalMessage(outcome: ReindexOutcome, probe?: ProbeOutcome): string {
  if (outcome.state === "fertig") {
    const head = `Semantische Suche: Neuberechnung auf ${describeConfig(outcome.target)} fertig, ${outcome.written} Einträge neu berechnet${outcome.withoutVector ? ` (${outcome.withoutVector} ohne Vektor: Anzeige-Meldungen, Einträge außer Fakten und leere Texte)` : ""}.`;
    const check = !probe
      ? ""
      : probe.state === "aktiv"
        ? ` Funktionsnachweis: aktiv. ${probe.text}`
        : ` Funktionsnachweis nicht bestanden: ${probe.text} Prüfen mit ${BRAND.cli} setup suche.`;
    return `${head}${check} ${RESTART}`;
  }
  return `Semantische Suche: Neuberechnung nicht fertig. ${outcome.message}`;
}

/** Inhaber aus tybo setup suche: nur einfache Zeichen, höchstens 200 */
const HOLDER_ARG = /^--inhaber=([A-Za-z0-9._:-]{1,200})$/;

async function recompute(args: string[], deps: SearchCommandDeps): Promise<number> {
  const background = args.includes("--hintergrund");
  const handedOver = args.map(a => HOLDER_ARG.exec(a)?.[1]).find(Boolean);
  const unknown = args.filter(a => a !== "--hintergrund" && !HOLDER_ARG.test(a));
  if (unknown.length) {
    deps.err(`Unbekannt: ${unknown.join(" ")}`);
    deps.err(SEARCH_USAGE);
    return 2;
  }
  if (background) {
    const start = deps.startBackground ?? defaultStartBackground;
    const ok = await start([process.execPath, "--no-env-file", join(deps.root, "scripts", "tybo.ts"), "suche", "neu-berechnen"], { cwd: deps.root, logFile: join(deps.root, REINDEX_LOG_FILE) });
    if (!ok) {
      deps.err("Der Start im Hintergrund ist fehlgeschlagen.");
      return 1;
    }
    deps.out(`Neuberechnung läuft im Hintergrund, Ausgabe in ${REINDEX_LOG_FILE}. Stand: ${BRAND.cli} suche status.`);
    return 0;
  }
  if ((deps.env.CONVEX_URL ?? "").trim()) {
    deps.err("Mit Convex gibt es keine Neuberechnung: dort bleibt es bei OpenAI.");
    return 2;
  }
  const target = registryTarget(envReader(deps.env));
  if (!target) {
    deps.err(`In der .env fehlen SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY. Erst ${BRAND.cli} setup datenbank.`);
    return 2;
  }
  const parsed = embeddingConfig(envReader(deps.env));
  if (!parsed.ok) {
    deps.err(parsed.message);
    return 2;
  }
  const fetchFn: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const sleep = deps.sleep ?? defaultSleep;
  const signal = deps.signal ?? new AbortController().signal;
  const store = deps.store ?? restReindexStore(target, fetchFn);
  let last = 0;
  const outcome = await runReindex({
    store,
    config: parsed.config,
    env: envReader(deps.env),
    fetch: fetchFn,
    holder: deps.holder ?? handedOver ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    sleep,
    signal,
    report: p => {
      // Höchstens eine Zeile je Sekunde, Warten und Pausen immer
      const now = Date.now();
      if (p.phase === "haupt" && now - last < 1000) return;
      last = now;
      deps.out(progressLine(p));
    },
  });
  if (outcome.state === "kein-lauf" || outcome.state === "belegt") {
    deps.out(outcome.message);
    return 0;
  }
  let probe: ProbeOutcome | undefined;
  if (outcome.state === "fertig") {
    deps.out(`Umgeschaltet: die Datenbank hält jetzt ${describeConfig(outcome.target)} fest. Prüfe die Suche …`);
    const run = deps.probe ?? ((config: EmbeddingConfig, s: AbortSignal) => defaultProbe(deps.root, deps.env, config, s));
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      try {
        probe = await run(outcome.target, signal);
      } catch {
        probe = { state: "fehler", text: "Der Test ist auf einen unerwarteten Fehler gestoßen." };
      }
      // Functions merken die Umstellung bis zu einer Minute: dann erneut
      if (probe.state === "aktiv" || probe.state === "abgebrochen" || attempt === PROBE_ATTEMPTS) break;
      await sleep(PROBE_PAUSE_MS, signal);
      if (signal.aborted) break;
    }
  }
  const text = finalMessage(outcome, probe);
  deps.out(text);
  const notify = deps.notify ?? (t => defaultNotify(deps.root, t));
  const sent = await notify(text).catch(() => false);
  if (!sent) deps.err("Die Meldung an Telegram ließ sich nicht senden.");
  if (outcome.state === "fertig") return probe?.state === "aktiv" ? 0 : 1;
  return outcome.state === "abgebrochen" ? 130 : 1;
}

async function status(deps: SearchCommandDeps): Promise<number> {
  const target = registryTarget(envReader(deps.env));
  if ((deps.env.CONVEX_URL ?? "").trim() || !target) {
    deps.out("Semantische Suche: nur mit Supabase; hier gibt es keine Neuberechnung.");
    return 0;
  }
  const fetchFn: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const stored = await readStoredProvider(target, fetchFn);
  if (!stored) {
    deps.err("Die Anbieterkennung der Datenbank ist nicht lesbar (Netz, Rechte oder Serverfehler).");
    return 1;
  }
  if (stored.state !== "umstellung") {
    const text =
      stored.state === "festgehalten"
        ? `Keine Neuberechnung. Die Datenbank hält ${describeConfig(stored.config)} fest.`
        : stored.state === "fehlt"
          ? "Keine Neuberechnung. Der Datenbank fehlt die Anbieterkennung (Schema aktualisieren mit tybo setup datenbank)."
          : "Keine Neuberechnung. Die Datenbank hat noch keinen Anbieter festgehalten.";
    deps.out(text);
    return 0;
  }
  const store = deps.store ?? restReindexStore(target, fetchFn);
  const view = await store.overview().catch(() => null);
  deps.out(`Neuberechnung auf ${describeConfig(stored.target)}: bis sie fertig ist, findet die Suche nur Text.`);
  if (view) {
    deps.out(view.active ? "Ein Prozess rechnet gerade." : `Gerade rechnet niemand. Fortsetzen mit: ${BRAND.cli} suche neu-berechnen --hintergrund`);
    for (const t of REINDEX_TABLES) {
      const p = view.progress[t];
      deps.out(`  ${TABLE_SPECS[t].label}: ${p ? `${p.done}${p.finished ? ", fertig" : ""}` : "noch nicht begonnen"}`);
    }
    if (view.queued) deps.out(`  Nachzuziehen (während der Neuberechnung geändert): ${view.queued}`);
  }
  return 0;
}

/** Verteilt tybo suche …; gibt den Exit-Code zurück */
export async function runSearchCommand(args: string[], deps: SearchCommandDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "neu-berechnen") return recompute(rest, deps);
  if (sub === "status" && !rest.length) return status(deps);
  if (sub === undefined || sub === "help" || sub === "--help") {
    deps.out(SEARCH_USAGE);
    return sub === undefined ? 2 : 0;
  }
  deps.err(`Unbekannter Befehl: suche ${args.join(" ")}`);
  deps.err(SEARCH_USAGE);
  return 2;
}
