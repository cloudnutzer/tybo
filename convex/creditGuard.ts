import { requireOwner } from "./auth";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Self-metered Agent SDK credit tally.
 *
 * From 2026-06-15, programmatic `claude -p` / Agent SDK calls authenticated with
 * a Claude Pro/Max subscription draw from a monthly Agent SDK credit. Anthropic
 * exposes no remaining-credit field or balance API, so we sum `total_cost_usd`
 * (present on every claude -p json result, even on a subscription) per billing
 * cycle and compare to a ceiling.
 *
 * One row per cycle; cycleStartMs is the most-recent resetDay boundary (UTC).
 * A new cycle lazily starts a fresh row on the next write.
 */

function cycleStartMs(resetDay: number, nowMs: number): number {
  const rd = Math.min(Math.max(Math.round(resetDay), 1), 28);
  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() < rd) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return Date.UTC(y, m, rd, 0, 0, 0, 0);
}

export const record = mutation({
  args: {
    costUsd: v.number(),
    resetDay: v.number(),
    plan: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const cs = cycleStartMs(args.resetDay, Date.now());
    const row = await ctx.db
      .query("creditTally")
      .withIndex("by_cycleStartMs", (q) => q.eq("cycleStartMs", cs))
      .first();

    if (!row) {
      await ctx.db.insert("creditTally", {
        cycleStartMs: cs,
        cycleSpendUsd: Math.max(0, args.costUsd),
        plan: args.plan,
        warnedThisCycle: false,
        lastUpdatedMs: Date.now(),
      });
      return { cycleSpendUsd: Math.max(0, args.costUsd), cycleStartMs: cs, warnedThisCycle: false, observedCeilingUsd: null };
    }

    const newTotal = row.cycleSpendUsd + Math.max(0, args.costUsd);
    await ctx.db.patch(row._id, {
      cycleSpendUsd: newTotal,
      lastUpdatedMs: Date.now(),
      ...(args.plan ? { plan: args.plan } : {}),
    });
    return {
      cycleSpendUsd: newTotal,
      cycleStartMs: cs,
      warnedThisCycle: row.warnedThisCycle,
      observedCeilingUsd: row.observedCeilingUsd ?? null,
    };
  },
});

export const markWarned = mutation({
  args: { resetDay: v.number() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const cs = cycleStartMs(args.resetDay, Date.now());
    const row = await ctx.db
      .query("creditTally")
      .withIndex("by_cycleStartMs", (q) => q.eq("cycleStartMs", cs))
      .first();
    if (row) await ctx.db.patch(row._id, { warnedThisCycle: true });
    return null;
  },
});

/**
 * Record the spend level at which a real credit-exhaustion error first fired this
 * cycle — the learned read of the member's actual plan ceiling. Only sets it once
 * per cycle (the first/earliest observation), so a mid-cycle plan change is picked
 * up next cycle. Powers plan up/downgrade self-correction.
 */
export const recordObservedCeiling = mutation({
  args: { resetDay: v.number(), spendUsd: v.number() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const cs = cycleStartMs(args.resetDay, Date.now());
    const row = await ctx.db
      .query("creditTally")
      .withIndex("by_cycleStartMs", (q) => q.eq("cycleStartMs", cs))
      .first();
    if (row && row.observedCeilingUsd == null) {
      await ctx.db.patch(row._id, { observedCeilingUsd: Math.max(0, args.spendUsd) });
    }
    return null;
  },
});

export const getCurrent = query({
  args: { resetDay: v.number() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const cs = cycleStartMs(args.resetDay, Date.now());
    const row = await ctx.db
      .query("creditTally")
      .withIndex("by_cycleStartMs", (q) => q.eq("cycleStartMs", cs))
      .first();
    return {
      cycleSpendUsd: row?.cycleSpendUsd ?? 0,
      cycleStartMs: cs,
      warnedThisCycle: row?.warnedThisCycle ?? false,
      observedCeilingUsd: row?.observedCeilingUsd ?? null,
    };
  },
});
