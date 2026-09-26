/**
 * Sperre für data/pending-reviews.json (Issue #53, Nachbesserung aus PR #79):
 * veraltete Sperren werden nur mit Besitzerprüfung aufgebrochen, niemand
 * entfernt eine fremde Sperre. Alles in einem Temp-Ordner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireFileLock, pidAlive, readLockOwner, releaseFileLock, type LockOwner } from "../src/lib/file-lock";
import { setPendingReviewsFileForTests, stagePendingReview, takePendingReview } from "../src/lib/session-distill";

const base = mkdtempSync(join(tmpdir(), "file-lock-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const lockPath = () => join(base, `sperre-${++counter}.lock`);

const STALE_PID = 999_999_001;
const isAlive = (pid: number) => pid !== STALE_PID;

function writeStale(path: string, token = "alt"): void {
  writeFileSync(path, JSON.stringify({ token, pid: STALE_PID }));
}

async function tokenAt(path: string): Promise<string | undefined> {
  const owner = await readLockOwner(path);
  return owner && owner !== "unknown" ? owner.token : undefined;
}

describe("Sperre mit Besitzer", () => {
  test("freie Sperre: erwerben, freigeben, keine Reste", async () => {
    const path = lockPath();
    const me = await acquireFileLock(path, { isAlive });
    expect(await tokenAt(path)).toBe(me.token);
    expect(await releaseFileLock(path, me)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(base).filter(f => f.startsWith(path.split("/").pop()!))).toEqual([]);
  });

  test("lebender Besitzer: zweiter wartet und gibt nach waitMs auf, Sperre bleibt", async () => {
    const path = lockPath();
    const a = await acquireFileLock(path, { isAlive });
    await expect(acquireFileLock(path, { isAlive, waitMs: 60, pollMs: 5 })).rejects.toThrow("belegt");
    expect(await tokenAt(path)).toBe(a.token);
  });

  test("Freigabe entfernt nie eine fremde Sperre", async () => {
    const path = lockPath();
    const a = await acquireFileLock(path, { isAlive });
    const fremd: LockOwner = { token: "fremd", pid: process.pid };
    expect(await releaseFileLock(path, fremd)).toBe(false);
    expect(await tokenAt(path)).toBe(a.token);
  });

  test("veraltete Sperre (Prozess tot) wird aufgebrochen", async () => {
    const path = lockPath();
    writeStale(path);
    const me = await acquireFileLock(path, { isAlive });
    expect(await tokenAt(path)).toBe(me.token);
  });

  test("Standardprüfung: PID eines beendeten Prozesses gilt als tot", async () => {
    const dead = Bun.spawnSync(["true"]).pid;
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(dead)).toBe(false);
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "alt", pid: dead }));
    const me = await acquireFileLock(path);
    expect(await tokenAt(path)).toBe(me.token);
  });

  test("A und B sehen dieselbe alte Sperre: B entfernt As neue Sperre nicht und tritt nicht ein", async () => {
    const path = lockPath();
    writeStale(path);

    // B erkennt die alte Sperre und hält genau vor dem Aufbrechen an
    let bSawStale!: () => void;
    const bStale = new Promise<void>(r => (bSawStale = r));
    let resumeB!: () => void;
    const bResume = new Promise<void>(r => (resumeB = r));
    let bHolds = false;
    const b = acquireFileLock(path, {
      isAlive,
      waitMs: 5_000,
      pollMs: 5,
      onStale: async (p, owner) => {
        if (p !== path || owner.token !== "alt") return;
        bSawStale();
        await bResume;
      },
    }).then(owner => {
      bHolds = true;
      return owner;
    });
    await bStale;

    // A erkennt dieselbe alte Sperre, bricht sie auf und erwirbt eine neue
    const a = await acquireFileLock(path, { isAlive });
    expect(await tokenAt(path)).toBe(a.token);

    // B macht weiter: findet am Pfad As Token, lässt die Sperre stehen und wartet
    resumeB();
    await new Promise(r => setTimeout(r, 100));
    expect(bHolds).toBe(false);
    expect(await tokenAt(path)).toBe(a.token);

    // Erst nach As Freigabe tritt B ein
    expect(await releaseFileLock(path, a)).toBe(true);
    const bOwner = await b;
    expect(bOwner.token).not.toBe(a.token);
    expect(await tokenAt(path)).toBe(bOwner.token);
    await releaseFileLock(path, bOwner);
  });

  test("Aufbruch-Sperre eines toten Prozesses blockiert nicht dauerhaft", async () => {
    const path = lockPath();
    writeStale(path, "alt");
    writeStale(`${path}.break-alt`, "brecher");
    const me = await acquireFileLock(path, { isAlive, waitMs: 1_000, pollMs: 5 });
    expect(await tokenAt(path)).toBe(me.token);
    expect(existsSync(`${path}.break-alt`)).toBe(false);
  });
});

describe("Ablage der Vorschläge", () => {
  test("veraltete Sperre an der Ablage: Vorschlag wird trotzdem gespeichert, Sperre danach frei", async () => {
    const file = join(base, "pending.json");
    setPendingReviewsFileForTests(file);
    try {
      writeFileSync(`${file}.lock`, JSON.stringify({ token: "alt", pid: Bun.spawnSync(["true"]).pid }));
      await stagePendingReview({ id: "r1", type: "memory", chatId: "1", tags: "[REMEMBER: x]", createdAt: Date.now() });
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect((await takePendingReview("r1"))?.tags).toBe("[REMEMBER: x]");
    } finally {
      setPendingReviewsFileForTests(null);
    }
  });
});
