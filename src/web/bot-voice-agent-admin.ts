/**
 * Verwaltung der Sprachagenten für die WebUI (Issue #495): dieselben Wege wie
 * /sprachagent (src/lib/voice-agents/manage.ts), dazu das Rezept in Klartext
 * (describe.ts) und die Versionen aus state.ts. Nur der Bot verdrahtet das
 * (src/app/bot-web.ts); der Web-Server sieht nur VoiceAgentAdminPort.
 *
 * Festlegungen:
 * - Testergebnisse meldet der Manager in das Gespräch, das testResults()
 *   liefert (im Bot der Direktchat, ohne Telegram der Direktchat der WebUI).
 *   Das Detail nennt den letzten Lauf und die davor aus testlauf.json
 *   (fruehereTests, neueste zuerst).
 * - Löschen fragt im Browser nach und ruft dann deleteAgent() direkt; eine
 *   Rückfrage im Chat entsteht dabei nicht.
 * - Minuten: Das Budget steht im Rezept. Gezählt sind nur die Minuten der
 *   Web-Gespräche (mit Reservierungen) aus der Gesprächsroute, kein Telefon-
 *   oder Gesamtverbrauch beim Anbieter.
 */
import { isValidKennung, recipeHash } from "../lib/voice-agents/base";
import type { ChoiceConversation } from "../lib/choices";
import { describeRecipe } from "../lib/voice-agents/describe";
import type { VoiceAgentEntry, VoiceAgentManager } from "../lib/voice-agents/manage";
import { loadRecipe, parseRecipe, type Recipe } from "../lib/voice-agents/recipe";
import { listVersions, readVersion } from "../lib/voice-agents/state";
import type { VoiceAgentPaths } from "../lib/voice-agents/base";
import { VOICE_AGENT_ADMIN_TEXT as TEXT, type VoiceAgentAdminPort, type VoiceAgentAdminResult } from "./voice-agent-admin";
import type { VoiceAgentSessionPort } from "./voice-agent-page";

export interface VoiceAgentAdminOptions {
  manager: VoiceAgentManager;
  paths?: VoiceAgentPaths;
  /** Gesprächsroute für die Minuten im Browser; ohne sie stehen keine da */
  sessions?: VoiceAgentSessionPort;
  /** Wohin der Manager das Ergebnis eines Testlaufs meldet */
  testResults(): ChoiceConversation;
  /** Höchstens so lange wartet das Detail auf die Minuten im Browser */
  minutesTimeoutMs?: number;
  log?: (line: string) => void;
}

/** Ein Statusabruf beim Anbieter darf zehn Sekunden dauern, das Detail wartet etwas länger */
export const VOICE_AGENT_DETAIL_MINUTES_TIMEOUT_MS = 12_000;

const ok = (body: Record<string, unknown>, status = 200): VoiceAgentAdminResult => ({ status, body });
const fail = (status: number, error: string, reason: string): VoiceAgentAdminResult => ({ status, body: { error, reason } });

/** Listeneintrag ohne Pfade oder Kennungen beim Anbieter, die der Browser nicht braucht */
function listEntry(entry: VoiceAgentEntry) {
  return {
    kennung: entry.kennung,
    name: entry.name,
    vorlage: entry.vorlage,
    gedaechtnis: entry.gedaechtnis,
    gehirn: entry.gehirn.art,
    web: entry.web,
    telefon: Boolean(entry.telefon),
    angelegt: entry.angelegt,
    letzterTest: entry.letzterTest,
    laufenderTest: entry.laufenderTest,
    minutenMonat: entry.minuten.limit,
    ...(entry.problem ? { problem: entry.problem } : {}),
  };
}

