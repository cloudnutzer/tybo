/**
 * Versionsnummern aus Ausgaben lesen und vergleichen; genutzt von den
 * Software-Updates (src/software-update.ts) und der Prüfung der
 * Dienst-Versionen (src/lib/maintenance/services.ts).
 */

/** Erste Versionsnummer in einer Ausgabe wie „2.1.293 (Claude Code)“ oder „codex-cli 0.159.2“ */
export function parseVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?/)?.[0];
}

/** Ist a neuer als b? Nur die Zahlen vor einem Zusatz zählen */
export function isNewer(a: string, b: string): boolean {
  const n = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
