/**
 * Gmail Data Source
 *
 * Fetches unread email count and top subjects via Gmail REST API.
 * Uses Google OAuth refresh token — no MCP or Keychain needed.
 *
 * Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

import { register } from "../registry";
import { isGoogleAuthAvailable, getGoogleAccessToken } from "../google-auth";
import type { DataSource, DataSourceResult } from "../types";

const gmailSource: DataSource = {
  id: "gmail",
  name: "Gmail (Unread)",
  emoji: "📧",

  isAvailable(): boolean {
    return isGoogleAuthAvailable();
  },

  async fetch(): Promise<DataSourceResult> {
    const token = await getGoogleAccessToken();

    // Fetch unread messages (max 10 for summary)
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=10",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const total = data.resultSizeEstimate || 0;
    const messageIds: string[] =
      data.messages?.map((m: any) => m.id).slice(0, 5) || [];

    if (total === 0) {
      return { lines: ["Inbox zero — no unread emails"], meta: { count: 0 } };
    }

    // Fetch subjects for top messages
    const subjects = await Promise.all(
      messageIds.map(async (id) => {
        try {
          const msgResp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!msgResp.ok) return null;
          const msg = await msgResp.json();
          const headers = msg.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "(no subject)";
          const from =
            headers.find((h: any) => h.name === "From")?.value || "";
          // Extract just the name from "Name <email>"
          const fromName = from.replace(/<.*>/, "").trim() || from;
          return `• ${fromName}: ${subject}`;
        } catch {
          return null;
        }
      })
    );

    const lines = subjects.filter(Boolean) as string[];
    if (total > 5) {
      lines.push(`_...and ${total - 5} more unread_`);
    }

    return {
      lines:
        lines.length > 0 ? lines : [`${total} unread emails`],
      meta: { count: total },
    };
  },
};

register(gmailSource);
