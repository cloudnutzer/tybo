/**
 * Credit-guard — keep `claude -p` / Agent SDK usage inside your Claude subscription
 * budget after the 2026-06-15 Anthropic change.
 *
 * From June 15 2026, programmatic Claude run on a Pro/Max SUBSCRIPTION (claude -p
 * with no API key, or the Agent SDK signed in with the subscription) draws from a
 * fixed monthly Agent SDK credit (Pro $20 / Max 5x $100 / Max 20x $200, no rollover).
 * Past it: API-rate overflow if you enabled usage-credits, otherwise requests stop.
 * If you run with your own ANTHROPIC_API_KEY, you are EXEMPT — pay-as-you-go, unchanged.
 *
 * Anthropic exposes no remaining-credit field or balance API. So this guard:
 *   1) ROUTES every -p call to the cheapest model that fits (so the credit lasts ~3-5x),
 *   2) SELF-METERS total_cost_usd per billing cycle into your own backend,
 *   3) DEGRADES gracefully at the ceiling (drop to a cheaper model, or accept overflow),
 *   4) LEARNS your real ceiling from when a credit-limit error actually fires — so if you
 *      up/downgrade your Claude plan, tybo picks it up on its own.
 *
 * EVERYTHING is FAIL-OPEN: any tracking/backend failure → full routing + a normal reply.
 * Routing applies to everyone (cheaper = good); metering/capping only when you're on a
 * subscription (no API key). Generic, member-configurable — no hardcoded plan.
 */
import { BRAND } from "../brand";
import { classifyComplexity, type ModelTier } from "./model-router";
import {
  recordSpend,
  getSpend,
  markSpendWarned,
  recordObservedCeiling,
  type SpendRow,
} from "./convex";

const TIER_ORDER: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

// Claude Code --model accepts these short aliases (resolved to the current model
// for the tier) — safer across CLI versions than dated IDs.
export const MODEL_ALIAS: Record<ModelTier, string> = {
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
};

// --- config (all env-overridable; conservative, plan-agnostic defaults) ---
const ENABLED = !["off", "false", "0", "no"].includes(
  (process.env.CREDIT_GUARD ?? "on").toLowerCase()
);
// Ceiling is OPTIONAL. If unset, the guard does not proactively cap — it meters and
// learns the real ceiling from the first credit-limit error. Set it (via setup or
// CREDIT_CEILING_USD) for proactive routing + the 80% warning.
const CONFIGURED_CEILING = process.env.CREDIT_CEILING_USD
  ? Number(process.env.CREDIT_CEILING_USD)
  : null;
const RESET_DAY = Number(process.env.CREDIT_RESET_DAY || 1); // billing-cycle day-of-month
const MODE = (process.env.CREDIT_MODE || "lowcost").toLowerCase() as "lowcost" | "overflow";
const CAP_TIER = (["haiku", "sonnet", "opus"].includes(process.env.CREDIT_CAP_TIER || "")
  ? process.env.CREDIT_CAP_TIER
  : "sonnet") as ModelTier;
const WARN_PCT = Number(process.env.CREDIT_WARN_PCT || 0.8);
const PLAN = process.env.CREDIT_PLAN || undefined;

// The bot/gateway registers a "send to the member's Telegram" function once at
// startup via setNotifier(), so the low-level spawner (claude.ts) can trigger the
// 80% warning without importing Telegram. Best-effort; never required.
let notifier: ((msg: string) => unknown) | null = null;
export function setNotifier(fn: (msg: string) => unknown): void {
  notifier = fn;
}
async function notify(msg: string): Promise<void> {
  if (!notifier) return;
  try {
    await notifier(msg);
  } catch {
    /* best-effort */
  }
}

