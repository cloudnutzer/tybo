import { authorizeBearer, processRequestSchema } from "./http-security";
import type { z } from "zod";

export function createProcessHandler(options: {
  secret: () => string;
  allowChat: (id: string) => boolean;
  process: (message: z.infer<typeof processRequestSchema>) => Promise<void>;
  capacity?: number;
}) {
  let pending = 0;
  return async (req: Request): Promise<Response> => {
    const denied = authorizeBearer(req, options.secret());
    if (denied) return denied;
    let parsed;
    try {
      const raw = await req.text();
      if (Buffer.byteLength(raw) > 64 * 1024) return new Response("Too large", { status: 413 });
      parsed = processRequestSchema.safeParse(JSON.parse(raw));
    } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!parsed.success) return new Response("Invalid message", { status: 400 });
    if (!options.allowChat(parsed.data.chatId)) return new Response("Forbidden chat", { status: 403 });
    if (pending >= (options.capacity ?? 16)) return new Response("Busy", { status: 429, headers: { "Retry-After": "5" } });
    pending++;
    Promise.resolve().then(() => options.process(parsed.data))
      .catch(error => console.error("/process failed", error))
      .finally(() => { pending--; });
    return Response.json({ accepted: true }, { status: 202 });
  };
}
