/**
 * Anzeigename aus config/profile.md (Issue #344), etwa für Anrufe
 * (/anruf, Werkzeug phone_call): die erste Überschrift erster Ebene oder
 * der Wert hinter „name:" bzw. „Name:", je nachdem, was zuerst im Text
 * steht. Ohne Treffer „User".
 */
const NAME_PATTERN = /^#\s+(.+)|[Nn]ame:\s*(.+)/m;

export const FALLBACK_USER_NAME = "User";

export function profileDisplayName(profile: string): string {
  const found = profile ? NAME_PATTERN.exec(profile) : null;
  const name = found ? (found[1] ?? found[2]) : undefined;
  return name ? name.trim() : FALLBACK_USER_NAME;
}
