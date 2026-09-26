/**
 * Custom Data Source Template
 *
 * Copy this file, rename it, and implement your own data source.
 * It will auto-register when imported in the registry index.
 *
 * Steps:
 * 1. Copy this file: cp custom.example.ts my-source.ts
 * 2. Implement isAvailable() and fetch()
 * 3. Add your env vars to .env
 * 4. Import it in src/lib/data-sources/sources/index.ts
 *
 * Your source will appear in the morning briefing automatically
 * when its required env vars are set.
 */

import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const customSource: DataSource = {
  // Unique ID — used internally
  id: "my-custom-source",

  // Display name — shown as the section header
  name: "My Custom Source",

  // Emoji — prepended to the section header
  emoji: "🔌",

  // Return true when all required env vars are present
  isAvailable(): boolean {
    return !!process.env.MY_CUSTOM_API_KEY;
  },

  // Fetch data and return formatted bullet points
  async fetch(): Promise<DataSourceResult> {
    const apiKey = process.env.MY_CUSTOM_API_KEY!;

    // Example: call your API
    // const response = await fetch("https://api.example.com/data", {
    //   headers: { Authorization: `Bearer ${apiKey}` },
    // });
    // const data = await response.json();

    return {
      lines: [
        "• First item from your source",
        "• Second item",
      ],
      meta: { count: 2 },
    };
  },
};

// Uncomment this line to activate:
// register(customSource);
