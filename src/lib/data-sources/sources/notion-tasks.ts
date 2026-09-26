/**
 * Notion Tasks Data Source
 *
 * Fetches due and overdue tasks from a Notion database.
 * Uses Notion REST API directly — no MCP needed.
 *
 * Required env vars: NOTION_TOKEN, NOTION_DATABASE_ID
 */

import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const notionTasksSource: DataSource = {
  id: "notion-tasks",
  name: "Notion Tasks",
  emoji: "✅",

  isAvailable(): boolean {
    return !!(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);
  },

  async fetch(): Promise<DataSourceResult> {
    const token = process.env.NOTION_TOKEN!;
    const databaseId = process.env.NOTION_DATABASE_ID!;
    const today = new Date().toISOString().split("T")[0]; // "2026-02-13"

    // Query for tasks that are not done and due today or overdue
    const response = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: "Due",
                date: { on_or_before: today },
              },
              {
                property: "Status",
                status: { does_not_equal: "Done" },
              },
            ],
          },
          sorts: [{ property: "Due", direction: "ascending" }],
          page_size: 10,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Notion API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const pages = data.results || [];

    if (pages.length === 0) {
      return { lines: ["No tasks due today"], meta: { count: 0 } };
    }

    const lines = pages.map((page: any) => {
      const title = extractTitle(page);
      const due = page.properties?.Due?.date?.start || "";
      const isOverdue = due < today;
      const prefix = isOverdue ? "⚠️ OVERDUE" : "📋";
      const dueLabel = due ? ` (${due})` : "";
      return `• ${prefix} ${title}${dueLabel}`;
    });

    const overdue = pages.filter(
      (p: any) => (p.properties?.Due?.date?.start || "") < today
    ).length;

    return {
      lines,
      meta: { count: pages.length, overdue },
    };
  },
};

function extractTitle(page: any): string {
  // Notion titles can be in various property names
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

register(notionTasksSource);
