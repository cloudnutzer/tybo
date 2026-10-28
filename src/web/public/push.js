// Benachrichtigungen auf diesem Gerät (Issue #225, Entscheidung 0021): Reiter
// „Benachrichtigungen" in den Einstellungen und der Abgleich des Push-Abos
// nach dem Laden der Seite. Klassisches Skript ohne Build, vor settings.js
// und app.js geladen; beide prüfen mit typeof, ob es da ist.
//
// - Die Berechtigung fragt nur ein Tipp auf „An" ab, nie das Laden der Seite.
// - Die Kennung dieses Geräts liegt in localStorage (PUSH_DEVICE_KEY). Kennt
//   der Server sie nicht mehr (auf einem anderen Gerät entfernt), meldet sich
//   die Seite auch beim Browser ab, statt das Gerät still neu anzulegen.
// - Scheitert das Ausschalten (Browser oder Server), bleibt die Kennung
//   gemerkt und PUSH_OFF_PENDING_KEY gesetzt: die Oberfläche zeigt weiter
//   „An" mit Fehler, der Abgleich nach Neuladen oder Anmeldung holt das
//   Ausschalten nach, statt das Abo wieder anzumelden.
// - Ein Abo, das der Server verworfen hat (404, 410), wird auch beim Browser
//   abgemeldet; „An" abonniert dann frisch.
// - Nutzertext (Gerätenamen, Meldungen des Servers) kommt nur über
//   textContent und value in die Seite.
// - Seit Issue #226 hat jedes Gerät eigene Schalter: Antworten, Rückfragen,
//   Meldungen und „Inhalt zeigen". Jede Änderung geht sofort an den Server
//   (PATCH mit settings) und gilt dort für den nächsten Push.
"use strict";

const PUSH_DEVICE_KEY = "tybo-push-device";
/** Ausschalten angefangen, aber nicht bei Browser und Server fertig */
const PUSH_OFF_PENDING_KEY = "tybo-push-off-pending";
/** Wie DEVICE_NAME_MAX_CHARS in src/web/push-store.ts */
const PUSH_NAME_MAX = 40;

const PUSH_TEXT = {
  intro: "Meldet sich, wenn die App geschlossen ist. Gilt nur für dieses Gerät.",
  insecure: "Benachrichtigungen gehen nur über https://… (Zugang von unterwegs) oder auf diesem Rechner über localhost. Über die Adresse im Heimnetz (http://…) lässt der Browser sie nicht zu.",
  get ios() { return "Auf dem iPhone und iPad erst " + window.TYBO_BRAND.name + " zum Home-Bildschirm hinzufügen (Teilen → Zum Home-Bildschirm), dann dort öffnen und hier einschalten. Ab iOS 16.4."; },
  unsupported: "Dieser Browser kann keine Benachrichtigungen empfangen.",
  denied: "Benachrichtigungen sind für diese Seite blockiert. So erlaubst du sie wieder:",
  deniedSteps: [
    "iPhone, iPad: Einstellungen → Mitteilungen → die App wählen → Mitteilungen erlauben.",
    "Android (Chrome): Schloss- oder Einstellungs-Symbol links neben der Adresse → Berechtigungen → Benachrichtigungen → Zulassen.",
    "Rechner: Symbol links neben der Adresse → Website-Einstellungen → Benachrichtigungen → Zulassen.",
  ],
  deniedAfter: "Danach diese Seite neu laden.",
  on: "An: Dieses Gerät bekommt Benachrichtigungen.",
  off: "Aus: Dieses Gerät bekommt keine Benachrichtigungen.",
  removed: "Dieses Gerät wurde entfernt und ist jetzt aus. Zum Einschalten „An\" tippen.",
  permissionDismissed: "Keine Erlaubnis erteilt. Zum erneuten Fragen noch einmal „An\" tippen.",
  subscribeFailed: "Einschalten hat nicht geklappt. Bitte noch einmal versuchen.",
  offline: "Server nicht erreichbar, nichts geändert.",
  offFailed: "Ausschalten hat nicht geklappt, dieses Gerät kann noch Benachrichtigungen bekommen. Bitte noch einmal „Aus\" tippen.",
  loadFailed: "Benachrichtigungen konnten nicht geladen werden.",
  testSent: "Test gesendet. Die Benachrichtigung sollte gleich erscheinen.",
  thisDevice: "Dieses Gerät",
  otherDevices: "Andere Geräte",
  noOthers: "Keine anderen Geräte.",
  never: "noch nie erreicht",
  nameInvalid: "Name muss 1 bis " + PUSH_NAME_MAX + " Zeichen haben.",
  categories: "Was sich meldet",
  categoriesHint: "Nie für das Gespräch, das gerade offen auf dem Bildschirm ist.",
  settingFailed: "Nicht gespeichert. Bitte noch einmal versuchen.",
};