export function createVoiceAgentAdmin(options: VoiceAgentAdminOptions): VoiceAgentAdminPort {
  const paths = options.paths ?? {};
  const log = options.log ?? ((line: string) => console.log(line));
  const manager = options.manager;
  const minutesTimeoutMs = options.minutesTimeoutMs ?? VOICE_AGENT_DETAIL_MINUTES_TIMEOUT_MS;

  async function guard<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      log(`[sprachagenten] ${what} gescheitert (${e instanceof Error ? e.name : "Fehler"})`);
      return fallback;
    }
  }

  async function list(): Promise<VoiceAgentAdminResult> {
    return guard(
      "Liste",
      async () => {
        const overview = await manager.overview();
        return ok({
          agents: overview.agents.map(listEntry),
          // Nur der Dateiname, die Fehler können Pfade nennen
          kaputt: overview.fehler.map((f) => ({ datei: f.datei.split(/[\\/]/).pop() ?? f.datei, fehler: f.fehler })),
        });
      },
      fail(500, TEXT.failed, "fehler"),
    );
  }

  async function versions(kennung: string, current: Recipe) {
    const numbers = await listVersions(kennung, paths).catch(() => [] as number[]);
    const hash = recipeHash(current);
    const out: { version: number; aktuell: boolean; lesbar: boolean }[] = [];
    for (const version of numbers) {
      let raw: unknown = null;
      try {
        raw = await readVersion(kennung, version, paths);
      } catch {
        raw = null;
      }
      const parsed = raw ? parseRecipe(raw) : null;
      out.push({ version, aktuell: Boolean(parsed?.ok && recipeHash(parsed.recipe) === hash), lesbar: Boolean(parsed?.ok) });
    }
    return out.reverse();
  }

  /**
   * Browser-Minuten aus der Gesprächsroute. Die fragt beim Anbieter nach
   * offenen Gesprächen (je Abruf bis zu zehn Sekunden); antwortet er nicht in
   * minutesTimeoutMs oder scheitert, kommt das Detail ohne Minuten (null).
   */
  async function minutes(kennung: string, web: boolean) {
    if (!web || !options.sessions) return null;
    let cancel = () => {};
    const timeout = new Promise<null>((resolve) => {
      const handle = setTimeout(() => {
        log(`[sprachagenten] ${kennung} Minuten: keine Antwort in ${minutesTimeoutMs} ms`);
        resolve(null);
      }, minutesTimeoutMs);
      cancel = () => clearTimeout(handle);
    });
    const info = await Promise.race([options.sessions.info(kennung).catch(() => null), timeout]).finally(cancel);
    const m = info?.body?.minuten as { limit?: unknown; verbraucht?: unknown } | undefined;
    if (!m || typeof m.limit !== "number") return null;
    return { limit: m.limit, verbraucht: typeof m.verbraucht === "number" ? m.verbraucht : null };
  }

  async function detail(kennung: string, version: number | null): Promise<VoiceAgentAdminResult> {
    if (!isValidKennung(kennung)) return fail(404, TEXT.unknown, "unbekannt");
    return guard(
      "Detail",
      async () => {
        const overview = await manager.overview();
        const entry = overview.agents.find((a) => a.kennung === kennung);
        if (!entry) {
          const broken = overview.fehler.some((f) => (f.datei.split(/[\\/]/).pop() ?? "") === `${kennung}.json`);
          return broken ? fail(422, TEXT.broken, "kaputt") : fail(404, TEXT.unknown, "unbekannt");
        }
        const recipe = await loadRecipe(kennung, paths);
        if (!recipe) return fail(404, TEXT.unknown, "unbekannt");
        let shown: Recipe = recipe;
        if (version !== null) {
          if (!Number.isInteger(version)) return fail(404, TEXT.noVersion, "keine_version");
          const raw = await readVersion(kennung, version, paths).catch(() => null);
          const parsed = raw ? parseRecipe(raw) : null;
          if (!parsed) return fail(404, TEXT.noVersion, "keine_version");
          if (!parsed.ok) return fail(422, TEXT.broken, "kaputt");
          shown = parsed.recipe;
        }
        return ok({
          ...listEntry(entry),
          // Die Läufe vor dem letzten, neueste zuerst (testlauf.json behält einige)
          fruehereTests: entry.fruehereTests ?? [],
          rezept: describeRecipe(shown),
          version,
          versionen: await versions(kennung, recipe),
          maxMinuten: recipe.zugang.maxMinuten,
          minutenWeb: await minutes(kennung, entry.web),
        });
      },
      fail(500, TEXT.failed, "fehler"),
    );
  }

  async function test(kennung: string): Promise<VoiceAgentAdminResult> {
    return guard(
      "Testen",
      async () => {
        const outcome = await manager.startTest(kennung, options.testResults());
        switch (outcome.status) {
          case "gestartet":
            return ok({ ok: true, text: TEXT.testStarted }, 202);
          case "unbekannt":
            return fail(404, TEXT.unknown, "unbekannt");
          case "kein_anbieter":
            return fail(503, TEXT.noProvider, "kein_anbieter");
          case "nicht_angelegt":
            return fail(409, TEXT.notDeployed, "nicht_angelegt");
          case "laeuft":
            return { status: 409, body: { error: TEXT.testRunning, reason: "laeuft", seit: outcome.seit } };
          case "fehler":
            return fail(502, outcome.fehler, "fehler");
        }
      },
      fail(500, TEXT.failed, "fehler"),
    );
  }

  async function link(kennung: string): Promise<VoiceAgentAdminResult> {
    return guard(
      "Link",
      async () => {
        const outcome = await manager.link(kennung);
        switch (outcome.status) {
          case "link":
            return ok({ url: outcome.url });
          case "unbekannt":
            return fail(404, TEXT.unknown, "unbekannt");
          case "kaputt":
            return fail(422, TEXT.broken, "kaputt");
          case "kein_web":
            return fail(409, TEXT.noWeb, "kein_web");
          case "gesperrt":
            return fail(409, TEXT.locked, "gesperrt");
          case "keine_webui":
            return fail(409, TEXT.noWebUi, "keine_webui");
        }
      },
      fail(500, TEXT.failed, "fehler"),
    );
  }

  async function remove(kennung: string): Promise<VoiceAgentAdminResult> {
    if (!isValidKennung(kennung)) return fail(404, TEXT.unknown, "unbekannt");
    return guard(
      "Löschen",
      async () => {
        const outcome = await manager.deleteAgent(kennung);
        log(`[sprachagenten] ${kennung} loeschen (WebUI): ${outcome.status}`);
        switch (outcome.status) {
          case "geloescht":
            return ok({ ok: true, archiv: outcome.archiv });
          case "weg":
            return fail(404, TEXT.unknown, "unbekannt");
          case "kein_anbieter":
            return fail(503, TEXT.noProvider, "kein_anbieter");
          case "anbieter_fehler":
            return fail(502, `Der Anbieter meldet: ${outcome.fehler}. Das Rezept bleibt.`, "anbieter_fehler");
          case "neu_angelegt":
            return fail(409, "Der Sprachagent wurde inzwischen beim Anbieter neu angelegt. Das Rezept bleibt.", "neu_angelegt");
          case "archiv_fehler":
            return fail(500, `Beim Anbieter gelöscht, das Rezept ließ sich aber nicht archivieren (${outcome.fehler}).`, "archiv_fehler");
        }
      },
      fail(500, TEXT.failed, "fehler"),
    );
  }

  return { list, detail, test, link, remove };
}
