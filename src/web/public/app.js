// Chat-Seite der WebUI (Issue #5, Design #13): Verlauf, Senden, Live-Ereignisse,
// Stopp, Seitenleiste mit den Web-Gesprächen, Schalter Hell/Dunkel (#15).
// Telegram-Gespräche lesen (#18) und schreiben, gespiegelt nach Telegram (#19).
// Neue Nachrichten aus Telegram live, Aktivität und Neu-Punkt in der Seitenleiste (#20).
// Web-Gespräche verwalten: Agent beim Anlegen wählen, umbenennen, löschen (#21).
// Unter jeder Antwort Agent, Modell, Dauer und ein Kopieren-Knopf (#22).
// Meldungen und Dateien anderer Dienste als ruhige Notiz mit Download (#47).
// Einstellungen (#38): Ansicht aus settings.js unter #/einstellungen/agenten,
// „Agent ändern …" im Topic-Menü; Reiter Modelle und Status (#39).
// Hinweis „Neue Version“ mit „Neu laden“, Entwürfe überstehen das Neuladen (#111).
// Reines JavaScript ohne Abhängigkeiten. Nutzertext, Fehler, Fortschritt und
// Hinweise kommen immer über textContent in die Seite; nur das vom Server
// gerenderte und bereinigte HTML einer Antwort (message.html) wird eingesetzt.
"use strict";

// Werkzeugnamen aus dem Fortschritt: rohe Namen (Attrappe) und die
// englischen Anzeigenamen aus src/lib/claude.ts
const TOOL_LABELS = {
  Read: "Datei lesen",
  "Reading file": "Datei lesen",
  Write: "Datei schreiben",
  "Writing file": "Datei schreiben",
  Edit: "Datei bearbeiten",
  "Editing file": "Datei bearbeiten",
  Glob: "Dateien suchen",
  "Searching files": "Dateien suchen",
  Grep: "Code durchsuchen",
  "Searching code": "Code durchsuchen",
  Bash: "Befehl ausführen",
  "Running command": "Befehl ausführen",
  WebSearch: "Websuche",
  "Searching the web": "Websuche",
  WebFetch: "Seite abrufen",
  "Fetching page": "Seite abrufen",
  Task: "Aufgabe weitergeben",
  "Delegating task": "Aufgabe weitergeben",
  AskUserQuestion: "Rückfrage",
  "Asking a question": "Rückfrage",
};

const MAX_INPUT_LINES = 8;
/** Text, den der Server nach einem Stopp speichert (ABORTED_TEXT in src/web/chat.ts) */
const STOPPED_TEXT = "Abgebrochen.";
const RECONNECT_MAX_MS = 10_000;
/** Höchstzahl Rückfragen je Stand-Abfrage, wie MAX_CHOICE_SNAPSHOT in server.ts */
const CHOICE_SNAPSHOT_MAX = 200;
/** Kennung einer Rückfrage, wie CHOICE_ID_PATTERN in src/web/store.ts */
const CHOICE_ID_PATTERN = /^[A-Za-z0-9]{1,12}$/;

// --- Neue Version (Issue #111) ----------------------------------------------

/** Oberflächen-Version des Servers (src/web/ui-version.ts) */
const UI_VERSION_PATH = "/api/version";
const UI_VERSION_PATTERN = /^[0-9a-f]{16}$/;
/** Prüfen beim Sichtbarwerden des Tabs höchstens so oft; Wiederverbinden prüft immer */
const VERSION_CHECK_MIN_MS = 60_000;
/** Rückfrage vor dem Neuladen, wenn der Entwurfsspeicher versagt */
const DRAFTS_LOST_TEXT = "Entwürfe ließen sich nicht sichern und gehen verloren.";
/** Entwürfe über das Neuladen per Hinweis-Knopf, nur in diesem Tab (sessionStorage) */
const RELOAD_DRAFTS_KEY = "tybo-reload-drafts";

/** Version aus dem Meta-Tag der geladenen Seite; null, wenn keine da ist */
function pageUiVersion(meta) {
  const value = meta && typeof meta.getAttribute === "function" ? meta.getAttribute("content") : null;
  return typeof value === "string" && UI_VERSION_PATTERN.test(value) ? value : null;
}

/** Entwürfe (ID → Text) als Text für sessionStorage; null ohne Entwurf */
function serializeReloadDrafts(drafts) {
  const out = {};
  let any = false;
  for (const [id, text] of drafts) {
    if (typeof id !== "string" || typeof text !== "string" || !text) continue;
    out[id] = text;
    any = true;
  }
  return any ? JSON.stringify({ drafts: out }) : null;
}

/** Gesicherte Entwürfe lesen; Unlesbares ergibt eine leere Liste */
function parseReloadDrafts(raw) {
  const result = new Map();
  if (typeof raw !== "string" || !raw) return result;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  const drafts = parsed && typeof parsed === "object" ? parsed.drafts : null;
  if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return result;
  for (const [id, text] of Object.entries(drafts)) {
    if (typeof text === "string" && text) result.set(id, text);
  }
  return result;
}

/** Deutscher Name für einen Werkzeugschritt. */
function toolLabel(name) {
  const raw = String(name || "").trim();
  if (TOOL_LABELS[raw]) return TOOL_LABELS[raw];
  if (raw.startsWith("mcp__")) return "Werkzeug: " + (raw.split("__")[1] || "MCP").replace(/[-_]/g, " ");
  if (raw.startsWith("Using ")) return "Werkzeug: " + raw.slice(6);
  return raw || "Werkzeug";
}

/** Abkürzungen, die groß geschrieben werden (wie agentLabel in src/web/agents.ts) */
const AGENT_ACRONYMS = { cto: "CTO", coo: "COO", cfo: "CFO", ceo: "CEO", cmo: "CMO" };
/** Anzeigenamen aus GET /api/agents, sobald geladen */
const agentLabels = new Map();

/** Anzeigename des Agenten, z.B. "general" wird "General", "cto" wird "CTO". */
function agentLabel(agent) {
  const a = String(agent || "");
  if (!a) return "";
  if (agentLabels.has(a)) return agentLabels.get(a);
  if (Object.prototype.hasOwnProperty.call(AGENT_ACRONYMS, a)) return AGENT_ACRONYMS[a];
  return a.charAt(0).toUpperCase() + a.slice(1);
}

/**
 * true, wenn rev nicht älter ist als have ({ boot, seq } vom Server), wie
 * isNotOlder in settings.js: späterer Prozess neuer, sonst höhere seq; ohne
 * Nummer auf einer Seite übernehmen.
 */
function revisionNotOlder(have, rev) {
  const valid = r => !!r && typeof r.boot === "number" && typeof r.seq === "number";
  if (!valid(have) || !valid(rev)) return true;
  if (rev.boot !== have.boot) return rev.boot > have.boot;
  return rev.seq >= have.seq;
}

/** Standardtitel eines Web-Gesprächs (DEFAULT_TITLE in src/web/store.ts) */
const DEFAULT_TITLE = "Neues Gespräch";
/** Obergrenze für einen von Hand gesetzten Titel (CUSTOM_TITLE_MAX_CHARS in src/web/store.ts) */
const TITLE_MAX_CHARS = 80;
/** Gültige Agentennamen (AGENT_NAME_PATTERN in src/web/agents.ts) */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Titel wie der Server: Leerraum (auch Zeilenumbrüche und Steuerzeichen)
 * zusammenziehen, außen abschneiden, dann 1 bis 80 Zeichen (Codepoints).
 * null, wenn ungültig.
 */
function normalizeTitle(value) {
  const clean = String(value == null ? "" : value).replace(/[\s\p{Cc}]+/gu, " ").trim();
  const length = [...clean].length;
  return length >= 1 && length <= TITLE_MAX_CHARS ? clean : null;
}

/** Telegram erlaubt 1 bis 128 Zeichen für Topic-Namen (TOPIC_TITLE_MAX_CHARS in src/web/topics.ts) */
const TOPIC_TITLE_MAX_CHARS = 128;

/**
 * Topic-Titel wie der Server (normalizeTopicTitle in src/web/topics.ts):
 * nur außen Leerraum abschneiden, 1 bis 128 Zeichen, keine Steuerzeichen.
 * null, wenn ungültig.
 */
function normalizeTopicTitle(value) {
  const clean = String(value == null ? "" : value).trim();
  const length = [...clean].length;
  if (length < 1 || length > TOPIC_TITLE_MAX_CHARS || /\p{Cc}/u.test(clean)) return null;
  return clean;
}

/** Topic außer General: lässt sich umbenennen, schließen und löschen (Entscheidung 0005) */
function isManagedTopicId(id) {
  const match = /^topic-([1-9][0-9]{0,9})$/.exec(String(id));
  return !!match && Number(match[1]) > 1;
}

/** Umbenennen geht bei Web-Gesprächen und Topics, nicht bei General und dem Direktchat */
function canRenameId(id) {
  return !isTelegramId(id) || isManagedTopicId(id);
}

/** Drei Punkte für die Menü-Knöpfe an den Gesprächseinträgen, wie im Menü der Kopfzeile */
function moreIcon() {
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const cx of [5, 12, 19]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "1.2");
    svg.appendChild(dot);
  }
  return svg;
}

/** Schloss für geschlossene Topics, gezeichnet wie die übrigen Icons */
function lockIcon() {
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(ns, "rect");
  for (const [k, v] of [["x", "5"], ["y", "11"], ["width", "14"], ["height", "10"], ["rx", "2"]]) body.setAttribute(k, v);
  svg.appendChild(body);
  const shackle = document.createElementNS(ns, "path");
  shackle.setAttribute("d", "M8 11V7a4 4 0 0 1 8 0v4");
  svg.appendChild(shackle);
  return svg;
}

// ---------------------------------------------------------------------------
// Telegram-Gespräche in der Seitenleiste (Issue #18)
// ---------------------------------------------------------------------------

/** Topics mit Aktivität in diesen Tagen stehen oben, die übrigen unter „Ältere Topics" */
const RECENT_TOPIC_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Name aus src/brand.ts, gesetzt von /brand.js (Issue #100); erst beim Gebrauch gelesen */
function brandName() {
  return window.TYBO_BRAND.name;
}
/** Zuletzt geöffnetes Gespräch, pro Browser; Schlüssel bleibt trotz Umbenennung (Issue #100) */
const LAST_CONVERSATION_KEY = "tybo-last-conversation";
/** Telegram-Gespräche mit Neu-Punkt, pro Browser, damit er ein Neuladen übersteht */
// Schlüssel bleibt trotz Umbenennung (Issue #100)
const UNREAD_KEY = "tybo-unread";
/** Sammelstrom mit der letzten Aktivität aller Telegram-Gespräche (TELEGRAM_ACTIVITY_PATH in server.ts) */
const ACTIVITY_EVENTS_PATH = "/api/telegram/events";

/** Direktchat ("dm") und Topics ("topic-<n>") kommen aus Telegram, alles andere ist ein Web-Gespräch. */
function isTelegramId(id) {
  return id === "dm" || /^topic-[1-9][0-9]{0,9}$/.test(String(id));
}

/**
 * Millisekunden eines ISO-Zeitpunkts; Mikrosekunden (Postgres) werden für
 * die Rechnung auf Millisekunden gekürzt. NaN bei allem anderen.
 */
function parseTime(value) {
  if (typeof value !== "string" || !value) return NaN;
  return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
}

/**
 * Sortierschlüssel für createdAt: Nachkommastellen auf sechs Stellen
 * aufgefüllt, sonst sortiert ".123Z" als Text hinter ".123001Z".
 */
function timeKey(value) {
  return String(value || "").replace(/\.(\d{1,6})Z$/, (_, f) => "." + f.padEnd(6, "0") + "Z");
}

/**
 * Letzte Aktivität relativ zu now: „gerade eben", „vor 5 Min.", „vor 3 Std."
 * (heute), „gestern", „12.9." (dieses Jahr), „12.9.2025". Kalendertage in der
 * Zeitzone des Browsers. Leer bei fehlendem oder ungültigem Zeitpunkt.
 */
function relativeTime(value, now) {
  const time = parseTime(value);
  if (!Number.isFinite(time)) return "";
  const nowMs = typeof now === "number" ? now : Date.now();
  const diff = Math.max(0, nowMs - time);
  if (diff < 60 * 1000) return "gerade eben";
  if (diff < 60 * 60 * 1000) return "vor " + Math.floor(diff / 60000) + " Min.";
  const date = new Date(time);
  const today = new Date(nowMs);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= startOfToday) return "vor " + Math.floor(diff / (60 * 60 * 1000)) + " Std.";
  const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (time >= startOfYesterday) return "gestern";
  const day = date.getDate() + "." + (date.getMonth() + 1) + ".";
  return date.getFullYear() === today.getFullYear() ? day : day + date.getFullYear();
}

/**
 * Teilt die Topics: aktuell ist, wessen letzte Aktivität höchstens 30 Tage
 * (genau 30 × 24 Stunden eingeschlossen) zurückliegt. Ohne bekannte
 * Aktivität (null, ungültig) gilt ein Topic als älter; es wird kein Datum
 * erfunden. Die Reihenfolge des Servers bleibt erhalten.
 * Issue #30: Geschlossene Topics stehen immer unter „Ältere Topics". In
 * diesem Browser angelegte Topics (pinned, IDs) stehen, solange sie noch
 * keine Aktivität haben, ganz oben, auch nach jedem Abgleich der Liste.
 */
function splitTopics(topics, now, pinned) {
  const nowMs = typeof now === "number" ? now : Date.now();
  const isPinned = id => !!pinned && typeof pinned.has === "function" && pinned.has(id);
  const top = [];
  const recent = [];
  const older = [];
  for (const t of Array.isArray(topics) ? topics : []) {
    if (!t || typeof t !== "object") continue;
    const time = parseTime(t.lastActivity);
    if (t.closed === true) older.push(t);
    else if (Number.isFinite(time) && nowMs - time <= RECENT_TOPIC_DAYS * DAY_MS) recent.push(t);
    else if (!Number.isFinite(time) && isPinned(t.id)) top.push(t);
    else older.push(t);
  }
  // Zuletzt angelegtes zuerst (Set in Reihenfolge des Anlegens)
  if (top.length > 1) {
    const order = [...pinned];
    top.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id));
  }
  return { recent: top.concat(recent), older };
}

/**
 * Setzt die letzte Aktivität eines Topics nach vorne und sortiert es wie der
 * Server ein: jüngste Aktivität zuerst, ohne Aktivität am Ende. Ein älterer
 * Zeitpunkt als der bekannte ändert nichts. Gibt die neue Liste zurück, die
 * übergebene bleibt unverändert; false, wenn das Topic fehlt.
 */
function applyTopicActivity(topics, id, lastActivity) {
  const list = Array.isArray(topics) ? topics.slice() : [];
  const index = list.findIndex(t => t && t.id === id);
  if (index < 0) return false;
  const current = list[index];
  if (current.lastActivity && timeKey(current.lastActivity) >= timeKey(lastActivity)) return list;
  const updated = Object.assign({}, current, { lastActivity });
  list.splice(index, 1);
  const key = timeKey(lastActivity);
  let at = list.findIndex(t => !t.lastActivity || timeKey(t.lastActivity) < key);
  if (at < 0) at = list.length;
  list.splice(at, 0, updated);
  return list;
}

/** Filter der Seitenleiste: Teilstring im Titel, ohne Groß/Klein; leerer Filter passt immer. */
function matchesFilter(title, filter) {
  const f = String(filter || "").trim().toLocaleLowerCase("de");
  return !f || String(title || "").toLocaleLowerCase("de").includes(f);
}

/**
 * Einzige Stelle, an der HTML in die Seite kommt: das vom Server gerenderte
 * und bereinigte message.html von Antworten und Meldungen. Ohne es der Text.
 */
function setServerHtml(body, message) {
  if (typeof message.html === "string") {
    body.innerHTML = message.html;
  } else {
    body.textContent = String(message.text ?? "");
  }
}

// ---------------------------------------------------------------------------
// Meldungen und Dateien (Issue #47, Entscheidung 0006)
// ---------------------------------------------------------------------------

/** Anzeigenamen der Absender; unbekannte Kennungen erscheinen, wie sie sind */
const NOTICE_SOURCES = {
  pipeline: "Pipeline",
  briefing: "Briefing",
  checkin: "Check-in",
  watchdog: "Watchdog",
  watcher: "Watcher",
  datei: "Datei",
  befehl: "Befehl",
  ziel: "Ziel",
  // Rückfragen aus dem Register (Issue #115, source wie CHOICE_SOURCES in src/lib/telegram-choices.ts)
  freigabe: "Freigabe",
  review: "Vorschlag",
  topic: "Topic",
};

/**
 * Steuerbefehle, die auch während einer Antwort und während Rückfragen
 * ([INVOKE:]) rausgehen: /stop bzw. /abbruch allein (Issue #74), dazu
 * /goal pause und /goal stop samt Aliasen (Issue #76, wie goalUnscoped im Register)
 */
function isUrgentCommand(text) {
  const value = String(text || "").trim();
  return /^\/(stop|abbruch)(@\S+)?$/i.test(value) || /^\/goal(@\S+)?\s+(pause|stop|cancel|done|abbrechen)$/i.test(value);
}

// ---------------------------------------------------------------------------
// Befehlsliste beim Tippen von / (Issue #77)
// ---------------------------------------------------------------------------

/**
 * Befehle, die nur die Oberfläche kennt und nie zum Server gehen
 * (Entscheidung 0013): /b64 macht aus Base64-Code ein Bild (Issue #73).
 * Form wie die Einträge aus GET /api/commands.
 */
const LOCAL_COMMANDS = [
  { name: "b64", aliases: [], description: "Bild aus Base64-Code anhängen (für Geräte ohne Bild-Upload)", args: "required", argsHint: "<code>" },
];

/**
 * Einträge aus GET /api/commands in eine feste Form bringen: Name ohne
 * Schrägstrich, klein; unbrauchbare Einträge fallen weg.
 */
function normalizeCommands(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c.name !== "string") continue;
    const name = c.name.trim().replace(/^\//, "").toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    const aliases = Array.isArray(c.aliases)
      ? c.aliases.filter(a => typeof a === "string").map(a => a.trim().replace(/^\//, "").toLowerCase()).filter(Boolean)
      : [];
    out.push({
      name,
      aliases,
      description: typeof c.description === "string" ? c.description : "",
      args: c.args === "optional" || c.args === "required" ? c.args : "none",
      argsHint: typeof c.argsHint === "string" ? c.argsHint : "",
    });
  }
  return out;
}

/** Tippt jemand „/bo" (Schrägstrich am Anfang, noch ohne Leerzeichen): „bo"; sonst null. */
function commandQuery(value) {
  const m = /^\/([^\s/]*)$/.exec(String(value || ""));
  return m ? m[1].toLowerCase() : null;
}

/** Befehle, deren Name oder Alias mit der Eingabe beginnt; Treffer im Namen zuerst, sonst alphabetisch. */
function filterCommands(commands, query) {
  const q = String(query || "").toLowerCase();
  const byName = [];
  const byAlias = [];
  for (const c of commands) {
    if (c.name.startsWith(q)) byName.push(c);
    else if (c.aliases.some(a => a.startsWith(q))) byAlias.push(c);
  }
  const order = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return byName.sort(order).concat(byAlias.sort(order));
}

/** Was nach der Auswahl im Feld steht: mit Argumenten ein Leerzeichen dahinter. */
function commandFill(command) {
  return "/" + command.name + (command.args === "none" ? "" : " ");
}

const FILE_ID_PATTERN =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Vorschau nur für diese Bildtypen (wie die Server-Route mit ?inline=1) */
const PREVIEW_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Absender als Text: bekannte deutsch, unbekannte roh, ohne Angabe „Meldung". */
function noticeSourceLabel(source) {
  const raw = typeof source === "string" ? source.trim() : "";
  if (!raw) return "Meldung";
  return Object.prototype.hasOwnProperty.call(NOTICE_SOURCES, raw) ? NOTICE_SOURCES[raw] : raw;
}

/** Uhrzeit „09:41" in der Zeitzone des Browsers; leer bei ungültigem Zeitpunkt. */
function clockTime(value) {
  const time = parseTime(value);
  if (!Number.isFinite(time)) return "";
  const d = new Date(time);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/**
 * Zeitstempel einer Nachricht (Issue #186) relativ zu now, in der Zeitzone
 * des Browsers: short ist „21:08" (heute), „gestern 21:08", „26.09. 21:08"
 * (dieses Jahr) oder „26.09.2025 21:08"; full das ausgeschriebene Datum für
 * Tooltip und Screenreader, „Samstag, 26. September 2026, 21:08 Uhr".
 * Verglichen werden Kalendertage, nicht 24 Stunden (Sommerzeit, Jahreswechsel).
 * null bei fehlendem oder ungültigem Zeitpunkt.
 */
function messageTime(value, now) {
  const clock = clockTime(value);
  if (!clock) return null;
  const date = new Date(parseTime(value));
  const today = new Date(typeof now === "number" ? now : Date.now());
  const startOfDay = offset => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).getTime();
  const time = date.getTime();
  const two = n => String(n).padStart(2, "0");
  const day = two(date.getDate()) + "." + two(date.getMonth() + 1) + ".";
  let short;
  if (time >= startOfDay(0) && time < startOfDay(1)) short = clock;
  else if (time >= startOfDay(-1) && time < startOfDay(0)) short = "gestern " + clock;
  else if (date.getFullYear() === today.getFullYear()) short = day + " " + clock;
  else short = day + date.getFullYear() + " " + clock;
  const full = WEEKDAYS[date.getDay()] + ", " + date.getDate() + ". " + MONTHS[date.getMonth()] + " " + date.getFullYear() + ", " + clock + " Uhr";
  return { short, full };
}

/** Kalendertag in der Zeitzone des Browsers, z.B. "2026-8-26" (Monat ab 0) */
function localDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

/** Millisekunden bis kurz nach der nächsten lokalen Mitternacht */
function msUntilNextDay(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now + 1000;
}

/**
 * <time> für eine Nachricht: sichtbar die kurze Form (für Screenreader
 * verborgen), dazu das volle Datum als title und als unsichtbarer Text, den
 * Screenreader vorlesen. Nur über textContent. null ohne gültigen Zeitpunkt.
 */
function messageTimeElement(value, className, now) {
  const label = messageTime(value, now);
  if (!label) return null;
  const at = document.createElement("time");
  at.className = className;
  at.setAttribute("datetime", String(value));
  at.setAttribute("title", label.full);
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  shown.textContent = label.short;
  at.appendChild(shown);
  const spoken = document.createElement("span");
  spoken.className = "visually-hidden";
  spoken.textContent = label.full;
  at.appendChild(spoken);
  return at;
}

/** Dateigröße kurz auf Deutsch: „850 Bytes", „12,3 KB", „4,2 MB". */
function formatFileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes + (bytes === 1 ? " Byte" : " Bytes");
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",").replace(/,0$/, "");
  return text + " " + units[unit];
}

/** Bildtyp für die Vorschau, wenn Name und Typ zusammenpassen; sonst null. */
function previewType(file) {
  const match = /\.([a-z0-9]+)$/i.exec(String(file.name || ""));
  const type = match ? PREVIEW_TYPES[match[1].toLowerCase()] : undefined;
  return type && file.mime === type ? type : null;
}

/** Blatt mit Eselsohr, gezeichnet wie die übrigen Icons */
function fileIcon() {
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const sheet = document.createElementNS(ns, "path");
  sheet.setAttribute("d", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z");
  svg.appendChild(sheet);
  const fold = document.createElementNS(ns, "path");
  fold.setAttribute("d", "M14 3v5h5");
  svg.appendChild(fold);
  return svg;
}

/**
 * Karte einer Datei: Name, Größe und „Herunterladen" (Link auf
 * /api/files/<id>, der Server liefert immer als Anhang). Bilder der
 * erlaubten Typen zusätzlich als Vorschau darüber. null bei ungültiger id.
 */
function fileCard(file) {
  if (!file || typeof file !== "object" || typeof file.id !== "string" || !FILE_ID_PATTERN.test(file.id)) return null;
  const href = "/api/files/" + encodeURIComponent(file.id);
  return fileCardElement(file, href, previewType(file) ? href + "?inline=1" : null);
}

/**
 * Karte mit Name, Größe, Herunterladen und, wenn previewHref gesetzt ist, der
 * Vorschau darüber; extra: weitere Elemente vor „Herunterladen"
 */
function fileCardElement(file, href, previewHref, extra) {
  const name = typeof file.name === "string" && file.name ? file.name : "Datei";
  const wrap = document.createElement("div");
  wrap.className = "file";
  if (previewHref) {
    const img = document.createElement("img");
    img.className = "file-preview";
    img.setAttribute("src", previewHref);
    img.setAttribute("alt", name);
    img.setAttribute("loading", "lazy");
    wrap.appendChild(img);
  }
  const card = document.createElement("div");
  card.className = "file-card";
  const icon = fileIcon();
  if (icon) card.appendChild(icon);
  const info = document.createElement("div");
  info.className = "file-info";
  const title = document.createElement("span");
  title.className = "file-name";
  title.textContent = name;
  info.appendChild(title);
  const size = formatFileSize(file.size);
  if (size) {
    const meta = document.createElement("span");
    meta.className = "file-size";
    meta.textContent = size;
    info.appendChild(meta);
  }
  card.appendChild(info);
  const link = document.createElement("a");
  link.className = "quiet-button file-download";
  link.setAttribute("href", href);
  link.setAttribute("download", name);
  link.setAttribute("aria-label", name + " herunterladen");
  link.textContent = "Herunterladen";
  for (const node of extra || []) card.appendChild(node);
  card.appendChild(link);
  wrap.appendChild(card);
  return wrap;
}

// ---------------------------------------------------------------------------
// Anhänge im Web-Chat (Issue #73, Entscheidung 0012)
// ---------------------------------------------------------------------------

const MB = 1048576;
/** Wie MAX_ATTACHMENTS und MEDIA_LIMITS auf dem Server (src/web/attachments.ts, media-check.ts) */
const MAX_ATTACHMENTS = 5;
const ATTACHMENT_LIMITS = { image: 20 * MB, document: 20 * MB, audio: 25 * MB };
const ATTACHMENT_KIND_LABEL = { image: "Bild", document: "PDF", audio: "Sprachdatei" };
const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const AUDIO_EXTENSIONS = ["ogg", "oga", "opus", "m4a", "mp4", "webm", "wav", "mp3", "mpeg"];
/**
 * Lokale Vorschau vor dem Hochladen als data:-URL (die CSP erlaubt für
 * Bilder nur 'self' und data:, kein blob:). Bis zu dieser Größe die Bytes
 * selbst, darüber (bis 20 MB) ein verkleinertes Bild aus einem canvas.
 */
const LOCAL_PREVIEW_MAX_BYTES = 8 * MB;
/** Längste Seite der verkleinerten Vorschau in Pixeln (Chip 2.5rem, doppelte Dichte reicht) */
const SCALED_PREVIEW_SIDE = 160;

const ATTACHMENT_TEXT = {
  noConversation: "Erst ein Gespräch öffnen, dann anhängen.",
  closed: "Dieses Topic ist geschlossen, Anhänge gehen erst nach „Wieder öffnen“.",
  tooMany: "Höchstens " + MAX_ATTACHMENTS + " Anhänge je Nachricht.",
  type: "Nur Bilder (PNG, JPEG, WebP, GIF), PDFs und Sprachdateien.",
  empty: "Die Datei ist leer.",
  retry: "Nicht alle Anhänge sind hochgeladen. Senden versucht es noch einmal, oder den Anhang entfernen.",
  withAnswer: "Eine Antwort auf eine Rückfrage nimmt keine Anhänge. Erst antworten, dann die Anhänge schicken.",
  offline: "Server nicht erreichbar.",
  sending: "Die Nachricht wird gerade gesendet. Weitere Anhänge bitte danach hinzufügen.",
};

/** Art eines Anhangs aus Typ oder Endung; null, wenn die Datei nicht erlaubt ist. Der Server prüft die Bytes. */
function attachmentKind(file) {
  const type = String((file && file.type) || "").toLowerCase();
  const match = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ""));
  const ext = match ? match[1].toLowerCase() : "";
  if (IMAGE_EXTENSIONS[type]) return "image";
  if (type === "application/pdf") return "document";
  if (type.startsWith("audio/")) return "audio";
  if (!type || type === "application/octet-stream") {
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
    if (ext === "pdf") return "document";
    if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  }
  return null;
}

