/**
 * tybo gedaechtnis ziele-nachholen (Issue #518). Eigener Prozess neben dem
 * Bot, wie die Sprach-Brücke: Die Rückfrage kommt in dasselbe Register
 * (data/choices.json), der Vorschlag in dieselbe Ablage
 * (data/pending-reviews.json), den Klick beantwortet der laufende Bot.
 *
 * Alle Vorschläge gehen in den Direktchat: mit Telegram dorthin und über die
 * Outbox auch in die WebUI, ohne Telegram nur in den Web-Direktchat. Kommt ein
 * Vorschlag nirgends an, wird er wieder herausgenommen und zählt nicht als
 * vorgeschlagen, damit ein neuer Aufruf es erneut versuchen kann.
 *
 * Ohne Supabase gibt es nichts nachzuholen: In der lokalen Ablage wurden Ziele
 * immer richtig gespeichert.
 */
import { Api } from "grammy";
import { BRAND } from "../../brand";
import { dmChatId, telegramConfigured } from "../channels";
import { useChoicesFileIn } from "../choices";
import { createReviewNotifier } from "../review-choices";
import { setReviewNotifier, stageMemoryReview, takePendingReview, usePendingReviewsFileIn } from "../session-distill";
import { selectBackend } from "../store";
import { getSupabase } from "../supabase";
import { createTelegramChoices, type ChoiceEditApi, type TelegramChoicesDeps } from "../telegram-choices";
import { effectiveTimeZone } from "../when";
import { goalBackfillFile, goalHeader, goalTag, readRepliesWithGoals, readStoredGoalTexts, runGoalBackfill, type GoalCandidate } from "./goal-backfill";

type Env = Record<string, string | undefined>;

export interface GoalBackfillCommandOptions {
  root: string;
  env: Env;
  out(line: string): void;
  err(line: string): void;
  /** Nur für Tests: Bot-API und Versand ersetzen */
  createApi?(token: string): ChoiceEditApi;
  send?: TelegramChoicesDeps["send"];
}

export function goalBackfillUsage(): string {
  return [
    `${BRAND.cli} gedaechtnis ziele-nachholen   [GOAL:]-Tags aus alten Antworten als Vorschläge mit Knöpfen vorlegen`,
    "",
    "Nichts wird direkt gespeichert: Jedes Ziel kommt einzeln in den Direktchat, Übernehmen oder Verwerfen geht",
    "dort, solange der Bot läuft, höchstens 7 Tage lang. Ein wiederholter Aufruf fragt nichts doppelt.",
  ].join("\n");
}

export async function runGoalBackfillCommand(args: string[], o: GoalBackfillCommandOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    o.out(goalBackfillUsage());
    return 0;
  }
  if (sub !== "ziele-nachholen" || rest.length > 0) {
    o.err(`Unbekannter Aufruf: ${BRAND.cli} gedaechtnis ${args.join(" ")}`);
    o.err(goalBackfillUsage());
    return 2;
  }
  if (selectBackend(o.env) !== "supabase") {
    o.out("Ohne Supabase gibt es nichts nachzuholen: In der lokalen Ablage wurden Ziele immer gespeichert.");
    return 0;
  }
  const client = getSupabase(o.env);
  if (!client) {
    o.err("Supabase ist nicht erreichbar, nichts vorgeschlagen.");
    return 1;
  }

  useChoicesFileIn(o.root);
  usePendingReviewsFileIn(o.root);
  const telegram = telegramConfigured(o.env);
  const createApi = o.createApi ?? ((token: string) => new Api(token));
  const choices = createTelegramChoices({
    ...(telegram ? { api: createApi(o.env.TELEGRAM_BOT_TOKEN!.trim()), owner: o.env.TELEGRAM_USER_ID!.trim() } : {}),
    ...(o.send ? { send: o.send } : {}),
    telegram: () => telegramConfigured(o.env),
  });
  const deliver = createReviewNotifier({ sendChoice: choice => choices.sendChoice(choice) });
  let delivered = false;
  setReviewNotifier(async proposal => {
    await deliver(proposal);
    delivered = true;
  });

  const timeZone = effectiveTimeZone(o.env.USER_TIMEZONE);
  const chatId = dmChatId(o.env);
  const propose = async (candidate: GoalCandidate): Promise<boolean> => {
    delivered = false;
    const id = await stageMemoryReview({ chatId, tags: goalTag(candidate), header: goalHeader(candidate, timeZone), origin: "Ziele nachholen" });
    if (id && !delivered) await takePendingReview(id);
    return id !== null && delivered;
  };

  try {
    const report = await runGoalBackfill({
      readReplies: () => readRepliesWithGoals(client),
      readStoredGoals: () => readStoredGoalTexts(client),
      file: goalBackfillFile(o.root),
      timeZone,
      propose,
    });
    o.out(
      `Gefunden: ${report.found} · schon gespeichert: ${report.stored} · schon vorgeschlagen: ${report.offeredBefore} · ` +
        `jetzt vorgeschlagen: ${report.offered} · nicht zugestellt: ${report.failed}`,
    );
    if (report.offered > 0) o.out(`Die Vorschläge stehen im Direktchat. Übernehmen oder Verwerfen geht dort, solange der Bot läuft, höchstens 7 Tage lang.`);
    if (report.failed > 0) {
      o.err("Nicht alle Vorschläge kamen an. Derselbe Befehl kann gefahrlos wiederholt werden.");
      return 1;
    }
    return 0;
  } catch (e) {
    o.err(`Alte Antworten oder Ziele nicht lesbar, nichts vorgeschlagen (${e instanceof Error ? e.name : "Fehler"}).`);
    return 1;
  } finally {
    setReviewNotifier(null);
  }
}
