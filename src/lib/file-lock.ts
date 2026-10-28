/**
 * Sperre ueber eine Datei, die mehrere Prozesse teilen (Bot und
 * Sprach-Bruecke schreiben data/pending-reviews.json, Issue #53).
 *
 * Die Sperrdatei nennt ihren Besitzer (Zufallstoken und PID). Entstehen
 * geht nur ganz oder gar nicht: der Inhalt wird in eine eigene Datei
 * geschrieben und per link() an den Sperrpfad gehaengt, das scheitert
 * atomar, wenn dort schon eine Sperre liegt.
 *
 * Wer eine Sperre entfernt, prueft vorher den Besitzer:
 * - Der Besitzer selbst entfernt nur seine eigene Sperre (releaseFileLock).
 * - Veraltet ist eine Sperre, wenn ihr Prozess nicht mehr lebt. Aufbrechen
 *   darf sie nur, wer die Aufbruch-Sperre "<pfad>.break-<token>" haelt, und
 *   nur, wenn am Pfad noch genau diese Sperre liegt. Sieht ein zweiter
 *   Prozess dieselbe alte Sperre, nachdem sie schon ersetzt ist, findet er
 *   dort ein anderes Token und laesst die neue Sperre stehen.
 * Die Aufbruch-Sperre ist selbst eine solche Sperre; stirbt ihr Halter,
 * wird sie auf demselben Weg aufgebrochen.
 *
 * Ein lebender, aber haengender Besitzer wird nie verdraengt: Wartende
 * geben nach waitMs mit einem Fehler auf.
 */

import { link, readFile, unlink, writeFile } from "fs/promises";
import { randomUUID } from "crypto";

export interface LockOwner {
  token: string;
  pid: number;
}

export interface FileLockOptions {
  /** Lebt der Prozess noch? Standard: process.kill(pid, 0) */
  isAlive?: (pid: number) => boolean;
  /** Wie lange auf eine belegte Sperre gewartet wird */
  waitMs?: number;
  pollMs?: number;
  /** Nur fuer Tests: eine veraltete Sperre wurde erkannt, gleich wird aufgebrochen */
  onStale?: (path: string, owner: LockOwner) => Promise<void> | void;
}

type Resolved = Required<Omit<FileLockOptions, "onStale">> & Pick<FileLockOptions, "onStale">;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM: der Prozess lebt, gehoert nur jemand anderem
    return error?.code === "EPERM";
  }
}

function resolve(opts: FileLockOptions): Resolved {
  return { isAlive: pidAlive, waitMs: 5_000, pollMs: 25, ...opts };
}

/** Besitzer am Pfad; null, wenn dort keine Sperre liegt; "unknown", wenn unlesbar. */
export async function readLockOwner(path: string): Promise<LockOwner | null | "unknown"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    return "unknown";
  }
  try {
    const owner = JSON.parse(raw);
    if (typeof owner?.token === "string" && typeof owner?.pid === "number") return owner;
  } catch {}
  return "unknown";
}

async function tryCreate(path: string, me: LockOwner): Promise<boolean> {
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify(me), { flag: "wx", mode: 0o600 });
  try {
    await link(staging, path);
    return true;
  } catch (error: any) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(staging).catch(() => {});
  }
}

/** Ein Versuch ohne Warten; bricht veraltete Sperren auf. null: belegt. */
async function tryLock(path: string, o: Resolved): Promise<LockOwner | null> {
  const me: LockOwner = { token: randomUUID(), pid: process.pid };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await tryCreate(path, me)) return me;
    const owner = await readLockOwner(path);
    if (owner === null) continue; // gerade freigegeben
    if (owner === "unknown" || o.isAlive(owner.pid)) return null;
    await o.onStale?.(path, owner);
    await breakStaleLock(path, owner, o);
  }
  return null;
}

async function breakStaleLock(path: string, stale: LockOwner, o: Resolved): Promise<void> {
  const marker = `${path}.break-${stale.token}`;
  const breaker = await tryLock(marker, o);
  if (!breaker) return; // ein anderer bricht gerade auf
  try {
    const current = await readLockOwner(path);
    if (current !== null && current !== "unknown" && current.token === stale.token) {
      await unlink(path).catch(() => {});
    }
  } finally {
    await releaseFileLock(marker, breaker);
  }
}

/** Wartet, bis die Sperre frei ist, und haelt sie dann. Wirft nach waitMs. */
export async function acquireFileLock(path: string, opts: FileLockOptions = {}): Promise<LockOwner> {
  const o = resolve(opts);
  const started = Date.now();
  for (;;) {
    const me = await tryLock(path, o);
    if (me) return me;
    if (Date.now() - started > o.waitMs) throw new Error(`Sperre ${path} belegt`);
    await new Promise(r => setTimeout(r, o.pollMs));
  }
}

/** Gibt die Sperre frei, aber nur die eigene. false: dort liegt eine fremde oder keine. */
export async function releaseFileLock(path: string, me: LockOwner): Promise<boolean> {
  const current = await readLockOwner(path);
  if (current === null || current === "unknown" || current.token !== me.token) return false;
  await unlink(path).catch(() => {});
  return true;
}