/** Grund, warum eine Datei nicht angehängt wird; null, wenn sie passt. */
function attachmentProblem(file, kind) {
  if (!kind) return ATTACHMENT_TEXT.type;
  const size = typeof file.size === "number" ? file.size : 0;
  if (size < 1) return ATTACHMENT_TEXT.empty;
  if (size > ATTACHMENT_LIMITS[kind]) {
    return ATTACHMENT_KIND_LABEL[kind] + " ist zu groß (höchstens " + ATTACHMENT_LIMITS[kind] / MB + " MB).";
  }
  return null;
}

/** Bytes als Base64, in Stücken, damit große Bilder den Aufruf nicht sprengen */
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Bildtyp aus den ersten Bytes: PNG, JPEG, GIF, WebP; sonst null (wie detectMedia auf dem Server). */
function sniffImage(bytes) {
  const at = (i, list) => list.every((b, k) => bytes[i + k] === b);
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "image/gif";
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/**
 * Adresse eines Anhangs im Verlauf: nur die gesprächsgebundene Route aus #72,
 * für Direktchat, Topics und (Issue #112) Web-Gespräche mit UUID, nichts anderes
 */
const ATTACHMENT_URL_PATTERN =
  /^\/api\/conversations\/(dm|topic-[1-9][0-9]{0,9}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Anhang einer eigenen Nachricht (POST-Antwort, Live-Ereignis, Verlauf):
 * Dateikarte mit Download, bei Bildern die Vorschau darüber. null, wenn die
 * Angaben nicht passen.
 */
function attachmentCard(a) {
  if (!a || typeof a !== "object" || typeof a.url !== "string" || !ATTACHMENT_URL_PATTERN.test(a.url)) return null;
  const preview = typeof a.previewUrl === "string" && a.previewUrl === a.url + "?inline=1" ? a.previewUrl : null;
  // Sprachdateien in Web-Gesprächen zum Abspielen (Issue #112); Telegram-Gespräche bleiben bei der Karte
  const conversationId = a.url.split("/")[3];
  if (a.kind !== "audio" || !AUDIO_MIMES.includes(a.mime) || isTelegramId(conversationId)) return fileCardElement(a, a.url, preview);
  // Neuaufbau desselben Verlaufs: dieselbe Karte samt Player, eine laufende Wiedergabe behält ihren Pauseknopf
  const kept = historyPlayers.get(a.url);
  if (kept && kept.pass !== historyPass) {
    kept.pass = historyPass;
    return kept.card;
  }
  // Dieselbe Datei zweimal in einem Verlauf: die zweite nur als Karte
  if (kept) return fileCardElement(a, a.url, preview);
  const player = document.createElement("audio");
  player.setAttribute("preload", "none");
  player.hidden = true;
  const life = { pass: historyPass, disposed: false, card: null, dispose: null };
  life.card = fileCardElement(a, a.url, preview, [historyPlayButton(a, player, life), player]);
  historyPlayers.set(a.url, life);
  return life.card;
}

/**
 * Player im Verlauf je Anhang-Adresse (Issue #112). Ein Neuaufbau desselben
 * Verlaufs übernimmt sie, was danach nicht mehr im Verlauf steht, wird beendet:
 * Wiedergabe gestoppt, laufender Download verworfen, Objekt-URL freigegeben.
 */
const historyPlayers = new Map();
let historyPass = 0;

/** Vor dem Aufbau des Verlaufs: ab hier übernommene Player gehören zum neuen Stand */
function beginHistoryPlayers() {
  historyPass++;
}

/** Nach dem Aufbau: Player, die nicht übernommen wurden, beenden; ohne keep alle */
function releaseHistoryPlayers(keep) {
  for (const [url, life] of historyPlayers) {
    if (keep && life.pass === historyPass) continue;
    historyPlayers.delete(url);
    life.dispose();
  }
}

/** Sprachdateien, die der Server annimmt (MIMES in src/web/attachments.ts) */
const AUDIO_MIMES = ["audio/ogg", "audio/mp4", "audio/webm", "audio/wav", "audio/mpeg"];

/**
 * Abspielen/Pause für eine Sprachdatei im Verlauf. Die Datei kommt erst beim
 * ersten Antippen über dieselbe Route wie der Download (dort bleiben alle
 * Zugriffsprüfungen, der Server liefert immer als Anhang) und spielt dann als
 * Objekt-URL mit dem gespeicherten Typ; die CSP erlaubt media-src blob:.
 */
function historyPlayButton(a, player, life) {
  const name = typeof a.name === "string" && a.name ? a.name : "Sprachdatei";
  const button = document.createElement("button");
  button.setAttribute("type", "button");
  button.className = "icon-button attachment-play";
  let loading = null;
  let objectUrl = null;
  life.dispose = () => {
    life.disposed = true;
    if (typeof player.pause === "function" && player.paused === false) player.pause();
    player.removeAttribute("src");
    if (objectUrl && typeof window.URL.revokeObjectURL === "function") window.URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  function paint() {
    const playing = player.paused === false && !player.ended;
    button.setAttribute("aria-label", playing ? "Pause" : name + " abspielen");
    button.setAttribute("aria-pressed", playing ? "true" : "false");
    button.replaceChildren();
    const icon = pathIcon(playing ? ["M8 5v14M16 5v14"] : ["M8 5l11 7-11 7z"]);
    if (icon) button.appendChild(icon);
  }
  function load() {
    if (!loading) {
      loading = fetch(a.url, { credentials: "same-origin" })
        .then(res => {
          if (!res.ok) throw new Error("status " + res.status);
          return res.blob();
        })
        .then(blob => {
          // Inzwischen anderes Gespräch oder Nachricht weg: nichts mehr anlegen
          if (life.disposed) return;
          objectUrl = window.URL.createObjectURL(new Blob([blob], { type: a.mime }));
          player.setAttribute("src", objectUrl);
        })
        .catch(e => {
          loading = null;
          throw e;
        });
    }
    return loading;
  }
  player.addEventListener("play", paint);
  player.addEventListener("pause", paint);
  player.addEventListener("ended", paint);
  button.addEventListener("click", () => {
    if (player.paused === false && !player.ended) {
      player.pause();
      return;
    }
    button.disabled = true;
    load()
      .then(() => {
        // Ein verspäteter Download startet keine Wiedergabe ohne sichtbaren Knopf
        if (life.disposed) return;
        const started = typeof player.play === "function" ? player.play() : null;
        if (started && typeof started.catch === "function") started.catch(() => {});
      })
      .catch(() => {
        button.setAttribute("aria-label", name + " gerade nicht abspielbar, noch einmal versuchen");
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  paint();
  return button;
}

const B64_TEXT = {
  empty: "Nach /b64 fehlt der Base64-Code. Nichts gesendet.",
  invalid: "Das ist kein gültiger Base64-Code. Nichts gesendet.",
  notImage: "Der Code ergibt kein Bild (PNG, JPEG, WebP oder GIF). Nichts gesendet.",
  tooLarge: "Bild ist zu groß (höchstens " + ATTACHMENT_LIMITS.image / MB + " MB). Nichts gesendet.",
};

/**
 * Base64-Code in einer Eingabe (Entscheidung 0012): nach /b64 am Anfang
 * oder als Text, der mit data:image/ beginnt. Gibt den Code zurück (auch
 * leer), sonst null.
 */
function base64Source(value) {
  const v = String(value || "").replace(/^\s+/, "");
  const command = /^\/b64(?=\s|$)/i.exec(v);
  if (command) return v.slice(command[0].length);
  return /^data:image\//i.test(v) ? v : null;
}

/**
 * Base64 zu Bild: mit oder ohne data:image/…;base64,-Anfang, Leerraum und
 * Zeilenumbrüche egal, auch URL-sicheres Alphabet und fehlendes Auffüllen.
 * Die ersten Bytes müssen PNG, JPEG, WebP oder GIF sein.
 * { ok: true, bytes, mime, base64 } oder { ok: false, error }
 */
function decodeImageBase64(code) {
  let s = String(code || "").replace(/\s+/g, "");
  const head = /^data:([^,]*),/i.exec(s);
  if (head) {
    if (!/^image\/[a-z0-9.+-]+;base64$/i.test(head[1])) return { ok: false, error: B64_TEXT.invalid };
    s = s.slice(head[0].length);
  }
  if (!s) return { ok: false, error: B64_TEXT.empty };
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return { ok: false, error: B64_TEXT.invalid };
  const bare = s.replace(/=+$/, "");
  if (bare.length % 4 === 1) return { ok: false, error: B64_TEXT.invalid };
  if (Math.floor((bare.length * 3) / 4) > ATTACHMENT_LIMITS.image) return { ok: false, error: B64_TEXT.tooLarge };
  const base64 = bare + "===".slice((bare.length + 3) % 4);
  let binary;
  try {
    binary = atob(base64);
  } catch {
    return { ok: false, error: B64_TEXT.invalid };
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, error: B64_TEXT.notImage };
  return { ok: true, bytes, mime, base64 };
}

/** Anzeigename eines Anhangs; ohne Namen einer wie auf dem Server („bild.png"). */
function attachmentName(name, kind, type) {
  const clean = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean) return clean;
  if (kind === "image") return "bild." + (IMAGE_EXTENSIONS[String(type || "").toLowerCase()] || "png");
  return kind === "document" ? "dokument.pdf" : "sprachdatei";
}

/** Symbol eines Anhangs ohne Vorschau: Note für Sprachdateien, sonst das Blatt */
function attachmentIcon(kind) {
  if (kind !== "audio") return fileIcon();
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const note = document.createElementNS(ns, "path");
  note.setAttribute("d", "M9 18V5l12-2v13");
  svg.appendChild(note);
  for (const [cx, cy] of [[6, 18], [18, 16]]) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", "3");
    svg.appendChild(c);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Sprachaufnahme im Browser (Issue #109, Nachtrag zu Entscheidung 0012)
// ---------------------------------------------------------------------------

/** Höchstdauer einer Aufnahme, danach stoppt sie von selbst */
const RECORDING_MAX_MS = 5 * 60 * 1000;
/** Aufnahmeformate in dieser Reihenfolge: Chrome und Firefox WebM, Safari MP4 */
const RECORDING_FORMATS = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
/** Endung je tatsächlich erkanntem Format (wie detectMedia auf dem Server) */
const RECORDING_EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg" };

const RECORDING_TEXT = {
  denied: "Kein Zugriff auf das Mikrofon. Erlaube es in den Einstellungen des Browsers und tippe dann noch einmal aufs Mikrofon. Nichts gesendet.",
  noDevice: "Kein Mikrofon gefunden. Nichts gesendet.",
  failed: "Die Aufnahme ließ sich nicht starten. Nichts gesendet.",
  unsupported: "Dieser Browser kann hier keine Sprache aufnehmen. Sprachdateien gehen weiter über die Büroklammer.",
  empty: "Die Aufnahme ist leer. Nichts angehängt.",
  broken: "Die Aufnahme ist abgebrochen. Nichts angehängt.",
};

/**
 * Aufnahme ist nur im sicheren Kontext (HTTPS, localhost) möglich und nur,
 * wenn der Browser Mikrofon und MediaRecorder hat. Sonst gibt es keinen Knopf
 * (Heimnetz über http bleibt, wie es war).
 */
function recordingSupported(win) {
  const devices = win && win.navigator && win.navigator.mediaDevices;
  return !!(win && win.isSecureContext === true && devices && typeof devices.getUserMedia === "function" && typeof win.MediaRecorder === "function");
}

/** Erstes Format, das der Recorder kann; null, wenn keins */
function recordingFormat(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== "function") return null;
  for (const type of RECORDING_FORMATS) {
    try {
      if (Recorder.isTypeSupported(type)) return type;
    } catch {
      // nächstes Format
    }
  }
  return null;
}

/** Format einer Aufnahme aus den ersten Bytes: WebM, MP4 oder OGG; sonst null */
function sniffRecording(bytes) {
  const at = (i, list) => bytes.length >= i + list.length && list.every((b, k) => bytes[i + k] === b);
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (at(4, [0x66, 0x74, 0x79, 0x70])) return "audio/mp4";
  if (at(0, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  return null;
}

/** Laufzeit als mm:ss */
function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = n => String(n).padStart(2, "0");
  return pad(Math.floor(seconds / 60)) + ":" + pad(seconds % 60);
}

/** Dateiname einer Aufnahme: aufnahme-JJJJMMTT-hhmmss.<endung>, Ortszeit */
function recordingName(date, ext) {
  const pad = n => String(n).padStart(2, "0");
  const day = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
  const time = pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  return "aufnahme-" + day + "-" + time + "." + ext;
}

/** Alle Spuren eines Mikrofon-Streams beenden; das Mikrofon ist danach frei */
function stopTracks(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // schon beendet
    }
  }
}

/** Meldung, wenn das Mikrofon nicht freigegeben oder nicht da ist */
function microphoneProblem(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return RECORDING_TEXT.denied;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return RECORDING_TEXT.noDevice;
  return RECORDING_TEXT.failed;
}

/** Kleines Symbol aus Pfaden (Abspielen, Pause) */
function pathIcon(paths) {
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Meldung eines Hintergrunddienstes oder gebaute Datei: keine Blase, kein
 * Agentenkopf. Oben eine kleine Zeile „Absender · Uhrzeit", darunter der
 * Text als vom Server gerendertes Markdown, bei Dateien die Karte.
 * Absender, Dateiname und Größe nur über textContent.
 */
function noticeElement(message, ui) {
  const item = document.createElement("article");
  item.className = "msg msg-notice";
  if (message.id) item.setAttribute("data-id", message.id);
  const head = document.createElement("div");
  head.className = "notice-head";
  const source = document.createElement("span");
  source.className = "notice-source";
  source.textContent = noticeSourceLabel(message.source);
  head.appendChild(source);
  const time = clockTime(message.createdAt);
  if (time) {
    const at = document.createElement("time");
    at.className = "notice-time";
    at.setAttribute("datetime", String(message.createdAt));
    at.textContent = time;
    head.appendChild(at);
  }
  item.appendChild(head);
  const card = fileCard(message.file);
  // Bei Dateien steht der Dateiname schon auf der Karte; Text nur, wenn er mehr sagt (Beschriftung)
  const text = String(message.text ?? "");
  const redundant = card && text.trim() === String(message.file.name || "");
  if (!redundant) {
    const body = document.createElement("div");
    body.className = "notice-body content";
    setServerHtml(body, message);
    item.appendChild(body);
  }
  if (card) item.appendChild(card);
  const choice = choiceOrNull(message.choice);
  if (choice) item.appendChild(choiceElement(choice, ui));
  return item;
}

// ---------------------------------------------------------------------------
// Rückfrage-Knöpfe (Issue #115, Entscheidung 0017)
// ---------------------------------------------------------------------------

const CHOICE_STATES = ["open", "done", "expired"];
const CHOICE_VIA_TEXT = { telegram: "in Telegram", web: "im Browser", terminal: "im Terminal" };

/**
 * Nur eine vollständige Rückfrage des Servers; sonst null (dann keine
 * Knöpfe). Beschriftungen bleiben Text, sie gehen nur über textContent raus.
 */
function choiceOrNull(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) return null;
  if (!CHOICE_STATES.includes(value.state)) return null;
  const options = Array.isArray(value.options)
    ? value.options.filter(o => o && typeof o.key === "string" && o.key && typeof o.label === "string" && o.label)
    : [];
  const choice = { id: value.id, state: value.state, options: value.state === "open" ? options : [] };
  const r = value.result;
  if (value.state === "done" && r && typeof r.label === "string" && Object.prototype.hasOwnProperty.call(CHOICE_VIA_TEXT, r.via)) {
    choice.result = { key: String(r.key || ""), label: r.label, via: r.via, at: typeof r.at === "string" ? r.at : "" };
  }
  if (typeof value.elsewhere === "string" && value.elsewhere) choice.elsewhere = value.elsewhere;
  return choice;
}

/** „Erledigt: Erlauben · im Browser · 14:32" bzw. „Abgelaufen"; null, solange die Frage offen ist */
function choiceStatusText(choice) {
  if (choice.state === "expired") return "Abgelaufen";
  if (choice.state !== "done") return null;
  if (!choice.result) return "Erledigt";
  const parts = ["Erledigt: " + choice.result.label, CHOICE_VIA_TEXT[choice.result.via]];
  const time = clockTime(choice.result.at);
  if (time) parts.push(time);
  return parts.join(" · ");
}

/**
 * Knöpfe bzw. Ergebnis unter einer Nachricht. ui (aus init) kennt die
 * gesperrten Fragen (pending), Meldungen (errors) und die Aktionen pick und
 * open; ohne ui sind die Knöpfe nur Anzeige.
 */
function choiceElement(choice, ui) {
  const box = document.createElement("div");
  box.className = "choice";
  box.setAttribute("data-choice", choice.id);
  box.setAttribute("data-state", choice.state);
  const status = choiceStatusText(choice);
  if (status) {
    const line = document.createElement("p");
    line.className = "choice-status";
    line.textContent = status;
    box.appendChild(line);
    return box;
  }
  if (choice.options.length) {
    const actions = document.createElement("div");
    actions.className = "choice-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Auswahl");
    const pending = !!ui && ui.pending.has(choice.id);
    choice.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      // Der erste Knopf trägt die Handlungsfarbe, die übrigen bleiben leise
      button.className = index === 0 ? "quiet-button choice-button primary" : "quiet-button choice-button";
      button.setAttribute("data-key", option.key);
      button.textContent = option.label;
      button.disabled = !ui || pending;
      if (ui) button.addEventListener("click", () => ui.pick(choice.id, option.key));
      actions.appendChild(button);
    });
    if (pending) actions.setAttribute("aria-busy", "true");
    box.appendChild(actions);
  } else {
    // Frage aus einem anderen Gespräch (Kopie im Direktchat): dort entscheiden
    const line = document.createElement("p");
    line.className = "choice-status";
    line.textContent = choice.elsewhere ? "Antwort im Gespräch, aus dem die Frage kommt." : "Antwort in Telegram.";
    box.appendChild(line);
    if (choice.elsewhere && ui) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "quiet-button choice-button choice-open";
      link.textContent = "Zum Gespräch";
      link.addEventListener("click", () => ui.open(choice.elsewhere));
      box.appendChild(link);
    }
  }
  const error = ui ? ui.errors.get(choice.id) : "";
  if (error) {
    const note = document.createElement("p");
    note.className = "choice-error";
    note.setAttribute("role", "alert");
    note.textContent = error;
    box.appendChild(note);
  }
  return box;
}

/**
 * Baut das Element für eine Nachricht. Nutzer- und Fehlernachrichten nur
 * als Text; Antworten als das bereinigte HTML des Servers. Antworten tragen
 * zusätzlich einen Kopf mit Agentenname und Farbpunkt (per CSS davor gezeigt).
 * Der Sprecher kommt aus message.agent (Telegram kennt mehrere), sonst aus
 * dem Agenten des Gesprächs. Darunter die Fußzeile mit Angaben und Kopieren.
 */
function messageElement(message, agent, ui) {
  if (message && message.kind === "notice") return noticeElement(message, ui);
  const role = message.role === "assistant" || message.role === "error" ? message.role : "user";
  const item = document.createElement("article");
  // Ein Stopp auf eigenen Wunsch ist kein Fehler: ruhige Notiz statt rotem Kasten
  const stopped = role === "error" && String(message.text ?? "").trim() === STOPPED_TEXT;
  item.className = stopped ? "msg msg-note" : "msg msg-" + role;
  if (message.id) item.setAttribute("data-id", message.id);
  // Eigene Anhänge (Issue #73): Karten über dem Text; ohne Text keine leere Blase
  const cards = role === "user" && Array.isArray(message.attachments) ? message.attachments.map(attachmentCard).filter(Boolean) : [];
  if (cards.length) {
    item.className += " msg-with-attachments";
    const files = document.createElement("div");
    files.className = "msg-attachments";
    for (const card of cards) files.appendChild(card);
    item.appendChild(files);
  }
  if (!cards.length || String(message.text ?? "").trim()) {
    const body = document.createElement("div");
    body.className = role === "assistant" ? "bubble content" : "bubble";
    if (role === "assistant") setServerHtml(body, message);
    else body.textContent = String(message.text ?? "");
    item.appendChild(body);
  }
  // Eigene Nachricht (Issue #186): leise Uhrzeit rechtsbündig unter Blase bzw. Anhängen
  if (role === "user") {
    const at = messageTimeElement(message.createdAt, "msg-time msg-user-time");
    if (at) item.appendChild(at);
  }
  // Rückfrage (Issue #115): Knöpfe bzw. Ergebnis unter der Antwort
  const choice = role === "assistant" ? choiceOrNull(message.choice) : null;
  if (choice) item.appendChild(choiceElement(choice, ui));
  if (role === "assistant") {
    const speaker = typeof message.agent === "string" && message.agent ? message.agent : agent;
    const head = document.createElement("div");
    head.className = "msg-head";
    head.setAttribute("data-agent", String(speaker || "general"));
    const dot = document.createElement("span");
    dot.className = "agent-dot";
    head.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = agentLabel(speaker) || brandName();
    head.appendChild(name);
    item.appendChild(head);
    // Hinter dem Kopf, per CSS aber unter dem Inhalt (der Kopf steht mit order -1 davor)
    const foot = replyFooter(message);
    if (foot) item.appendChild(foot);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Fußzeile unter Antworten: Uhrzeit, Agent, Modell, Dauer, Kopieren (Issue #22, #186)
// ---------------------------------------------------------------------------

/** So lange steht „Kopiert" bzw. die Fehlermeldung neben dem Knopf */
const COPY_STATUS_MS = 2000;
const COPIED_TEXT = "Kopiert";
const COPY_FAILED_TEXT = "Kopieren nicht möglich";

/** Dauer kurz auf Deutsch: „0,4 s", „42 s", „3 min 5 s", „1 h 2 min"; null ohne gültigen Wert. */
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return (Math.max(ms, 100) / 1000).toFixed(1).replace(".", ",") + " s";
  const total = Math.round(ms / 1000);
  if (total < 60) return total + " s";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? minutes + " min " + (total % 60) + " s" : minutes + " min";
  return minutes % 60 ? Math.floor(minutes / 60) + " h " + (minutes % 60) + " min" : Math.floor(minutes / 60) + " h";
}

/**
 * Motoren mit Anzeigenamen: unter der Antwort (Issue #125, seit #126 auch
 * Claude Code) und in der Pille der Kopfzeile (Issue #126)
 */
const ENGINE_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/**
 * Pille der Kopfzeile (Issue #126): Motor des Gesprächs, wenn er vom
 * Standard abweicht oder der Standard nicht Claude Code ist; sonst null.
 * engine: eingestellter Motor des Gesprächs (nicht der der letzten Antwort),
 * standard: Standard-Motor oder null, wenn der Server keinen nennt.
 */
function enginePillText(engine, standard) {
  if (typeof engine !== "string" || !Object.hasOwn(ENGINE_NAMES, engine)) return null;
  const base = typeof standard === "string" && standard ? standard : "claude";
  if (engine === "claude" && base === "claude") return null;
  return ENGINE_NAMES[engine];
}

/**
 * Leise Zeile unter einer Antwort, z.B. „General · Claude Code · claude-opus-5-5 · 42 s"
 * oder „General · Codex · gpt-5.6-sol · 42 s". Den Motor nennt nur eine
 * Antwort, die ihn mitbringt: Fallback-Antworten und ältere haben keinen.
 * Nur, was die Nachricht selbst mitbringt: ältere Antworten ohne Angaben
 * zeigen weniger oder nichts, der Agent des Gesprächs wird nicht eingesetzt.
 */
function replyMetaText(message) {
  const parts = [];
  if (typeof message.agent === "string" && message.agent) parts.push(agentLabel(message.agent));
  if (typeof message.engine === "string" && Object.hasOwn(ENGINE_NAMES, message.engine)) parts.push(ENGINE_NAMES[message.engine]);
  if (typeof message.model === "string" && message.model.trim()) parts.push(message.model.trim());
  const duration = formatDuration(message.durationMs);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

/** Zwei überlappende Blätter, gezeichnet wie die übrigen Icons */
function copyIcon() {
  if (typeof document.createElementNS !== "function") return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const front = document.createElementNS(ns, "rect");
  for (const [k, v] of [["x", "9"], ["y", "9"], ["width", "11"], ["height", "11"], ["rx", "2"]]) front.setAttribute(k, v);
  svg.appendChild(front);
  const back = document.createElementNS(ns, "path");
  back.setAttribute("d", "M5 15V6a2 2 0 0 1 2-2h8");
  svg.appendChild(back);
  return svg;
}

/**
 * Ersatzweg ohne Clipboard-API: Über HTTP an der Heimnetz-IP ist die Seite
 * kein sicherer Kontext, dort fehlt navigator.clipboard. Ein unsichtbares
 * Textfeld wird markiert und per execCommand("copy") kopiert. true nur,
 * wenn der Browser das Kopieren bestätigt.
 */
function copyWithTextarea(text) {
  if (typeof document.execCommand !== "function" || !document.body) return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.className = "copy-buffer";
  document.body.appendChild(area);
  let ok = false;
  try {
    area.select();
    // iOS Safari markiert mit select() allein nichts
    if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, text.length);
    ok = document.execCommand("copy") === true;
  } catch {
    ok = false;
  }
  if (typeof area.remove === "function") area.remove();
  else if (typeof document.body.removeChild === "function") document.body.removeChild(area);
  return ok;
}

/** Legt Text in die Zwischenablage: erst die Clipboard-API, sonst der Ersatzweg. true bei Erfolg. */
async function copyToClipboard(text) {
  const nav = typeof window !== "undefined" ? window.navigator : undefined;
  const clipboard = nav && nav.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // abgelehnt (keine Berechtigung, kein Fokus): Ersatzweg versuchen
    }
  }
  return copyWithTextarea(text);
}

/**
 * Fußzeile einer Antwort: Kopieren-Knopf, Uhrzeit (Issue #186), Metazeile
 * und Kopierstatus. Alles nur über textContent; kopiert wird copyText vom
 * Server (Markdown ohne Steuer-Tags). Ohne copyText gibt es keinen Knopf,
 * ohne gültiges createdAt keine Uhrzeit, ohne Angaben keine Metazeile.
 * null, wenn alles fehlt.
 */
function replyFooter(message) {
  const meta = replyMetaText(message);
  const copyText = typeof message.copyText === "string" && message.copyText ? message.copyText : null;
  // Die Uhrzeit steht vorn: sie steht so bei jeder Antwort an derselben Stelle und nicht neben der Dauer
  const at = messageTimeElement(message.createdAt, "msg-time");
  if (!meta && !copyText && !at) return null;
  const foot = document.createElement("div");
  foot.className = "msg-foot";
  let status = null;
  if (copyText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button copy-button";
    button.setAttribute("aria-label", "Antwort kopieren");
    button.setAttribute("title", "Antwort kopieren");
    const icon = copyIcon();
    if (icon) button.appendChild(icon);
    status = document.createElement("span");
    status.className = "copy-status";
    status.setAttribute("role", "status");
    let timer = null;
    button.addEventListener("click", async () => {
      const ok = await copyToClipboard(copyText);
      // „Kopiert" nur bei Erfolg, sonst eine Fehlermeldung
      status.textContent = ok ? COPIED_TEXT : COPY_FAILED_TEXT;
      foot.setAttribute("data-copy", ok ? "ok" : "failed");
      // Der Ersatzweg nimmt dem Knopf den Fokus
      if (typeof button.focus === "function") button.focus();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        status.textContent = "";
        foot.removeAttribute("data-copy");
      }, COPY_STATUS_MS);
    });
    foot.appendChild(button);
  }
  if (at) foot.appendChild(at);
  if (meta) {
    const line = document.createElement("span");
    line.className = "msg-meta";
    line.textContent = meta;
    foot.appendChild(line);
  }
  if (status) foot.appendChild(status);
  return foot;
}

