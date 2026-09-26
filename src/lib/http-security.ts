import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeBearer(req: Request, secret: string): Response | null {
  if (!secret) return new Response("Integration not configured", { status: 503 });
  return secretMatches(req.headers.get("authorization"), `Bearer ${secret}`)
    ? null : new Response("Unauthorized", { status: 401 });
}

export const processRequestSchema = z.object({
  text: z.string().max(32_000).optional(),
  chatId: z.union([z.string().regex(/^-?\d+$/), z.number().int().safe()]).transform(String),
  threadId: z.number().int().positive().optional(),
  photoFileId: z.string().min(1).max(512).optional(),
}).strict().refine(x => !!x.text?.trim() || !!x.photoFileId, "Message required");

export function allowedChat(chatId: string): boolean {
  return [process.env.TELEGRAM_USER_ID, process.env.TELEGRAM_CHAT_ID,
    ...(process.env.GATEWAY_ALLOWED_CHAT_IDS || "").split(",")]
    .filter(Boolean).map(x => x!.trim()).includes(chatId);
}

export function verifyElevenLabs(body: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = header.split(",").map(x => x.trim());
  const timestamp = parts.find(x => x.startsWith("t="))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return parts.some(x => x.startsWith("v0=") && secretMatches(x.slice(3), digest));
}
