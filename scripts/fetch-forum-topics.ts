/**
 * Fetch all forum topics (ID + name) of a Telegram group via MTProto.
 *
 * The Bot API cannot list forum topics, so this uses your USER account
 * (GramJS + api_id/api_hash from my.telegram.org). First run asks for your
 * phone number and the login code Telegram sends to your app; the session
 * is then saved to data/telegram-user.session (gitignored) so later runs
 * need no login.
 *
 * Usage:
 *   bun run scripts/fetch-forum-topics.ts [chatId]
 *
 * chatId defaults to the first chat in config/topics.json. Output: a table
 * of topic IDs + names, the current agent mapping, and data/topic-names.json
 * (id → name) for later reference.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { createInterface } from "readline/promises";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

const ROOT = process.cwd();
const SESSION_FILE = join(ROOT, "data", "telegram-user.session");
const TOPICS_CONFIG = join(ROOT, "config", "topics.json");
const NAMES_FILE = join(ROOT, "data", "topic-names.json");

const apiId = parseInt(process.env.TELEGRAM_API_ID || "", 10);
const apiHash = process.env.TELEGRAM_API_HASH || "";
if (!apiId || !apiHash) {
  console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH fehlen in .env");
  process.exit(1);
}

function loadTopicsConfig(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(readFileSync(TOPICS_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

const config = loadTopicsConfig();
const chatId =
  process.argv[2] || Object.keys(config).find((k) => k !== "*") || "";
if (!chatId) {
  console.error("Keine Chat-ID: als Argument uebergeben oder in config/topics.json anlegen");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const savedSession = existsSync(SESSION_FILE)
  ? readFileSync(SESSION_FILE, "utf-8").trim()
  : "";

const client = new TelegramClient(new StringSession(savedSession), apiId, apiHash, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: () => rl.question("Telefonnummer (mit +49...): "),
  password: () => rl.question("2FA-Passwort (falls gesetzt): "),
  phoneCode: () => rl.question("Login-Code aus der Telegram-App: "),
  onError: (err) => console.error("Login-Fehler:", err.message),
});
rl.close();

writeFileSync(SESSION_FILE, client.session.save() as unknown as string);
chmodSync(SESSION_FILE, 0o600);

let entity;
try {
  entity = await client.getEntity(Number(chatId));
} catch {
  // Entity not cached yet — walk the dialog list once to populate it.
  for await (const dialog of client.iterDialogs({})) {
    if (String(dialog.id) === chatId) {
      entity = dialog.entity;
      break;
    }
  }
  if (!entity) {
    console.error(`Gruppe ${chatId} nicht in deinen Dialogen gefunden`);
    process.exit(1);
  }
}

const names: Record<string, string> = {};
let offsetTopic = 0;
let offsetId = 0;
let offsetDate = 0;
for (;;) {
  const res = (await client.invoke(
    new Api.channels.GetForumTopics({
      channel: entity,
      limit: 100,
      offsetId,
      offsetDate,
      offsetTopic,
    })
  )) as Api.messages.ForumTopics;

  const topics = res.topics.filter(
    (t): t is Api.ForumTopic => t.className === "ForumTopic"
  );
  for (const t of topics) names[String(t.id)] = t.title;

  if (topics.length < 100 || res.topics.length === 0) break;
  const last = topics[topics.length - 1];
  offsetTopic = last.id;
  offsetId = last.topMessage;
  offsetDate = 0;
}

writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2));

const mapping = config[chatId] || {};
console.log(`\nForum-Topics in ${chatId} (${Object.keys(names).length} gefunden):\n`);
const width = Math.max(...Object.values(names).map((n) => n.length), 10);
for (const [id, title] of Object.entries(names).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const agent = mapping[id] ? `→ ${mapping[id]}` : "→ (nicht gemappt)";
  console.log(`  ${id.padStart(6)}  ${title.padEnd(width)}  ${agent}`);
}
console.log(`\nNamen gespeichert in ${NAMES_FILE}`);

await client.disconnect();
process.exit(0);