/** Schalter pro Gerät (Issue #226), Reihenfolge wie in der Oberfläche */
const PUSH_SETTINGS = [
  { key: "replies", label: "Antworten", hint: "Wenn eine Antwort fertig ist, die du im Browser oder im Terminal angestoßen hast. Antworten in Telegram meldet Telegram selbst." },
  { key: "choices", label: "Rückfragen", hint: "Wenn eine Freigabe, ein Merk-Vorschlag oder eine Entscheidung wartet." },
  { key: "notices", label: "Meldungen", hint: "Pipeline, Jobs, Briefing, Check-in, Watchdog, Dateien. Mit Telegram standardmäßig aus, sonst kommt alles doppelt." },
  { key: "preview", label: "Inhalt in der Benachrichtigung zeigen", hint: "Zeigt den Anfang der Antwort oder Meldung und Dateinamen, auch auf dem Sperrbildschirm. Aus: nur Gespräch und Absender." },
];

/** Was dieser Browser kann; wirft nie */
function pushEnvironment(win) {
  const env = { secure: false, supported: false, ios: false, standalone: false, permission: "default" };
  try {
    const nav = win.navigator || {};
    env.secure = !!win.isSecureContext;
    env.supported = !!(nav.serviceWorker && win.PushManager && win.Notification);
    const ua = String(nav.userAgent || "");
    env.ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
    env.standalone = nav.standalone === true || (typeof win.matchMedia === "function" && !!win.matchMedia("(display-mode: standalone)").matches);
    if (win.Notification && typeof win.Notification.permission === "string") env.permission = win.Notification.permission;
  } catch {
    // alte Browser: bleibt „nicht möglich"
  }
  return env;
}

/**
 * Zustand des Abschnitts: server-off, insecure, ios-install, unsupported,
 * denied, on oder off. Reihenfolge wie im Browser: ohne sicheren Kontext gibt
 * es kein PushManager, auf dem iPhone erst nach dem Installieren.
 */
function pushViewState(env, serverAvailable, subscribed) {
  if (!serverAvailable) return "server-off";
  if (!env.secure) return "insecure";
  if (env.ios && !env.standalone) return "ios-install";
  if (!env.supported) return "unsupported";
  if (env.permission === "denied") return "denied";
  return subscribed ? "on" : "off";
}