/** Subscription mode = no real API key set (so claude -p rides the subscription). */
export function isSubscriptionMode(): boolean {
  return !(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/** Whether the guard meters/caps at all (on, and on a subscription). Routing still applies regardless. */
function metersActive(): boolean {
  return ENABLED && isSubscriptionMode();
}

const cheaper = (a: ModelTier, b: ModelTier): ModelTier =>
  TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;

/** The ceiling we actually trust: learned-from-reality first, configured second, else none. */
function effectiveCeiling(row: SpendRow | null): number | null {
  if (row?.observedCeilingUsd != null && row.observedCeilingUsd > 0) return row.observedCeilingUsd;
  return CONFIGURED_CEILING;
}

// brief cache so routing doesn't query the backend on every message
let cache: { row: SpendRow | null; at: number } | null = null;
const CACHE_MS = 60_000;

async function currentRow(): Promise<SpendRow | null> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    cache = { row: await getSpend(RESET_DAY), at: now };
  }
  return cache.row;
}

/**
 * Pick the model tier for a -p call: classify the message, then clamp to the credit
 * cap if we're over the ceiling in lowcost mode. Returns a --model alias string.
 * Fail-open: any error → the classified tier (full routing). `requestedTier` lets a
 * caller that already classified (e.g. bot.ts) pass it through; background jobs pass "haiku".
 */
export async function resolveModelAlias(
  message: string,
  requestedTier?: ModelTier
): Promise<string> {
  const tier = await capTier(requestedTier ?? classifyComplexity(message));
  return MODEL_ALIAS[tier];
}

/**
 * Clamp a tier to the credit cap when over the ceiling in lowcost mode.
 * Used by the relay (-p) and the VPS Agent SDK path. Fail-open → returns `tier`.
 */
export async function capTier(tier: ModelTier): Promise<ModelTier> {
  try {
    if (metersActive() && MODE === "lowcost") {
      const row = await currentRow();
      const ceiling = effectiveCeiling(row);
      if (ceiling != null && (row?.cycleSpendUsd ?? 0) >= ceiling) {
        return cheaper(tier, CAP_TIER);
      }
    }
  } catch {
    /* fail-open */
  }
  return tier;
}

/**
 * Record one call's cost (fire-and-forget; caller should not await-block). One-time
 * 80% warning per cycle via `notify`. No-op unless metering is active.
 */
