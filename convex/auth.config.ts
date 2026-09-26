import type { AuthConfig } from "convex/server";

export default {
  providers: process.env.CONVEX_AUTH_ISSUER && process.env.CONVEX_AUTH_AUDIENCE
    ? [{ domain: process.env.CONVEX_AUTH_ISSUER, applicationID: process.env.CONVEX_AUTH_AUDIENCE }]
    : [],
} satisfies AuthConfig;
