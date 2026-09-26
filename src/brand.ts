/**
 * Name, Befehl und Domain an genau einer Stelle (Entscheidungen 0009 und 0015).
 * Sichtbare Texte nutzen BRAND statt fester Namen. Umgebungsvariablen heißen
 * TYBO_*, Dienstnamen stehen in src/lib/service-names.ts. repo ist das GitHub-Repo für Klon und Updates
 * (setup/upgrade.ts, setup/install.ts, src/lib/repo-remote.ts).
 */

export const BRAND = {
  name: "tybo",
  cli: "tybo",
  domain: "tybo.ai",
  repo: "cloudnutzer/tybo",
} as const;

/** Kennung der App bei OpenRouter (Referer und Titel), an allen OpenRouter-Aufrufen gleich */
export const OPENROUTER_APP_HEADERS = {
  "HTTP-Referer": `https://${BRAND.domain}`,
  "X-Title": BRAND.name,
} as const;