export async function record(costUsd: number): Promise<void> {
  if (!metersActive() || !(costUsd > 0)) return;
  try {
    const row = await recordSpend(costUsd, RESET_DAY, PLAN);
    if (!row) return;
    cache = { row, at: Date.now() };
    const ceiling = effectiveCeiling(row);
    if (ceiling != null && !row.warnedThisCycle && row.cycleSpendUsd >= ceiling * WARN_PCT) {
      const pct = Math.round((100 * row.cycleSpendUsd) / ceiling);
      await markSpendWarned(RESET_DAY);
      const tail =
        MODE === "lowcost"
          ? `At 100% ${BRAND.name} drops to a cheaper model (stays on your subscription).`
          : `Past 100% it bills overflow at API rates.`;
      await notify(
        `💳 Heads up — you're at ${pct}% of your Claude credit ($${row.cycleSpendUsd.toFixed(2)} of $${ceiling.toFixed(0)} this cycle). ${tail} See /credit.`
      );
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Call when a real credit/limit error fires on a subscription call. Records the
 * spend level as the observed (true) ceiling for this cycle — this is how the guard
 * self-corrects to the member's ACTUAL plan after an up/downgrade, with no config.
 */
export async function onCreditLimitHit(): Promise<void> {
  if (!metersActive()) return;
  try {
    const row = await currentRow();
    const spend = row?.cycleSpendUsd ?? 0;
    if (spend > 0 && row?.observedCeilingUsd == null) {
      await recordObservedCeiling(RESET_DAY, spend);
      cache = null; // force refresh
      // If reality is well under the configured ceiling, their plan likely shrank.
      if (CONFIGURED_CEILING != null && spend < CONFIGURED_CEILING * 0.75) {
        await notify(
          `💳 Your Claude credit ran out at ~$${spend.toFixed(2)}, below your set $${CONFIGURED_CEILING.toFixed(0)} — looks like your plan changed. Update it with /plan. ${BRAND.name} is adjusting automatically.`
        );
      }
    }
  } catch {
    /* fail-open */
  }
}

function daysUntilReset(): number {
  const rd = Math.min(Math.max(Math.round(RESET_DAY), 1), 28);
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() >= rd) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return Math.max(0, Math.ceil((Date.UTC(y, m, rd) - Date.now()) / 86_400_000));
}

/** One-line spend summary for /status and the morning briefing. */
export async function statusLine(): Promise<string> {
  if (!isSubscriptionMode()) return ""; // API-key members are exempt
  try {
    const row = await getSpend(RESET_DAY);
    const ceiling = effectiveCeiling(row);
    const spend = row?.cycleSpendUsd ?? 0;
    return ceiling
      ? `Credit: $${spend.toFixed(2)}/$${ceiling.toFixed(0)} (${Math.round((100 * spend) / ceiling)}%), ~${daysUntilReset()}d left`
      : `Credit: $${spend.toFixed(2)} this cycle (set your plan with /plan)`;
  } catch {
    return "";
  }
}

/** Telegram-ready plan info for /plan — what plan/ceiling is set and how to change it. */
export async function formatPlan(): Promise<string> {
  if (!isSubscriptionMode()) {
    return "💳 You're on your own Anthropic API key (pay-as-you-go) — no subscription credit to budget. Nothing to set.";
  }
  let learned = "";
  try {
    const row = await getSpend(RESET_DAY);
    if (row?.observedCeilingUsd != null) learned = ` (I've learned your real ceiling is ~$${row.observedCeilingUsd.toFixed(0)})`;
  } catch {
    /* ignore */
  }
  const set = CONFIGURED_CEILING != null ? `$${CONFIGURED_CEILING.toFixed(0)}` : "not set";
  return (
    `💳 *Your Claude plan budget*\n` +
    `Configured credit ceiling: ${set}${learned}\n` +
    `Reset day: ${RESET_DAY} · mode: ${MODE}\n\n` +
    `Monthly Agent SDK credit by plan: Pro $20 · Max 5x $100 · Max 20x $200.\n` +
    `To set yours: put \`CREDIT_CEILING_USD\` (and \`CREDIT_RESET_DAY\`) in your .env and restart, or re-run setup. ` +
    `If your plan changes, I also learn the real ceiling automatically the next time the credit runs out.`
  );
}

/** Telegram-ready status for /credit. */
export async function formatStatus(): Promise<string> {
  if (!isSubscriptionMode()) {
    return "💳 You're running on your own Anthropic API key — pay-as-you-go, exempt from the June 15 credit change. Nothing to watch here.";
  }
  if (!ENABLED)
    return "💳 Credit guard is off (CREDIT_GUARD). Deine echten Limits siehst du auf claude.ai → Settings → Usage (Session- und Wochen-Limits in %).";
  try {
    const row = await getSpend(RESET_DAY);
    const spend = row?.cycleSpendUsd ?? 0;
    const ceiling = effectiveCeiling(row);
    const learned = row?.observedCeilingUsd != null;
    if (!ceiling) {
      return (
        `💳 *Agent SDK credit* (self-metered)\n` +
        `$${spend.toFixed(2)} spent this cycle · ~${daysUntilReset()} days left\n` +
        `Ceiling: not set — run /plan (or set CREDIT_CEILING_USD) so I can warn you before you run out. ` +
        `I'll also learn it automatically the first time you hit the limit.`
      );
    }
    const pct = Math.round((100 * spend) / ceiling);
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    return (
      `💳 *Agent SDK credit* (self-metered)\n` +
      `${bar} ${pct}%\n` +
      `$${spend.toFixed(2)} / $${ceiling.toFixed(0)}${learned ? " (learned)" : ""} this cycle\n` +
      `📅 ~${daysUntilReset()} days left · mode: ${MODE}`
    );
  } catch {
    return "💳 Credit status unavailable (tracking is fail-open — your bot is unaffected).";
  }
}
