import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
/**
 * Google OAuth Setup Helper
 *
 * Interactive script to help users get their Google OAuth refresh token.
 * This token enables Gmail and Calendar data sources in morning briefings.
 *
 * Run: bun run setup/setup-google-oauth.ts
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createServer } from "http";
import { BRAND } from "../src/brand";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

console.log(`
╔══════════════════════════════════════════════════════════════╗
║          ${`Google OAuth Setup for ${BRAND.name}`.padEnd(51)}║
║          Enables: Gmail + Calendar in morning briefings     ║
╚══════════════════════════════════════════════════════════════╝

This script helps you get a Google OAuth refresh token.
You'll need a Google Cloud project with Gmail and Calendar APIs enabled.

STEPS:
1. Go to https://console.cloud.google.com
2. Create a project (or use existing)
3. Enable "Gmail API" and "Google Calendar API"
4. Go to APIs & Services → Credentials
5. Create an OAuth 2.0 Client ID (Desktop app)
6. Copy the Client ID and Client Secret below
`);

const readline = await import("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

const clientId = await ask("Client ID: ");
const clientSecret = await ask("Client Secret: ");

if (!clientId || !clientSecret) {
  console.error("Both Client ID and Client Secret are required.");
  process.exit(1);
}

const oauthState = randomBytes(32).toString("hex");
const verifier = randomBytes(32).toString("base64url");
// Build authorization URL
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId.trim());
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", oauthState);
authUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
authUrl.searchParams.set("code_challenge_method", "S256");

console.log(`\nOpening browser for authorization...\n`);
console.log(`If it doesn't open automatically, visit:\n${authUrl.toString()}\n`);

// Try to open browser
try {
  const { exec } = await import("child_process");
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${authUrl.toString()}"`);
} catch {}

// Start local server to catch the callback
const code = await new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("Timed out waiting for authorization (120s)"));
  }, 120_000);

  const server = createServer((req, res) => {
    const url = new URL(req.url || "", `http://localhost:${REDIRECT_PORT}`);
    const receivedState = Buffer.from(url.searchParams.get("state") || "");
    if (req.method !== "GET" || url.pathname !== "/callback" || receivedState.length !== oauthState.length || !timingSafeEqual(receivedState, Buffer.from(oauthState))) {
      res.writeHead(403); res.end("Invalid callback"); return;
    }
    const authCode = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("Authorization failed. You can close this tab.");
      clearTimeout(timeout);
      server.close();
      reject(new Error(`Authorization failed: ${error}`));
      return;
    }

    if (authCode) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>`
      );
      clearTimeout(timeout);
      server.close();
      resolve(authCode);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(REDIRECT_PORT, "127.0.0.1", () => {
    console.log(`Waiting for authorization callback on port ${REDIRECT_PORT}...`);
  });
});

// Exchange code for tokens
console.log("\nExchanging authorization code for tokens...");

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    code,
    grant_type: "authorization_code",
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  }),
});

if (!tokenResponse.ok) {
  const text = await tokenResponse.text();
  console.error(`Token exchange failed: ${text}`);
  process.exit(1);
}

const tokens = await tokenResponse.json();

if (!tokens.refresh_token) {
  console.error(
    "No refresh token received. Make sure you selected 'consent' prompt and 'offline' access."
  );
  process.exit(1);
}

console.log("\n✅ Success! Here are your credentials:\n");
console.log(`GOOGLE_CLIENT_ID=${clientId.trim()}`);
console.log(`GOOGLE_CLIENT_SECRET=${clientSecret.trim()}`);
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);

// Offer to save to .env
const save = await ask("\nSave these to .env? (y/n): ");

if (save.toLowerCase() === "y") {
  const envPath = join(PROJECT_ROOT, ".env");
  let envContent = "";
  try {
    envContent = await readFile(envPath, "utf-8");
  } catch {}

  const vars = {
    GOOGLE_CLIENT_ID: clientId.trim(),
    GOOGLE_CLIENT_SECRET: clientSecret.trim(),
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
  };

  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  await writeFile(envPath, envContent);
  console.log(`\n✅ Saved to ${envPath}`);
  console.log("Gmail and Calendar will appear in your next morning briefing.");
}

rl.close();
