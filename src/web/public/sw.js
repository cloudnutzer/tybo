// Service Worker der installierbaren WebUI (Issue #224, Entscheidung 0021).
// Klassisches Skript ohne Build. Er macht nur eines: Ist tybo nicht
// erreichbar, zeigt er bei einer Navigation die Seite offline.html aus
// seinem Cache statt einer Fehlerseite des Browsers oder von Cloudflare.
//
// - Navigationen gehen unverändert ans Netz (fetch(event.request), keine neu
//   gebaute Anfrage), damit Weiterleitungen von Cloudflare Access so beim
//   Browser ankommen, wie sie kommen (auch opaqueredirect).
// - Netzfehler oder Status 502/503/504/520 bis 530 (Cloudflare meldet einen
//   abgeschalteten Tunnel mit 530) auf eine Navigation: offline.html.
// - Die Dateien der Offline-Seite (offline.js, style.css, theme.js,
//   favicon.svg) holt er zuerst aus dem Netz und nur bei Fehler aus dem Cache.
// - Alles andere (/api, Live-Verbindungen, Dateien, Downloads, app.js) fasst
//   er nicht an und cacht nichts davon: keine Kopie von Gesprächen.
// - Cache-Name trägt die Oberflächen-Version; der Server setzt sie beim
//   Ausliefern ein, jede Änderung in public/ ergibt also einen neuen Worker.
//   Beim activate löscht er nur eigene ältere Caches.
// - skipWaiting erst auf Wunsch der Seite (Knopf „Neu laden" beim Hinweis
//   „Neue Version"), damit kein halb geladener Stand mischt.
//
// Web Push (Issue #225):
// - push zeigt immer eine Benachrichtigung (Browser verlangen das), auch bei
//   leerer oder kaputter Nutzlast (dann ein allgemeiner Text).
// - notificationclick öffnet nur Adressen der eigenen Seite: ein offenes
//   Fenster wird dorthin geführt und nach vorn geholt, sonst ein neues.
// - Seit Issue #226 tragen Benachrichtigungen Kategorie (reply, choice,
//   notice), Gespräch und bei Rückfragen die Frage-Kennung in data. Ein Tipp
//   auf eine Benachrichtigung zu einem Gespräch wechselt in einem offenen
//   Fenster per postMessage das Gespräch (ohne Neuladen), sonst öffnet er
//   /#/gespraech/<id>. Die Chat-App bestätigt die Nachricht über einen
//   MessageChannel; bleibt die Bestätigung aus (Offline-Seite unter /, alter
//   Stand), lädt der Worker das Fenster mit dem Gesprächslink neu. Beim Öffnen der App schließt die Seite erledigte
//   Rückfragen und das sichtbare Gespräch (app.js).
// - pushsubscriptionchange meldet das neue Abo an den Server (mit dem alten
//   Endpunkt, damit es dasselbe Gerät bleibt). Scheitert das (offline,
//   abgemeldet), gleicht die Seite beim nächsten Öffnen ab (push.js).
//
// Teilen-Ziel (Issue #229, nur Android): Der POST an /teilen aus dem
// Teilen-Menü geht nie an den Server. Der Worker liest Titel, Text, Link und
// die Dateien (Feld „dateien"), prüft Art, Größe und Anzahl wie die
// Büroklammer, legt alles in einem eigenen Cache ab (eine Übergabe je Teilen
// mit zufälliger Kennung) und leitet mit 303 auf /#/teilen um. Die Chat-App
// übernimmt die Übergabe und löscht sie danach. Übergaben verfallen nach zehn
// Minuten: geprüft und gelöscht beim Aktivieren, bei jedem neuen Teilen und
// beim Lesen durch die App; ein Zeitgeber bei geschlossener App fehlt. Kann
// der Worker nicht ablegen (Speicher voll), räumt er die halbe Übergabe weg
// und leitet auf /#/teilen/fehler um.
"use strict";