/** Kurzer Text für die Statuszeile zum jüngsten Fortschrittsschritt. */
function activityLabel(kind, text) {
  if (kind === "tool") return toolLabel(text) + " …";
  if (kind === "snippet") return "Formuliert die Antwort …";
  return String(text ?? "");
}

/** Ein Eintrag der Fortschrittsliste: Werkzeug, Snippet (kursiv) oder Hinweis. */
function progressItem(kind, text) {
  const li = document.createElement("li");
  if (kind === "tool") {
    li.className = "step step-tool";
    li.textContent = toolLabel(text);
  } else if (kind === "snippet") {
    li.className = "step step-snippet";
    const em = document.createElement("em");
    em.textContent = String(text ?? "");
    li.appendChild(em);
  } else {
    li.className = "step step-notice";
    li.textContent = String(text ?? "");
  }
  return li;
}

// ---------------------------------------------------------------------------
// Schalter System / Hell / Dunkel (Issue #15)
// ---------------------------------------------------------------------------

/** Reihenfolge der Knöpfe; IDs im HTML: theme-system, theme-light, theme-dark */
const THEME_CHOICES = ["system", "light", "dark"];

/**
 * Verbindet die Radiogruppe in der Seitenleiste mit theme.js (window.WebTheme).
 * Genau ein Tab-Stopp (der gewählte Knopf), Pfeiltasten wechseln Fokus und
 * Wahl reihum, Pos1/Ende springen an den Rand, Leertaste und Klick wählen.
 * Ohne theme.js oder ohne Schalter im DOM passiert nichts.
 */
