/**
 * Bildbeschreibung per Vision-Modell (Issue #318). Gebraucht, wo Claude die
 * Datei nicht selbst lesen kann, also im VPS-Gateway: das Bild geht als
 * Base64 an die Anthropic-API (bei Ausfall OpenRouter, resilient-client.ts),
 * zurück kommen Beschreibung, Schlagwörter und ein vorgeschlagenes Projekt.
 * Auf dem Mac liest Claude das Bild selbst und liefert [ASSET_DESC]
 * (src/lib/assets/tags.ts).
 *
 * Wirft nie: ohne Schlüssel, bei Fehlern oder unbrauchbarer Antwort gilt
 * der Bildtext des Nutzers bzw. ein fester Ersatztext als Beschreibung.
 */
import { readFile } from "node:fs/promises";
import { visionMediaType } from "./file-types";

/** Beschreibung, Schlagwörter und vorgeschlagenes Projekt (null: keins) */
export type VisionResult = { description: string; tags: string[]; suggestedProject: string | null };

/** Modell für die Beschreibung, unverändert aus der früheren asset-store.ts */
export const VISION_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 400;
/** Längster Rohtext, der als Beschreibung übernommen wird, wenn kein JSON kommt */
const RAW_TEXT_LIMIT = 500;

export interface VisionRequest {
  model: string;
  prompt: string;
  mediaType: string;
  base64: string;
}

export interface DescribeDeps {
  env?: Record<string, string | undefined>;
  /** Schickt Bild und Auftrag an das Modell, gibt dessen Text zurück */
  ask?: (request: VisionRequest) => Promise<string>;
}

async function askResilient(request: VisionRequest): Promise<string> {
  const { createResilientMessage } = await import("../resilient-client");
  const answer = await createResilientMessage({
    model: request.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: request.prompt },
          {
            type: "image",
            source: { type: "base64", media_type: request.mediaType as "image/jpeg", data: request.base64 },
          },
        ],
      },
    ],
  });
  for (const block of answer.content) if (block.type === "text") return block.text;
  return "";
}

/** Bildtyp aus der Endung des Namens, unbekannt gilt als JPEG */
export const imageMediaType = visionMediaType;

/** Auftrag an das Modell: Bildtext und Gesprächsverlauf als Zusammenhang, Antwort als JSON */
export function visionPrompt(caption?: string, recentContext?: string): string {
  const sections: string[] = [];
  if (caption) sections.push(`The user's message that came with this image: "${caption}"\nKeep it in mind while looking at the image.`);
  if (recentContext) sections.push(`What was said before:\n${recentContext}`);
  sections.push(
    [
      "Write a short note about this image so it can be found again later. Cover:",
      "- what can be seen (things, people, screens, documents)",
      "- any readable text",
      `- what it is probably for${caption ? ", above all with regard to the user's message" : ""}`,
      "",
      "Answer with JSON only, in this shape:",
      '{"description": "one or two sentences", "tags": ["keyword", "keyword"], "suggestedProject": "project name or null"}',
    ].join("\n"),
  );
  return sections.join("\n\n");
}

/** Erstes JSON-Objekt im Text, auch hinter Codezäunen oder Vorrede; sonst null */
function firstObject(text: string): Record<string, unknown> | null {
  const attempts = [text.replace(/```(?:json)?\s*/g, "").trim()];
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) attempts.push(text.slice(open, close + 1));
  for (const candidate of attempts) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // nächster Versuch
    }
  }
  return null;
}

/** Antwort des Modells in ein Ergebnis übersetzen; ohne JSON zählt der bereinigte Text */
export function readVisionAnswer(text: string, caption?: string): VisionResult {
  const parsed = firstObject(text);
  if (parsed) {
    const description = typeof parsed.description === "string" && parsed.description ? parsed.description : caption || "Image";
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [];
    const project = typeof parsed.suggestedProject === "string" && parsed.suggestedProject ? parsed.suggestedProject : null;
    return { description, tags, suggestedProject: project };
  }
  const plain = text.replace(/[*_#`]/g, "").trim().slice(0, RAW_TEXT_LIMIT);
  return { description: plain || caption || "Image", tags: [], suggestedProject: null };
}

const fallback = (description: string): VisionResult => ({ description, tags: [], suggestedProject: null });

/** Beschreibung eines Bildes aus dem Speicher; filename bestimmt nur den Bildtyp */
export async function describeImageBytes(
  bytes: Uint8Array,
  filename: string,
  caption?: string,
  recentContext?: string,
  deps: DescribeDeps = {},
): Promise<VisionResult> {
  const env = deps.env ?? process.env;
  if (!env.ANTHROPIC_API_KEY && !env.OPENROUTER_API_KEY) {
    console.warn("[Bilder] Kein ANTHROPIC_API_KEY oder OPENROUTER_API_KEY, Bild bleibt ohne Beschreibung");
    return fallback(caption || "Image (no description available)");
  }
  try {
    const ask = deps.ask ?? askResilient;
    const text = await ask({
      model: VISION_MODEL,
      prompt: visionPrompt(caption, recentContext),
      mediaType: imageMediaType(filename),
      base64: Buffer.from(bytes).toString("base64"),
    });
    return readVisionAnswer(text, caption);
  } catch (err) {
    console.error("[Bilder] Beschreibung gescheitert:", err instanceof Error ? err.message : "Fehler");
    return fallback(caption || "Image (description failed)");
  }
}

/** Beschreibung eines Bildes von der Platte; nicht lesbar ergibt den Ersatztext */
export async function describeImageFile(
  path: string,
  caption?: string,
  recentContext?: string,
  deps: DescribeDeps = {},
): Promise<VisionResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    console.error("[Bilder] Datei nicht lesbar:", err instanceof Error ? err.message : "Fehler");
    return fallback(caption || "Image (description failed)");
  }
  return describeImageBytes(bytes, path, caption, recentContext, deps);
}
