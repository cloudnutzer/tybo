/** Issue #491: Wissensdatei mit Grenze und Cache, mit Uhr-Attrappe. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeCache, KNOWLEDGE_CACHE_TTL_MS, KNOWLEDGE_PROMPT_LIMIT } from "../src/lib/voice-agents/knowledge";

let root: string;
let clock: number;
const recipe = (kennung: string, name = "wissen.md") => ({ kennung, wissen: { datei: `data/voice-agents/${kennung}/${name}` } });
const file = (kennung: string, name = "wissen.md") => join(root, kennung, name);
const FIXED_TIME = new Date("2026-10-30T12:00:00Z");

async function put(kennung: string, text: string, name = "wissen.md") {
  await mkdir(join(root, kennung), { recursive: true });
  await writeFile(file(kennung, name), text);
  // Gleiche Änderungszeit: Der Test unterscheidet sonst nicht, ob Ablauf oder Dateiänderung gewirkt hat
  await utimes(file(kennung, name), FIXED_TIME, FIXED_TIME);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wissen-"));
  clock = 1_000_000;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const cache = () => createKnowledgeCache({ dataDir: root, now: () => clock });

describe("Grenze", () => {
  test("40.000 Zeichen im Prompt, 40.001 nicht", async () => {
    const load = cache();
    await put("a", "x".repeat(KNOWLEDGE_PROMPT_LIMIT));
    expect((await load(recipe("a"))).status).toBe("prompt");
    await put("b", "x".repeat(KNOWLEDGE_PROMPT_LIMIT + 1));
    expect(await load(recipe("b"))).toEqual({ status: "zu-gross" });
  });

  test("gezählt werden Zeichen, nicht Bytes", async () => {
    await put("a", "ä".repeat(KNOWLEDGE_PROMPT_LIMIT));
    expect((await cache()(recipe("a"))).status).toBe("prompt");
  });

  test("sehr große Datei: zu groß", async () => {
    await put("a", "x".repeat(KNOWLEDGE_PROMPT_LIMIT * 4 + 1));
    expect(await cache()(recipe("a"))).toEqual({ status: "zu-gross" });
  });
});

describe("Cache", () => {
  test("gleiche Datei: aus dem Cache, bis er abläuft", async () => {
    const load = cache();
    await put("a", "alt");
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "alt" });
    // Gleiche Größe, gleiche Zeit: nur der Ablauf kann das bemerken
    await put("a", "neu");
    clock += KNOWLEDGE_CACHE_TTL_MS - 1;
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "alt" });
    clock += 1;
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "neu" });
  });

  test("Dateiänderung wirkt sofort, über Größe und über Änderungszeit", async () => {
    const load = cache();
    await put("a", "alt");
    await load(recipe("a"));
    await put("a", "viel länger");
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "viel länger" });
    await writeFile(file("a"), "VIEL LÄNGER");
    await utimes(file("a"), new Date("2026-10-30T13:00:00Z"), new Date("2026-10-30T13:00:00Z"));
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "VIEL LÄNGER" });
  });

  test("Datei, die über die Grenze wächst, fällt sofort aus dem Prompt", async () => {
    const load = cache();
    await put("a", "klein");
    await load(recipe("a"));
    await put("a", "x".repeat(KNOWLEDGE_PROMPT_LIMIT + 1));
    expect(await load(recipe("a"))).toEqual({ status: "zu-gross" });
  });

  test("Rezeptwechsel: andere Kennung und andere Datei bekommen nie den alten Inhalt", async () => {
    const load = cache();
    await put("a", "aaa");
    await put("b", "bbb");
    await put("a", "ccc", "anderes.md");
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "aaa" });
    expect(await load(recipe("b"))).toEqual({ status: "prompt", text: "bbb" });
    expect(await load(recipe("a", "anderes.md"))).toEqual({ status: "prompt", text: "ccc" });
    expect(await load(recipe("a"))).toEqual({ status: "prompt", text: "aaa" });
  });

  test("gelöschte Datei ist sofort weg", async () => {
    const load = cache();
    await put("a", "aaa");
    await load(recipe("a"));
    await rm(file("a"));
    expect(await load(recipe("a"))).toEqual({ status: "fehlt" });
  });
});

describe("sichere Zugriffe", () => {
  test("einem symbolischen Link wird nicht gefolgt", async () => {
    await put("a", "aaa", "echt.md");
    await symlink(file("a", "echt.md"), file("a"));
    expect(await cache()(recipe("a"))).toEqual({ status: "fehlt" });
  });

  test("auch ein verlinkter Agentenordner zählt nicht", async () => {
    await put("a", "aaa");
    await symlink(join(root, "a"), join(root, "b"));
    expect(await cache()(recipe("b"))).toEqual({ status: "fehlt" });
  });

  test("Pfadteile im Namen verlassen den Agentenordner nicht", async () => {
    await put("a", "aaa");
    await put("b", "geheim");
    expect(await cache()({ kennung: "a", wissen: { datei: "../b/wissen.md" } })).toEqual({ status: "prompt", text: "aaa" });
  });

  test("leer oder ohne Datei im Rezept: fehlt", async () => {
    await put("a", "  \n");
    expect(await cache()(recipe("a"))).toEqual({ status: "fehlt" });
    expect(await cache()({ kennung: "a" })).toEqual({ status: "fehlt" });
  });
});