const CACHE_PREFIX = "{{brand.cli}}-offline-";
const CACHE_NAME = CACHE_PREFIX + "{{ui.version}}";
const OFFLINE_PAGE = "/offline.html";
/** Alles, was die Offline-Seite braucht */
const OFFLINE_ASSETS = [OFFLINE_PAGE, "/offline.js", "/style.css", "/theme.js", "/favicon.svg"];
/** Nachricht der Seite, damit ein wartender Worker übernimmt */
const SKIP_WAITING = "skip-waiting";
/** Name für Benachrichtigungen ohne eigenen Titel */
const BRAND_NAME = "{{brand.name}}";
const PUSH_ICON = "/icon-192.png";
const PUSH_FALLBACK_BODY = "Neue Nachricht";
const PUSH_TITLE_MAX = 120;
const PUSH_BODY_MAX = 500;

/** Antworten, die „tybo nicht erreichbar" heißen */
function isUnreachableStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

/** Pfade, die der Worker nie anfasst, auch beim direkten Öffnen im Browser */
function isExcludedPath(path) {
  return path === "/api" || path.startsWith("/api/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)))
      )
      .then(() => cleanShares(Date.now()))
      .catch(() => {})
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === SKIP_WAITING) self.skipWaiting();
});

async function offlineResponse() {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(OFFLINE_PAGE);
}

async function navigate(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const page = await offlineResponse();
    if (page) return page;
    throw error;
  }
  if (!isUnreachableStatus(response.status)) return response;
  return (await offlineResponse()) || response;
}

async function offlineAsset(request) {
  try {
    const response = await fetch(request);
    if (!isUnreachableStatus(response.status)) return response;
    return (await caches.match(request, { cacheName: CACHE_NAME })) || response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName: CACHE_NAME });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Teilen-Ziel (Issue #229): der POST erreicht den Server nie
  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === SHARE_PATH && !url.search) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin || isExcludedPath(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (!url.search && OFFLINE_ASSETS.includes(url.pathname)) event.respondWith(offlineAsset(request));
});

// --- Web Push (Issue #225) ----------------------------------------------------

/** Text auf eine Länge gekürzt; alles andere als Text wird leer */
function pushText(value, max) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Nur Pfade der eigenen Seite: /… (nicht //…), sonst die Startseite. Ergebnis
 * ist immer eine volle Adresse auf dem eigenen Ursprung.
 */
function pushTarget(value) {
  const origin = self.location.origin;
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return origin + "/";
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.href : origin + "/";
  } catch {
    return origin + "/";
  }
}

