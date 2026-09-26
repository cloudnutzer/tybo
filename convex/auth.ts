import type { QueryCtx } from "./_generated/server";

/** This personal deployment has exactly one authorized service identity. */
export async function requireOwner(ctx: Pick<QueryCtx, "auth">): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  const owner = process.env.CONVEX_OWNER_TOKEN_IDENTIFIER;
  if (!owner || !identity || identity.tokenIdentifier !== owner) {
    throw new Error("Unauthorized");
  }
}
