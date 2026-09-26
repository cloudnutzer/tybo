/**
 * GitHub-Repo von tybo als git-Remote (Issue #134): Klon-URL aus BRAND.repo
 * und die Prüfung, ob ein Remote genau darauf zeigt. Die URL wird zerlegt,
 * verglichen werden der tatsächliche Host (github.com) und der exakte Pfad
 * `besitzer/repo`, nicht ein Teilstring.
 */
import { BRAND } from "../brand";

/** Klon-URL über HTTPS */
export function repoCloneUrl(repo: string = BRAND.repo): string {
  return `https://github.com/${repo}.git`;
}

/** Erlaubte Protokolle mit ihrem Standard-Port */
const DEFAULT_PORTS: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22" };

/** `besitzer/repo` aus dem Pfad-Teil, optional mit .git und Schrägstrich am Ende */
function repoFromPath(path: string): string | null {
  const m = /^\/?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(path);
  if (!m || [m[1], m[2]].some(part => part === "." || part === "..")) return null;
  return `${m[1]}/${m[2]}`;
}

/** `besitzer/repo` aus einer GitHub-URL (HTTPS, ssh:// oder git@github.com:), sonst null */
export function githubRepoPath(url: string): string | null {
  const s = url.trim();
  // Query, Fragment, Escapes und Backslashes gehören in keine Klon-URL; sie
  // verschieben beim Zerlegen Host und Pfad (etwa `https://evil.example?@github.com/...`).
  if (!s || /[\s?#%\\]/.test(s)) return null;
  // `.` und `..` als Pfadteil würde der URL-Parser still auflösen
  if (/\/\.{1,2}(?:\/|$)/.test(s)) return null;

  // SCP-Form ohne Protokoll: git@github.com:besitzer/repo
  if (!s.includes("://")) {
    const scp = /^git@github\.com:(.+)$/i.exec(s);
    return scp ? repoFromPath(scp[1]) : null;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const defaultPort = DEFAULT_PORTS[u.protocol];
  if (!defaultPort || u.hostname !== "github.com") return null;
  if (u.port && u.port !== defaultPort) return null;
  if (u.password) return null;
  if (u.protocol === "ssh:" && u.username !== "git") return null;
  return repoFromPath(u.pathname);
}

/** Zeigt die URL auf BRAND.repo? GitHub unterscheidet bei Namen nicht nach Groß- und Kleinschreibung. */
export function isBrandRepoUrl(url: string, repo: string = BRAND.repo): boolean {
  const path = githubRepoPath(url);
  return path !== null && path.toLowerCase() === repo.toLowerCase();
}