function initThemeSwitch(theme) {
  if (!theme || !document.getElementById("theme-switch")) return null;
  const buttons = THEME_CHOICES.map(choice => document.getElementById("theme-" + choice));
  if (buttons.some(b => !b)) return null;

  function render(choice) {
    buttons.forEach((button, i) => {
      const checked = THEME_CHOICES[i] === choice;
      button.setAttribute("aria-checked", checked ? "true" : "false");
      button.setAttribute("tabindex", checked ? "0" : "-1");
    });
  }

  function select(index, focus) {
    render(theme.choose(THEME_CHOICES[index]));
    if (focus) buttons[index].focus();
  }

  const last = buttons.length - 1;
  const steps = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  buttons.forEach((button, i) => {
    button.addEventListener("click", () => select(i, false));
    button.addEventListener("keydown", event => {
      let next = null;
      if (event.key in steps) next = (i + steps[event.key] + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      else if (event.key === " " || event.key === "Spacebar") next = i;
      if (next === null) return;
      event.preventDefault();
      select(next, next !== i);
    });
  });

  render(theme.current());
  return { render };
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

function init() {
  const el = {
    log: document.getElementById("chat-log"),
    messages: document.getElementById("messages"),
    activity: document.getElementById("activity"),
    progress: document.getElementById("progress"),
    stop: document.getElementById("stop"),
    form: document.getElementById("composer"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    agent: document.getElementById("agent-name"),
    engine: document.getElementById("engine-name"),
    newChat: document.getElementById("new-chat"),
    logout: document.getElementById("logout"),
    connection: document.getElementById("connection"),
    empty: document.getElementById("empty"),
    title: document.getElementById("chat-title"),
    list: document.getElementById("conversation-list"),
    sidebar: document.getElementById("sidebar"),
    scrim: document.getElementById("scrim"),
    menu: document.getElementById("menu"),
    sidebarClose: document.getElementById("sidebar-close"),
    activityToggle: document.getElementById("activity-toggle"),
    activityText: document.getElementById("activity-text"),
    filter: document.getElementById("conversation-filter"),
    filterEmpty: document.getElementById("filter-empty"),
    dmGroup: document.getElementById("dm-group"),
    dmList: document.getElementById("dm-list"),
    topicGroup: document.getElementById("topic-group"),
    topicList: document.getElementById("topic-list"),
    olderToggle: document.getElementById("older-toggle"),
    olderLabel: document.getElementById("older-label"),
    olderList: document.getElementById("older-list"),
    webGroup: document.getElementById("web-group"),
    loadOlder: document.getElementById("load-older"),
    emptyTitle: document.getElementById("empty-title"),
    emptyText: document.getElementById("empty-text"),
    agentPicker: document.getElementById("agent-picker"),
    agentOptions: document.getElementById("agent-options"),
    titleInput: document.getElementById("title-input"),
    conversationMenu: document.getElementById("conversation-menu"),
    conversationActions: document.getElementById("conversation-actions"),
    emptyNew: document.getElementById("empty-new"),
    closedNote: document.getElementById("closed-note"),
    main: document.getElementById("main"),
    openSettings: document.getElementById("open-settings"),
    settingsBack: document.getElementById("settings-back"),
    settingsTitle: document.getElementById("settings-title"),
    goalCard: document.getElementById("goal-card"),
    commandList: document.getElementById("command-list"),
    attach: document.getElementById("attach"),
    fileInput: document.getElementById("file-input"),
    attachments: document.getElementById("attachments"),
    attachNote: document.getElementById("attach-note"),
    record: document.getElementById("record"),
    recorder: document.getElementById("recorder"),
    recorderTime: document.getElementById("recorder-time"),
    recorderStop: document.getElementById("recorder-stop"),
    recorderDiscard: document.getElementById("recorder-discard"),
    /** Hinweis „Neue Version“ im Chat und in den Einstellungen (Issue #111) */
    updateNotes: [document.getElementById("update-note"), document.getElementById("settings-update-note")],
  };

  const state = {
    conversation: null,
    /** Status-Karte des Ziels im offenen Gespräch (Issue #76), null ohne Ziel */
    goal: null,
    /** Ein Knopf der Karte wartet auf den Server */
    goalPending: false,
    /** Meldung unter den Knöpfen (veraltet, Fehler) */
    goalError: "",
    /** Zählt goal-Ereignisse; eine ältere Antwort auf GET oder POST überschreibt sie nicht */
    goalSeq: 0,
    /** Rückfragen (Issue #115), deren Klick gerade beim Server liegt: Knöpfe gesperrt, auch über Neuzeichnen und Gesprächswechsel */
    choicePending: new Set(),
    /** Meldung unter den Knöpfen einer Rückfrage (ID → Text) */
    choiceErrors: new Map(),
    /**
     * Endzustand je Rückfrage (ID → { state, result }), sobald einer bekannt
     * ist. Eine verspätete Antwort (GET, POST, SSE) mit „offen" öffnet die
     * Knöpfe nie wieder; der erste Endzustand bleibt.
     */
    choiceFinal: new Map(),
    /** Web-Gespräche für die Seitenleiste, jüngstes zuerst */
    conversations: [],
    /** Direktchat (oder null) und Topics aus GET /api/conversations */
    telegram: { dm: null, topics: [] },
    /** Standard-Motor aus GET /api/conversations (Issue #126), null ohne Angabe */
    engineDefault: null,
    /** „Ältere Topics" aufgeklappt (gilt nur ohne Filter) */
    olderOpen: false,
    /** Telegram-Gespräche mit neuer Nachricht seit dem letzten Öffnen (Neu-Punkt), gespeichert bis zum Öffnen */
    unread: loadUnread(),
    /** Sammelstrom der Aktivität (auch ohne Telegram-Gespräche, für Motor-Änderungen) */
    activityEvents: null,
    activityTimer: null,
    activityDelay: 1000,
    /** Der Sammelstrom war schon einmal offen: beim Wiederverbinden die Liste abgleichen */
    activityWasOpen: false,
    /** Telegram-Verlauf: Es gibt ältere Nachrichten vor der ersten geladenen */
    hasMore: false,
    /** Ein Nachladen älterer Nachrichten läuft */
    loadingOlder: false,
    /** Angefangene Entwürfe je Gespräch (ID → Text), bis zum Neuladen der Seite */
    drafts: new Map(),
    /** Telegram: Die erste Verlaufsseite des offenen Gesprächs ist da (bestimmt hasMore) */
    historyLoaded: false,
    /** IDs, die beim nächsten Zeichnen kurz einblenden */
    fresh: new Set(),
    /** Kalendertag des letzten Zeichnens und Timer auf Mitternacht (Issue #186) */
    renderedDay: "",
    dayTimer: null,
    /** Nachrichten des aktuellen Gesprächs, nach createdAt sortiert */
    messages: [],
    running: false,
    /** Eine Rückfrage des laufenden Turns wartet auf die eingetippte Antwort */
    awaiting: false,
    /** Kennung dieser Rückfrage; geht mit der Antwort zurück an den Server */
    approvalId: null,
    sending: false,
    stopping: false,
    busy: false,
    /** Zählt Gesprächswechsel; ältere Antworten werden verworfen */
    generation: 0,
    /** Zählt status-Ereignisse, um sie gegen die Antwort auf POST abzugleichen */
    statusSeq: 0,
    events: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    /** true, solange die SSE-Verbindung offen ist */
    connected: false,
    /** Wiederholung des Verlaufabgleichs nach einem Fehlschlag */
    syncTimer: null,
    syncDelay: 1000,
    leaving: false,
    /** Agenten für neue Gespräche; bis GET /api/agents antwortet nur General */
    agents: [{ name: "general", label: "General" }],
    defaultAgent: "general",
    /** Version des übernommenen Agenten-Katalogs ({ boot, seq }, Issue #51) */
    agentsRevision: null,
    /** Auswahl des Agenten unter „Neues Gespräch" offen, markierter Eintrag */
    pickerOpen: false,
    pickerIndex: 0,
    /** Titel wird in der Kopfzeile bearbeitet bzw. gerade gespeichert */
    editingTitle: false,
    renaming: false,
    /** Offenes Menü: { place: "header" | "entry", id, confirm, focus } oder null */
    menu: null,
    /** ID des Gesprächs, das gerade gelöscht wird */
    deleting: null,
    /** ID des Topics, das gerade geschlossen oder geöffnet wird */
    closing: null,
    /** In diesem Browser angelegte Topics: stehen oben, bis sie Aktivität haben (Issue #30) */
    pinned: new Set(),
    /**
     * Rechte des Bots in der Gruppe (GET /api/telegram/rights):
     * { status: "loading" | "ok" | "failed", group, manageTopics, deleteMessages, error, at } oder null
     */
    rights: null,
    /** ID des Topics, dessen Agent gerade geändert wird (Issue #38) */
    changingAgent: null,
    /**
     * Zählt bestätigte Änderungen an Einträgen (Agent, Name, geschlossen), die
     * applyConversation übernimmt. Eine Liste, die vorher angefragt wurde,
     * kann sie noch nicht enthalten und wird neu geholt statt übernommen
     * (dieselbe Befundklasse wie Codex Runde 4 bis 7 zu PR #43).
     */
    entryChanges: 0,
    /** Die Einstellungen wurden aus dieser Seite geöffnet: Zurück geht einen Verlaufsschritt zurück */
    settingsPushed: false,
    /** Zurück-Knopf gedrückt, der Schritt zurück steht noch aus */
    closingSettings: false,
    /** Befehle aus GET /api/commands (Issue #77); null bis zur ersten Antwort */
    commands: null,
    /** "idle" | "loading" | "ok" | "failed" */
    commandsStatus: "idle",
    /** Befehlsliste über der Eingabe offen, Treffer und markierter Eintrag */
    commandOpen: false,
    commandMatches: [],
    commandIndex: 0,
    /** Auswahl per Pfeiltaste verschoben: nur dann bleibt sie in Web-Gesprächen beim Neuaufbau der Liste stehen */
    commandMoved: false,
    /** Eingabe, bei der die Liste per Escape oder Auswahl geschlossen wurde; bleibt zu, bis sich der Text ändert */
    commandDismissed: null,
    /**
     * Anhänge vor dem Senden je Gespräch (ID → Liste), bis zum Neuladen der
     * Seite (Issue #73). Hochgeladene gehören zu ihrem Gespräch und behalten
     * ihre Upload-ID, auch wenn inzwischen ein anderes offen ist.
     * Eintrag: { key, file, name, size, kind, preview, status, id, error };
     * status "ready" | "uploading" | "done" | "error"
     */
    attachments: new Map(),
    attachmentSeq: 0,
    /** Laufende Sprachaufnahme (Issue #109): { phase, conversationId, stream, recorder, … } oder null */
    recording: null,
    /** Ziehen über dem Chat: Zähler für dragenter/dragleave der Kindelemente */
    dragDepth: 0,
    /**
     * Neue Version (Issue #111): loaded aus dem Meta-Tag (ohne ihn keine
     * Prüfung), available sobald der Server eine andere nennt. checking: die
     * laufende Anfrage, gleichzeitige Anlässe teilen sie. lastCheck für die
     * Minutengrenze beim Sichtbarwerden, deferTimer holt eine gebremste
     * Prüfung nach. risks: offene Rückfrage vor dem Neuladen (Texte) oder null.
     */
    update: {
      loaded: pageUiVersion(document.getElementById("ui-version")),
      available: false,
      checking: null,
      lastCheck: -Infinity,
      deferTimer: null,
      risks: null,
    },
    /** Die Live-Verbindung des Gesprächs war weg: beim nächsten open die Version prüfen */
    eventsLost: false,
  };

  const touchInput = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  // Mikrofon nur im sicheren Kontext (Issue #109); einmal beim Laden geprüft
  const canRecord = recordingSupported(window);

  function goToLogin() {
    state.leaving = true;
    discardRecording();
    closeEvents();
    closeActivity();
    window.location.href = "/login";
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return apiResult(res);
  }

  /** Antwort des Servers lesen; 401 führt zur Anmeldung */
  async function apiResult(res) {
    if (res.status === 401) {
      goToLogin();
      throw new Error("Nicht angemeldet");
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // keine JSON-Antwort
    }
    return { status: res.status, ok: res.ok, data };
  }

  // --- Anzeige ---------------------------------------------------------------

  function nearBottom() {
    return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
  }

  function scrollToBottom() {
    el.log.scrollTop = el.log.scrollHeight;
  }

  function renderMessages() {
    const agent = state.conversation ? state.conversation.agent : "";
    const fragment = document.createDocumentFragment();
    beginHistoryPlayers();
    for (const m of state.messages) {
      const node = messageElement(m, agent, choiceUi);
      if (m.id && state.fresh.has(m.id)) node.setAttribute("data-fresh", "");
      fragment.appendChild(node);
    }
    state.fresh.clear();
    el.messages.replaceChildren(fragment);
    releaseHistoryPlayers(true);
    el.empty.hidden = state.messages.length > 0;
    // Ohne Gespräch (Issue #30): nichts wird angelegt, der Leerzustand bietet „Neues Gespräch" an
    el.emptyNew.hidden = !!state.conversation;
    if (!state.conversation) {
      el.emptyTitle.textContent = "Noch kein Gespräch";
      el.emptyText.textContent = "Leg ein neues Gespräch an. Es erscheint auch als Topic in Telegram.";
    }
    el.loadOlder.hidden = !(isTelegram() && state.hasMore);
    el.loadOlder.disabled = state.loadingOlder;
    el.loadOlder.textContent = state.loadingOlder ? "Lädt …" : "Ältere Nachrichten laden";
    watchDayChange();
  }

  // --- Zeitstempel über Mitternacht (Issue #186) ------------------------------

  /**
   * Bleibt die Seite über Mitternacht offen, wird aus „21:08" am neuen Tag
   * „gestern 21:08": einmal kurz nach Mitternacht neu zeichnen. Im
   * Hintergrund pausieren Timer, deshalb prüft auch das Zurückkehren in den
   * Tab (refreshDay). Kein Dauer-Polling.
   */
  function watchDayChange() {
    const now = Date.now();
    const today = localDay(now);
    // Schon für heute gestellt: nicht bei jedem Zeichnen neu
    if (state.dayTimer && state.renderedDay === today) return;
    state.renderedDay = today;
    if (state.dayTimer) clearTimeout(state.dayTimer);
    state.dayTimer = setTimeout(() => {
      state.dayTimer = null;
      refreshDay();
    }, msUntilNextDay(now));
  }

  /** Neuer Kalendertag seit dem letzten Zeichnen: Verlauf neu zeichnen */
  function refreshDay() {
    if (localDay(Date.now()) !== state.renderedDay) renderMessages();
  }

  // --- Rückfragen (Issue #115) ----------------------------------------------

  /** Aktionen für choiceElement */
  const choiceUi = {
    pending: state.choicePending,
    errors: state.choiceErrors,
    pick: (id, key) => void pickChoice(id, key),
    open: id => openById(id),
  };

  /**
   * Rückfrage einer Nachricht mit dem bekannten Endzustand; ein Endzustand
   * wird nie wieder offen. Nur „Abgelaufen" darf ein gemeldetes Erledigt
   * noch ersetzen: eine abgelaufene Frage lässt sich nicht mehr entscheiden,
   * ein späteres done heißt also, das Abgelaufen war falsch.
   */
  function settledChoice(choice) {
    const valid = choiceOrNull(choice);
    if (!valid) return null;
    if (valid.state !== "open") {
      const known = state.choiceFinal.get(valid.id);
      if (!known || (known.state === "expired" && valid.state === "done")) {
        state.choiceFinal.set(valid.id, { state: valid.state, result: valid.result });
      }
    }
    const final = state.choiceFinal.get(valid.id);
    if (!final) return valid;
    const settled = { id: valid.id, state: final.state, options: [] };
    if (final.result) settled.result = final.result;
    if (valid.elsewhere) settled.elsewhere = valid.elsewhere;
    return settled;
  }

  function sameChoice(a, b) {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  }

  /**
   * Nachricht mit geprüfter Rückfrage (Endzustand beachtet). choiceId ohne
   * choice heißt: das Register war beim Server nicht lesbar. Die Kennung
   * bleibt dann stehen, damit syncChoices den Stand nachholen kann.
   */
  function withChoice(m) {
    const { choice: raw, choiceId, ...rest } = m;
    if ("choice" in m) {
      const choice = settledChoice(raw);
      return choice ? Object.assign(rest, { choice }) : rest;
    }
    return unresolvedChoiceId(m) ? Object.assign(rest, { choiceId }) : rest;
  }

  /** Kennung einer Rückfrage, deren Stand noch fehlt, sonst "" */
  function unresolvedChoiceId(m) {
    return !m.choice && typeof m.choiceId === "string" && CHOICE_ID_PATTERN.test(m.choiceId) ? m.choiceId : "";
  }

  /**
   * Neuer Zustand einer Rückfrage (SSE choice, Antwort auf den Klick): gilt
   * für jede Nachricht im offenen Gespräch mit dieser Frage. true, wenn sich
   * etwas geändert hat.
   */
  function applyChoice(value) {
    const choice = choiceOrNull(value);
    if (!choice) return false;
    if (choice.state !== "open") settledChoice(choice);
    let changed = false;
    state.messages = state.messages.map(m => {
      // Stand noch nicht gelesen (Register war nicht lesbar): jetzt übernehmen
      if (unresolvedChoiceId(m) === choice.id) {
        changed = true;
        const { choiceId: _id, ...rest } = m;
        return Object.assign(rest, { choice: settledChoice(choice) });
      }
      if (!m.choice || m.choice.id !== choice.id) return m;
      // Aus Sicht dieser Nachricht: ein Verweis auf ein anderes Gespräch bleibt
      const next = settledChoice(Object.assign({}, choice, m.choice.elsewhere ? { elsewhere: m.choice.elsewhere, options: [] } : {}));
      if (sameChoice(next, m.choice)) return m;
      changed = true;
      return Object.assign({}, m, { choice: next });
    });
    if (changed) {
      const stick = nearBottom();
      renderMessages();
      if (stick) scrollToBottom();
    }
    return changed;
  }

  /**
   * Klick auf einen Knopf: genau ein POST, solange er läuft sind alle Knöpfe
   * der Frage gesperrt. 200 und 409 bringen den Endzustand, 404 heißt: hier
   * nicht (mehr) entscheidbar. Andere Fehler geben die Knöpfe wieder frei.
   */
  async function pickChoice(id, key) {
    const conversation = state.conversation;
    if (!conversation || state.choicePending.has(id) || state.choiceFinal.has(id)) return;
    const message = state.messages.find(m => m.choice && m.choice.id === id);
    if (!message || message.choice.state !== "open" || !message.choice.options.some(o => o.key === key)) return;
    state.choicePending.add(id);
    state.choiceErrors.delete(id);
    renderMessages();
    let error = "";
    try {
      const { status, data } = await api("POST", "/api/conversations/" + conversation.id + "/choices/" + encodeURIComponent(id), { option: key });
      if (data && data.choice) settledChoice(data.choice);
      else if (status === 404 || (data && data.expired)) settledChoice({ id, state: "expired", options: [] });
      else error = data && typeof data.error === "string" && data.error ? data.error : "Die Auswahl ist fehlgeschlagen.";
    } catch {
      error = "Server nicht erreichbar.";
    } finally {
      state.choicePending.delete(id);
    }
    if (error && !state.choiceFinal.has(id)) state.choiceErrors.set(id, error);
    else state.choiceErrors.delete(id);
    // Nur das jetzt offene Gespräch neu zeichnen; der Endzustand gilt dort, wo die Frage steht
    const final = state.choiceFinal.get(id);
    if (!(final && applyChoice(Object.assign({ id, options: [] }, final)))) renderMessages();
  }

  /** Gespräch aus einem Verweis öffnen (Kopie einer Web-Frage im Direktchat) */
  function openById(id) {
    const target = findConversation(id);
    if (target) openConversation(target);
  }

  /** Fügt Nachrichten ein, ohne doppelte IDs; true, wenn etwas neu war oder sich eine Rückfrage geändert hat. */
  function mergeMessages(list) {
    let changed = false;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const m = withChoice(raw);
      const i = m.id ? state.messages.findIndex(x => x.id === m.id) : -1;
      if (i >= 0) {
        // Bekannte Nachricht: nur der Zustand ihrer Rückfrage kann sich ändern.
        // Ohne lesbaren Stand (nur choiceId) bleibt der bisherige stehen.
        const old = state.messages[i];
        if (m.choice && !sameChoice(old.choice, m.choice)) {
          const { choiceId: _id, ...rest } = old;
          state.messages[i] = Object.assign(rest, { choice: m.choice });
          changed = true;
        } else if (m.choiceId && !old.choice && !old.choiceId) {
          state.messages[i] = Object.assign({}, old, { choiceId: m.choiceId });
        }
        continue;
      }
      state.messages.push(m);
      changed = true;
    }
    if (changed) {
      state.messages.sort((a, b) => {
        const ka = timeKey(a.createdAt);
        const kb = timeKey(b.createdAt);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    }
    return changed;
  }

  function addMessages(list) {
    for (const m of list) {
      if (m && m.id && !state.messages.some(x => x.id === m.id)) state.fresh.add(m.id);
    }
    if (mergeMessages(list)) {
      renderMessages();
      scrollToBottom();
      // Eine gerade eingetroffene Frage kann das Senden freigeben
      updateControls();
    }
  }

  /** Meldung ohne Nachrichten-ID (z.B. Speichern fehlgeschlagen), nur lokal. */
  function addLocalError(text) {
    addMessages([{ id: "lokal-" + Date.now() + "-" + Math.random().toString(36).slice(2), role: "error", text, createdAt: new Date().toISOString() }]);
  }

  /** Fehlermeldung im offenen Gespräch; ohne Gespräch im Hinweisbalken */
  function reportError(text) {
    if (state.conversation) addLocalError(text);
    else showConnection(text);
  }

  /**
   * Eine Freigabe darf nur beantwortet werden, wenn die Frage mit genau dieser
   * Kennung schon im Verlauf steht. Sonst könnte ein „ja" zur sichtbaren alten
   * Frage eine neuere, noch nicht angezeigte Frage freigeben. Seit Issue #116
   * ist die Kennung die Register-ID der Rückfrage (choice.id bzw. choiceId,
   * in Telegram-Gesprächen kommt die Nachricht über den Nachrichtenspeicher).
   */
  function approvalShown() {
    const id = state.approvalId;
    return !!id && state.messages.some(m => m && (m.approvalId === id || m.choiceId === id || (!!m.choice && m.choice.id === id)));
  }

  /** Offenes Gespräch ist ein geschlossenes Topic: Schreiben gesperrt (Issue #30) */
  function isClosed() {
    return !!state.conversation && state.conversation.closed === true;
  }

  function updateControls() {
    const answerable = state.awaiting && approvalShown();
    const closed = isClosed();
    // /stop und /goal pause|stop dürfen auch während einer Antwort raus (Issue #74, #76)
    const urgentTyped = state.running && isUrgentCommand(el.input.value);
    const locked = (state.running && !answerable && !urgentTyped) || state.sending || state.busy || !state.conversation || closed;
    // Anhänge allein reichen zum Senden (Issue #73)
    el.send.disabled = locked || (!el.input.value.trim() && !currentAttachments().length);
    // Geschlossenes Topic oder gar kein Gespräch: Eingabe aus, beim Topic mit Hinweis
    el.input.disabled = closed || !state.conversation;
    el.closedNote.hidden = !closed;
    el.activity.hidden = !state.running;
    // Während der Arbeit wird Senden zu Stopp; bei einer offenen Freigabe-Frage
    // stehen beide da: Senden für die Antwort, Stopp bricht den Turn ab
    el.stop.hidden = !state.running;
    el.send.hidden = state.running && !answerable && !urgentTyped;
    el.stop.disabled = state.stopping;
    el.stop.setAttribute("aria-label", state.stopping ? "Wird gestoppt" : "Stopp");
    el.newChat.disabled = state.busy;
    // Büroklammer in jedem offenen Gespräch (Issue #112), gesperrt im geschlossenen Topic und beim Senden
    el.attach.hidden = !state.conversation;
    el.attach.disabled = closed || state.sending;
    // Mikrofon rechts neben Senden/Stopp, wo auch Anhänge gehen (Issue #109), nur im sicheren Kontext
    const recording = state.recording;
    const recorderShown = !!recording && recording.phase !== "requesting";
    el.record.hidden = !canRecord || el.attach.hidden || recorderShown;
    el.record.disabled = closed || state.sending || !!recording;
    el.recorder.hidden = !recorderShown;
    if (recorderShown) {
      // Während der Aufnahme: Zeit, Stopp und Verwerfen statt Feld, Büroklammer und Senden
      el.input.hidden = true;
      el.attach.hidden = true;
      el.send.hidden = true;
      el.recorderStop.disabled = recording.phase !== "recording";
    } else {
      el.input.hidden = false;
    }
  }

  function setRunning(running, awaiting, approvalId) {
    const wasRunning = state.running;
    state.running = !!running;
    state.approvalId = state.running && awaiting && typeof approvalId === "string" ? approvalId : null;
    state.awaiting = !!state.approvalId;
    if (!state.running) {
      state.stopping = false;
      el.progress.replaceChildren();
    }
    if (state.running && !wasRunning) {
      el.progress.replaceChildren();
      el.activityText.textContent = brandName() + " denkt nach …";
      scrollToBottom();
    }
    if (state.awaiting) el.activityText.textContent = "Wartet auf deine Antwort";
    updateControls();
  }

  function addProgress(kind, text) {
    const stick = nearBottom();
    el.progress.appendChild(progressItem(kind, text));
    el.activityText.textContent = activityLabel(kind, text);
    if (stick) scrollToBottom();
  }

  function showConnection(text) {
    el.connection.textContent = text || "";
    el.connection.hidden = !text;
  }

  function autosize() {
    const input = el.input;
    input.style.height = "auto";
    const style = window.getComputedStyle(input);
    const line = parseFloat(style.lineHeight) || 22;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // Wächst bis etwa 8 Zeilen, danach scrollt das Feld in sich
    const max = line * MAX_INPUT_LINES + padding + border;
    const wanted = input.scrollHeight + border;
    input.style.height = Math.min(wanted, max) + "px";
    input.style.overflowY = wanted > max ? "auto" : "hidden";
  }

  // --- Gespräch laden --------------------------------------------------------

  /** Holt den Verlauf; wirft bei Netzwerk- und HTTP-Fehlern. */
  async function loadMessages() {
    const conversation = state.conversation;
    if (!conversation) return;
    const generation = state.generation;
    const seq = state.statusSeq;
    const { ok, status, data } = await api("GET", "/api/conversations/" + conversation.id + "/messages");
    if (generation !== state.generation) return;
    // Gespräch oder Topic inzwischen gelöscht (anderer Browser)? Nur wenn es
    // auch in der Liste fehlt, sonst wie jeder Fehler: später neu versuchen.
    // Direktchat und General verschwinden nie.
    if (status === 404 && canRenameId(conversation.id) && (await confirmGone(conversation.id))) {
      if (generation === state.generation) void conversationGone(conversation.id);
      return;
    }
    if (!ok || !data) throw new Error("Verlauf nicht geladen (Fehler " + status + ")");
    if (isTelegramId(conversation.id)) {
      // Telegram: jüngste Seite dazumischen, nicht ersetzen. Nachgeladene
      // ältere Seiten und per SSE Gekommenes (auch reine Live-Meldungen wie
      // „Abgebrochen.") bleiben; gleiche IDs (msgId) erscheinen nur einmal.
      const list = Array.isArray(data.messages) ? data.messages : [];
      mergeMessages(list);
      // Ob es Älteres gibt, sagt nur die erste Seite; ein Abgleich später
      // sieht nur die jüngsten und darf den Nachlade-Knopf nicht verstecken
      if (!state.historyLoaded) {
        state.historyLoaded = true;
        state.hasMore = !!data.hasMore && list.length > 0;
      }
      renderMessages();
      scrollToBottom();
      if (seq === state.statusSeq) setRunning(!!data.running);
      else updateControls();
      return;
    }
    // Neu geladen: Server-Stand ist maßgeblich, später per SSE Gekommenes bleibt.
    // War eine Rückfrage beim Server nicht lesbar (nur choiceId), bleibt der
    // bisher gezeigte Stand, bis syncChoices den aktuellen bringt.
    const list = Array.isArray(data.messages) ? data.messages : [];
    const known = new Set(list.map(m => m && m.id));
    const later = state.messages.filter(m => !known.has(m.id) && !String(m.id).startsWith("lokal-"));
    const before = new Map(state.messages.map(m => [m.id, m]));
    state.messages = [];
    mergeMessages(list.map(m => {
      const old = m && !m.choice && m.choiceId ? before.get(m.id) : null;
      if (!old || !old.choice || old.choice.id !== m.choiceId) return m;
      const { choiceId: _id, ...rest } = m;
      return Object.assign(rest, { choice: old.choice });
    }));
    mergeMessages(later);
    renderMessages();
    scrollToBottom();
    // Kam zwischendurch ein status-Ereignis, ist es aktueller als diese Antwort
    if (seq === state.statusSeq) setRunning(!!data.running, !!data.awaiting, data.approvalId);
    else updateControls();
  }

  function clearSyncTimer() {
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = null;
  }

  /**
   * Stand aller Rückfragen, die im geladenen Verlauf noch offen stehen
   * (Issue #115). Der Verlauf bringt nur die jüngste Seite; Fragen auf älteren,
   * nachgeladenen Seiten, die in einer Verbindungslücke entschieden wurden,
   * kämen sonst nie an. Wirft bei Fehlern, dann wiederholt syncMessages.
   */
  async function syncChoices() {
    const conversation = state.conversation;
    if (!conversation) return;
    const generation = state.generation;
    const ids = [];
    for (const m of state.messages) {
      // Offene Fragen und solche, deren Stand beim Laden nicht lesbar war
      const unresolved = unresolvedChoiceId(m);
      const id = unresolved || (m.choice && m.choice.state === "open" && !state.choiceFinal.has(m.choice.id) ? m.choice.id : "");
      if (id && !ids.includes(id)) ids.push(id);
    }
    for (let i = 0; i < ids.length; i += CHOICE_SNAPSHOT_MAX) {
      const part = ids.slice(i, i + CHOICE_SNAPSHOT_MAX);
      const { ok, status, data } = await api(
        "GET",
        "/api/conversations/" + conversation.id + "/choices?ids=" + part.map(encodeURIComponent).join(",")
      );
      if (generation !== state.generation) return;
      if (!ok || !data || !Array.isArray(data.choices)) throw new Error("Rückfragen nicht geladen (Fehler " + status + ")");
      for (const choice of data.choices) applyChoice(choice);
    }
  }

  /**
   * Gleicht den Verlauf mit dem Server ab und wiederholt das bei Fehlern, bis
   * es klappt. Der Hinweis bleibt stehen, bis ein Abgleich bei offener
   * Verbindung gelungen ist.
   */
  async function syncMessages() {
    const generation = state.generation;
    clearSyncTimer();
    try {
      await loadMessages();
      if (generation !== state.generation) return;
      await syncChoices();
      if (generation !== state.generation) return;
      state.syncDelay = 1000;
      if (state.connected) showConnection("");
    } catch {
      if (generation !== state.generation || state.leaving) return;
      if (state.connected) showConnection("Verlauf konnte nicht geladen werden, neuer Versuch läuft");
      clearSyncTimer();
      const delay = state.syncDelay;
      state.syncDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
      state.syncTimer = setTimeout(() => {
        state.syncTimer = null;
        if (generation === state.generation && !state.leaving) void syncMessages();
      }, delay);
    }
  }

  /**
   * Telegram: lädt die Seite vor der ältesten geladenen Nachricht. Cursor ist
   * deren createdAt, unverändert (samt Mikrosekunden) und URL-kodiert. Die
   * sichtbare Stelle bleibt stehen: Der Abstand zum unteren Ende des
   * Verlaufs ist vor und nach dem Voranstellen gleich. Doppelklicks und
   * Antworten, die erst nach einem Gesprächswechsel eintreffen, bleiben ohne Wirkung.
   */
  async function loadOlder() {
    const conversation = state.conversation;
    if (!conversation || !isTelegram() || !state.hasMore || state.loadingOlder) return;
    const oldest = state.messages.find(m => m && typeof m.createdAt === "string" && m.createdAt);
    if (!oldest) return;
    const generation = state.generation;
    state.loadingOlder = true;
    renderMessages();
    let loaded = null;
    try {
      const { ok, data } = await api(
        "GET",
        "/api/conversations/" + conversation.id + "/messages?before=" + encodeURIComponent(oldest.createdAt)
      );
      if (ok && data && Array.isArray(data.messages)) loaded = data;
    } catch {
      // unten als Hinweis gemeldet
    }
    if (generation !== state.generation) return;
    state.loadingOlder = false;
    if (!loaded) {
      if (!state.leaving) showConnection("Ältere Nachrichten konnten nicht geladen werden");
      renderMessages();
      return;
    }
    showConnection("");
    const fromBottom = el.log.scrollHeight - el.log.scrollTop;
    const added = mergeMessages(loaded.messages);
    // Kam nichts Neues, gibt es auch nichts mehr zu holen (keine Endlosschleife)
    state.hasMore = !!loaded.hasMore && added;
    renderMessages();
    el.log.scrollTop = el.log.scrollHeight - fromBottom;
    // Rückfrage beim Server nicht lesbar: Stand nachholen, bei Fehlern mit neuem Versuch
    if (loaded.messages.some(m => m && unresolvedChoiceId(m)) && !state.syncTimer) void syncMessages();
  }

  // --- Seitenleiste ---------------------------------------------------------

  function conversationTitle(conversation) {
    return String((conversation && conversation.title) || "Neues Gespräch");
  }

  /** Offenes Gespräch ist ein Telegram-Gespräch (Direktchat oder Topic) */
  function isTelegram() {
    return !!state.conversation && isTelegramId(state.conversation.id);
  }

  /**
   * Ein Eintrag der Seitenleiste. Titel und Namen nur als Text; Telegram-
   * Einträge zeigen rechts die letzte Aktivität.
   */
  function conversationItem(c, withTime) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "conversation";
    button.setAttribute("type", "button");
    button.setAttribute("data-id", String(c.id));
    if (state.conversation && c.id === state.conversation.id) button.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversationTitle(c);
    button.appendChild(title);
    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    meta.setAttribute("data-agent", String(c.agent || "general"));
    const dot = document.createElement("span");
    dot.className = "agent-dot";
    meta.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = agentLabel(c.agent) || "General";
    meta.appendChild(name);
    // Geschlossenes Topic: gedämpft, mit Schloss und Namen für Screenreader
    if (c.closed === true) {
      button.setAttribute("data-closed", "true");
      const lock = document.createElement("span");
      lock.className = "closed-mark";
      lock.setAttribute("role", "img");
      lock.setAttribute("aria-label", "geschlossen");
      lock.setAttribute("title", "Geschlossen");
      const icon = lockIcon();
      if (icon) lock.appendChild(icon);
      meta.appendChild(lock);
    }
    if (withTime) {
      const when = relativeTime(c.lastActivity);
      if (when) {
        const time = document.createElement("span");
        time.className = "conversation-time";
        time.textContent = when;
        meta.appendChild(time);
      }
    }
    // Neue Nachricht, seit das Gespräch zuletzt offen war: neutraler Punkt, kein Akzentblau
    if (state.unread.has(c.id) && !(state.conversation && state.conversation.id === c.id)) {
      button.setAttribute("data-unread", "true");
      const unread = document.createElement("span");
      unread.className = "unread-dot";
      unread.setAttribute("role", "img");
      unread.setAttribute("aria-label", "neu");
      unread.setAttribute("title", "Neue Nachricht");
      meta.appendChild(unread);
    }
    button.appendChild(meta);
    button.setAttribute("data-focus-key", "open:" + c.id);
    button.addEventListener("click", () => {
      closeSidebar();
      if (!state.conversation || state.conversation.id !== c.id) openConversation(c);
    });
    li.appendChild(button);
    // Menü für Web-Gespräche und Topics außer General (Direktchat und General nicht)
    if (canRenameId(c.id)) {
      li.className = "conversation-row";
      const open = !!state.menu && state.menu.place === "entry" && state.menu.id === c.id;
      const more = document.createElement("button");
      more.className = "icon-button entry-menu";
      more.setAttribute("type", "button");
      more.setAttribute("aria-label", "Optionen für " + conversationTitle(c));
      more.setAttribute("aria-expanded", open ? "true" : "false");
      more.setAttribute("data-focus-key", "menu:" + c.id);
      const icon = moreIcon();
      if (icon) more.appendChild(icon);
      more.addEventListener("click", () => toggleMenu("entry", c.id));
      li.appendChild(more);
      if (open) li.appendChild(actionsPanel(c, "entry"));
    }
    return li;
  }

  function fillList(list, items, withTime) {
    const fragment = document.createDocumentFragment();
    for (const c of items) fragment.appendChild(conversationItem(c, withTime));
    list.replaceChildren(fragment);
  }

  /**
   * Zeichnet die drei Gruppen. Der Filter wirkt nur lokal auf die Titel.
   * Bei aktivem Filter stehen passende ältere Topics aufgeklappt da; ohne
   * Filter gilt wieder der eigene Einklappzustand. Leere Gruppen verschwinden.
   */
  function renderConversationList() {
    // Neu gezeichnete Einträge ersetzen die alten Knöpfe: Fokus danach wiederherstellen
    const focused = document.activeElement && typeof document.activeElement.getAttribute === "function"
      ? document.activeElement.getAttribute("data-focus-key")
      : null;
    renderGroups();
    if (focused && !state.menuFocus) focusKey(focused);
  }

  /** Setzt den Fokus auf das Element mit diesem data-focus-key, falls es eines gibt. */
  function focusKey(key) {
    if (!key || typeof document.querySelector !== "function") return;
    const target = document.querySelector('[data-focus-key="' + key.replace(/["\\]/g, "") + '"]');
    if (target && typeof target.focus === "function") target.focus();
  }

  function renderGroups() {
    const filter = el.filter ? el.filter.value : "";
    const filtering = !!String(filter).trim();
    const match = c => matchesFilter(conversationTitle(c), filter);

    const dm = state.telegram.dm && match(state.telegram.dm) ? [state.telegram.dm] : [];
    fillList(el.dmList, dm, true);
    el.dmGroup.hidden = dm.length === 0;

    const { recent, older } = splitTopics(state.telegram.topics, undefined, state.pinned);
    const recentShown = recent.filter(match);
    const olderShown = older.filter(match);
    fillList(el.topicList, recentShown, true);
    fillList(el.olderList, olderShown, true);
    el.topicList.hidden = recentShown.length === 0;
    const olderOpen = filtering || state.olderOpen;
    el.olderLabel.textContent = "Ältere Topics (" + olderShown.length + ")";
    el.olderToggle.hidden = filtering || olderShown.length === 0;
    el.olderToggle.setAttribute("aria-expanded", olderOpen ? "true" : "false");
    el.olderList.hidden = !olderOpen || olderShown.length === 0;
    el.topicGroup.hidden = recentShown.length + olderShown.length === 0;

    const web = state.conversations.filter(match);
    fillList(el.list, web, false);
    // Nur, wenn es (passende) ältere Web-Gespräche gibt; neue entstehen nicht mehr (Entscheidung 0005)
    el.webGroup.hidden = web.length === 0;

    el.filterEmpty.hidden = !filtering || dm.length + recentShown.length + olderShown.length + web.length > 0;
  }

  /** Übernimmt die Antwort von GET /api/conversations; fehlendes telegram heißt: keine. */
  function applyConversationList(data) {
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    const telegram = data.telegram && typeof data.telegram === "object" ? data.telegram : {};
    state.telegram = {
      dm: telegram.dm && typeof telegram.dm === "object" && telegram.dm.id === "dm" ? telegram.dm : null,
      topics: Array.isArray(telegram.topics) ? telegram.topics.filter(t => t && isTelegramId(t.id) && t.id !== "dm") : [],
      // Chat-ID der Forum-Gruppe; fehlt sie, gilt kein Topic-Name als zugeordnet (Issue #51)
      chatId: typeof telegram.chatId === "string" && telegram.chatId ? telegram.chatId : null,
    };
    state.engineDefault = data.engine && typeof data.engine.default === "string" ? data.engine.default : null;
  }

  /** Eintrag mit dieser ID aus allen drei Gruppen, sonst null */
  function findConversation(id) {
    if (!id) return null;
    if (state.telegram.dm && state.telegram.dm.id === id) return state.telegram.dm;
    return state.telegram.topics.find(t => t.id === id) || state.conversations.find(c => c.id === id) || null;
  }

  /**
   * Neuer Stand eines Eintrags über den alten. closed kommt nur vom neuen:
   * Wiederöffnen liefert kein closed-Feld, ein altes closed: true darf nicht bleiben.
   * exactTitle ebenso, aber nur bei einem vollständigen Serverstand (mit title):
   * nach dem Umbenennen fehlt es dort, ein Teilstand wie { id, closed: true }
   * lässt den weiterhin gültigen exakten Namen stehen.
   */
  function mergeEntry(old, updated) {
    const base = Object.assign({}, old);
    delete base.closed;
    if (typeof updated.title === "string") delete base.exactTitle;
    return Object.assign(base, updated);
  }

  /** Neues Gespräch vorn in seine Gruppe: Topics zu den Topics (oben angeheftet), ältere Web-Gespräche zu den Web-Gesprächen */
  function addConversation(conversation) {
    if (isTelegramId(conversation.id)) {
      state.telegram.topics = [conversation].concat(state.telegram.topics.filter(t => t.id !== conversation.id));
      state.pinned.delete(conversation.id);
      state.pinned.add(conversation.id);
    } else {
      state.conversations = [conversation].concat(state.conversations.filter(c => c.id !== conversation.id));
    }
  }

  /**
   * Erstes vorhandenes Gespräch, ohne eines anzulegen (Issue #30): jüngstes
   * Web-Gespräch, sonst Direktchat, sonst das zuletzt aktive offene Topic,
   * sonst irgendein Topic; null, wenn es gar keines gibt.
   */
  function firstExisting() {
    const { recent, older } = splitTopics(state.telegram.topics, undefined, state.pinned);
    return state.conversations[0] || state.telegram.dm || recent[0] || older.find(t => t.closed !== true) || older[0] || null;
  }

  /**
   * Nach dem Abgleich mit dem Server: Telegram-Gespräche, deren letzte
   * Aktivität jünger ist als bisher bekannt (z.B. Nachricht während einer
   * Verbindungslücke), bekommen den Neu-Punkt, außer dem offenen.
   */
  function markNewerActivity(before) {
    const previous = new Map();
    if (before.dm) previous.set(before.dm.id, before.dm.lastActivity);
    for (const t of before.topics) previous.set(t.id, t.lastActivity);
    const after = state.telegram.dm ? [state.telegram.dm, ...state.telegram.topics] : state.telegram.topics;
    for (const entry of after) {
      if (!Number.isFinite(parseTime(entry.lastActivity))) continue;
      if (state.conversation && state.conversation.id === entry.id) continue;
      const known = previous.get(entry.id);
      if (known && timeKey(known) >= timeKey(entry.lastActivity)) continue;
      markUnread(entry.id);
    }
  }

  /** Holt die Liste neu (z.B. für den Titel nach der ersten Nachricht). */
  async function refreshConversations() {
    try {
      const changes = state.entryChanges;
      const { ok, data } = await api("GET", "/api/conversations");
      if (!ok || !data || !Array.isArray(data.conversations)) return;
      // Inzwischen bestätigte Änderung: diese Liste ist älter, eine neue enthält sie
      if (changes !== state.entryChanges) {
        void refreshConversations();
        return;
      }
      const before = state.telegram;
      applyConversationList(data);
      markNewerActivity(before);
      const current = state.conversation && findConversation(state.conversation.id);
      if (current) {
        // Agent in einem anderen Browser geändert: Sprecher älterer Antworten festhalten
        keepSpeakers(current.agent);
        state.conversation = mergeEntry(state.conversation, current);
        if (!state.editingTitle) el.title.textContent = conversationTitle(state.conversation);
        renderAgentChip();
        updatePlaceholder();
        updateControls();
      }
      renderConversationList();
      renderHeaderMenu();
    } catch {
      // Liste ist Beiwerk; der Chat funktioniert auch ohne
    }
  }

  /** Agent-Chip der Kopfzeile aus dem offenen Gespräch, daneben die Motor-Pille (Issue #126) */
  function renderAgentChip() {
    const conversation = state.conversation;
    el.agent.textContent = conversation ? agentLabel(conversation.agent) : "";
    el.agent.setAttribute("data-agent", String((conversation && conversation.agent) || "general"));
    renderEnginePill();
  }

  /**
   * Motor-Pille: eingestellter Motor des offenen Gesprächs aus der
   * Gesprächsliste. /motor, Standard und „Auf Standard" kommen als
   * SSE-Ereignis engine, danach ein Abgleich der Liste; ohne Angabe keine Pille.
   */
  function renderEnginePill() {
    if (!el.engine) return;
    const conversation = state.conversation;
    const listed = conversation ? findConversation(conversation.id) : null;
    const engine = listed && typeof listed.engine === "string" ? listed.engine : conversation && conversation.engine;
    const text = conversation ? enginePillText(engine, state.engineDefault) : null;
    el.engine.textContent = text || "";
    el.engine.hidden = !text;
    // Leeren statt entfernen: die Pille ist dann ohnehin ausgeblendet
    el.engine.setAttribute("data-engine", text ? engine : "");
    el.engine.setAttribute("title", text ? "Motor dieses Gesprächs: " + text + ". Wechseln mit /motor." : "");
  }

  /**
   * Vor einem Agentenwechsel im offenen Gespräch: Antworten ohne eigenen
   * Sprecher behalten den bisherigen Agenten, statt beim nächsten Zeichnen
   * den neuen zu zeigen (Issue #38).
   */
  function keepSpeakers(nextAgent) {
    const previous = state.conversation && state.conversation.agent;
    if (!previous || !nextAgent || previous === nextAgent) return;
    state.messages = state.messages.map(m =>
      m && m.role === "assistant" && !(typeof m.agent === "string" && m.agent) ? Object.assign({}, m, { agent: previous }) : m
    );
  }

  function openSidebar() {
    el.sidebar.setAttribute("data-open", "true");
    el.scrim.hidden = false;
    el.menu.setAttribute("aria-expanded", "true");
    el.newChat.focus();
  }

  function closeSidebar() {
    const wasOpen = el.sidebar.getAttribute("data-open") === "true";
    el.sidebar.setAttribute("data-open", "false");
    el.scrim.hidden = true;
    el.menu.setAttribute("aria-expanded", "false");
    // Fokus zurück zum Menü-Knopf, aber nur, wenn die Schublade offen war
    if (wasOpen) el.menu.focus();
  }

  /** Merkt das Gespräch für den nächsten Start; gesperrter Speicher stört nicht. */
  function rememberConversation(id) {
    try {
      window.localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
    } catch {
      // privater Modus oder Speicher voll
    }
  }

  /** Neu-Punkte laden; nur Telegram-IDs, gesperrter oder kaputter Speicher ergibt keine. */
  function loadUnread() {
    try {
      const list = JSON.parse(window.localStorage.getItem(UNREAD_KEY) || "[]");
      return new Set(Array.isArray(list) ? list.filter(id => typeof id === "string" && isTelegramId(id)) : []);
    } catch {
      return new Set();
    }
  }

  function saveUnread() {
    try {
      window.localStorage.setItem(UNREAD_KEY, JSON.stringify([...state.unread]));
    } catch {
      // privater Modus oder Speicher voll
    }
  }

  function markUnread(id) {
    if (state.unread.has(id)) return;
    state.unread.add(id);
    saveUnread();
  }

  function clearUnread(id) {
    if (!state.unread.delete(id)) return;
    saveUnread();
  }

  function rememberedConversation() {
    try {
      const value = window.localStorage.getItem(LAST_CONVERSATION_KEY);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Eingabe und Leerzustand passend zur Art des Gesprächs. Ein angefangener
   * Entwurf bleibt beim Gespräch, in dem er getippt wurde, und kommt beim
   * Zurückwechseln wieder.
   */
  /** Platzhalter der Eingabe; bei Telegram mit dem aktuellen Namen (auch nach dem Umbenennen) */
  function updatePlaceholder() {
    const conversation = state.conversation;
    if (!conversation) return;
    el.input.setAttribute("placeholder", isTelegramId(conversation.id) ? "Nachricht an " + conversationTitle(conversation) : "Nachricht an " + brandName());
  }

  function applyMode(previousId, conversation) {
    if (previousId) {
      if (el.input.value) state.drafts.set(previousId, el.input.value);
      else state.drafts.delete(previousId);
    }
    el.input.value = state.drafts.get(conversation.id) || "";
    state.commandDismissed = null;
    closeCommandList();
    // Anhänge bleiben beim Gespräch, in dem sie angelegt wurden
    state.dragDepth = 0;
    setDropping(false);
    showAttachNote("");
    renderAttachments();
    const telegram = isTelegramId(conversation.id);
    updatePlaceholder();
    el.emptyTitle.textContent = telegram ? "Noch keine Nachrichten" : "Womit kann ich helfen?";
    el.emptyText.textContent = telegram
      ? "Für dieses Telegram-Gespräch ist noch nichts gespeichert. Was du hier schreibst, erscheint auch in Telegram. " +
        "Bilder, PDFs und Sprachdateien über die Büroklammer, per Ziehen oder mit Strg/Cmd+V; " +
        "wo Bild-Uploads gesperrt sind: /b64 und dahinter den Base64-Code."
      : "Gleiches Gedächtnis wie in Telegram. Enter sendet, Shift+Enter macht eine neue Zeile. " +
        "Bilder, PDFs und Sprachdateien über die Büroklammer, per Ziehen oder mit Strg/Cmd+V; " +
        "wo Bild-Uploads gesperrt sind: /b64 und dahinter den Base64-Code.";
    autosize();
  }

  function openConversation(conversation) {
    const previousId = state.conversation ? state.conversation.id : null;
    // Eine laufende Aufnahme gehört zum alten Gespräch: verwerfen, Mikrofon frei
    discardRecording();
    // Offene Bearbeitung, Menüs und Agentenauswahl gehören zum alten Stand
    cancelRename();
    state.menu = null;
    if (state.pickerOpen) closePicker(false);
    state.generation++;
    state.conversation = conversation;
    state.messages = [];
    state.statusSeq = 0;
    state.syncDelay = 1000;
    state.hasMore = false;
    state.historyLoaded = false;
    state.loadingOlder = false;
    el.messages.replaceChildren();
    // Player des alten Gesprächs: Wiedergabe stoppen, Downloads verwerfen, Objekt-URLs freigeben
    releaseHistoryPlayers(false);
    el.empty.hidden = true;
    el.loadOlder.hidden = true;
    el.title.textContent = conversationTitle(conversation);
    renderAgentChip();
    // Web-Gespräche und Topics außer General lassen sich umbenennen und verwalten
    const manageable = canRenameId(conversation.id);
    el.title.disabled = !manageable;
    if (manageable) el.title.setAttribute("title", "Zum Umbenennen antippen");
    else el.title.setAttribute("title", "");
    el.conversationMenu.hidden = !manageable;
    renderHeaderMenu();
    rememberConversation(conversation.id);
    clearUnread(conversation.id);
    renderConversationList();
    applyMode(previousId, conversation);
    setRunning(false);
    showConnection("");
    state.goalPending = false;
    applyGoal(null);
    connectEvents();
    void syncMessages();
    void loadGoal();
  }

  // --- Ziel (/goal, Issue #76) -----------------------------------------------

  const GOAL_ACTION_LABELS = { pause: "Pause", resume: "Weiter", more: "Weiter (+5)", stop: "Stopp" };

  /** Nur eine vollständige Karte des Servers; alles andere heißt: keine Karte */
  function goalCardOrNull(card) {
    if (!card || typeof card !== "object") return null;
    if (typeof card.goalId !== "number" || typeof card.goal !== "string") return null;
    if (typeof card.turnsUsed !== "number" || typeof card.maxTurns !== "number") return null;
    const actions = Array.isArray(card.actions) ? card.actions.filter(a => Object.prototype.hasOwnProperty.call(GOAL_ACTION_LABELS, a)) : [];
    return { ...card, actions };
  }

  function applyGoal(card) {
    state.goal = goalCardOrNull(card);
    state.goalError = "";
    renderGoalCard();
  }

  /** Karte des offenen Gesprächs laden: beim Öffnen und nach jedem Neuverbinden */
  async function loadGoal() {
    const conversation = state.conversation;
    if (!conversation || !isTelegramId(conversation.id)) return;
    const generation = state.generation;
    const seq = state.goalSeq;
    try {
      const { ok, data } = await api("GET", "/api/conversations/" + conversation.id + "/goal");
      if (generation !== state.generation || seq !== state.goalSeq || state.goalPending) return;
      if (ok && data) applyGoal(data.card);
    } catch {
      // offline; das nächste open lädt erneut
    }
  }

  async function pressGoal(action) {
    const conversation = state.conversation;
    const card = state.goal;
    // Solange ein Knopf wartet, zählt kein zweiter (Doppelklick)
    if (!conversation || !card || state.goalPending) return;
    state.goalPending = true;
    state.goalError = "";
    renderGoalCard();
    const generation = state.generation;
    const seq = state.goalSeq;
    try {
      const { ok, status, data } = await api("POST", "/api/conversations/" + conversation.id + "/goal", { action, goalId: card.goalId });
      if (generation !== state.generation) return;
      // Ein goal-Ereignis ist neuer als diese Antwort
      if (data && "card" in data && seq === state.goalSeq) state.goal = goalCardOrNull(data.card);
      if (!ok) {
        const fallback = status === 409 ? "Der Knopf passt nicht mehr zum Stand des Ziels." : "Die Aktion ist fehlgeschlagen.";
        state.goalError = data && typeof data.error === "string" && data.error ? data.error : fallback;
      }
    } catch {
      if (generation === state.generation) state.goalError = "Server nicht erreichbar.";
    } finally {
      if (generation === state.generation) {
        state.goalPending = false;
        renderGoalCard();
      }
    }
  }

  function goalStateText(card) {
    if (card.status === "paused") return "pausiert";
    return card.running ? "arbeitet" : "aktiv";
  }

  /**
   * Karte über der Eingabe: „Ziel" mit Zustand, der Zieltext, Runde x von n
   * und Agent, der letzte Stand, die Knöpfe. Texte nur über textContent.
   */
  function renderGoalCard() {
    const box = el.goalCard;
    const card = state.goal;
    if (!card) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const head = document.createElement("div");
    head.className = "goal-head";
    const label = document.createElement("span");
    label.className = "goal-label";
    label.textContent = "Ziel";
    head.appendChild(label);
    const pill = document.createElement("span");
    pill.className = "goal-state";
    pill.setAttribute("data-state", card.status === "paused" ? "paused" : card.running ? "running" : "active");
    pill.textContent = goalStateText(card);
    head.appendChild(pill);

    const text = document.createElement("p");
    text.className = "goal-text";
    text.textContent = card.goal;

    const meta = document.createElement("p");
    meta.className = "goal-meta";
    const agent = typeof card.agent === "string" && card.agent ? " · " + (agentLabel(card.agent) || card.agent) : "";
    meta.textContent = "Runde " + card.turnsUsed + " von " + card.maxTurns + agent;

    const parts = [head, text, meta];
    if (typeof card.note === "string" && card.note) {
      const note = document.createElement("p");
      note.className = "goal-note";
      note.textContent = "Letzter Stand: " + card.note;
      parts.push(note);
    }
    if (card.actions.length) {
      const actions = document.createElement("div");
      actions.className = "goal-actions";
      for (const action of card.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet-button goal-button";
        button.setAttribute("data-action", action);
        button.textContent = GOAL_ACTION_LABELS[action];
        button.disabled = state.goalPending;
        button.addEventListener("click", () => void pressGoal(action));
        actions.appendChild(button);
      }
      parts.push(actions);
    }
    if (state.goalError) {
      const error = document.createElement("p");
      error.className = "goal-error";
      error.setAttribute("role", "alert");
      error.textContent = state.goalError;
      parts.push(error);
    }
    box.replaceChildren(...parts);
    box.hidden = false;
  }

  /**
   * Legt ein Gespräch an; ohne agent nimmt der Server General. Seit Issue #29
   * ist das ein Telegram-Topic (topic-<n>). Ergebnis: { conversation, error }.
   * conversation fehlt, wenn nichts angelegt wurde; error ist die Meldung des
   * Servers (keine Gruppe, fehlendes Recht, Telegram lehnt ab). Ein 500 mit
   * conversation heißt: Topic angelegt, aber nicht alles gespeichert.
   */
  async function createConversation(agent) {
    const { status, data } = await api("POST", "/api/conversations", agent ? { agent } : {});
    const conversation = data && data.conversation && typeof data.conversation === "object" && typeof data.conversation.id === "string"
      ? data.conversation
      : null;
    const serverError = data && typeof data.error === "string" && data.error ? data.error : null;
    if (status === 201 && conversation) return { conversation, error: null };
    return { conversation, error: serverError || "Neues Gespräch konnte nicht angelegt werden (Fehler " + status + ")." };
  }

  /**
   * Kein Gespräch offen und keines da (Issue #30): Leerzustand mit „Neues
   * Gespräch", Eingabe gesperrt. Es wird nie von selbst eines angelegt,
   * denn das wäre ein echtes Telegram-Topic.
   */
  function showNoConversation() {
    state.conversation = null;
    state.messages = [];
    state.goalPending = false;
    applyGoal(null);
    el.title.textContent = brandName();
    el.title.disabled = true;
    el.title.setAttribute("title", "");
    el.agent.textContent = "";
    renderEnginePill();
    el.conversationMenu.hidden = true;
    el.input.value = "";
    closeCommandList();
    el.input.setAttribute("placeholder", "Erst ein Gespräch wählen oder anlegen");
    renderHeaderMenu();
    renderConversationList();
    renderMessages();
    setRunning(false);
  }

  async function start() {
    state.busy = true;
    updateControls();
    // Agentenliste nebenher; bis sie da ist, bietet die Auswahl nur General an
    void loadAgents();
    try {
      const { ok, data } = await api("GET", "/api/conversations");
      if (!ok || !data) throw new Error("Liste nicht geladen");
      applyConversationList(data);
      // Zuletzt geöffnetes Gespräch, falls es noch existiert; sonst das
      // jüngste Web-Gespräch, der Direktchat oder ein Topic. Nie anlegen:
      // das wäre bei jedem Seitenaufruf ein neues Telegram-Topic (Issue #30)
      const first = findConversation(rememberedConversation()) || firstExisting();
      // Vor dem Gespräch: dessen Strom bleibt der zuletzt geöffnete
      connectActivity();
      if (!first) {
        showNoConversation();
        return;
      }
      // Liegt es unter „Ältere Topics", die Gruppe aufklappen, damit die Markierung zu sehen ist
      if (splitTopics(state.telegram.topics, undefined, state.pinned).older.some(t => t.id === first.id)) state.olderOpen = true;
      openConversation(first);
    } catch {
      if (!state.leaving) showConnection("Server nicht erreichbar. Bitte die Seite neu laden.");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  // --- Neue Version (Issue #111) ---------------------------------------------

  /**
   * Fragt die Version des Servers ab. Gleichzeitige Anlässe (beide
   * Live-Verbindungen, Sichtbarwerden) teilen eine Anfrage. Fehler bleiben
   * still, der nächste Anlass fragt erneut.
   */
  function checkUiVersion() {
    const u = state.update;
    if (!u.loaded || u.available || state.leaving) return Promise.resolve();
    if (u.checking) return u.checking;
    u.lastCheck = Date.now();
    u.checking = (async () => {
      try {
        const { ok, data } = await api("GET", UI_VERSION_PATH);
        const version = ok && data ? data.version : null;
        if (typeof version === "string" && UI_VERSION_PATTERN.test(version) && version !== u.loaded) showUpdate();
      } catch {
        // offline oder abgemeldet; bei 401 hat api() schon umgeleitet
      } finally {
        u.checking = null;
      }
    })();
    return u.checking;
  }

  /**
   * Tab wieder sichtbar: prüfen, höchstens einmal pro Minute. Eine gebremste
   * Prüfung wird nach Ablauf der Minute einmal nachgeholt, damit sie den
   * Hinweis nicht dauerhaft verhindert; kein Dauer-Polling.
   */
  function onVisible() {
    if (document.visibilityState === "hidden") return;
    const u = state.update;
    if (!u.loaded || u.available) return;
    const wait = u.lastCheck + VERSION_CHECK_MIN_MS - Date.now();
    if (wait <= 0) {
      // Ein überholter Timer (im Hintergrund pausiert) darf nicht gleich noch einmal fragen
      if (u.deferTimer) clearTimeout(u.deferTimer);
      u.deferTimer = null;
      void checkUiVersion();
      return;
    }
    if (u.deferTimer) return;
    u.deferTimer = setTimeout(() => {
      u.deferTimer = null;
      // Inzwischen geprüft (etwa beim Wiederverbinden): die Grenze gilt ab dort neu
      onVisible();
    }, wait);
  }

  function showUpdate() {
    const u = state.update;
    if (u.available) return;
    u.available = true;
    if (u.deferTimer) clearTimeout(u.deferTimer);
    u.deferTimer = null;
    renderUpdateNotes();
  }

  function updateButton(label, primary, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "update-button primary" : "update-button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  /** Beide Hinweise (Chat, Einstellungen) gleich; leer sind sie unsichtbar */
  function renderUpdateNotes(focusCancel) {
    const u = state.update;
    for (const note of el.updateNotes) {
      if (!note) continue;
      if (!u.available) {
        note.replaceChildren();
        continue;
      }
      const text = document.createElement("p");
      text.className = "update-text";
      const actions = document.createElement("div");
      actions.className = "update-actions";
      let cancel = null;
      if (u.risks) {
        text.textContent = u.risks.join(" ") + " Trotzdem neu laden?";
        cancel = updateButton("Abbrechen", false, () => cancelReload());
        actions.appendChild(updateButton("Neu laden", true, () => reloadNow()));
        actions.appendChild(cancel);
      } else {
        text.textContent = "Neue Version von " + brandName() + " verfügbar";
        actions.appendChild(updateButton("Neu laden", true, () => requestReload()));
      }
      note.replaceChildren(text, actions);
      // Fokus nur im sichtbaren Hinweis; Abbrechen ist die sichere Wahl
      const visible = (note === el.updateNotes[1]) === (el.main.getAttribute("data-view") === "settings");
      if (focusCancel && cancel && visible) cancel.focus();
    }
  }

  // --- Entwürfe über das Neuladen (Issue #111) --------------------------------

  function sessionStore() {
    try {
      return window.sessionStorage || null;
    } catch {
      // gesperrt (etwa Datenschutz-Einstellungen)
      return null;
    }
  }

  /**
   * Sichert alle Entwürfe samt aktueller Eingabe je Gespräch. true, wenn
   * nichts verloren geht (auch: es gibt keinen Entwurf), false bei gesperrtem
   * oder vollem Speicher.
   */
  function saveReloadDrafts() {
    const drafts = new Map(state.drafts);
    const id = state.conversation ? state.conversation.id : null;
    if (id) {
      if (el.input.value) drafts.set(id, el.input.value);
      else drafts.delete(id);
    }
    const raw = serializeReloadDrafts(drafts);
    const store = sessionStore();
    try {
      if (raw === null) {
        if (store) store.removeItem(RELOAD_DRAFTS_KEY);
        return true;
      }
      if (!store) return false;
      store.setItem(RELOAD_DRAFTS_KEY, raw);
      return store.getItem(RELOAD_DRAFTS_KEY) === raw;
    } catch {
      return raw === null;
    }
  }

  /** Beim Laden: gesicherte Entwürfe übernehmen (vor dem ersten applyMode) und entfernen */
  function restoreReloadDrafts() {
    const store = sessionStore();
    if (!store) return;
    let raw = null;
    try {
      raw = store.getItem(RELOAD_DRAFTS_KEY);
      if (raw !== null) store.removeItem(RELOAD_DRAFTS_KEY);
    } catch {
      return;
    }
    for (const [id, text] of parseReloadDrafts(raw)) {
      if (!state.drafts.has(id)) state.drafts.set(id, text);
    }
  }

  /** Was beim Neuladen verloren ginge; leer heißt ohne Rückfrage neu laden */
  function reloadRisks(draftsSaved) {
    const risks = [];
    if (state.recording) risks.push("Eine Sprachaufnahme läuft und geht verloren.");
    let uploading = false;
    let unsent = false;
    for (const list of state.attachments.values()) {
      for (const item of list) {
        if (item.status === "uploading") uploading = true;
        else unsent = true;
      }
    }
    if (uploading) risks.push("Ein Upload läuft noch und bricht ab.");
    if (unsent) risks.push("Nicht gesendete Anhänge gehen verloren.");
    let unsaved = false;
    try {
      unsaved = !!(settingsView && typeof settingsView.hasUnsavedChanges === "function" && settingsView.hasUnsavedChanges());
    } catch {
      unsaved = true;
    }
    if (unsaved) risks.push("Ungespeicherte Einstellungen gehen verloren.");
    if (!draftsSaved) risks.push(DRAFTS_LOST_TEXT);
    return risks;
  }

  /** Knopf „Neu laden“: Entwürfe sichern, bei Verlust erst nachfragen */
  function requestReload() {
    const risks = reloadRisks(saveReloadDrafts());
    if (!risks.length) {
      reloadPage();
      return;
    }
    state.update.risks = risks;
    renderUpdateNotes(true);
  }

  function cancelReload() {
    state.update.risks = null;
    renderUpdateNotes();
    // Gesicherte Entwürfe gelten nur für dieses Neuladen
    const store = sessionStore();
    try {
      if (store) store.removeItem(RELOAD_DRAFTS_KEY);
    } catch {
      // nichts zu tun
    }
  }

  /**
   * Nach der Rückfrage bestätigt: Entwürfe erneut sichern (sie können sich
   * geändert haben), dann laden. Scheitert die Sicherung jetzt erst (etwa
   * Text nach einer Rückfrage nur wegen eines Anhangs), erneut nachfragen.
   */
  function reloadNow() {
    const saved = saveReloadDrafts();
    const confirmed = state.update.risks || [];
    if (!saved && !confirmed.includes(DRAFTS_LOST_TEXT)) {
      state.update.risks = reloadRisks(false);
      renderUpdateNotes(true);
      return;
    }
    reloadPage();
  }

  function reloadPage() {
    state.leaving = true;
    discardRecording();
    closeEvents();
    closeActivity();
    window.location.reload();
  }

  // --- Live-Ereignisse -------------------------------------------------------

  function closeEvents() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    // Ein offener Wiederholungsversuch entfällt, das nächste open gleicht ab
    clearSyncTimer();
    if (state.events) state.events.close();
    state.events = null;
    state.connected = false;
  }

  function parse(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  function connectEvents() {
    closeEvents();
    const conversation = state.conversation;
    if (!conversation || state.leaving) return;
    const generation = state.generation;
    const source = new EventSource("/api/conversations/" + conversation.id + "/events");
    state.events = source;
    const current = () => state.events === source && generation === state.generation;

    source.addEventListener("open", () => {
      if (!current()) return;
      state.reconnectDelay = 1000;
      state.connected = true;
      // Nach einem Abbruch (etwa Neustart des Bots) kann eine neue Oberfläche da sein
      if (state.eventsLost) {
        state.eventsLost = false;
        void checkUiVersion();
      }
      // Nach jedem open abgleichen: was vor der ersten Anmeldung oder in einer
      // Lücke entstanden ist, kam nie als Ereignis. Der Hinweis verschwindet
      // erst nach gelungenem Abgleich.
      void syncMessages();
      // Ebenso die Karte des Ziels (Issue #76): Änderungen in der Lücke kamen nie als Ereignis
      void loadGoal();
    });
    // Ziel geändert (Issue #76): aus Browser, Terminal, Telegram oder der laufenden Arbeit
    source.addEventListener("goal", event => {
      if (!current()) return;
      const data = parse(event);
      if (!data || !("card" in data)) return;
      state.goalSeq++;
      state.goal = goalCardOrNull(data.card);
      renderGoalCard();
    });
    // Rückfrage entschieden oder abgelaufen (Issue #115), aus jedem Kanal
    source.addEventListener("choice", event => {
      if (!current()) return;
      const data = parse(event);
      if (!data || data.conversationId !== conversation.id) return;
      applyChoice(data.choice);
    });
    source.addEventListener("status", event => {
      if (!current()) return;
      const data = parse(event);
      if (!data) return;
      state.statusSeq++;
      setRunning(!!data.running, !!data.awaiting, data.approvalId);
    });
    source.addEventListener("progress", event => {
      if (!current()) return;
      const data = parse(event);
      if (data) addProgress(data.kind === "tool" ? "tool" : "snippet", data.text);
    });
    source.addEventListener("notice", event => {
      if (!current()) return;
      const data = parse(event);
      if (data) addProgress("notice", data.text);
    });
    source.addEventListener("message", event => {
      if (!current()) return;
      const data = parse(event);
      if (!data) return;
      addMessages([data]);
      // Rückfrage beim Server nicht lesbar: Stand nachholen, bei Fehlern mit neuem Versuch
      if (unresolvedChoiceId(data) && !state.syncTimer) void syncMessages();
    });
    // Gespräch wurde gelöscht (auch in einem anderen Browser)
    source.addEventListener("deleted", () => {
      if (!current()) return;
      void conversationGone(conversation.id);
    });
    source.addEventListener("error", event => {
      if (!current()) return;
      // Fachlicher Fehler vom Server: benanntes Ereignis mit Daten
      if (typeof event.data === "string") {
        const data = parse(event);
        if (!data) return;
        if (data.id) addMessages([data]);
        else addLocalError(String(data.text || "Unbekannter Fehler"));
        return;
      }
      // Verbindung weg: selbst neu verbinden, vorher Anmeldung prüfen
      source.close();
      state.events = null;
      state.connected = false;
      state.eventsLost = true;
      if (state.leaving) return;
      showConnection("Verbindung unterbrochen, verbinde neu");
      const delay = state.reconnectDelay;
      state.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
      state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        if (generation !== state.generation) return;
        try {
          await api("GET", "/api/me");
        } catch {
          // offline oder abgemeldet; bei 401 hat api() schon umgeleitet
        }
        if (generation === state.generation && !state.leaving) connectEvents();
      }, delay);
    });
  }

  // --- Aktivität der Telegram-Gespräche (Seitenleiste) ----------------------

  function closeActivity() {
    if (state.activityTimer) clearTimeout(state.activityTimer);
    state.activityTimer = null;
    if (state.activityEvents) state.activityEvents.close();
    state.activityEvents = null;
  }

  /**
   * Neue Nachricht in einem Telegram-Gespräch: letzte Aktivität live setzen,
   * ist es nicht offen, bekommt es den Neu-Punkt. Ein unbekanntes Topic
   * (neu angelegt) holt die Liste neu.
   */
  function applyActivity(id, lastActivity) {
    if (!isTelegramId(id) || !Number.isFinite(parseTime(lastActivity))) return;
    const open = !!state.conversation && state.conversation.id === id;
    if (!open) markUnread(id);
    if (id === "dm") {
      const dm = state.telegram.dm;
      if (!dm) {
        void refreshConversations();
        return;
      }
      if (!dm.lastActivity || timeKey(dm.lastActivity) < timeKey(lastActivity)) {
        state.telegram.dm = Object.assign({}, dm, { lastActivity });
      }
    } else {
      const topics = applyTopicActivity(state.telegram.topics, id, lastActivity);
      if (!topics) {
        void refreshConversations();
        return;
      }
      state.telegram.topics = topics;
      // Neues Topic: den Titel setzt der Server aus der ersten Nachricht, die Liste holt ihn
      const topic = topics.find(t => t.id === id);
      if (topic && topic.title === DEFAULT_TITLE) void refreshConversations();
    }
    renderConversationList();
  }

  /**
   * Ein Strom für alle Gespräche, unabhängig vom offenen Gespräch.
   * Er bringt nur ID und Zeitpunkt (activity) oder nur die ID (topic), nie
   * Nachrichteninhalt; den bekommt nur der Strom des offenen Gesprächs.
   * Auch ohne Direktchat und Topics offen: Motor-Änderungen (engine) gelten
   * für reine Web-Gespräche genauso (Issue #126).
   */
  function connectActivity() {
    closeActivity();
    if (state.leaving) return;
    const source = new EventSource(ACTIVITY_EVENTS_PATH);
    state.activityEvents = source;
    const current = () => state.activityEvents === source;
    source.addEventListener("open", () => {
      if (!current()) return;
      state.activityDelay = 1000;
      // Was während der Lücke passiert ist, kam nie als Ereignis; auch eine neue Oberfläche
      if (state.activityWasOpen) {
        void refreshConversations();
        void checkUiVersion();
      }
      state.activityWasOpen = true;
    });
    source.addEventListener("activity", event => {
      if (!current()) return;
      const data = parse(event);
      if (data && typeof data.id === "string") applyActivity(data.id, data.lastActivity);
    });
    // Rückfrage entschieden oder abgelaufen (Issue #115): nur Kennung und Zustand.
    // Steht sie im offenen Gespräch noch offen da, den Verlauf abgleichen
    source.addEventListener("choice", event => {
      if (!current()) return;
      const data = parse(event);
      if (!data || typeof data.id !== "string" || data.state === "open" || !state.conversation) return;
      const shown = state.messages.some(m => (m.choice && m.choice.id === data.id && m.choice.state === "open") || unresolvedChoiceId(m) === data.id);
      if (shown && !state.choicePending.has(data.id)) void syncMessages();
    });
    // Topic in Telegram umbenannt oder angelegt (Issue #32): Liste abgleichen,
    // das setzt Seitenleiste und Kopfzeile; kein Neu-Punkt, es kam keine Nachricht
    source.addEventListener("topic", event => {
      if (!current()) return;
      const data = parse(event);
      if (data && typeof data.id === "string" && isTelegramId(data.id)) void refreshConversations();
    });
    // Motor geändert (Issue #126): /motor aus Telegram, Browser oder Terminal,
    // Standard oder „Auf Standard" auf der Einstellungsseite. Ohne Inhalt: Liste
    // abgleichen, das setzt die Pille der Kopfzeile ohne Neuladen
    source.addEventListener("engine", () => {
      if (!current()) return;
      void refreshConversations();
    });
    source.addEventListener("error", () => {
      if (!current()) return;
      source.close();
      state.activityEvents = null;
      if (state.leaving) return;
      const delay = state.activityDelay;
      state.activityDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
      state.activityTimer = setTimeout(() => {
        state.activityTimer = null;
        if (!state.leaving) connectActivity();
      }, delay);
    });
  }

  // --- Befehlsliste (Issue #77) ----------------------------------------------

  /** Holt GET /api/commands einmal; nach einem Fehlschlag beim nächsten Öffnen erneut. */
  async function loadCommands() {
    if (state.commandsStatus === "loading" || state.commandsStatus === "ok") return;
    state.commandsStatus = "loading";
    try {
      const { status, data } = await api("GET", "/api/commands");
      if (status === 200 && data && Array.isArray(data.commands)) {
        state.commands = normalizeCommands(data.commands);
        state.commandsStatus = "ok";
      } else {
        state.commandsStatus = "failed";
      }
    } catch {
      state.commandsStatus = "failed";
    }
    // Eingabe inzwischen verlassen: die späte Antwort öffnet die Liste nicht wieder
    if (document.activeElement === el.input) updateCommandList();
  }

  /** Öffnet, filtert oder schließt die Liste passend zur Eingabe. */
  function updateCommandList() {
    const value = el.input.value;
    const query = commandQuery(value);
    if (query === null || value === state.commandDismissed || !state.conversation || isClosed()) {
      if (value !== state.commandDismissed) state.commandDismissed = null;
      closeCommandList();
      return;
    }
    state.commandDismissed = null;
    if (!state.commandOpen && (state.commandsStatus === "idle" || state.commandsStatus === "failed")) void loadCommands();
    // /b64 nur, wo Anhänge gehen (Issue #73; seit #112 auch in Web-Gesprächen, nicht im geschlossenen Topic)
    const known = (attachRefusal() ? [] : LOCAL_COMMANDS).concat(state.commands || []);
    const matches = filterCommands(known, query);
    const waiting = state.commandsStatus === "loading" || state.commandsStatus === "idle";
    const failed = state.commandsStatus === "failed";
    // Keine Treffer: ohne Hinweis zu, damit normales Senden ungestört bleibt
    if (!matches.length && !waiting && !failed) {
      closeCommandList();
      return;
    }
    // Web-Gespräche (Issue #112): sonst bliebe der zuerst allein bekannte /b64 markiert, wenn die
    // Befehle des Servers nachkommen. Telegram-Gespräche behalten die Markierung wie bisher.
    const telegram = !!state.conversation && isTelegramId(state.conversation.id);
    const previous = telegram || state.commandMoved ? state.commandMatches[state.commandIndex] : null;
    const keep = previous ? matches.findIndex(c => c.name === previous.name) : -1;
    state.commandMatches = matches;
    state.commandIndex = keep >= 0 ? keep : 0;
    state.commandOpen = true;
    renderCommandList();
  }

  function closeCommandList() {
    if (!state.commandOpen && el.commandList.hidden) return;
    state.commandOpen = false;
    state.commandMatches = [];
    state.commandIndex = 0;
    state.commandMoved = false;
    renderCommandList();
  }

  /** Namen und Beschreibungen nur über textContent. */
  function renderCommandList() {
    const open = state.commandOpen;
    el.commandList.hidden = !open;
    if (!open) {
      el.commandList.replaceChildren();
      if (el.input.removeAttribute) el.input.removeAttribute("aria-activedescendant");
      return;
    }
    const fragment = document.createDocumentFragment();
    let active = null;
    state.commandMatches.forEach((command, index) => {
      const li = document.createElement("li");
      li.className = "command-option";
      li.id = "command-option-" + index;
      li.setAttribute("role", "option");
      li.setAttribute("data-name", command.name);
      li.setAttribute("aria-selected", index === state.commandIndex ? "true" : "false");
      const head = document.createElement("span");
      head.className = "command-head";
      const name = document.createElement("span");
      name.className = "command-name";
      name.textContent = "/" + command.name;
      head.appendChild(name);
      if (command.argsHint) {
        const hint = document.createElement("span");
        hint.className = "command-args";
        hint.textContent = command.argsHint;
        head.appendChild(hint);
      }
      li.appendChild(head);
      if (command.description) {
        const desc = document.createElement("span");
        desc.className = "command-desc";
        desc.textContent = command.description;
        li.appendChild(desc);
      }
      li.addEventListener("click", () => pickCommand(index));
      if (index === state.commandIndex) active = li;
      fragment.appendChild(li);
    });
    // Hinweis auch unter lokalen Befehlen (/b64), solange die Liste des Servers fehlt
    const serverMissing = state.commandsStatus !== "ok";
    if (!state.commandMatches.length || serverMissing) {
      const note = document.createElement("li");
      note.className = "command-note";
      note.setAttribute("role", "presentation");
      note.textContent = state.commandsStatus === "failed" ? "Befehlsliste gerade nicht erreichbar." : "Befehle werden geladen …";
      fragment.appendChild(note);
    }
    el.commandList.replaceChildren(fragment);
    // Markierten Eintrag im sichtbaren Ausschnitt halten, auch beim Umlauf
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
    if (state.commandMatches.length) el.input.setAttribute("aria-activedescendant", "command-option-" + state.commandIndex);
    else if (el.input.removeAttribute) el.input.removeAttribute("aria-activedescendant");
  }

  /** Übernimmt den Befehl ins Feld, sendet nie. */
  function pickCommand(index) {
    const command = state.commandMatches[index];
    if (!command) return;
    const value = commandFill(command);
    el.input.value = value;
    state.commandDismissed = value;
    closeCommandList();
    autosize();
    updateControls();
    el.input.focus();
    if (typeof el.input.setSelectionRange === "function") el.input.setSelectionRange(value.length, value.length);
  }

  /**
   * Tasten bei offener Liste; true, wenn die Taste verbraucht ist. Läuft vor
   * dem Senden per Enter. Nicht während IME-Eingabe; Shift+Enter bleibt
   * Zeilenumbruch, auf Touch-Geräten wählt nur Antippen (Enter wie bisher).
   */
  function commandKeydown(event) {
    if (!state.commandOpen || event.isComposing || event.keyCode === 229) return false;
    const count = state.commandMatches.length;
    if (event.key === "Escape") {
      event.preventDefault();
      // Sonst schlösse das Fenster zusätzlich Menü oder Schublade
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      state.commandDismissed = el.input.value;
      closeCommandList();
      return true;
    }
    if (!count) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      state.commandIndex = (state.commandIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      state.commandMoved = true;
      renderCommandList();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && !touchInput) {
      event.preventDefault();
      pickCommand(state.commandIndex);
      return true;
    }
    return false;
  }

  // --- Anhänge (Issue #73) ---------------------------------------------------

  function attachmentsOf(id) {
    return (id && state.attachments.get(id)) || [];
  }

  function currentAttachments() {
    return state.conversation ? attachmentsOf(state.conversation.id) : [];
  }

  /** Warum im offenen Gespräch nichts angehängt werden kann; null, wenn es geht */
  function attachRefusal() {
    if (!state.conversation) return ATTACHMENT_TEXT.noConversation;
    if (isClosed()) return ATTACHMENT_TEXT.closed;
    return null;
  }

  /** Hinweis über den Chips (abgelehnte Datei, ungültiger Code); leer blendet ihn aus */
  function showAttachNote(text) {
    el.attachNote.textContent = text || "";
    el.attachNote.hidden = !text;
  }

  /**
   * Einziger Weg in die Anhangsliste: Büroklammer, Ziehen, Einfügen und /b64
   * landen alle hier. Einträge { file, name?, kind?, preview? }. Prüft Art,
   * Größe und Anzahl; was nicht passt, nennt der Hinweis über den Chips.
   * Gibt die Zahl der angehängten Dateien zurück.
   */
  function addAttachments(entries) {
    const refusal = attachRefusal();
    if (refusal) {
      showAttachNote(refusal);
      return 0;
    }
    // Während des Sendens gehört die Liste dem laufenden Senden: ablehnen, sichtbar
    if (state.sending) {
      showAttachNote(ATTACHMENT_TEXT.sending);
      return 0;
    }
    const id = state.conversation.id;
    let list = state.attachments.get(id);
    if (!list) {
      list = [];
      state.attachments.set(id, list);
    }
    const problems = [];
    let added = 0;
    for (const entry of entries) {
      const file = entry.file;
      const kind = entry.kind || attachmentKind(file);
      const problem = attachmentProblem(file, kind);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (list.length >= MAX_ATTACHMENTS) {
        problems.push(ATTACHMENT_TEXT.tooMany);
        break;
      }
      const item = {
        key: "a" + ++state.attachmentSeq,
        file,
        name: attachmentName(entry.name || file.name, kind, file.type),
        size: file.size,
        kind,
        preview: entry.preview || null,
        // Aufnahme aus dem Browser (Issue #109): Dauer und lokale Wiedergabe
        duration: typeof entry.duration === "number" ? entry.duration : null,
        audioUrl: null,
        player: null,
        status: "ready",
        id: null,
        error: "",
      };
      list.push(item);
      added++;
      if (!item.preview && kind === "image") void loadPreview(item);
    }
    if (!list.length) state.attachments.delete(id);
    showAttachNote(problems[0] || "");
    renderAttachments();
    updateControls();
    return added;
  }

  /** Vorschau aus den Bytes, nur für erkannte Bildtypen (nie der angegebene Typ) */
  async function loadPreview(item) {
    try {
      if (item.size <= LOCAL_PREVIEW_MAX_BYTES) {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const mime = sniffImage(bytes);
        if (!mime) return;
        item.preview = "data:" + mime + ";base64," + bytesToBase64(bytes);
      } else {
        item.preview = await scaledPreview(item.file);
        if (!item.preview) return;
      }
      if (currentAttachments().includes(item)) renderAttachments();
    } catch {
      // ohne Vorschau: das Symbol bleibt
    }
  }

  /**
   * Große Bilder (über 8 MB): im Browser dekodieren und auf höchstens
   * SCALED_PREVIEW_SIDE Pixel verkleinert als PNG-data:-URL. Nur, wenn die
   * ersten Bytes ein Bild sind; ohne createImageBitmap oder canvas null.
   */
  async function scaledPreview(file) {
    if (typeof window.createImageBitmap !== "function" || typeof file.slice !== "function") return null;
    if (!sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return null;
    const bitmap = await window.createImageBitmap(file);
    try {
      const scale = Math.min(1, SCALED_PREVIEW_SIDE / Math.max(bitmap.width, bitmap.height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext && canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/png");
      return /^data:image\/png;base64,/.test(url) ? url : null;
    } finally {
      if (typeof bitmap.close === "function") bitmap.close();
    }
  }

  function removeAttachment(key) {
    if (state.sending || !state.conversation) return;
    const id = state.conversation.id;
    const list = attachmentsOf(id);
    const index = list.findIndex(item => item.key === key);
    if (index < 0) return;
    releaseAudio(list[index]);
    list.splice(index, 1);
    if (!list.length) state.attachments.delete(id);
    showAttachNote("");
    renderAttachments();
    updateControls();
    el.input.focus();
  }

  function attachmentStatusText(item) {
    if (item.status === "uploading") return "Lädt hoch …";
    if (item.status === "error") return item.error || "Hochladen fehlgeschlagen.";
    const size = [item.duration !== null ? formatClock(item.duration) : "", formatFileSize(item.size)].filter(Boolean).join(" · ");
    return item.status === "done" ? (size ? size + " · hochgeladen" : "hochgeladen") : size;
  }

  /**
   * Wiedergabe einer Aufnahme vor dem Senden: ein <audio> ohne eigene
   * Bedienung je Anhang, die Objekt-URL entsteht erst hier (und nach der
   * Rückkehr auf die Seite neu). Die CSP erlaubt dafür media-src blob:.
   */
  function recordingPlayer(item) {
    if (!item.audioUrl && window.URL && typeof window.URL.createObjectURL === "function") {
      item.audioUrl = window.URL.createObjectURL(item.file);
    }
    if (!item.player) {
      const player = document.createElement("audio");
      player.setAttribute("preload", "metadata");
      player.hidden = true;
      player.addEventListener("play", () => renderAttachments());
      player.addEventListener("pause", () => renderAttachments());
      player.addEventListener("ended", () => renderAttachments());
      item.player = player;
    }
    if (item.audioUrl && item.player.getAttribute("src") !== item.audioUrl) item.player.setAttribute("src", item.audioUrl);
    return item.player;
  }

  /** Objekt-URL und Wiedergabe eines Anhangs freigeben (Entfernen, Senden, Verlassen) */
  function releaseAudio(item) {
    if (!item) return;
    if (item.player) {
      if (typeof item.player.pause === "function") item.player.pause();
      item.player.removeAttribute("src");
      item.player = null;
    }
    if (item.audioUrl) {
      if (window.URL && typeof window.URL.revokeObjectURL === "function") window.URL.revokeObjectURL(item.audioUrl);
      item.audioUrl = null;
    }
  }

  /** Abspielen/Pause für eine Aufnahme im Chip */
  function playButton(item) {
    const player = recordingPlayer(item);
    const playing = player.paused === false && !player.ended;
    const button = document.createElement("button");
    button.setAttribute("type", "button");
    button.className = "icon-button attachment-play";
    button.setAttribute("aria-label", playing ? "Pause" : "Aufnahme abspielen");
    button.setAttribute("aria-pressed", playing ? "true" : "false");
    const icon = pathIcon(playing ? ["M8 5v14M16 5v14"] : ["M8 5l11 7-11 7z"]);
    if (icon) button.appendChild(icon);
    button.addEventListener("click", () => {
      if (player.paused === false && !player.ended) {
        player.pause();
        return;
      }
      const started = typeof player.play === "function" ? player.play() : null;
      if (started && typeof started.catch === "function") started.catch(() => {});
    });
    return button;
  }

  /** Chip über der Eingabe: Vorschau oder Symbol, Name, Größe bzw. Zustand, Entfernen. Alles als Text. */
  function attachmentChip(item) {
    const chip = document.createElement("li");
    chip.className = "attachment-chip";
    chip.setAttribute("data-key", item.key);
    chip.setAttribute("data-status", item.status);
    if (item.preview) {
      const img = document.createElement("img");
      img.className = "attachment-thumb";
      img.setAttribute("src", item.preview);
      img.setAttribute("alt", "");
      chip.appendChild(img);
    } else {
      const box = document.createElement("span");
      box.className = "attachment-thumb attachment-symbol";
      const icon = attachmentIcon(item.kind);
      if (icon) box.appendChild(icon);
      chip.appendChild(box);
    }
    const info = document.createElement("span");
    info.className = "attachment-info";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.name;
    info.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "attachment-meta";
    meta.textContent = attachmentStatusText(item);
    info.appendChild(meta);
    chip.appendChild(info);
    if (item.duration !== null && item.kind === "audio") {
      chip.appendChild(playButton(item));
      chip.appendChild(item.player);
    }
    const remove = document.createElement("button");
    remove.setAttribute("type", "button");
    remove.className = "icon-button attachment-remove";
    remove.setAttribute("aria-label", item.name + " entfernen");
    remove.disabled = state.sending;
    if (typeof document.createElementNS === "function") {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const cross = document.createElementNS(ns, "path");
      cross.setAttribute("d", "M7 7l10 10M17 7L7 17");
      svg.appendChild(cross);
      remove.appendChild(svg);
    }
    remove.addEventListener("click", () => removeAttachment(item.key));
    chip.appendChild(remove);
    return chip;
  }

  function renderAttachments() {
    const list = currentAttachments();
    el.attachments.replaceChildren(...list.map(attachmentChip));
    el.attachments.hidden = list.length === 0;
  }

  /** Das Ziehen trägt Dateien (nicht markierten Text oder Links) */
  function draggingFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") >= 0;
  }

  /** Ruhige Markierung der Ablagefläche, nur wo Anhänge gehen */
  function setDropping(on) {
    if (on && !attachRefusal()) el.main.setAttribute("data-drop", "true");
    else if (el.main.removeAttribute) el.main.removeAttribute("data-drop");
  }

  function renderAttachmentsOf(id) {
    if (state.conversation && state.conversation.id === id) renderAttachments();
  }

  /**
   * Base64-Code als Bild anhängen (/b64, data:image/…); rest bleibt danach im
   * Feld. Ungültiger Code: Hinweis, nichts angehängt, das Feld bleibt, wie es
   * war. true, wenn das Bild angehängt ist.
   */
  function takeBase64(code, rest) {
    const refusal = attachRefusal();
    if (refusal) {
      showAttachNote(refusal);
      return false;
    }
    const result = decodeImageBase64(code);
    if (!result.ok) {
      showAttachNote(result.error);
      return false;
    }
    const file = new Blob([result.bytes], { type: result.mime });
    const preview = result.bytes.length <= LOCAL_PREVIEW_MAX_BYTES ? "data:" + result.mime + ";base64," + result.base64 : null;
    const added = addAttachments([{ file, name: "bild." + IMAGE_EXTENSIONS[result.mime], kind: "image", preview }]);
    if (!added) return false;
    el.input.value = rest;
    autosize();
    updateControls();
    updateCommandList();
    return true;
  }

  /** Eine Datei als Rohdaten hochladen (POST …/attachments), Name prozentkodiert in X-File-Name */
  async function uploadFile(conversationId, item) {
    const res = await fetch("/api/conversations/" + conversationId + "/attachments", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": item.file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(item.name) },
      body: item.file,
    });
    return apiResult(res);
  }

  /**
   * Lädt die noch nicht hochgeladenen Anhänge der Liste nacheinander hoch;
   * schon hochgeladene behalten ihre ID. Zustand und Fehler stehen am Chip.
   * Die IDs in Reihenfolge, oder null, wenn einer fehlschlug, eine ID fehlt
   * oder das Gespräch inzwischen gewechselt wurde.
   */
  async function uploadPending(conversationId, list, generation) {
    let failed = false;
    for (const item of list.slice()) {
      if (item.status === "done" && item.id) continue;
      if (generation !== state.generation || state.leaving) return null;
      item.status = "uploading";
      item.error = "";
      renderAttachmentsOf(conversationId);
      try {
        const { status, data } = await uploadFile(conversationId, item);
        if (status === 201 && data && typeof data.id === "string" && FILE_ID_PATTERN.test(data.id)) {
          item.id = data.id;
          item.status = "done";
        } else {
          item.status = "error";
          item.error = (data && typeof data.error === "string" && data.error) || "Hochladen fehlgeschlagen (Fehler " + status + ").";
          failed = true;
        }
      } catch {
        item.status = "error";
        item.error = ATTACHMENT_TEXT.offline;
        failed = true;
      }
      renderAttachmentsOf(conversationId);
    }
    if (failed) {
      if (state.conversation && state.conversation.id === conversationId) showAttachNote(ATTACHMENT_TEXT.retry);
      return null;
    }
    const ids = list.map(item => item.id);
    return ids.every(id => typeof id === "string" && FILE_ID_PATTERN.test(id)) ? ids : null;
  }

  /** Dateien aus der Zwischenablage: files, sonst die Datei-Einträge in items (ältere Safari) */
  function clipboardFiles(data) {
    if (data.files && data.files.length) return Array.from(data.files);
    const out = [];
    for (const item of Array.from(data.items || [])) {
      if (!item || item.kind !== "file" || typeof item.getAsFile !== "function") continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
    return out;
  }

  /**
   * Strg/Cmd+V (Issue #73): Bilder und andere Dateien werden Anhänge, auch
   * mehrere; Text fügt der Browser wie gewohnt ein, auch neben Bildern.
   * Nur clipboardData, keine Clipboard-API: geht auch ohne sicheren Kontext
   * im Heimnetz.
   */
  function onPaste(event) {
    const data = event.clipboardData;
    if (!data) return;
    const files = clipboardFiles(data);
    const text = typeof data.getData === "function" ? String(data.getData("text/plain") || "") : "";
    // Base64-Code (Entscheidung 0012): sofort zum Bild, der Code kommt nie ins Feld,
    // auch wenn die Zwischenablage zugleich Dateien trägt
    const value = String(el.input.value || "");
    const start = typeof el.input.selectionStart === "number" ? el.input.selectionStart : value.length;
    const end = typeof el.input.selectionEnd === "number" ? el.input.selectionEnd : value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const code = text ? base64Source(before + text + after) : null;
    let source = null;
    let rest = "";
    if (code !== null && /^\s*\/b64/i.test(before + text) && code.trim()) {
      source = code;
    } else if (/^\s*data:image\//i.test(text)) {
      source = text;
      rest = before + after;
    }
    if (source !== null) {
      event.preventDefault();
      // Ungültiger Code: auch die Dateien bleiben draußen, das Feld bleibt, wie es war
      if (takeBase64(source, rest) && files.length) addAttachments(files.map(file => ({ file })));
      return;
    }
    if (files.length) {
      // Kopierte Dateien bringen oft nur ihren Namen als Text mit: den nicht einfügen
      const names = files.map(f => String((f && f.name) || "").trim());
      if (!text.trim() || names.includes(text.trim())) event.preventDefault();
      addAttachments(files.map(file => ({ file })));
    }
  }

  // --- Sprachaufnahme (Issue #109) -------------------------------------------

  /**
   * Mikrofon antippen: Freigabe anfragen, dann aufnehmen. Nur wo Anhänge
   * gehen, nicht beim Senden, nicht bei fünf Anhängen. Jeder Schritt prüft,
   * ob die Aufnahme noch dieselbe ist: Verwerfen, Gesprächswechsel und
   * Verlassen setzen state.recording zurück, späte Freigaben und Ereignisse
   * geben dann nur noch das Mikrofon frei.
   */
  async function startRecording() {
    if (!canRecord || state.recording || state.sending) return;
    const refusal = attachRefusal();
    if (refusal) {
      showAttachNote(refusal);
      return;
    }
    if (currentAttachments().length >= MAX_ATTACHMENTS) {
      showAttachNote(ATTACHMENT_TEXT.tooMany);
      return;
    }
    const type = recordingFormat(window.MediaRecorder);
    if (!type) {
      showAttachNote(RECORDING_TEXT.unsupported);
      return;
    }
    const rec = { phase: "requesting", conversationId: state.conversation.id, type, stream: null, recorder: null, chunks: [], startedAt: 0, stoppedAt: 0, tick: null, limit: null };
    state.recording = rec;
    showAttachNote("");
    updateControls();
    let stream;
    try {
      stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (state.recording !== rec) return;
      state.recording = null;
      showAttachNote(microphoneProblem(err));
      updateControls();
      return;
    }
    // Inzwischen verworfen (Gesprächswechsel, Verlassen): Mikrofon sofort wieder frei
    if (state.recording !== rec) {
      stopTracks(stream);
      return;
    }
    rec.stream = stream;
    try {
      const recorder = new window.MediaRecorder(stream, { mimeType: type });
      rec.recorder = recorder;
      recorder.ondataavailable = event => {
        if (state.recording === rec && event && event.data && event.data.size > 0) rec.chunks.push(event.data);
      };
      recorder.onstop = () => void finishRecording(rec);
      recorder.onerror = () => failRecording(rec, RECORDING_TEXT.broken);
      recorder.start();
    } catch {
      failRecording(rec, RECORDING_TEXT.failed);
      return;
    }
    rec.phase = "recording";
    rec.startedAt = Date.now();
    rec.limit = setTimeout(() => stopRecording(rec), RECORDING_MAX_MS);
    el.recorderTime.textContent = formatClock(0);
    updateControls();
    scheduleTick(rec);
    if (typeof el.recorderStop.focus === "function") el.recorderStop.focus();
  }

  /** Laufende Zeit, sekundengenau nach der Uhr (Timer im Hintergrund können sich verspäten) */
  function scheduleTick(rec) {
    const elapsed = Date.now() - rec.startedAt;
    rec.tick = setTimeout(() => {
      if (state.recording !== rec || rec.phase !== "recording") return;
      const now = Date.now() - rec.startedAt;
      el.recorderTime.textContent = formatClock(Math.min(now, RECORDING_MAX_MS));
      if (now >= RECORDING_MAX_MS) stopRecording(rec);
      else scheduleTick(rec);
    }, 1000 - (elapsed % 1000));
  }

  function clearRecordingTimers(rec) {
    clearTimeout(rec.tick);
    clearTimeout(rec.limit);
    rec.tick = null;
    rec.limit = null;
  }

  /** Stopp (Knopf oder Höchstdauer): der Recorder liefert die letzten Daten, dann entsteht der Chip */
  function stopRecording(rec) {
    if (!rec || state.recording !== rec || rec.phase !== "recording") return;
    rec.phase = "stopping";
    rec.stoppedAt = Date.now();
    clearRecordingTimers(rec);
    el.recorderTime.textContent = formatClock(Math.min(rec.stoppedAt - rec.startedAt, RECORDING_MAX_MS));
    try {
      rec.recorder.stop();
    } catch {
      failRecording(rec, RECORDING_TEXT.broken);
      return;
    }
    // Das Mikrofon ist sofort frei; die gepufferten Daten kommen trotzdem
    stopTracks(rec.stream);
    updateControls();
  }

  /**
   * Nach dem stop-Ereignis: genau ein Anhang aus allen Daten, Typ und Endung
   * nach den ersten Bytes. Nur im Gespräch, in dem aufgenommen wurde, und
   * nur, wenn die Aufnahme nicht inzwischen verworfen wurde.
   */
  async function finishRecording(rec) {
    if (state.recording !== rec) return;
    // Stoppt der Browser selbst (Mikrofon weg), gilt das wie Stopp
    if (!rec.stoppedAt) rec.stoppedAt = Date.now();
    rec.phase = "finishing";
    clearRecordingTimers(rec);
    stopTracks(rec.stream);
    const blob = new Blob(rec.chunks);
    let mime = null;
    try {
      mime = blob.size ? sniffRecording(new Uint8Array(await blob.slice(0, 12).arrayBuffer())) : null;
    } catch {
      mime = null;
    }
    if (state.recording !== rec) return;
    detachRecorder(rec);
    state.recording = null;
    if (!state.conversation || state.conversation.id !== rec.conversationId) {
      updateControls();
      return;
    }
    if (!blob.size || !mime) {
      showAttachNote(blob.size ? RECORDING_TEXT.broken : RECORDING_TEXT.empty);
      updateControls();
      return;
    }
    const file = new Blob([blob], { type: mime });
    const duration = Math.min(rec.stoppedAt - rec.startedAt, RECORDING_MAX_MS);
    const added = addAttachments([{ file, name: recordingName(new Date(rec.startedAt), RECORDING_EXTENSIONS[mime]), kind: "audio", duration }]);
    if (!added) updateControls();
    if (typeof el.input.focus === "function") el.input.focus();
  }

  function detachRecorder(rec) {
    if (!rec.recorder) return;
    rec.recorder.ondataavailable = null;
    rec.recorder.onstop = null;
    rec.recorder.onerror = null;
  }

  /**
   * Aufnahme verwerfen (Knopf, Gesprächswechsel, Einstellungen, Verlassen):
   * nichts wird angehängt, alle Spuren stoppen. Eine noch offene
   * Freigabe-Anfrage gibt ihr Mikrofon beim Eintreffen selbst frei.
   */
  function discardRecording() {
    const rec = state.recording;
    if (!rec) return;
    state.recording = null;
    clearRecordingTimers(rec);
    detachRecorder(rec);
    if (rec.recorder && rec.recorder.state !== "inactive") {
      try {
        rec.recorder.stop();
      } catch {
        // schon beendet
      }
    }
    stopTracks(rec.stream);
    rec.chunks = [];
    updateControls();
  }

  /** Fehler beim Start oder während der Aufnahme: verwerfen, Meldung am Eingabefeld */
  function failRecording(rec, text) {
    if (state.recording !== rec) return;
    discardRecording();
    showAttachNote(text);
  }

  // --- Aktionen --------------------------------------------------------------

  async function send() {
    const conversation = state.conversation;
    if (!conversation || isClosed() || state.sending) return;
    // Erst die Aufnahme stoppen oder verwerfen (Issue #109); Enter geht dann nicht ins Leere
    if (state.recording) return;
    // /b64 und data:image/… (Issue #73): spätestens hier zum Anhang, nie als Text an den Server
    const code = base64Source(el.input.value);
    if (code !== null && !takeBase64(code, "")) return;
    const text = el.input.value;
    const answerable = state.awaiting && approvalShown();
    const urgent = isUrgentCommand(text);
    // Fester Stand der Liste: genau diese Einträge werden hochgeladen, gesendet und danach entfernt
    const pending = attachmentsOf(conversation.id).slice();
    // Steuerbefehle während einer Antwort gehen ohne Anhänge raus, die Chips bleiben stehen
    const withAttachments = pending.length > 0 && !(state.running && urgent);
    if (!text.trim() && !withAttachments) return;
    if (state.running && !answerable && !urgent) return;
    if (withAttachments && answerable) {
      showAttachNote(ATTACHMENT_TEXT.withAnswer);
      return;
    }
    state.sending = true;
    updateControls();
    if (withAttachments) renderAttachments();
    const generation = state.generation;
    const seq = state.statusSeq;
    try {
      // Erst hochladen, dann die Nachricht; schlägt ein Upload fehl, geht keine Nachricht raus
      const ids = withAttachments ? await uploadPending(conversation.id, pending, generation) : null;
      if (withAttachments && !ids) return;
      if (generation !== state.generation) return;
      // Antwort auf eine Rückfrage: an genau die angezeigte Frage gebunden
      const body = answerable ? { text, approvalId: state.approvalId } : ids ? { text, attachments: ids } : { text };
      const { status, data } = await api("POST", "/api/conversations/" + conversation.id + "/messages", body);
      const sent = status === 202 && data && data.message;
      // Gesendetes verschwindet auch nach einem Gesprächswechsel, sonst ginge es ein zweites Mal raus
      if (sent) forgetSent(conversation.id, text, ids ? pending : null);
      if (generation !== state.generation) return;
      if (sent) {
        closeCommandList();
        // Der Hinweis auf abgelehnte Anhänge bleibt stehen
        if (ids && el.attachNote.textContent !== ATTACHMENT_TEXT.sending) showAttachNote("");
        addMessages([data.message]);
        // Ohne status-Ereignis in der Zwischenzeit gilt der Turn als laufend;
        // ein Befehl wie /stop meldet selbst, ob danach noch etwas läuft (Issue #74)
        if (seq === state.statusSeq) setRunning(data.running !== false);
        // Der Titel entsteht aus der ersten Nachricht
        if (conversationTitle(state.conversation) === "Neues Gespräch") void refreshConversations();
      } else if (status === 409 && data && data.closed === true) {
        // Inzwischen geschlossen (anderer Browser): sperren, Entwurf bleibt, Meldung des Servers
        applyConversation({ id: conversation.id, closed: true });
        addLocalError(String(data.error || "Das Topic ist geschlossen."));
        void refreshConversations();
      } else if (status === 409) {
        if (data && data.stale) addLocalError(String(data.error || "Die Freigabe-Frage ist nicht mehr offen."));
        await syncMessages();
      } else {
        // Abgelaufene Uploads (nach 24 Stunden weg): beim nächsten Senden neu hochladen
        if (ids && status === 400 && data && typeof data.error === "string" && /^Anhang unbekannt/.test(data.error)) {
          for (const item of pending) {
            item.status = "ready";
            item.id = null;
          }
        }
        addLocalError((data && data.error) || "Senden fehlgeschlagen (Fehler " + status + ").");
      }
    } catch {
      if (!state.leaving) addLocalError("Server nicht erreichbar, Nachricht nicht gesendet.");
    } finally {
      state.sending = false;
      updateControls();
      renderAttachments();
    }
  }

  /**
   * Nach dem Senden: genau die gesendeten Anhänge und den gesendeten Text aus
   * dem Gespräch nehmen, ob es noch offen ist oder nicht. Danach Getipptes
   * oder ein neuer Entwurf bleibt stehen.
   */
  function forgetSent(id, text, pending) {
    if (pending) {
      for (const item of pending) releaseAudio(item);
      const rest = attachmentsOf(id).filter(item => !pending.includes(item));
      if (rest.length) state.attachments.set(id, rest);
      else state.attachments.delete(id);
    }
    if (state.conversation && state.conversation.id === id) {
      if (el.input.value === text) el.input.value = "";
      if (!el.input.value) state.drafts.delete(id);
      autosize();
    } else if (state.drafts.get(id) === text) {
      state.drafts.delete(id);
    }
  }

  async function stopTurn() {
    const conversation = state.conversation;
    if (!conversation || !state.running || state.stopping) return;
    state.stopping = true;
    updateControls();
    try {
      const { data } = await api("POST", "/api/conversations/" + conversation.id + "/stop");
      // Lief nichts mehr, den Stand neu holen
      if (!data || !data.stopping) {
        state.stopping = false;
        await loadMessages();
      }
    } catch {
      state.stopping = false;
    }
    updateControls();
  }

  async function newConversation(agent) {
    if (state.busy) return;
    state.busy = true;
    updateControls();
    try {
      const { conversation, error } = await createConversation(agent);
      if (conversation) {
        addConversation(conversation);
        closePicker(false);
        closeSidebar();
        // Erstes Topic überhaupt: jetzt auch den Sammelstrom der Aktivität öffnen
        if (!state.activityEvents && !state.activityTimer) connectActivity();
        openConversation(conversation);
        el.input.focus();
      }
      // Abgelehnt oder nur teilweise gespeichert: die Meldung des Servers zeigen
      if (error) reportError(error);
    } catch {
      if (!state.leaving) reportError("Server nicht erreichbar, kein Gespräch angelegt.");
    } finally {
      state.busy = false;
      updateControls();
      renderPicker(false);
    }
  }

  // --- Gespräche verwalten (Issue #21) ---------------------------------------

  /**
   * Holt die Agenten für die Auswahl; Fehler lassen es beim bisherigen Stand
   * (anfangs General). Auch bei jedem Öffnen der Auswahl (Issue #50), damit
   * gelöschte Agenten ohne Neuladen der Seite verschwinden.
   */
  let agentsRequest = 0;
  async function loadAgents() {
    const request = ++agentsRequest;
    try {
      const { ok, data } = await api("GET", "/api/agents");
      if (!ok || !data) return;
      // Ohne Versionsnummer (alter Server): nur die letzte Anfrage zählt
      if (!data.revision && request !== agentsRequest) return;
      applyAgents(data);
    } catch {
      // Auswahl bleibt bei General
    }
  }

  /**
   * Stand von /api/agents übernehmen, aus loadAgents oder aus den
   * Einstellungen nach Anlegen, Löschen, Wiederherstellen (Issue #51). Ein
   * älterer Stand (revision wie in settings.js) ersetzt nie einen neueren.
   * Danach sind Seitenleiste, Agenten-Chip, Auswahl für neue Gespräche und
   * „Agent ändern …" aktuell. false, wenn verworfen.
   */
  function applyAgents(data) {
    if (!data || !Array.isArray(data.agents)) return false;
    if (!revisionNotOlder(state.agentsRevision, data.revision)) return false;
    const list = data.agents
      .filter(a => a && typeof a.name === "string" && AGENT_NAME.test(a.name))
      .map(a => ({ name: a.name, label: typeof a.label === "string" && a.label.trim() ? a.label.trim() : agentLabel(a.name) }));
    if (!list.length) return false;
    if (data.revision && typeof data.revision.seq === "number") state.agentsRevision = data.revision;
    for (const a of list) agentLabels.set(a.name, a.label);
    const selected = state.pickerOpen && state.agents[state.pickerIndex] ? state.agents[state.pickerIndex].name : null;
    state.agents = list;
    state.defaultAgent = list.some(a => a.name === data.defaultAgent) ? data.defaultAgent : list[0].name;
    // Namen neu zeichnen, die schon mit dem Ersatznamen da stehen
    if (state.conversation) renderAgentChip();
    renderConversationList();
    if (state.pickerOpen) {
      // Markierung bleibt beim selben Agenten; ist er weg, zurück auf den Standard
      const index = list.findIndex(a => a.name === selected);
      const fallback = list.findIndex(a => a.name === state.defaultAgent);
      state.pickerIndex = index >= 0 ? index : Math.max(fallback, 0);
      const active = document.activeElement;
      renderPicker(Boolean(active && el.agentOptions.contains && el.agentOptions.contains(active)));
    }
    // Offenes „Agent ändern …" zeigt die neue Liste
    if (state.menu) renderMenus();
    return true;
  }

  /**
   * Auswahl des Agenten unter „Neues Gespräch": Liste mit Agentenpunkt und
   * Name, in der Seitenleiste (am Handy in der Schublade), kein Dialog.
   * Genau ein Tab-Stopp (der markierte Eintrag).
   */
  function renderPicker(focus) {
    el.agentPicker.hidden = !state.pickerOpen;
    el.newChat.setAttribute("aria-expanded", state.pickerOpen ? "true" : "false");
    if (!state.pickerOpen) {
      el.agentOptions.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    let selectedButton = null;
    state.agents.forEach((agent, i) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.className = "conversation agent-option";
      button.setAttribute("type", "button");
      button.setAttribute("role", "option");
      button.setAttribute("data-agent-option", agent.name);
      const selected = i === state.pickerIndex;
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.setAttribute("tabindex", selected ? "0" : "-1");
      button.disabled = state.busy;
      const name = document.createElement("span");
      name.className = "agent-option-name";
      name.setAttribute("data-agent", agent.name);
      const dot = document.createElement("span");
      dot.className = "agent-dot";
      name.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = agent.label;
      name.appendChild(label);
      button.appendChild(name);
      button.addEventListener("click", () => {
        state.pickerIndex = i;
        void newConversation(agent.name);
      });
      li.appendChild(button);
      fragment.appendChild(li);
      if (selected) selectedButton = button;
    });
    el.agentOptions.replaceChildren(fragment);
    if (focus && selectedButton) selectedButton.focus();
  }

  function openPicker() {
    if (state.busy) return;
    state.menu = null;
    renderMenus();
    const index = state.agents.findIndex(a => a.name === state.defaultAgent);
    state.pickerIndex = index >= 0 ? index : 0;
    state.pickerOpen = true;
    renderPicker(true);
    // Katalog kann sich seit dem Laden der Seite geändert haben (Issue #50)
    void loadAgents();
  }

  function closePicker(focusNewChat) {
    state.pickerOpen = false;
    renderPicker(false);
    if (focusNewChat) el.newChat.focus();
  }

  /** Pfeiltasten wandern (reihum), Pos1/Ende an den Rand, Enter übernimmt, Escape schließt. */
  function pickerKeydown(event) {
    const count = state.agents.length;
    if (!state.pickerOpen || !count) return;
    const steps = { ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (event.key in steps) next = (state.pickerIndex + steps[event.key] + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Enter") {
      event.preventDefault();
      const agent = state.agents[state.pickerIndex] || state.agents[0];
      void newConversation(agent.name);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      closePicker(true);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    state.pickerIndex = next;
    renderPicker(true);
  }

  /** Offenes Gespräch lässt sich umbenennen und verwalten (Web-Gespräch oder Topic außer General, nicht der Direktchat) */
  function canManage() {
    return !!state.conversation && canRenameId(state.conversation.id);
  }

  /** Titel in der Kopfzeile als Eingabefeld: Enter speichert, Escape bricht ab. */
  function startRename() {
    if (!canManage() || state.editingTitle) return;
    state.menu = null;
    renderMenus();
    state.editingTitle = true;
    el.titleInput.value = conversationTitle(state.conversation);
    el.titleInput.removeAttribute && el.titleInput.removeAttribute("aria-invalid");
    el.titleInput.disabled = false;
    el.title.hidden = true;
    el.titleInput.hidden = false;
    el.titleInput.focus();
    if (typeof el.titleInput.select === "function") el.titleInput.select();
  }

  /** Beendet die Bearbeitung ohne zu speichern; der Titel kommt aus dem aktuellen Stand. */
  function cancelRename(focusTitle) {
    if (!state.editingTitle) return;
    state.editingTitle = false;
    el.titleInput.hidden = true;
    el.title.hidden = false;
    if (state.conversation) el.title.textContent = conversationTitle(state.conversation);
    if (focusTitle) el.title.focus();
  }

  /**
   * Übernimmt ein geändertes Gespräch oder Topic (umbenannt, geschlossen,
   * geöffnet) in Kopfzeile und Liste. closed kommt nur vom neuen Stand.
   */
  function applyConversation(updated) {
    if (!updated || typeof updated !== "object" || typeof updated.id !== "string") return;
    state.entryChanges++;
    const replace = c => (c.id === updated.id ? mergeEntry(c, updated) : c);
    state.conversations = state.conversations.map(replace);
    state.telegram.topics = state.telegram.topics.map(replace);
    if (state.conversation && state.conversation.id === updated.id) {
      state.conversation = mergeEntry(state.conversation, updated);
      if (!state.editingTitle) el.title.textContent = conversationTitle(state.conversation);
      updatePlaceholder();
      // Geschlossenes Topic, das offen ist: „Ältere Topics" aufklappen, damit die Markierung zu sehen ist
      if (state.conversation.closed === true) state.olderOpen = true;
      updateControls();
    }
    renderConversationList();
    renderHeaderMenu();
  }

  async function saveRename() {
    const conversation = state.conversation;
    if (!state.editingTitle || state.renaming || !conversation) return;
    const raw = el.titleInput.value;
    // Leer gelassen: nichts ändern
    if (!String(raw).trim()) return cancelRename(true);
    // Topics nach den Regeln von Telegram (bis 128 Zeichen), Web-Gespräche wie bisher
    const topic = isTelegramId(conversation.id);
    const title = topic ? normalizeTopicTitle(raw) : normalizeTitle(raw);
    if (title === null) {
      el.titleInput.setAttribute("aria-invalid", "true");
      showConnection(topic
        ? "Der Name darf höchstens " + TOPIC_TITLE_MAX_CHARS + " Zeichen lang sein, ohne Steuerzeichen."
        : "Der Titel darf höchstens " + TITLE_MAX_CHARS + " Zeichen lang sein.");
      return;
    }
    if (title === conversationTitle(conversation)) return cancelRename(true);
    state.renaming = true;
    el.titleInput.disabled = true;
    const generation = state.generation;
    try {
      const { status, data } = await api("PATCH", "/api/conversations/" + conversation.id, { title });
      if (generation !== state.generation) return;
      // 500 mit conversation (Topic): in Telegram umbenannt, nur nicht überall gespeichert
      if ((status === 200 || status === 500) && data && data.conversation && data.conversation.id === conversation.id) {
        showConnection(status === 200 ? "" : String(data.error || "Umbenannt, aber nicht gespeichert."));
        state.editingTitle = false;
        el.titleInput.hidden = true;
        el.title.hidden = false;
        applyConversation(data.conversation);
        el.title.focus();
      } else if (status === 404 && (await confirmGone(conversation.id))) {
        cancelRename(false);
        void conversationGone(conversation.id);
      } else {
        el.titleInput.setAttribute("aria-invalid", "true");
        showConnection((data && data.error) || "Umbenennen fehlgeschlagen (Fehler " + status + ").");
      }
    } catch {
      if (!state.leaving) showConnection("Server nicht erreichbar, Titel nicht geändert.");
    } finally {
      state.renaming = false;
      el.titleInput.disabled = false;
      if (state.editingTitle) el.titleInput.focus();
    }
  }

  /** Umbenennen aus dem Menü eines Eintrags: Gespräch öffnen, dann den Titel bearbeiten. */
  function renameFrom(conversation) {
    if (!state.conversation || state.conversation.id !== conversation.id) openConversation(conversation);
    closeSidebar();
    startRename();
  }

  /**
   * Menü eines Web-Gesprächs (Kopfzeile oder Eintrag in der Seitenleiste):
   * Umbenennen und Löschen, Löschen erst nach der Rückfrage „Gespräch löschen?".
   */
  function actionsPanel(conversation, place) {
    const panel = document.createElement("div");
    panel.className = place === "entry" ? "entry-actions" : "actions-list";
    panel.setAttribute("role", "group");
    const confirming = !!state.menu && state.menu.confirm;
    const busy = state.deleting === conversation.id || state.closing === conversation.id || state.changingAgent === conversation.id;
    const add = (label, key, handler, strong) => {
      const button = document.createElement("button");
      button.className = strong ? "quiet-button action-confirm" : "quiet-button";
      button.setAttribute("type", "button");
      button.setAttribute("data-focus-key", place + ":" + key + ":" + conversation.id);
      button.textContent = label;
      button.disabled = busy;
      button.addEventListener("click", handler);
      panel.appendChild(button);
      return button;
    };
    if (isManagedTopicId(conversation.id)) {
      if (confirming) topicDeletePanel(panel, conversation, place, add);
      else if (state.menu && state.menu.agentPick) topicAgentPanel(panel, conversation, place);
      else topicMenuPanel(panel, conversation, place, add);
      return panel;
    }
    if (confirming) {
      panel.setAttribute("aria-label", "Gespräch löschen?");
      const question = document.createElement("p");
      question.className = "actions-question";
      question.textContent = "Gespräch löschen?";
      panel.appendChild(question);
      add(busy ? "Wird gelöscht …" : "Löschen", "delete-yes", () => void deleteConversation(conversation.id), true);
      add("Abbrechen", "delete-no", () => closeMenu(true));
    } else {
      panel.setAttribute("aria-label", "Optionen für " + conversationTitle(conversation));
      add("Umbenennen", "rename", () => {
        closeMenu(false);
        renameFrom(conversation);
      });
      add("Löschen", "delete", () => {
        // Fokus auf „Abbrechen": ein zweites Enter löscht nicht aus Versehen
        state.menu = Object.assign({}, state.menu, { confirm: true, focus: place + ":delete-no:" + conversation.id });
        renderMenus();
      });
    }
    return panel;
  }

  /** Meldung im offenen Menü (Serverfehler), als Text in der Fehlerfarbe */
  function panelError(panel) {
    if (!state.menu || !state.menu.error) return;
    const error = document.createElement("p");
    error.className = "actions-error";
    error.setAttribute("role", "alert");
    error.textContent = state.menu.error;
    panel.appendChild(error);
  }

  /**
   * Menü eines Topics (Issue #30): Umbenennen, Schließen bzw. Wieder öffnen,
   * „Löschen …". Löschen braucht das Recht „Nachrichten löschen"; fehlt es
   * oder ist es unbekannt, ist der Knopf gesperrt und darunter steht, warum.
   */
  function topicMenuPanel(panel, topic, place, add) {
    panel.setAttribute("aria-label", "Optionen für " + conversationTitle(topic));
    add("Umbenennen", "rename", () => {
      closeMenu(false);
      renameFrom(topic);
    });
    const closed = topic.closed === true;
    add(state.closing === topic.id ? (closed ? "Wird geöffnet …" : "Wird geschlossen …") : closed ? "Wieder öffnen" : "Schließen",
      "close", () => void setTopicClosed(topic.id, !closed));
    // Unabhängig von den Löschrechten (Issue #38)
    add("Agent ändern …", "agent", () => {
      state.menu = Object.assign({}, state.menu, { agentPick: true, error: null, focus: place + ":agent-option-" + (topic.agent || "general") + ":" + topic.id });
      renderMenus();
    });
    const rights = state.rights;
    const allowed = !!rights && rights.status === "ok" && rights.group === true && rights.deleteMessages === true;
    const del = add("Löschen …", "delete", () => {
      if (!allowed) return;
      // Fokus ins Namensfeld der Rückfrage
      state.menu = Object.assign({}, state.menu, { confirm: true, typed: "", error: null, focus: place + ":confirm-name:" + topic.id });
      renderMenus();
    });
    if (!allowed) {
      del.disabled = true;
      const hint = document.createElement("p");
      hint.className = "actions-hint";
      hint.id = place + "-delete-hint-" + topic.id;
      del.setAttribute("aria-describedby", hint.id);
      if (!rights || rights.status === "loading") {
        hint.textContent = "Rechte des Bots werden geprüft …";
      } else if (rights.status === "failed") {
        hint.textContent = (rights.error || "Die Rechte des Bots konnten nicht geprüft werden.") + " Löschen bleibt gesperrt.";
      } else if (!rights.group) {
        hint.textContent = "Keine Forum-Gruppe eingerichtet, Löschen ist nicht möglich.";
      } else {
        hint.textContent = "Dem Bot fehlt das Recht „Nachrichten löschen\". In Telegram: Gruppe → Administratoren → Bot → „Nachrichten löschen\" einschalten.";
      }
      panel.appendChild(hint);
      if (rights && rights.status !== "loading") {
        add("Rechte erneut prüfen", "rights", () => void loadRights(true));
      }
    }
    panelError(panel);
  }

  /**
   * Rückfrage vor dem endgültigen Löschen eines Topics: Name nennen,
   * eintippen lassen, roter Knopf erst bei exakt gleichem Namen aktiv.
   * Name und Meldungen nur als Text; die Eingabe wird nicht normalisiert.
   * Verlangt wird der Name, den DELETE prüft: exactTitle, falls der Server ihn
   * liefert (Bestand mit Leerraum außen), sonst der Titel.
   */
  function topicDeletePanel(panel, topic, place, add) {
    const exact = typeof topic.exactTitle === "string" && topic.exactTitle ? topic.exactTitle : topic.title;
    const name = String(exact == null ? "" : exact);
    const busy = state.deleting === topic.id;
    panel.className += " delete-confirm";
    panel.setAttribute("aria-label", "Topic löschen");
    const question = document.createElement("p");
    question.className = "actions-question";
    question.textContent = "Topic ‚" + name + "' in Telegram endgültig löschen?";
    panel.appendChild(question);
    const text = document.createElement("p");
    text.className = "actions-hint";
    text.textContent = "Alle Nachrichten darin verschwinden aus Telegram. Der Verlauf im Gedächtnis von " + brandName() + " bleibt.";
    panel.appendChild(text);
    const inputId = place + "-confirm-name-" + topic.id;
    const label = document.createElement("label");
    label.className = "confirm-label";
    label.setAttribute("for", inputId);
    label.textContent = "Zum Bestätigen Namen eintippen";
    panel.appendChild(label);
    const input = document.createElement("input");
    input.className = "confirm-input";
    input.id = inputId;
    input.setAttribute("type", "text");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("data-focus-key", place + ":confirm-name:" + topic.id);
    input.value = (state.menu && state.menu.typed) || "";
    input.disabled = busy;
    panel.appendChild(input);
    const matches = () => input.value === name;
    const confirm = document.createElement("button");
    confirm.className = "danger-button";
    confirm.setAttribute("type", "button");
    confirm.setAttribute("data-focus-key", place + ":delete-yes:" + topic.id);
    confirm.textContent = busy ? "Wird gelöscht …" : "Endgültig löschen";
    confirm.disabled = busy || !matches();
    confirm.addEventListener("click", () => {
      if (matches()) void deleteTopic(topic.id, input.value);
    });
    input.addEventListener("input", () => {
      // Ohne Neuzeichnen: Fokus und Cursor bleiben im Feld
      if (state.menu) state.menu.typed = input.value;
      confirm.disabled = busy || !matches();
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (matches() && !busy) void deleteTopic(topic.id, input.value);
    });
    panel.appendChild(confirm);
    add("Abbrechen", "delete-no", () => closeMenu(true));
    panelError(panel);
  }

  /**
   * „Agent ändern …" (Issue #38): Liste der Agenten mit Punkt und Namen, der
   * aktuelle ist markiert (aria-current). Wahl sendet PATCH { agent }.
   */
  function topicAgentPanel(panel, topic, place) {
    const busy = state.changingAgent === topic.id;
    panel.setAttribute("aria-label", "Agent für " + conversationTitle(topic) + " wählen");
    const question = document.createElement("p");
    question.className = "actions-question";
    question.textContent = busy ? "Agent wird geändert …" : "Welcher Agent antwortet hier?";
    panel.appendChild(question);
    for (const agent of state.agents) {
      const button = document.createElement("button");
      button.className = "quiet-button agent-choice";
      button.setAttribute("type", "button");
      button.setAttribute("data-focus-key", place + ":agent-option-" + agent.name + ":" + topic.id);
      button.setAttribute("data-agent-choice", agent.name);
      const current = agent.name === (topic.agent || "general");
      if (current) button.setAttribute("aria-current", "true");
      button.disabled = busy;
      const name = document.createElement("span");
      name.className = "agent-option-name";
      name.setAttribute("data-agent", agent.name);
      const dot = document.createElement("span");
      dot.className = "agent-dot";
      name.appendChild(dot);
      const label = document.createElement("span");
      label.textContent = agent.label + (current ? " (aktuell)" : "");
      name.appendChild(label);
      button.appendChild(name);
      button.addEventListener("click", () => {
        if (current) closeMenu(true);
        else void changeTopicAgent(topic.id, agent.name);
      });
      panel.appendChild(button);
    }
    const cancel = document.createElement("button");
    cancel.className = "quiet-button";
    cancel.setAttribute("type", "button");
    cancel.setAttribute("data-focus-key", place + ":agent-cancel:" + topic.id);
    cancel.textContent = "Abbrechen";
    cancel.disabled = busy;
    cancel.addEventListener("click", () => closeMenu(true));
    panel.appendChild(cancel);
    panelError(panel);
  }

  /**
   * PATCH /api/conversations/topic-<n> mit { agent } (Issue #38). Danach
   * zeigen Seitenleiste und, falls das Topic offen ist, die Kopfzeile den
   * neuen Agenten; ältere Antworten behalten ihren Sprecher. Fehler stehen im
   * Menü, die Auswahl bleibt offen.
   */
  async function changeTopicAgent(id, agent) {
    if (state.changingAgent || state.deleting || state.closing) return;
    state.changingAgent = id;
    if (state.menu) state.menu.error = null;
    renderMenus();
    let error = null;
    try {
      const { status, data } = await api("PATCH", "/api/conversations/" + id, { agent });
      if (status === 200 && data && data.conversation && data.conversation.id === id) {
        state.changingAgent = null;
        if (state.conversation && state.conversation.id === id) keepSpeakers(data.conversation.agent);
        const menu = state.menu && state.menu.id === id ? state.menu : null;
        if (menu) state.menu = null;
        applyConversation(data.conversation);
        if (state.conversation && state.conversation.id === id) {
          renderAgentChip();
          renderMessages();
        }
        if (typeof data.note === "string" && data.note) showConnection(data.note);
        if (menu && menu.place === "header") el.conversationMenu.focus();
        else if (menu) focusKey("menu:" + id);
        return;
      }
      if (status === 404 && (await confirmGone(id))) {
        state.changingAgent = null;
        state.menu = null;
        await conversationGone(id);
        return;
      }
      error = (data && data.error) || "Agent nicht geändert (Fehler " + status + ").";
    } catch {
      error = "Server nicht erreichbar, Agent nicht geändert.";
    }
    state.changingAgent = null;
    if (state.menu && state.menu.id === id) state.menu.error = error;
    else reportError(error);
    renderMenus();
  }

  function renderHeaderMenu() {
    const open = !!state.menu && state.menu.place === "header" && canManage() && state.menu.id === state.conversation.id;
    const focused = focusedKey();
    el.conversationMenu.setAttribute("aria-expanded", open ? "true" : "false");
    el.conversationActions.hidden = !open;
    if (open) el.conversationActions.replaceChildren(actionsPanel(state.conversation, "header"));
    else el.conversationActions.replaceChildren();
    // Neu gezeichnet (z.B. nach einem Abgleich der Liste): Fokus im Menü behalten
    if (open && focused && focused.startsWith("header:") && !state.menuFocus) focusKey(focused);
  }

  /** data-focus-key des fokussierten Elements, sonst null */
  function focusedKey() {
    const active = document.activeElement;
    return active && typeof active.getAttribute === "function" ? active.getAttribute("data-focus-key") || null : null;
  }

  /**
   * Rechte des Bots holen, höchstens alle 60 s (der Server hält sie
   * ebenso lange). Ein Fehler zählt nie als erteiltes Recht.
   */
  async function loadRights(force) {
    const current = state.rights;
    if (state.rightsLoading) return;
    if (!force && current && current.status === "ok" && Date.now() - current.at < 60_000) return;
    state.rightsLoading = true;
    // Ein bekannter Stand bleibt sichtbar, bis der neue da ist
    if (!current || current.status !== "ok") {
      state.rights = { status: "loading", at: Date.now() };
      renderMenus();
    }
    let next;
    try {
      const { ok, data } = await api("GET", "/api/telegram/rights");
      if (ok && data && typeof data === "object") {
        next = { status: "ok", group: data.group === true, manageTopics: data.manageTopics === true, deleteMessages: data.deleteMessages === true, at: Date.now() };
      } else {
        next = { status: "failed", error: data && typeof data.error === "string" ? data.error : null, at: Date.now() };
      }
    } catch {
      next = { status: "failed", error: "Server nicht erreichbar.", at: Date.now() };
    }
    state.rightsLoading = false;
    state.rights = next;
    renderMenus();
  }

  /** POST .../close bzw. .../reopen; Fehler stehen im Menü, sonst schließt es */
  async function setTopicClosed(id, closed) {
    if (state.closing || state.deleting || state.changingAgent) return;
    state.closing = id;
    if (state.menu) state.menu.error = null;
    renderMenus();
    let error = null;
    try {
      const { status, data } = await api("POST", "/api/conversations/" + id + (closed ? "/close" : "/reopen"));
      // 500 mit conversation: in Telegram geändert, nur der Zustand fehlt
      if ((status === 200 || status === 500) && data && data.conversation && data.conversation.id === id) {
        state.closing = null;
        applyConversation(data.conversation);
        if (status !== 200) error = String(data.error || "Geändert, aber nicht gespeichert.");
      } else if (status === 404 && (await confirmGone(id))) {
        state.closing = null;
        state.menu = null;
        await conversationGone(id);
        return;
      } else {
        error = (data && data.error) || (closed ? "Schließen" : "Öffnen") + " fehlgeschlagen (Fehler " + status + ").";
      }
    } catch {
      error = "Server nicht erreichbar, nichts geändert.";
    }
    state.closing = null;
    if (error) {
      if (state.menu && state.menu.id === id) state.menu.error = error;
      else reportError(error);
    } else if (state.menu && state.menu.id === id) {
      const place = state.menu.place;
      state.menu = null;
      renderMenus();
      if (place === "header") el.conversationMenu.focus();
      else focusKey("menu:" + id);
      return;
    }
    renderMenus();
  }

  /**
   * DELETE /api/conversations/topic-<n> mit dem exakt eingetippten Namen.
   * deleted: true (auch mit cleanup „unvollständig") heißt gelöscht; 404
   * nach Abgleich ebenso. Alles andere: Meldung des Servers in der Rückfrage.
   */
  async function deleteTopic(id, confirmName) {
    if (state.deleting || state.closing) return;
    state.deleting = id;
    if (state.menu) state.menu.error = null;
    renderMenus();
    let error = null;
    try {
      const { status, data } = await api("DELETE", "/api/conversations/" + id, { confirm: confirmName });
      if ((status === 200 && data && data.deleted === true) || (status === 404 && (await confirmGone(id)))) {
        state.deleting = null;
        state.menu = null;
        await conversationGone(id);
        if (data && data.cleanup) showConnection("Topic gelöscht, das Aufräumen in " + brandName() + " war unvollständig (Details im Log).");
        return;
      }
      error = (data && data.error) || "Löschen fehlgeschlagen (Fehler " + status + ").";
      // Recht fehlt laut Server: Anzeige der Rechte auffrischen
      if (status === 403) state.rights = null;
    } catch {
      error = "Server nicht erreichbar, Topic nicht gelöscht.";
    }
    state.deleting = null;
    if (state.menu && state.menu.id === id) state.menu.error = error;
    else reportError(error);
    renderMenus();
    if (state.rights === null && state.menu) void loadRights(true);
  }

  /** Zeichnet beide Menüorte neu und setzt danach den gewünschten Fokus. */
  function renderMenus() {
    const focus = state.menu && state.menu.focus;
    state.menuFocus = !!focus;
    renderConversationList();
    renderHeaderMenu();
    state.menuFocus = false;
    if (focus) {
      state.menu.focus = null;
      focusKey(focus);
    }
  }

  function toggleMenu(place, id) {
    if (state.menu && state.menu.place === place && state.menu.id === id) return closeMenu(true);
    if (state.pickerOpen) closePicker(false);
    state.menu = { place, id, confirm: false, agentPick: false, focus: place + ":rename:" + id, typed: "", error: null };
    renderMenus();
    // Topic: ob Löschen erlaubt ist, weiß nur der Server
    if (isManagedTopicId(id)) void loadRights(false);
  }

  /** Schließt das offene Menü; mit focusToggle geht der Fokus zurück an seinen Knopf. */
  function closeMenu(focusToggle) {
    const menu = state.menu;
    if (!menu) return;
    state.menu = null;
    renderMenus();
    if (!focusToggle) return;
    if (menu.place === "header") el.conversationMenu.focus();
    else focusKey("menu:" + menu.id);
  }

  /** DELETE; läuft gerade eine Antwort, lehnt der Server mit 409 ab. */
  async function deleteConversation(id) {
    if (state.deleting) return;
    state.deleting = id;
    renderMenus();
    try {
      const { status, data } = await api("DELETE", "/api/conversations/" + id);
      if (status === 200 || status === 404) {
        state.deleting = null;
        state.menu = null;
        await conversationGone(id);
        return;
      }
      state.menu = null;
      if (status === 409) addLocalError("Solange " + brandName() + " antwortet, lässt sich das Gespräch nicht löschen. Erst stoppen oder die Antwort abwarten.");
      else addLocalError((data && data.error) || "Löschen fehlgeschlagen (Fehler " + status + ").");
    } catch {
      if (!state.leaving) addLocalError("Server nicht erreichbar, Gespräch nicht gelöscht.");
    } finally {
      state.deleting = null;
      renderMenus();
    }
  }

  /** true, wenn der Server das Web-Gespräch bzw. Topic nicht mehr in seiner Liste führt */
  async function confirmGone(id) {
    try {
      const { ok, data } = await api("GET", "/api/conversations");
      if (!ok || !data || !Array.isArray(data.conversations)) return false;
      if (!isTelegramId(id)) return !data.conversations.some(c => c && c.id === id);
      // Topics: nur mit Telegram-Teil in der Antwort entscheiden, sonst lieber nicht aufräumen
      const topics = data.telegram && Array.isArray(data.telegram.topics) ? data.telegram.topics : null;
      return !!topics && !topics.some(t => t && t.id === id);
    } catch {
      return false;
    }
  }

  function forgetConversation(id) {
    try {
      if (window.localStorage.getItem(LAST_CONVERSATION_KEY) === id) window.localStorage.removeItem(LAST_CONVERSATION_KEY);
    } catch {
      // privater Modus oder Speicher gesperrt
    }
  }

  /** Entfernt ein Web-Gespräch oder Topic aus den lokalen Listen, Neu-Punkten und Anheftungen */
  function dropConversation(id) {
    state.conversations = state.conversations.filter(c => c.id !== id);
    state.telegram.topics = state.telegram.topics.filter(t => t.id !== id);
    state.pinned.delete(id);
    clearUnread(id);
  }

  /**
   * Ein Web-Gespräch oder Topic gibt es nicht mehr (hier oder in einem
   * anderen Browser gelöscht): aus Liste, Entwürfen und gemerkter Auswahl
   * entfernen. War es offen, Live-Verbindung und Wiederholungen beenden und
   * ein vorhandenes Gespräch öffnen (jüngstes Web-Gespräch, Direktchat,
   * Topic). Gibt es keines mehr, bleibt der Leerzustand; nie wird eines
   * angelegt, denn das wäre ein neues Telegram-Topic (Issue #30).
   */
  async function conversationGone(id) {
    const wasKnown = !!findConversation(id);
    dropConversation(id);
    state.drafts.delete(id);
    forgetConversation(id);
    if (state.menu && state.menu.id === id) state.menu = null;
    const open = !!state.conversation && state.conversation.id === id;
    if (!open) {
      if (wasKnown) renderMenus();
      return;
    }
    cancelRename(false);
    closeEvents();
    discardRecording();
    state.generation++;
    state.conversation = null;
    state.messages = [];
    el.input.value = "";
    closeCommandList();
    // Lokale Reihenfolge kann veraltet sein (Antworten verschieben die
    // Aktivität auf dem Server): Liste vor der Auswahl abgleichen
    await refreshConversations();
    if (state.conversation) {
      renderMenus();
      return;
    }
    // Der Abgleich kann den Eintrag noch kurz führen (Löschen läuft noch)
    dropConversation(id);
    const next = firstExisting();
    if (!next) {
      showNoConversation();
      return;
    }
    if (splitTopics(state.telegram.topics, undefined, state.pinned).older.some(t => t.id === next.id)) state.olderOpen = true;
    openConversation(next);
  }

  // --- Einstellungen (Issue #38) -----------------------------------------------

  const settingsView = typeof createSettingsView === "function"
    ? createSettingsView({
      api,
      agentLabel,
      setTimeout,
      clearTimeout,
      // Agenten angelegt, gelöscht, wiederhergestellt (Issue #51): Auswahl und Seitenleiste nachziehen
      onAgentsChanged: (data, options) => {
        if (data) applyAgents(data);
        // Gelöschte Agenten: ihre Topics nutzen jetzt General
        // Ältere Listen-Antworten (noch mit dem gelöschten Agenten) verfallen
        if (options && options.topicsChanged) {
          state.entryChanges++;
          void refreshConversations();
        }
      },
      // Name nur, wenn das Topic nachweislich aus der Gruppe der Seitenleiste stammt
      topicTitle: (chatId, topicId) => {
        if (!state.telegram.chatId || chatId !== state.telegram.chatId) return null;
        const topic = state.telegram.topics.find(t => t.id === "topic-" + topicId);
        return topic ? conversationTitle(topic) : null;
      },
      // Reiterwechsel ersetzt die Adresse, ohne neuen Verlaufseintrag (Issue #39)
      onTab: tab => {
        replaceHash(settingsHash(tab));
        routeFromHash();
      },
    })
    : null;

  /** Adresse ohne neuen Verlaufseintrag setzen; null entfernt den Hash */
  function replaceHash(hash) {
    const loc = window.location;
    if (!window.history || typeof window.history.replaceState !== "function") return;
    window.history.replaceState(null, "", String(loc.pathname || "/") + String(loc.search || "") + (hash || ""));
  }

  /**
   * Zeigt Chat oder Einstellungen passend zur Adresse. #/einstellungen und
   * nicht fertige Reiter werden zu #/einstellungen/agenten. Neuladen und
   * Direktaufruf landen so in derselben Ansicht, der Browser-Zurück-Knopf
   * führt zum Chat.
   */
  function routeFromHash() {
    const hash = window.location ? window.location.hash : "";
    let tab = settingsView ? settingsTabFromHash(hash) : null;
    // Zurück-Knopf: landet der Schritt zurück wieder in den Einstellungen, Hash entfernen
    if (tab && state.closingSettings) {
      replaceHash(null);
      tab = null;
    }
    state.closingSettings = false;
    if (tab) {
      if (hash !== settingsHash(tab)) replaceHash(settingsHash(tab));
      const wasOpen = settingsView.isOpen();
      if (state.menu) closeMenu(false);
      if (state.pickerOpen) closePicker(false);
      cancelRename(false);
      closeSidebar();
      // Die Eingabebox ist in den Einstellungen nicht zu sehen: keine unsichtbare Aufnahme
      discardRecording();
      el.main.setAttribute("data-view", "settings");
      el.openSettings.setAttribute("aria-current", "page");
      settingsView.show(tab);
      if (!wasOpen) el.settingsTitle.focus();
      return;
    }
    state.settingsPushed = false;
    if (!settingsView || !settingsView.isOpen()) return;
    settingsView.hide();
    el.main.setAttribute("data-view", "chat");
    el.openSettings.removeAttribute("aria-current");
    if (!el.input.disabled) el.input.focus();
  }

  function openSettings() {
    if (!settingsView) return;
    if (settingsView.isOpen()) {
      closeSidebar();
      return;
    }
    state.settingsPushed = true;
    window.location.hash = settingsHash("agenten");
    // Manche Umgebungen melden hashchange nicht zuverlässig
    if (!settingsView.isOpen()) routeFromHash();
  }

  /** Zurück zum Chat: aus der Seite geöffnet einen Schritt zurück, sonst den Hash entfernen */
  function closeSettings() {
    if (state.settingsPushed && window.history && typeof window.history.back === "function") {
      state.settingsPushed = false;
      state.closingSettings = true;
      window.history.back();
      return;
    }
    replaceHash(null);
    routeFromHash();
  }

  async function logout() {
    discardRecording();
    closeEvents();
    closeActivity();
    state.leaving = true;
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // Umleiten auch ohne Antwort
    }
    window.location.href = "/login";
  }

  el.form.addEventListener("submit", event => {
    event.preventDefault();
    void send();
  });
  el.input.addEventListener("keydown", event => {
    // Enter sendet am Rechner; nicht während der Eingabe per IME und nicht
    // auf Touch-Geräten (dort sendet nur der Knopf)
    // Offene Befehlsliste zuerst: dort übernimmt Enter den Befehl, statt zu senden
    if (commandKeydown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (touchInput) return;
    event.preventDefault();
    void send();
  });
  el.input.addEventListener("input", () => {
    autosize();
    updateControls();
    updateCommandList();
  });
  el.input.addEventListener("focus", () => updateCommandList());
  el.input.addEventListener("paste", onPaste);
  // Anhänge (Issue #73): Büroklammer öffnet die Dateiauswahl, Ziehen auf den Chat
  el.attach.addEventListener("click", () => {
    if (!state.sending) el.fileInput.click();
  });
  // Sprachaufnahme (Issue #109)
  el.record.addEventListener("click", () => void startRecording());
  el.recorderStop.addEventListener("click", () => stopRecording(state.recording));
  el.recorderDiscard.addEventListener("click", () => {
    discardRecording();
    el.input.focus();
  });
  el.fileInput.addEventListener("change", () => {
    const files = Array.from(el.fileInput.files || []);
    // Zurücksetzen, damit dieselbe Datei noch einmal gewählt werden kann
    el.fileInput.value = "";
    if (files.length) addAttachments(files.map(file => ({ file })));
    el.input.focus();
  });
  el.main.addEventListener("dragenter", event => {
    if (!draggingFiles(event) || el.main.getAttribute("data-view") === "settings") return;
    event.preventDefault();
    state.dragDepth++;
    setDropping(true);
  });
  el.main.addEventListener("dragover", event => {
    if (!draggingFiles(event) || el.main.getAttribute("data-view") === "settings") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = attachRefusal() ? "none" : "copy";
  });
  el.main.addEventListener("dragleave", event => {
    if (!draggingFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) setDropping(false);
  });
  el.main.addEventListener("drop", event => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    setDropping(false);
    if (el.main.getAttribute("data-view") === "settings") return;
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) addAttachments(files.map(file => ({ file })));
  });
  // Daneben fallen gelassen: nicht die Datei öffnen und die Seite verlassen
  window.addEventListener("dragover", event => {
    if (draggingFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", event => {
    if (draggingFiles(event)) event.preventDefault();
  });
  el.input.addEventListener("blur", () => closeCommandList());
  // Antippen oder Klicken eines Eintrags nimmt der Eingabe den Fokus nicht
  el.commandList.addEventListener("mousedown", event => event.preventDefault());
  el.stop.addEventListener("click", () => void stopTurn());
  el.menu.addEventListener("click", () => openSidebar());
  el.sidebarClose.addEventListener("click", () => closeSidebar());
  el.scrim.addEventListener("click", () => closeSidebar());
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    // Erst das Innerste schließen: Menü, dann Agentenauswahl, dann Schublade
    if (state.menu) closeMenu(true);
    else if (state.pickerOpen) closePicker(true);
    else if (el.sidebar.getAttribute("data-open") === "true") closeSidebar();
  });
  el.activityToggle.addEventListener("click", () => {
    const open = el.progress.hidden;
    const stick = nearBottom();
    el.progress.hidden = !open;
    el.activityToggle.setAttribute("aria-expanded", open ? "true" : "false");
    // Aufgeklappte Schritte nicht hinter der Eingabe verstecken
    if (open && stick) scrollToBottom();
  });
  el.newChat.addEventListener("click", () => (state.pickerOpen ? closePicker(true) : openPicker()));
  // Leerzustand ohne Gespräch: dieselbe Agentenauswahl, am Handy in der geöffneten Schublade
  el.emptyNew.addEventListener("click", () => {
    const drawer = window.matchMedia && window.matchMedia("(max-width: 55.99rem)").matches;
    if (drawer) openSidebar();
    openPicker();
  });
  el.agentOptions.addEventListener("keydown", pickerKeydown);
  el.title.addEventListener("click", () => startRename());
  el.conversationMenu.addEventListener("click", () => {
    if (state.conversation) toggleMenu("header", state.conversation.id);
  });
  el.titleInput.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void saveRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      showConnection("");
      cancelRename(true);
    }
  });
  el.titleInput.addEventListener("input", () => {
    if (el.titleInput.removeAttribute) el.titleInput.removeAttribute("aria-invalid");
  });
  // Fokus verlassen ohne Enter: nichts ändern (vorsichtig, kein Speichern aus Versehen)
  el.titleInput.addEventListener("blur", () => {
    if (!state.renaming) cancelRename(false);
  });
  // Klick außerhalb schließt ein offenes Menü
  window.addEventListener("click", event => {
    if (!state.menu) return;
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest(".actions-panel, .actions-list, .entry-actions, .entry-menu, #conversation-menu")) return;
    closeMenu(false);
  });
  // Filtert nur die schon geladene Liste, ohne Anfrage an den Server
  el.filter.addEventListener("input", () => renderConversationList());
  el.olderToggle.addEventListener("click", () => {
    state.olderOpen = !state.olderOpen;
    renderConversationList();
  });
  el.loadOlder.addEventListener("click", () => void loadOlder());
  el.logout.addEventListener("click", () => void logout());
  if (settingsView) {
    el.openSettings.addEventListener("click", () => openSettings());
    el.settingsBack.addEventListener("click", () => closeSettings());
    window.addEventListener("hashchange", () => routeFromHash());
  } else {
    el.openSettings.hidden = true;
  }
  window.addEventListener("pagehide", () => {
    closeEvents();
    closeActivity();
    // Seite verlassen (Issue #109): Aufnahme verwerfen, Mikrofon und Objekt-URLs frei
    discardRecording();
    for (const list of state.attachments.values()) list.forEach(releaseAudio);
  });
  // Aus dem Zurück-Cache: Wiedergabe der Aufnahmen neu aufbauen
  window.addEventListener("pageshow", () => renderAttachments());
  // Neue Version (Issue #111): beim Zurückkehren in den Tab prüfen
  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      onVisible();
      if (document.visibilityState !== "hidden") refreshDay();
    });
  }

  if (touchInput) el.input.setAttribute("enterkeyhint", "enter");
  initThemeSwitch(window.WebTheme);
  autosize();
  updateControls();
  // Vor start(): das erste applyMode setzt den gesicherten Entwurf ein
  restoreReloadDrafts();
  void start();
  routeFromHash();
}

if (typeof document !== "undefined" && document.getElementById("chat-log")) init();
