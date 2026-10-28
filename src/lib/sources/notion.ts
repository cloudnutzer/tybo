/**
 * Quelle Notion (Issue #354): Aufgaben aus einer Notion-Datenbank, die
 * heute oder früher fällig und nicht erledigt sind, die früheste zuerst,
 * höchstens MAX_TASKS. Bereit mit NOTION_TOKEN und NOTION_DATABASE_ID.
 *
 * Erwartetes Schema der Datenbank: eine Datumseigenschaft „Due", eine
 * Status-Eigenschaft „Status" mit dem Wert „Done" für erledigt, dazu die
 * Titel-Eigenschaft (Name beliebig). „Heute" ist der Tag in USER_TIMEZONE;
 * Notion vergleicht reine Daten ohne Uhrzeit, ein Termin mit Uhrzeit zählt
 * mit seinem Tag.
 */
import { dayIn } from "./run";
import type { Env, Section, SectionItem, Source, SourceContext } from "./types";

export const MAX_TASKS = 10;
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

interface NotionText {
  plain_text?: string;
}

interface NotionProperty {
  type?: string;
  title?: NotionText[];
  date?: { start?: string | null } | null;
}

interface NotionPage {
  url?: string;
  properties?: Record<string, NotionProperty>;
}

const filled = (value: string | undefined) => !!value?.trim();

/** Text der Titel-Eigenschaft, gleich wie sie heißt */
function titleOf(page: NotionPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property?.type !== "title") continue;
    const text = (property.title ?? []).map(part => part.plain_text ?? "").join("").trim();
    if (text) return text;
  }
  return "(ohne Titel)";
}

function toItem(page: NotionPage, today: string): SectionItem {
  const item: SectionItem = { text: titleOf(page) };
  const start = page.properties?.Due?.date?.start;
  if (start) {
    item.due = start.slice(0, 10);
    if (item.due < today) item.overdue = true;
  }
  if (page.url) item.link = page.url;
  return item;
}

const notionHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
});

/** Abfrage: fällig bis heute, nicht erledigt, die früheste zuerst */
function dueQuery(today: string) {
  const dueUntilToday = { property: "Due", date: { on_or_before: today } };
  const notDone = { property: "Status", status: { does_not_equal: "Done" } };
  return { filter: { and: [dueUntilToday, notDone] }, sorts: [{ property: "Due", direction: "ascending" }], page_size: MAX_TASKS };
}

export const notionSource: Source = {
  id: "notion-tasks",
  label: "Notion Tasks",
  timeoutMs: 15_000,
  ready: (env: Env) => filled(env.NOTION_TOKEN) && filled(env.NOTION_DATABASE_ID),
  async collect(ctx: SourceContext): Promise<Section> {
    const today = dayIn(ctx.now, ctx.timeZone);
    const database = encodeURIComponent(ctx.env.NOTION_DATABASE_ID!.trim());
    const response = await ctx.fetch(`${NOTION_API}/databases/${database}/query`, {
      method: "POST",
      signal: ctx.signal,
      headers: notionHeaders(ctx.env.NOTION_TOKEN!.trim()),
      body: JSON.stringify(dueQuery(today)),
    });
    // Den Antworttext nicht übernehmen: er kann Angaben zur Datenbank enthalten
    if (response.status === 401) throw new Error("Notion lehnt den Zugang ab (401), NOTION_TOKEN prüfen");
    if (!response.ok) throw new Error(`Notion antwortet mit HTTP ${response.status}`);
    const data = (await response.json()) as { results?: NotionPage[] };
    const pages = Array.isArray(data.results) ? data.results : [];
    return { items: pages.slice(0, MAX_TASKS).map(page => toItem(page, today)) };
  },
};
