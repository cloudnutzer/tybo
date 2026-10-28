/**
 * Issue #318: Bildbeschreibung (src/lib/assets/describe.ts) und der Tag
 * [ASSET_DESC] (src/lib/assets/tags.ts). Kein Netz: der Vision-Aufruf ist
 * eine Attrappe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as layer from "../src/lib/asset-store";
import {
  describeImageBytes,
  describeImageFile,
  imageMediaType,
  readVisionAnswer,
  VISION_MODEL,
  visionPrompt,
  type VisionRequest,
} from "../src/lib/assets/describe";
import { parseAssetDescTag, stripAssetDescTag } from "../src/lib/assets/tags";

const KEY = { ANTHROPIC_API_KEY: "attrappe" };

describe("parseAssetDescTag", () => {
  test("Beschreibung und kommagetrennte Schlagwörter", () => {
    expect(parseAssetDescTag("Schön!\n\n[ASSET_DESC: Hund am Strand | hund, strand ,  meer]")).toEqual({
      description: "Hund am Strand",
      tags: ["hund", "strand", "meer"],
    });
  });

  test("ohne senkrechten Strich: keine Schlagwörter", () => {
    expect(parseAssetDescTag("[ASSET_DESC: Nur Text]")).toEqual({ description: "Nur Text", tags: [] });
  });

  test("leere Schlagwörter fallen weg", () => {
    expect(parseAssetDescTag("[ASSET_DESC: Bild | , a,,b, ]")).toEqual({ description: "Bild", tags: ["a", "b"] });
  });

  test("mehrere Tags: der erste zählt", () => {
    expect(parseAssetDescTag("[ASSET_DESC: eins | a] [ASSET_DESC: zwei | b]")).toEqual({ description: "eins", tags: ["a"] });
  });

  test("kein Tag, offener Tag oder leerer Tag: null", () => {
    expect(parseAssetDescTag("Antwort ohne Tag")).toBeNull();
    expect(parseAssetDescTag("[ASSET_DESC: offen")).toBeNull();
    expect(parseAssetDescTag("[ASSET_DESC:]")).toBeNull();
    expect(parseAssetDescTag("[REMEMBER: x]")).toBeNull();
  });
});

describe("stripAssetDescTag", () => {
  test("entfernt alle Tags samt Leerraum, außen getrimmt", () => {
    expect(stripAssetDescTag("Katze. [ASSET_DESC: Katze | tier]")).toBe("Katze.");
    expect(stripAssetDescTag("  Antwort. [ASSET_DESC: z]  ")).toBe("Antwort.");
    expect(stripAssetDescTag("Drei.\n[ASSET_DESC: a]\n[ASSET_DESC: b | c]")).toBe("Drei.");
    expect(stripAssetDescTag("A [ASSET_DESC: x] B")).toBe("AB");
  });

  test("andere Tags bleiben", () => {
    expect(stripAssetDescTag("Text [REMEMBER: x]")).toBe("Text [REMEMBER: x]");
  });
});

describe("Antwort des Vision-Modells lesen", () => {
  test("sauberes JSON", () => {
    expect(readVisionAnswer('{"description":"Ein Kessel","tags":["heizung"],"suggestedProject":"Haus"}')).toEqual({
      description: "Ein Kessel",
      tags: ["heizung"],
      suggestedProject: "Haus",
    });
  });

  test("JSON hinter Codezaun oder mit Vorrede", () => {
    expect(readVisionAnswer('```json\n{"description":"A","tags":[]}\n```').description).toBe("A");
    expect(readVisionAnswer('Hier ist es: {"description":"B","tags":["x"],"suggestedProject":null} fertig')).toEqual({ description: "B", tags: ["x"], suggestedProject: null });
  });

  test("JSON ohne Beschreibung: Bildtext, sonst Image; Schlagwörter nur Texte", () => {
    expect(readVisionAnswer('{"tags":["a",3]}', "Mein Bild")).toEqual({ description: "Mein Bild", tags: ["a"], suggestedProject: null });
    expect(readVisionAnswer('{"tags":"kein array"}').description).toBe("Image");
  });

  test("kein JSON: Rohtext ohne Markdown-Zeichen, höchstens 500 Zeichen", () => {
    expect(readVisionAnswer("**Ein** _Hund_ #am `Strand`")).toEqual({ description: "Ein Hund am Strand", tags: [], suggestedProject: null });
    expect(readVisionAnswer("x".repeat(800)).description).toHaveLength(500);
    expect(readVisionAnswer("  ", "Bildtext").description).toBe("Bildtext");
  });
});

describe("describeImageBytes", () => {
  test("schickt Modell, Bildtyp, Base64 und Auftrag mit Bildtext und Verlauf", async () => {
    const seen: VisionRequest[] = [];
    const result = await describeImageBytes(new Uint8Array([1, 2, 3]), "foto.PNG", "Was ist das?", "vorher: Heizung", {
      env: KEY,
      ask: async request => {
        seen.push(request);
        return '{"description":"Heizkessel","tags":["heizung"],"suggestedProject":null}';
      },
    });
    expect(result).toEqual({ description: "Heizkessel", tags: ["heizung"], suggestedProject: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe(VISION_MODEL);
    expect(VISION_MODEL).toBe("claude-opus-5-5");
    expect(seen[0].mediaType).toBe("image/png");
    expect(seen[0].base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(seen[0].prompt).toContain('"Was ist das?"');
    expect(seen[0].prompt).toContain("vorher: Heizung");
    expect(seen[0].prompt).toContain("JSON");
  });

  test("ohne Schlüssel: kein Aufruf, Bildtext oder Ersatztext", async () => {
    let asked = false;
    const ask = async () => {
      asked = true;
      return "";
    };
    expect((await describeImageBytes(new Uint8Array([1]), "a.jpg", "Bildtext", undefined, { env: {}, ask })).description).toBe("Bildtext");
    expect((await describeImageBytes(new Uint8Array([1]), "a.jpg", undefined, undefined, { env: {}, ask })).description).toBe("Image (no description available)");
    expect(asked).toBe(false);
  });

  test("OpenRouter allein reicht", async () => {
    const result = await describeImageBytes(new Uint8Array([1]), "a.jpg", undefined, undefined, {
      env: { OPENROUTER_API_KEY: "attrappe" },
      ask: async () => '{"description":"ok"}',
    });
    expect(result.description).toBe("ok");
  });

  test("Aufruf scheitert: Bildtext oder Ersatztext, keine Ausnahme", async () => {
    const ask = async (): Promise<string> => {
      throw new Error("weg");
    };
    expect((await describeImageBytes(new Uint8Array([1]), "a.jpg", "Bildtext", undefined, { env: KEY, ask })).description).toBe("Bildtext");
    expect((await describeImageBytes(new Uint8Array([1]), "a.jpg", undefined, undefined, { env: KEY, ask })).description).toBe("Image (description failed)");
  });
});

describe("describeImageFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-describe-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("liest die Datei und nimmt den Bildtyp aus dem Pfad", async () => {
    const file = join(dir, "bild.webp");
    await writeFile(file, new Uint8Array([7]));
    let type = "";
    await describeImageFile(file, undefined, undefined, {
      env: KEY,
      ask: async request => {
        type = request.mediaType;
        return '{"description":"x"}';
      },
    });
    expect(type).toBe("image/webp");
  });

  test("nicht lesbar: Ersatztext", async () => {
    const result = await describeImageFile(join(dir, "fehlt.jpg"), undefined, undefined, { env: KEY, ask: async () => "" });
    expect(result).toEqual({ description: "Image (description failed)", tags: [], suggestedProject: null });
  });
});

describe("Hilfen", () => {
  test("Bildtyp aus der Endung, unbekannt JPEG", () => {
    expect(imageMediaType("a.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("a.GIF")).toBe("image/gif");
    expect(imageMediaType("a.heic")).toBe("image/jpeg");
    expect(imageMediaType("ohne")).toBe("image/jpeg");
  });

  test("Auftrag ohne Bildtext und Verlauf nennt beides nicht", () => {
    const prompt = visionPrompt();
    expect(prompt).not.toContain("user's message that came");
    expect(prompt).not.toContain("What was said before");
  });
});

describe("Schicht asset-store.ts", () => {
  test("Tag-Funktionen und Beschreibung kommen aus src/lib/assets", () => {
    expect(layer.parseAssetDescTag).toBe(parseAssetDescTag);
    expect(layer.stripAssetDescTag).toBe(stripAssetDescTag);
    expect(layer.describeImageFromBuffer).toBe(describeImageBytes);
    expect(layer.describeImage).toBe(describeImageFile);
  });
});
