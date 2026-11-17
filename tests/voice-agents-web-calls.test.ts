/** Issue #491: Web-Freigabe je Gesprächs-ID und Rezept, mit Uhr-Attrappe. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWebCalls, issueWebCall, isValidConversationId, verifyWebCall, WEB_CALL_MAX_TTL_MS, type WebCallOptions } from "../src/lib/voice-agents/web-calls";

const REF = { conversationId: "conv_abc123", kennung: "jarvis" };
const MINUTE = 60_000;

let root: string;
let clock: number;
let options: WebCallOptions;
const dir = (kennung = "jarvis") => join(root, kennung, "web-calls");
const onlyFile = async (kennung = "jarvis") => (await readdir(dir(kennung)))[0]!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-calls-"));
  clock = 1_000_000;
  options = { dataDir: root, token: "bruecken-token", now: () => clock };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("Prüfen", () => {
  test("gültig bis kurz vor dem Ablauf, danach nicht mehr", async () => {
    const { ablauf } = await issueWebCall(REF, 10 * MINUTE, options);
    expect(ablauf).toBe(clock + 10 * MINUTE);
    expect(await verifyWebCall(REF, options)).toBe(true);
    clock = ablauf - 1;
    expect(await verifyWebCall(REF, options)).toBe(true);
    clock = ablauf;
    expect(await verifyWebCall(REF, options)).toBe(false);
  });

  test("ohne Freigabe nichts, auch ohne Ordner", async () => {
    expect(await verifyWebCall(REF, options)).toBe(false);
  });

  test("fremde Gesprächs-ID", async () => {
    await issueWebCall(REF, MINUTE, options);
    expect(await verifyWebCall({ ...REF, conversationId: "conv_anders" }, options)).toBe(false);
  });

  test("anderes Rezept, auch mit kopierter Datei", async () => {
    await issueWebCall(REF, MINUTE, options);
    const other = { ...REF, kennung: "trainer" };
    await issueWebCall({ ...other, conversationId: "conv_platzhalter" }, MINUTE, options);
    expect(await verifyWebCall(other, options)).toBe(false);
    const name = await onlyFile();
    await copyFile(join(dir(), name), join(dir("trainer"), name));
    expect(await verifyWebCall(other, options)).toBe(false);
  });

  test("umbenannte Datei gilt nicht für eine andere Gesprächs-ID", async () => {
    await issueWebCall({ ...REF, conversationId: "conv_anders" }, MINUTE, options);
    const source = await onlyFile();
    await issueWebCall(REF, MINUTE, options);
    const target = (await readdir(dir())).find((name) => name !== source)!;
    await copyFile(join(dir(), source), join(dir(), target));
    expect(await verifyWebCall(REF, options)).toBe(false);
  });

  test("manipuliert: Ablauf verlängert, Prüfsumme geändert, beschädigt", async () => {
    await issueWebCall(REF, MINUTE, options);
    const path = join(dir(), await onlyFile());
    const original = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...original, ablauf: original.ablauf + 60 * MINUTE }));
    expect(await verifyWebCall(REF, options)).toBe(false);
    await writeFile(path, JSON.stringify({ ...original, mac: "00".repeat(32) }));
    expect(await verifyWebCall(REF, options)).toBe(false);
    await writeFile(path, JSON.stringify({ ...original, mac: "zz" }));
    expect(await verifyWebCall(REF, options)).toBe(false);
    await writeFile(path, "kein json");
    expect(await verifyWebCall(REF, options)).toBe(false);
    await writeFile(path, JSON.stringify(original));
    expect(await verifyWebCall(REF, options)).toBe(true);
  });

  test("anderer oder fehlender Schlüssel", async () => {
    await issueWebCall(REF, MINUTE, options);
    expect(await verifyWebCall(REF, { ...options, token: "anderes-token" })).toBe(false);
    expect(await verifyWebCall(REF, { ...options, token: "" })).toBe(false);
  });

  test("einem symbolischen Link wird nicht gefolgt", async () => {
    await issueWebCall(REF, MINUTE, options);
    const path = join(dir(), await onlyFile());
    const elsewhere = join(root, "anderswo.json");
    await copyFile(path, elsewhere);
    await rm(path);
    await symlink(elsewhere, path);
    expect(await verifyWebCall(REF, options)).toBe(false);
  });

  test("fehlende oder nicht aufgelöste Gesprächs-IDs zählen nie", async () => {
    for (const id of ["", " ", "{{system__conversation_id}}", "system__conversation_id", "a/../b", "x".repeat(201)]) {
      expect(isValidConversationId(id)).toBe(false);
      expect(await verifyWebCall({ ...REF, conversationId: id }, options)).toBe(false);
      await expect(issueWebCall({ ...REF, conversationId: id }, MINUTE, options)).rejects.toThrow("Gesprächs-ID");
    }
    await expect(verifyWebCall({ ...REF, kennung: "../jarvis" }, options)).resolves.toBe(false);
  });
});

describe("Ausstellen", () => {
  test("ohne Schlüssel oder Laufzeit keine Freigabe", async () => {
    await expect(issueWebCall(REF, MINUTE, { ...options, token: "" })).rejects.toThrow("VOICE_BRIDGE_TOKEN");
    await expect(issueWebCall(REF, 0, options)).rejects.toThrow("Laufzeit");
  });

  test("die Laufzeit ist gedeckelt", async () => {
    const { ablauf } = await issueWebCall(REF, 365 * 24 * 60 * MINUTE, options);
    expect(ablauf).toBe(clock + WEB_CALL_MAX_TTL_MS);
  });

  test("das Token steht nicht in der Datei, die Ablage liegt beim Rezept", async () => {
    await issueWebCall(REF, MINUTE, options);
    const content = await readFile(join(dir(), await onlyFile()), "utf8");
    expect(content).not.toContain("bruecken-token");
    expect(JSON.parse(content)).toMatchObject({ rezept: "jarvis", gespraech: "conv_abc123" });
  });
});

describe("Aufräumen", () => {
  test("entfernt Abgelaufenes und Unlesbares, Gültiges bleibt", async () => {
    await issueWebCall({ ...REF, conversationId: "conv_kurz" }, MINUTE, options);
    await issueWebCall(REF, 10 * MINUTE, options);
    await writeFile(join(dir(), `${"a".repeat(64)}.json`), "kaputt");
    await writeFile(join(dir(), "fremd.txt"), "bleibt");
    clock += 2 * MINUTE;
    expect(await cleanupWebCalls("jarvis", options)).toBe(2);
    expect(await verifyWebCall(REF, options)).toBe(true);
    expect((await readdir(dir())).sort()).toContain("fremd.txt");
    expect((await readdir(dir())).length).toBe(2);
  });

  test("Ausstellen räumt mit auf", async () => {
    await issueWebCall({ ...REF, conversationId: "conv_alt" }, MINUTE, options);
    clock += 2 * MINUTE;
    await issueWebCall(REF, MINUTE, options);
    expect((await readdir(dir())).length).toBe(1);
  });

  test("ohne Ordner nichts zu tun", async () => {
    expect(await cleanupWebCalls("jarvis", options)).toBe(0);
  });
});