/** base64url zu Bytes für applicationServerKey */
function pushKeyBytes(base64url) {
  const b64 = String(base64url).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Nur die Teile, die der Server braucht */
function subscriptionBody(subscription) {
  const json = subscription && typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
  return { endpoint: json && json.endpoint, keys: json && json.keys ? { p256dh: json.keys.p256dh, auth: json.keys.auth } : null };
}

function readId(storage, key) {
  try {
    const id = storage ? storage.getItem(key) : null;
    return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function writeId(storage, key, id) {
  try {
    if (!storage) return;
    if (id) storage.setItem(key, id);
    else storage.removeItem(key);
  } catch {
    // privater Modus: dann gilt das Gerät nach dem Neuladen als aus
  }
}

function readDeviceId(storage) {
  return readId(storage, PUSH_DEVICE_KEY);
}

function writeDeviceId(storage, id) {
  writeId(storage, PUSH_DEVICE_KEY, id);
}

/** Kennung des Geräts, dessen Ausschalten noch aussteht; sonst null */
function readPendingOff(storage) {
  const id = readId(storage, PUSH_OFF_PENDING_KEY);
  return id && id === readDeviceId(storage) ? id : null;
}

/** Registrierung des Service Workers; null ohne (kein sicherer Kontext, keiner registriert) */
async function pushRegistration(win) {
  try {
    const container = win.navigator && win.navigator.serviceWorker;
    if (!win.isSecureContext || !container) return null;
    const registration = await container.getRegistration("/");
    return registration && registration.pushManager ? registration : null;
  } catch {
    return null;
  }
}

async function currentSubscription(win) {
  const registration = await pushRegistration(win);
  if (!registration) return null;
  try {
    return (await registration.pushManager.getSubscription()) || null;
  } catch {
    return null;
  }
}

/** Abo beim Browser abmelden; true, wenn keins mehr besteht */
async function dropBrowserSubscription(subscription) {
  if (!subscription) return true;
  try {
    return (await subscription.unsubscribe()) !== false;
  } catch {
    return false;
  }
}

/**
 * Dieses Gerät ausschalten: beim Browser abmelden und beim Server entfernen
 * (404 heißt schon weg). Erst wenn beides geklappt hat, vergisst die Seite
 * das Gerät; sonst bleibt es mit PUSH_OFF_PENDING_KEY zum Wiederholen gemerkt.
 * Ergebnis: { done, res } mit der Antwort des Servers (null bei Netzfehler).
 */
async function turnOffDevice(deps, id) {
  if (id) writeId(deps.storage, PUSH_OFF_PENDING_KEY, id);
  const browserOk = await dropBrowserSubscription(await currentSubscription(deps.win));
  let res = null;
  let serverOk = true;
  if (id) {
    try {
      res = await deps.api("DELETE", "/api/push/subscriptions/" + encodeURIComponent(id));
    } catch {
      res = null;
    }
    serverOk = !!res && (res.ok || res.status === 404);
  }
  const done = browserOk && serverOk;
  if (done) {
    writeDeviceId(deps.storage, null);
    writeId(deps.storage, PUSH_OFF_PENDING_KEY, null);
  }
  return { done, res };
}

/**
 * Abgleich nach dem Laden der Seite (also auch nach einer neuen Anmeldung):
 * Hat der Browser ein Abo und kennt die Seite ihr Gerät, meldet sie das
 * aktuelle Abo an den Server (etwa nach einem Abo-Wechsel, den der Service
 * Worker nicht melden konnte). Kennt der Server das Gerät nicht mehr, meldet
 * sich die Seite auch beim Browser ab. Steht ein Ausschalten aus, wird es
 * nachgeholt ("off" oder "failed"). Ergebnis: "synced", "removed", "off",
 * "skipped" oder "failed". Wirft nie.
 */
async function syncPushSubscription(deps) {
  const id = readDeviceId(deps.storage);
  if (!id) return "skipped";
  if (readPendingOff(deps.storage)) return (await turnOffDevice(deps, id)).done ? "off" : "failed";
  const subscription = await currentSubscription(deps.win);
  if (!subscription) return "skipped";
  try {
    const res = await deps.api("POST", "/api/push/subscriptions", { subscription: subscriptionBody(subscription), id });
    if (res.status === 404 && res.data && res.data.removed) {
      writeDeviceId(deps.storage, null);
      // Scheitert das, bleibt es beim Browser; „An" abonniert trotzdem frisch
      await dropBrowserSubscription(subscription);
      return "removed";
    }
    return res.ok ? "synced" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Reiter „Benachrichtigungen". deps: api(method, path, body) wie in app.js,
 * win (window), storage (localStorage), render() zum Neuzeichnen,
 * h(tag, props, children) und sectionNode(id, title, hints, children) aus settings.js.
 */
function createPushSettings(deps) {
  const win = deps.win;
  const storage = deps.storage;
  const state = {
    phase: "idle",
    data: null,
    error: null,
    seq: 0,
    subscribed: false,
    deviceId: readDeviceId(storage),
    pendingOff: false,
    busy: null,
    message: null,
    renaming: null,
    confirmRemove: null,
    rowError: null,
    /** Fehler beim Speichern eines Schalters: { key, text } */
    settingError: null,
  };

  function render() {
    if (typeof deps.render === "function") deps.render();
  }

  function errorOf(res, fallback) {
    return res && res.data && typeof res.data.error === "string" && res.data.error ? res.data.error : fallback;
  }

  async function load() {
    const seq = ++state.seq;
    state.phase = state.data ? "ready" : "loading";
    state.error = null;
    render();
    let res;
    try {
      res = await deps.api("GET", "/api/push");
    } catch {
      if (seq !== state.seq) return;
      state.phase = state.data ? "ready" : "failed";
      state.error = PUSH_TEXT.loadFailed;
      render();
      return;
    }
    if (seq !== state.seq) return;
    if (!res.ok || !res.data) {
      state.phase = state.data ? "ready" : "failed";
      state.error = errorOf(res, PUSH_TEXT.loadFailed);
      render();
      return;
    }
    const subscription = await currentSubscription(win);
    if (seq !== state.seq) return;
    state.data = res.data;
    state.deviceId = readDeviceId(storage);
    state.pendingOff = !!readPendingOff(storage);
    const known = state.deviceId && (res.data.devices || []).some(d => d.id === state.deviceId);
    if (state.pendingOff) {
      // Ausschalten steht aus: weiter „An" zeigen, bis „Aus" oder der Abgleich es erledigt
      if (!known && !subscription) {
        writeDeviceId(storage, null);
        writeId(storage, PUSH_OFF_PENDING_KEY, null);
        state.deviceId = null;
        state.pendingOff = false;
        state.subscribed = false;
      } else {
        state.subscribed = true;
        state.message = { kind: "error", text: PUSH_TEXT.offFailed };
      }
    } else if (state.deviceId && !known && res.data.available) {
      // Auf einem anderen Gerät entfernt: auch beim Browser abmelden, nicht still neu anlegen
      writeDeviceId(storage, null);
      state.deviceId = null;
      // Scheitert das, abonniert „An" trotzdem frisch
      await dropBrowserSubscription(subscription);
      state.message = { kind: "hint", text: PUSH_TEXT.removed };
      state.subscribed = false;
    } else {
      state.subscribed = !!(subscription && known);
    }
    state.phase = "ready";
    render();
  }

  async function enable() {
    if (state.busy || !state.data || !state.data.publicKey) return;
    state.busy = "on";
    state.message = null;
    render();
    try {
      let permission = win.Notification.permission;
      // Nur hier, nach dem Tipp auf „An"
      if (permission !== "granted") permission = await win.Notification.requestPermission();
      if (permission !== "granted") {
        state.message = permission === "denied" ? null : { kind: "hint", text: PUSH_TEXT.permissionDismissed };
        return;
      }
      const registration = (await pushRegistration(win)) || (win.navigator.serviceWorker ? await win.navigator.serviceWorker.ready : null);
      if (!registration || !registration.pushManager) {
        state.message = { kind: "error", text: PUSH_TEXT.subscribeFailed };
        return;
      }
      const subscribe = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(state.data.publicKey) });
      /** Altes Abo verwerfen und frisch abonnieren; wirft, wenn der Browser das alte behält */
      const fresh = async old => {
        if (!(await dropBrowserSubscription(old))) throw new Error("altes Abo bleibt");
        return subscribe();
      };
      // Kennt der Server dieses Gerät noch, bleibt es dasselbe (Name, Einstellungen); sonst neu
      const known = state.deviceId && (state.data.devices || []).some(d => d.id === state.deviceId);
      let subscription = await registration.pushManager.getSubscription();
      // Ohne bekanntes Gerät kann ein vorhandenes Abo abgelaufen sein (404, 410): nie weiterverwenden
      if (!subscription) subscription = await subscribe();
      else if (!known) subscription = await fresh(subscription);
      const body = { subscription: subscriptionBody(subscription) };
      if (known) body.id = state.deviceId;
      let res;
      try {
        res = await deps.api("POST", "/api/push/subscriptions", body);
      } catch {
        state.message = { kind: "error", text: PUSH_TEXT.offline };
        return;
      }
      if (known && res.status === 404) {
        subscription = await fresh(subscription);
        try {
          res = await deps.api("POST", "/api/push/subscriptions", { subscription: subscriptionBody(subscription) });
        } catch {
          state.message = { kind: "error", text: PUSH_TEXT.offline };
          return;
        }
      }
      if (!res.ok || !res.data || !res.data.device) {
        state.message = { kind: "error", text: errorOf(res, PUSH_TEXT.subscribeFailed) };
        return;
      }
      writeDeviceId(storage, res.data.device.id);
      writeId(storage, PUSH_OFF_PENDING_KEY, null);
      state.deviceId = res.data.device.id;
      state.pendingOff = false;
      state.subscribed = true;
      upsertDevice(res.data.device);
    } catch {
      state.message = { kind: "error", text: PUSH_TEXT.subscribeFailed };
    } finally {
      state.busy = null;
      render();
    }
  }

  async function disable() {
    if (state.busy) return;
    state.busy = "off";
    state.message = null;
    render();
    const id = state.deviceId;
    try {
      const { done, res } = await turnOffDevice({ api: deps.api, win, storage }, id);
      if (res && (res.ok || res.status === 404)) dropDevice(id);
      if (done) {
        state.deviceId = null;
        state.pendingOff = false;
        state.subscribed = false;
      } else {
        // Bleibt „An" und gemerkt: noch einmal „Aus" oder der Abgleich nach dem Neuladen
        state.pendingOff = !!id;
        state.subscribed = true;
        const reason = res && !res.ok && res.status !== 404 ? errorOf(res, "") : "";
        state.message = { kind: "error", text: reason ? PUSH_TEXT.offFailed + " (" + reason + ")" : PUSH_TEXT.offFailed };
      }
    } finally {
      state.busy = null;
      render();
    }
  }

  async function sendTest() {
    if (state.busy || !state.deviceId) return;
    state.busy = "test";
    state.message = null;
    render();
    try {
      // Das aktuelle Abo mitschicken: der Server sagt dann, ob genau dieses abgelaufen ist
      const id = state.deviceId;
      const tested = await currentSubscription(win);
      const endpoint = tested ? subscriptionBody(tested).endpoint : null;
      const body = { id };
      if (typeof endpoint === "string") body.endpoint = endpoint;
      const res = await deps.api("POST", "/api/push/test", body);
      if (res.ok) state.message = { kind: "ok", text: PUSH_TEXT.testSent };
      else {
        state.message = { kind: "error", text: errorOf(res, PUSH_TEXT.subscribeFailed) };
        if (res.data && res.data.removed === true) {
          // Der Server hat das Gerät entfernt; „An" abonniert dann frisch
          dropDevice(id);
          if (state.deviceId === id) {
            writeDeviceId(storage, null);
            state.deviceId = null;
            state.subscribed = false;
          }
          // Beim Browser nur das abgelaufene Abo verwerfen, nie ein inzwischen erneuertes
          const now = await currentSubscription(win);
          if (res.data.subscriptionGone === true && now && subscriptionBody(now).endpoint === endpoint) {
            await dropBrowserSubscription(now);
          }
        }
      }
    } catch {
      state.message = { kind: "error", text: PUSH_TEXT.offline };
    } finally {
      state.busy = null;
      render();
    }
  }

  async function rename() {
    const r = state.renaming;
    if (!r || r.busy || !state.deviceId) return;
    const name = String(r.input || "").replace(/\s+/g, " ").trim();
    if (!name || [...name].length > PUSH_NAME_MAX || /\p{Cc}/u.test(name)) {
      r.error = PUSH_TEXT.nameInvalid;
      render();
      return;
    }
    r.busy = true;
    r.error = null;
    render();
    try {
      const res = await deps.api("PATCH", "/api/push/subscriptions/" + encodeURIComponent(state.deviceId), { name });
      if (res.ok && res.data && res.data.device) {
        upsertDevice(res.data.device);
        state.renaming = null;
      } else {
        r.error = errorOf(res, PUSH_TEXT.nameInvalid);
      }
    } catch {
      r.error = PUSH_TEXT.offline;
    } finally {
      if (state.renaming) state.renaming.busy = false;
      render();
    }
  }

  /** Einen Schalter dieses Geräts ändern; sofort gespeichert */
  async function saveSetting(key, value) {
    if (state.busy || !state.deviceId || !PUSH_SETTINGS.some(s => s.key === key)) return;
    state.busy = "setting:" + key;
    state.settingError = null;
    render();
    try {
      const res = await deps.api("PATCH", "/api/push/subscriptions/" + encodeURIComponent(state.deviceId), { settings: { [key]: value } });
      if (res.ok && res.data && res.data.device) upsertDevice(res.data.device);
      else state.settingError = { key, text: errorOf(res, PUSH_TEXT.settingFailed) };
    } catch {
      state.settingError = { key, text: PUSH_TEXT.offline };
    } finally {
      state.busy = null;
      render();
    }
  }

  async function removeOther(id) {
    if (state.busy) return;
    state.busy = "remove:" + id;
    state.rowError = null;
    render();
    try {
      const res = await deps.api("DELETE", "/api/push/subscriptions/" + encodeURIComponent(id));
      if (res.ok || res.status === 404) dropDevice(id);
      else state.rowError = { id, text: errorOf(res, PUSH_TEXT.offline) };
    } catch {
      state.rowError = { id, text: PUSH_TEXT.offline };
    } finally {
      state.busy = null;
      state.confirmRemove = null;
      render();
    }
  }

  function upsertDevice(device) {
    if (!state.data) return;
    const list = (state.data.devices || []).filter(d => d.id !== device.id);
    list.push(device);
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    state.data.devices = list;
  }

  function dropDevice(id) {
    if (state.data) state.data.devices = (state.data.devices || []).filter(d => d.id !== id);
  }

  // --- Anzeige ----------------------------------------------------------------

  function when(iso) {
    if (!iso) return PUSH_TEXT.never;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return PUSH_TEXT.never;
    return "zuletzt erreicht " + date.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function switchNode(h, on, disabled) {
    return segmentNode(h, "push-switch-label", "push", on, disabled, value => void (value ? enable() : disable()));
  }

  /** Segment-Steuerung An / Aus wie „Bei /board dabei" */
  function segmentNode(h, labelId, focusPrefix, on, disabled, pick) {
    const choices = [{ on: true, key: "on", label: "An" }, { on: false, key: "off", label: "Aus" }];
    const group = h("div", { className: "theme-switch settings-switch", role: "radiogroup", "aria-labelledby": labelId });
    choices.forEach((c, index) => {
      const checked = on === c.on;
      const button = h("button", {
        type: "button",
        className: "theme-option",
        role: "radio",
        "aria-checked": checked ? "true" : "false",
        tabindex: checked ? "0" : "-1",
        "data-focus-key": focusPrefix + ":" + c.key,
        disabled,
        text: c.label,
      });
      button.addEventListener("click", () => {
        if (c.on !== on) pick(c.on);
      });
      button.addEventListener("keydown", event => {
        let next = null;
        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) next = choices[(index + 1) % choices.length];
        else if (event.key === "Home") next = choices[0];
        else if (event.key === "End") next = choices[choices.length - 1];
        else if (event.key === " ") next = c;
        if (!next) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (next.on !== on) pick(next.on);
      });
      group.appendChild(button);
    });
    return group;
  }

  function messageNode(h) {
    const m = state.message;
    if (!m) return null;
    if (m.kind === "error") return h("p", { className: "actions-error", role: "alert", text: m.text });
    if (m.kind === "ok") return h("p", { className: "settings-status", role: "status", text: m.text });
    return h("p", { className: "actions-hint", role: "status", text: m.text });
  }

  /** Erklärung statt totem Schalter */
  function explainNodes(h, view) {
    if (view === "server-off") return [h("p", { className: "actions-hint", "data-push-state": view, text: String(state.data.reason || PUSH_TEXT.unsupported) })];
    if (view === "insecure") return [h("p", { className: "actions-hint", "data-push-state": view, text: PUSH_TEXT.insecure })];
    if (view === "ios-install") return [h("p", { className: "actions-hint", "data-push-state": view, text: PUSH_TEXT.ios })];
    if (view === "unsupported") return [h("p", { className: "actions-hint", "data-push-state": view, text: PUSH_TEXT.unsupported })];
    // denied
    const steps = h("ul", { className: "settings-push-steps" }, PUSH_TEXT.deniedSteps.map(s => h("li", { text: s })));
    return [
      h("p", { className: "actions-hint", "data-push-state": view, text: PUSH_TEXT.denied }),
      steps,
      h("p", { className: "actions-hint", text: PUSH_TEXT.deniedAfter }),
    ];
  }

  function thisDeviceNodes(h, view) {
    const on = view === "on";
    const busy = !!state.busy;
    const nodes = [
      h("p", { className: "settings-label", id: "push-switch-label", text: "Benachrichtigungen" }),
      h("div", { className: "settings-actions" }, [
        switchNode(h, on, busy),
        state.busy === "on" || state.busy === "off" ? h("p", { className: "settings-status", role: "status", text: "Einen Moment …" }) : null,
      ]),
      h("p", { className: "actions-hint", "data-push-state": view, text: on ? PUSH_TEXT.on : PUSH_TEXT.off }),
    ];
    const device = on && state.data ? (state.data.devices || []).find(d => d.id === state.deviceId) : null;
    if (device) {
      if (state.renaming) {
        const r = state.renaming;
        const input = h("input", {
          type: "text",
          className: "settings-input",
          id: "push-device-name",
          maxlength: String(PUSH_NAME_MAX),
          "data-focus-key": "push:name",
          value: r.input,
          disabled: r.busy,
          "aria-invalid": r.error ? "true" : null,
        });
        input.addEventListener("input", () => {
          r.input = input.value;
        });
        input.addEventListener("keydown", event => {
          if (event.key === "Enter") void rename();
          if (event.key === "Escape") {
            state.renaming = null;
            render();
          }
        });
        const save = h("button", { type: "button", className: "primary-button", "data-focus-key": "push:name-save", disabled: r.busy, text: "Speichern" });
        save.addEventListener("click", () => void rename());
        const cancel = h("button", { type: "button", className: "quiet-button", disabled: r.busy, text: "Abbrechen" });
        cancel.addEventListener("click", () => {
          state.renaming = null;
          render();
        });
        nodes.push(h("div", { className: "settings-field" }, [
          h("label", { className: "settings-label", for: "push-device-name", text: "Name dieses Geräts" }),
          input,
          h("div", { className: "settings-actions" }, [save, cancel]),
          r.error ? h("p", { className: "actions-error", role: "alert", text: r.error }) : null,
        ]));
      } else {
        const renameButton = h("button", { type: "button", className: "quiet-button", "data-focus-key": "push:rename", disabled: busy, text: "Umbenennen" });
        renameButton.addEventListener("click", () => {
          state.renaming = { input: device.name, busy: false, error: null };
          render();
          if (typeof document !== "undefined" && typeof document.querySelector === "function") {
            const field = document.querySelector('[data-focus-key="push:name"]');
            if (field && typeof field.focus === "function") field.focus();
          }
        });
        nodes.push(h("ul", { className: "settings-devices" }, [
          h("li", { "data-device": "this" }, [
            h("span", { className: "settings-device-name" }, [
              h("span", { text: device.name }),
              h("span", { className: "settings-device-meta", text: when(device.lastOkAt) }),
            ]),
            renameButton,
          ]),
        ]));
      }
      const test = h("button", { type: "button", className: "quiet-button settings-push-test", "data-focus-key": "push:test", disabled: busy, text: state.busy === "test" ? "Wird gesendet …" : "Test senden" });
      test.addEventListener("click", () => void sendTest());
      nodes.push(h("div", { className: "settings-actions" }, [test]));
      nodes.push(...settingsNodes(h, device, busy));
    }
    return nodes;
  }

  /** Was sich auf diesem Gerät meldet (Issue #226): je Schalter Label, An / Aus, Erklärung */
  function settingsNodes(h, device, busy) {
    const settings = device.settings || {};
    const rows = PUSH_SETTINGS.map(s => {
      const labelId = "push-setting-" + s.key;
      const error = state.settingError && state.settingError.key === s.key ? state.settingError.text : null;
      return h("div", { className: "settings-field", "data-push-setting": s.key }, [
        h("p", { className: "settings-label", id: labelId, text: s.label }),
        h("div", { className: "settings-actions" }, [
          segmentNode(h, labelId, "push-setting:" + s.key, settings[s.key] === true, busy, value => void saveSetting(s.key, value)),
          state.busy === "setting:" + s.key ? h("p", { className: "settings-status", role: "status", text: "Einen Moment …" }) : null,
        ]),
        h("p", { className: "actions-hint", text: s.hint }),
        error ? h("p", { className: "actions-error", role: "alert", text: error }) : null,
      ]);
    });
    return [
      h("p", { className: "settings-label settings-push-categories", text: PUSH_TEXT.categories }),
      h("p", { className: "actions-hint", text: PUSH_TEXT.categoriesHint }),
      ...rows,
    ];
  }

  function othersNodes(h) {
    const others = ((state.data && state.data.devices) || []).filter(d => d.id !== state.deviceId);
    if (!others.length) return [h("p", { className: "actions-hint", text: PUSH_TEXT.noOthers })];
    const list = h("ul", { className: "settings-devices" });
    for (const d of others) {
      const confirming = state.confirmRemove === d.id;
      const row = h("li", { "data-device": d.id }, [
        h("span", { className: "settings-device-name" }, [
          h("span", { text: d.name }),
          h("span", { className: "settings-device-meta", text: when(d.lastOkAt) }),
        ]),
      ]);
      if (confirming) {
        const yes = h("button", { type: "button", className: "quiet-button settings-device-confirm", "data-focus-key": "push:remove-yes:" + d.id, disabled: !!state.busy, text: "Entfernen" });
        yes.addEventListener("click", () => void removeOther(d.id));
        const no = h("button", { type: "button", className: "quiet-button", "data-focus-key": "push:remove-no:" + d.id, disabled: !!state.busy, text: "Abbrechen" });
        no.addEventListener("click", () => {
          state.confirmRemove = null;
          render();
        });
        row.appendChild(h("span", { className: "settings-device-actions" }, [h("span", { className: "actions-question", text: "Entfernen?" }), yes, no]));
      } else {
        const remove = h("button", { type: "button", className: "quiet-button", "data-focus-key": "push:remove:" + d.id, disabled: !!state.busy, text: "Entfernen" });
        remove.addEventListener("click", () => {
          state.confirmRemove = d.id;
          render();
          if (typeof document !== "undefined" && typeof document.querySelector === "function") {
            const target = document.querySelector('[data-focus-key="push:remove-no:' + d.id + '"]');
            if (target && typeof target.focus === "function") target.focus();
          }
        });
        row.appendChild(remove);
      }
      if (state.rowError && state.rowError.id === d.id) row.appendChild(h("p", { className: "actions-error", role: "alert", text: state.rowError.text }));
      list.appendChild(row);
    }
    return [list];
  }

  function nodes() {
    const h = deps.h;
    if (!state.data) {
      if (state.phase === "failed") {
        const retry = h("button", { type: "button", className: "quiet-button", text: "Erneut laden" });
        retry.addEventListener("click", () => void load());
        return [h("p", { className: "actions-error", role: "alert", text: state.error || PUSH_TEXT.loadFailed }), retry];
      }
      return [h("p", { className: "settings-empty", text: "Lädt …" })];
    }
    const env = pushEnvironment(win);
    const view = pushViewState(env, !!state.data.available, state.subscribed && !!state.deviceId);
    const own = view === "on" || view === "off" ? thisDeviceNodes(h, view) : explainNodes(h, view);
    const out = [
      h("p", { className: "settings-intro", text: PUSH_TEXT.intro }),
      state.error ? h("p", { className: "actions-error", role: "alert", text: state.error }) : null,
      deps.sectionNode("push-this", "Benachrichtigungen auf diesem Gerät", [], [...own, messageNode(h)]),
    ];
    if (state.data.available) out.push(deps.sectionNode("push-others", PUSH_TEXT.otherDevices, [], othersNodes(h)));
    return out.filter(Boolean);
  }

  function open() {
    state.message = null;
    state.renaming = null;
    state.confirmRemove = null;
    state.rowError = null;
    state.settingError = null;
    void load();
  }

  function isBusy() {
    return !!state.busy || !!(state.renaming && state.renaming.busy);
  }

  return { open, nodes, isBusy, state, load, enable, disable, sendTest, rename, removeOther, saveSetting };
}
