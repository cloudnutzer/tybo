import { reserveBudget, settleBudget } from "./daily-budget";
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";

export function isWhatsAppOwner(number: string): boolean {
  const normalize = (s: string) => s.replace(/^whatsapp:/, "").replace(/\s/g, "");
  const owner = process.env.WHATSAPP_OWNER_NUMBER || process.env.WHATSAPP_USER_NUMBER;
  return !!owner && normalize(number) === normalize(owner);
}

function guestDatabase() {
  mkdirSync("data", { recursive: true });
  const db = new Database("data/guest-history.sqlite", { create: true });
  chmodSync("data/guest-history.sqlite", 0o600);
  db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, scope TEXT, role TEXT, content TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS messages_scope ON messages(scope,id)");
  return db;
}

export function saveGuestMessage(scope: string, role: string, content: string): void {
  const db = guestDatabase();
  try {
    db.query("INSERT INTO messages(scope,role,content) VALUES (?,?,?)").run(scope, role, content);
    db.query("DELETE FROM messages WHERE scope=? AND id NOT IN (SELECT id FROM messages WHERE scope=? ORDER BY id DESC LIMIT 20)").run(scope, scope);
  } finally { db.close(); }
}

/** Guests never enter the local CLI, MCP, owner memory, or intent pipeline. */
export async function answerGuest(scope: string, message: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return "Der Gäste-Assistent ist derzeit nicht verfügbar.";
  const db = guestDatabase();
  let history: { role: string; content: string }[];
  try {
    history = db.query("SELECT role,content FROM (SELECT id,role,content FROM messages WHERE scope=? ORDER BY id DESC LIMIT 10) ORDER BY id").all(scope) as typeof history;
  } finally { db.close(); }
  // The caller may already have stored this message.
  if (history.at(-1)?.content !== message) history.push({ role: "user", content: message });
  const reservation = reserveBudget("whatsapp-guest", Number(process.env.GUEST_REQUEST_RESERVATION_USD || "0.25"));
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.WHATSAPP_GUEST_MODEL || process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7",
      messages: [{ role: "system", content: "Du bist ein hilfreicher WhatsApp-Assistent für Gäste. Antworte kurz. Du hast ausschließlich diesen Gesprächskontext und keine Werkzeuge oder persönlichen Daten des Betreibers." }, ...history], max_tokens: 2048 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Guest provider: ${response.status}`);
  const data = await response.json() as { usage?: { cost?: number }; choices?: { message?: { content?: string } }[] };
  settleBudget(reservation, data.usage?.cost);
  return data.choices?.[0]?.message?.content || "Keine Antwort erhalten.";
}
