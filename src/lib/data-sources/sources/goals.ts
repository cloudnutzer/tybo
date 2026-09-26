/**
 * Goals Data Source
 *
 * Fetches active goals from Supabase memory table.
 * Falls back to local memory.json if Supabase is unavailable.
 *
 * Required env vars: SUPABASE_URL, SUPABASE_ANON_KEY
 * Fallback: reads memory.json from project root
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { supabaseHeaders } from "../../supabase-keys";
import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();

const goalsSource: DataSource = {
  id: "goals",
  name: "Active Goals",
  emoji: "🎯",

  isAvailable(): boolean {
    // Always available — has local fallback
    return true;
  },

  async fetch(): Promise<DataSourceResult> {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    // Try Supabase first
    if (supabaseUrl && supabaseKey) {
      try {
        const response = await fetch(
          `${supabaseUrl}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=5`,
          {
            headers: supabaseHeaders(supabaseKey),
          }
        );

        if (response.ok) {
          const data = await response.json();
          if (data.length === 0) {
            return { lines: ["No active goals"], meta: { count: 0 } };
          }
          const lines = data.map((g: any) => {
            const deadline = g.metadata?.deadline
              ? ` (${g.metadata.deadline})`
              : "";
            return `• ${g.content}${deadline}`;
          });
          return { lines, meta: { count: data.length } };
        }
      } catch {
        // Fall through to local
      }
    }

    // Local fallback
    try {
      const content = await readFile(
        join(PROJECT_ROOT, "memory.json"),
        "utf-8"
      );
      const memory = JSON.parse(content);
      const goals =
        memory.goals?.map(
          (g: any) =>
            `• ${g.text}${g.deadline ? ` (${g.deadline})` : ""}`
        ) || [];
      return {
        lines: goals.length > 0 ? goals : ["No active goals"],
        meta: { count: goals.length, source: "local" },
      };
    } catch {
      return { lines: ["No goals tracked yet"], meta: { count: 0 } };
    }
  },
};

register(goalsSource);