/** Wie LINK_ID_PATTERN in app.js: Web-Gespräch, Direktchat oder Topic */
const CONVERSATION_ID = /^(dm|topic-[1-9][0-9]{0,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CATEGORIES = ["reply", "choice", "notice"];
const CHOICE_ID = /^[A-Za-z0-9]{1,12}$/;
/** Wie OPEN_CONVERSATION_MESSAGE in app.js */
const OPEN_CONVERSATION = "open-conversation";
/** Wie OPEN_CONVERSATION_ACK in app.js: Antwort der Chat-App auf dem Kanal */
const OPEN_CONVERSATION_ACK = "open-conversation-ack";

/** Nutzlast lesen; kaputt oder leer ergibt einen allgemeinen Text */
function pushPayload(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") payload = {};
  const tag = pushText(payload.tag, 64);
  const title = pushText(payload.title, PUSH_TITLE_MAX);
  const conversationId = typeof payload.conversationId === "string" && CONVERSATION_ID.test(payload.conversationId) ? payload.conversationId : null;
  const category = CATEGORIES.includes(payload.category) ? payload.category : null;
  return {
    title: title || BRAND_NAME,
    body: pushText(payload.body, PUSH_BODY_MAX) || (title ? "" : PUSH_FALLBACK_BODY),
    tag,
    url: pushTarget(payload.url),
    conversationId,
    category,
    choiceId: category === "choice" && typeof payload.choiceId === "string" && CHOICE_ID.test(payload.choiceId) ? payload.choiceId : null,
  };
}

self.addEventListener("push", (event) => {
  const message = pushPayload(event.data);
  const data = { url: message.url };
  if (message.conversationId) data.conversationId = message.conversationId;
  if (message.category) data.category = message.category;
  if (message.choiceId) data.choiceId = message.choiceId;
  const options = { body: message.body, icon: PUSH_ICON, badge: PUSH_ICON, data };
  if (message.tag) {
    options.tag = message.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(message.title, options));
});

/** So lange wartet der Worker auf die Bestätigung der Chat-App */
const OPEN_CONVERSATION_ACK_MS = 800;

/**
 * Schickt das Gespräch an ein Fenster und wartet auf die Bestätigung der
 * Chat-App über einen eigenen Kanal. Die Offline-Seite (auch unter /) und
 * ältere Stände antworten nicht: dann false.
 */
function askToOpen(client, conversationId) {
  if (typeof client.postMessage !== "function" || typeof MessageChannel !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, OPEN_CONVERSATION_ACK_MS);
    channel.port1.onmessage = (event) => {
      if (!event.data || event.data.type !== OPEN_CONVERSATION_ACK) return;
      clearTimeout(timer);
      channel.port1.close();
      resolve(true);
    };
    try {
      client.postMessage({ type: OPEN_CONVERSATION, conversationId }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Gesprächslink, der im Fenster sicher neu lädt. Unterscheidet sich die neue
 * Adresse nur im Teil nach # von der alten, wechselt der Browser nur den Hash
 * und die Seite (etwa die Offline-Seite unter /) bleibt stehen. Dann nimmt
 * der Worker / mit leerer Abfrage (/?); die App räumt das ? beim Öffnen weg.
 */
function reloadingLink(clientUrl, url) {
  try {
    const current = new URL(clientUrl);
    const target = new URL(url);
    current.hash = "";
    target.hash = "";
    if (current.href !== target.href) return url;
    const hash = new URL(url).hash;
    const origin = self.location.origin;
    return (current.href === origin + "/" ? origin + "/?" : origin + "/") + hash;
  } catch {
    return url;
  }
}

async function openTarget(url, conversationId) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const own = windows.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  const client = own.find((c) => c.focused) || own[0];
  if (!client) return self.clients.openWindow(url);
  // Gespräch (Issue #226): im offenen Fenster wechseln, ohne es neu zu laden.
  // Nur Fenster, die dieser Worker steuert, bekommen Nachrichten; die Login-Seite hört nicht zu.
  const inApp = (() => {
    try {
      return new URL(client.url).pathname === "/";
    } catch {
      return false;
    }
  })();
  if (conversationId && inApp) {
    // Erst nach vorn holen, solange der Klick noch als Nutzeraktion gilt
    const focused = typeof client.focus === "function" ? await client.focus().catch(() => client) : client;
    if (await askToOpen(client, conversationId)) return focused;
    // Kein Empfänger (Offline-Seite unter /, alter Stand): ganz laden mit dem Gesprächslink
    return showIn(focused || client, reloadingLink(client.url, url), url);
  }
  if (client.url === url) return typeof client.focus === "function" ? client.focus() : client;
  const target = await showIn(client, url, null);
  return typeof target.focus === "function" ? target.focus() : target;
}

/**
 * Führt ein Fenster zu einer Adresse. Klappt das nicht (nicht von diesem
 * Worker gesteuert), öffnet ein neues Fenster mit fallback, ohne fallback
 * bleibt das alte Fenster.
 */
async function showIn(client, url, fallback) {
  if (typeof client.navigate === "function") {
    try {
      const target = await client.navigate(url);
      if (target) return target;
    } catch {
      // nicht von diesem Worker gesteuert
    }
  }
  if (fallback) {
    try {
      const opened = await self.clients.openWindow(fallback);
      if (opened) return opened;
    } catch {
      // Browser lässt kein neues Fenster zu
    }
  }
  return client;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const conversationId = data && typeof data.conversationId === "string" && CONVERSATION_ID.test(data.conversationId) ? data.conversationId : null;
  event.waitUntil(openTarget(clickTarget(data), conversationId));
});

/** Ziel aus den Daten der Benachrichtigung, noch einmal auf den eigenen Ursprung geprüft */
function clickTarget(data) {
  const value = data && typeof data.url === "string" ? data.url : "";
  try {
    const url = new URL(value);
    if (url.origin === self.location.origin) return pushTarget(url.pathname + url.search + url.hash);
  } catch {
    // keine volle Adresse
  }
  return pushTarget("/");
}

async function resubscribe(event) {
  const old = event.oldSubscription || null;
  let subscription = event.newSubscription || null;
  if (!subscription && old && old.options) {
    subscription = await self.registration.pushManager.subscribe(old.options);
  }
  if (!subscription) return;
  const json = subscription.toJSON();
  const body = { subscription: { endpoint: json.endpoint, keys: json.keys } };
  if (old && old.endpoint) body.previousEndpoint = old.endpoint;
  await fetch("/api/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

self.addEventListener("pushsubscriptionchange", (event) => {
  // Ohne alten Endpunkt kennt der Server das Gerät nicht; dann gleicht die Seite beim Öffnen ab
  event.waitUntil(resubscribe(event).catch(() => {}));
});

// --- Teilen-Ziel (Issue #229) -------------------------------------------------

/** Wie SHARE_TARGET_PATH in src/web/manifest.ts */
const SHARE_PATH = "/teilen";
/** Eigener Cache, den activate nicht mit den Offline-Caches wegräumt */
const SHARE_CACHE = "{{brand.cli}}-teilen";
const SHARE_REDIRECT = "/#/teilen";
const SHARE_FAILED = "/#/teilen/fehler";
/** Wie MAX_ATTACHMENTS in src/web/attachments.ts */
const SHARE_MAX_FILES = 5;
const SHARE_MAX_AGE_MS = 10 * 60 * 1000;
/** So weit darf ein Zeitpunkt in der Zukunft liegen: gleichzeitiges Schreiben und Lesen */
const SHARE_CLOCK_SKEW_MS = 60 * 1000;
/** Titel, Text und Link zusammen höchstens so viele Zeichen (wie ein langer Entwurf) */
const SHARE_TEXT_MAX = 20000;
const SHARE_MB = 1048576;
/** Wie MEDIA_LIMITS in src/web/media-check.ts */
const SHARE_LIMITS = { image: 20 * SHARE_MB, document: 20 * SHARE_MB, audio: 25 * SHARE_MB };
/** Wie SHARE_ACCEPT in src/web/manifest.ts: Typ → Art */
const SHARE_TYPES = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "document",
  "audio/ogg": "audio",
  "audio/opus": "audio",
  "audio/mp4": "audio",
  "audio/x-m4a": "audio",
  "audio/m4a": "audio",
  "audio/webm": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
};
/** Endungen für Dateien ohne Typ, wie attachmentKind in app.js */
const SHARE_EXTENSIONS = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", pdf: "document",
  ogg: "audio", oga: "audio", opus: "audio", m4a: "audio", mp4: "audio", webm: "audio", wav: "audio", mp3: "audio", mpeg: "audio",
};
const SHARE_ID = /^[0-9a-f]{32}$/;

/**
 * Kennung einer Übergabe: 12 Hex-Stellen Zeitpunkt (ms), 20 zufällige. So
 * sieht jeder schon an den Dateien, wie alt eine Übergabe ohne Beschreibung
 * ist: jung heißt, sie wird gerade noch geschrieben.
 */
function shareId(now) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Math.floor(now).toString(16).padStart(12, "0").slice(-12) + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Zeitpunkt aus der Kennung */
function shareIdAt(id) {
  return parseInt(id.slice(0, 12), 16);
}

/** Noch gültig: jünger als zehn Minuten, höchstens eine Minute in der Zukunft (Uhren zweier Kontexte) */
function shareFresh(at, now) {
  return typeof at === "number" && at - now < SHARE_CLOCK_SKEW_MS && now - at < SHARE_MAX_AGE_MS;
}

/** Art einer geteilten Datei; null, wenn sie kein erlaubter Anhang ist */
function shareKind(file) {
  const type = String(file.type || "").toLowerCase();
  if (SHARE_TYPES[type]) return SHARE_TYPES[type];
  if (type && type !== "application/octet-stream") return null;
  const match = /\.([a-z0-9]+)$/i.exec(String(file.name || ""));
  return match ? SHARE_EXTENSIONS[match[1].toLowerCase()] || null : null;
}

/** Textfeld aus dem Formular; Dateien und alles andere ergeben leeren Text */
function shareField(form, name) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Dateiname ohne Pfad und Steuerzeichen, höchstens 120 Zeichen */
function shareName(value) {
  const name = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .split(/[\\/]/)
    .pop()
    .trim();
  return name.slice(0, 120) || "datei";
}

/**
 * Prüft die Dateien wie die Büroklammer: erlaubte Art, nicht leer, Grenze je
 * Art, höchstens fünf. Gibt übernommene Dateien und Gründe für den Rest.
 */
function checkSharedFiles(values) {
  const accepted = [];
  const rejected = [];
  for (const value of values) {
    if (!value || typeof value === "string" || typeof value.size !== "number") continue;
    const name = shareName(value.name);
    const kind = shareKind(value);
    if (!kind) rejected.push({ name, reason: "type" });
    else if (value.size < 1) rejected.push({ name, reason: "empty" });
    else if (value.size > SHARE_LIMITS[kind]) rejected.push({ name, reason: "size", kind });
    else if (accepted.length >= SHARE_MAX_FILES) rejected.push({ name, reason: "count" });
    else accepted.push({ file: value, name, kind });
  }
  return { accepted, rejected };
}

function shareUrl(id, index) {
  return self.location.origin + SHARE_PATH + "/" + id + (index === undefined ? "" : "/" + index);
}

/** Kennung einer Übergabe aus einem Cache-Eintrag; null bei fremden Einträgen */
function shareIdOf(requestUrl) {
  try {
    const parts = new URL(requestUrl).pathname.split("/");
    return parts[1] === SHARE_PATH.slice(1) && SHARE_ID.test(parts[2] || "") ? parts[2] : null;
  } catch {
    return null;
  }
}

/** Löscht alle Einträge einer Übergabe, die Beschreibung zuerst */
async function dropShare(cache, id) {
  await cache.delete(shareUrl(id));
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => shareIdOf(request.url) === id).map((request) => cache.delete(request)));
}

/**
 * Räumt abgelaufene und kaputte Übergaben weg. Dateien ohne Beschreibung
 * bleiben, solange die Kennung jung ist: ein anderes Teilen schreibt sie
 * gerade (oder die App löscht sie gerade); ältere sind abgebrochen.
 * Einträge verfallen im Cache nicht von selbst.
 */
async function cleanShares(now) {
  if (!(await caches.has(SHARE_CACHE))) return;
  const cache = await caches.open(SHARE_CACHE);
  const keys = await cache.keys();
  const ids = new Set();
  for (const request of keys) {
    const id = shareIdOf(request.url);
    if (id) ids.add(id);
    else await cache.delete(request);
  }
  for (const id of ids) {
    const response = await cache.match(shareUrl(id));
    if (!response) {
      if (!shareFresh(shareIdAt(id), now)) await dropShare(cache, id);
      continue;
    }
    let meta = null;
    try {
      meta = await response.json();
    } catch {
      meta = null;
    }
    if (!(meta && meta.id === id && shareFresh(meta.at, now))) await dropShare(cache, id);
  }
}

function shareRedirect(path) {
  return Response.redirect(self.location.origin + path, 303);
}

async function receiveShare(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return shareRedirect(SHARE_FAILED);
  }
  const now = Date.now();
  try {
    await cleanShares(now);
  } catch {
    // Aufräumen scheitert: das neue Teilen trotzdem versuchen
  }
  const { accepted, rejected } = checkSharedFiles(form.getAll("dateien"));
  let title = shareField(form, "title");
  let text = shareField(form, "text");
  let url = shareField(form, "url");
  if (title.length + text.length + url.length > SHARE_TEXT_MAX) {
    text = text.slice(0, SHARE_TEXT_MAX);
    title = title.slice(0, Math.max(0, SHARE_TEXT_MAX - text.length));
    url = url.slice(0, Math.max(0, SHARE_TEXT_MAX - text.length - title.length));
  }
  if (!accepted.length && !rejected.length && !title && !text && !url) return shareRedirect(SHARE_REDIRECT);
  const id = shareId(now);
  let cache = null;
  try {
    cache = await caches.open(SHARE_CACHE);
    const files = [];
    for (let i = 0; i < accepted.length; i++) {
      const entry = accepted[i];
      const type = String(entry.file.type || "application/octet-stream");
      await cache.put(shareUrl(id, i), new Response(entry.file, { headers: { "Content-Type": type } }));
      files.push({ n: i, name: entry.name, type, size: entry.file.size, kind: entry.kind });
    }
    const meta = { v: 1, id, at: now, title, text, url, files, rejected };
    // Die Beschreibung zuletzt: erst mit ihr ist die Übergabe vollständig
    await cache.put(shareUrl(id), new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  } catch {
    if (cache) await dropShare(cache, id).catch(() => {});
    return shareRedirect(SHARE_FAILED);
  }
  return shareRedirect(SHARE_REDIRECT);
}
