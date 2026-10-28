/**
 * Quelle Gmail (Issue #355): ungelesene Mails im Posteingang. Der Abschnitt
 * zeigt höchstens MAX_SHOWN davon mit Absender und Betreff, die Gesamtzahl
 * steht in total. Bereit, wenn der Google-Zugang eingerichtet ist
 * (src/lib/google/token.ts).
 *
 * Scheitert der Abruf einer einzelnen Mail, fehlt nur dieser Eintrag; die
 * Gesamtzahl bleibt. Ein Abbruch durch das Signal bricht dagegen alles ab.
 */
import { googleAccessToken, googleReady } from "../google/token";
import type { Env, Section, SectionItem, Source, SourceContext } from "./types";

const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
/** So viele Kennungen holt die Liste */
export const LIST_SIZE = 10;
/** So viele Mails werden im Einzelnen abgerufen */
export const MAX_SHOWN = 5;

interface Header {
  name?: string;
  value?: string;
}

/** Name aus „Name <adresse>"; ohne Namen die ganze Angabe */
export function senderName(from: string): string {
  const open = from.indexOf("<");
  const close = from.lastIndexOf(">");
  if (open < 0 || close < open) return from.trim() || from;
  return (from.slice(0, open) + from.slice(close + 1)).trim() || from;
}

const header = (headers: Header[], name: string) =>
  headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

export const gmailSource: Source = {
  id: "gmail",
  label: "Gmail (Unread)",
  ready: (env: Env) => googleReady(env),
  async collect(ctx: SourceContext): Promise<Section> {
    const token = await googleAccessToken({ env: ctx.env, fetch: ctx.fetch, signal: ctx.signal });
    const request = { signal: ctx.signal, headers: { Authorization: `Bearer ${token}` } };

    const listQuery = new URLSearchParams({ q: "is:unread in:inbox", maxResults: String(LIST_SIZE) });
    const response = await ctx.fetch(`${MESSAGES_URL}?${listQuery}`, request);
    // Antworttext nicht übernehmen: er kann Angaben zum Postfach enthalten
    if (response.status === 401) throw new Error("Gmail lehnt den Zugang ab (401), Google-Zugang prüfen");
    if (!response.ok) throw new Error(`Gmail antwortet mit HTTP ${response.status}`);
    const list = (await response.json()) as { resultSizeEstimate?: number; messages?: { id?: string }[] };
    const total = typeof list.resultSizeEstimate === "number" && list.resultSizeEstimate > 0 ? list.resultSizeEstimate : 0;
    if (total === 0) return { items: [], total: 0 };

    const ids = (Array.isArray(list.messages) ? list.messages : [])
      .map(message => message?.id)
      .filter((id): id is string => typeof id === "string" && id !== "")
      .slice(0, MAX_SHOWN);

    const describe = async (id: string): Promise<SectionItem | undefined> => {
      try {
        const detail = await ctx.fetch(
          `${MESSAGES_URL}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          request,
        );
        if (!detail.ok) return undefined;
        const message = (await detail.json()) as { payload?: { headers?: Header[] } };
        const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
        const subject = header(headers, "Subject") || "(ohne Betreff)";
        return { text: `${senderName(header(headers, "From"))}: ${subject}` };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return undefined;
      }
    };

    const described = await Promise.all(ids.map(describe));
    return { items: described.filter((item): item is SectionItem => item !== undefined), total };
  },
};
