// Abschnitt „Eigene Stimme" im Reiter „Sprechen" (Issue #253, Entscheidung 0023).
//
// Ablauf: Hinweis in zwei Sätzen und Pflicht-Häkchen zur Einwilligung, dann
// eine Aufnahme in tybo (kein Datei-Upload, kein Dateidialog, kein Ziehen):
// ein vorgegebener Text zum Vorlesen, Aufnahme mit dem Mikrofon, Anhören,
// Wiederholen, Speichern. Die Aufnahme wird hier im Browser zu WAV (PCM 16
// Bit, mono, 24 kHz) und geht nur an POST /api/speech/voices mit consent=ja;
// ohne Häkchen öffnet tybo das Mikrofon gar nicht. Danach Probe mit dem
// Testsatz, „Als Stimme verwenden", Löschen.
//
// Das Mikrofon ist nur während der Aufnahme offen: Stopp, Verwerfen,
// Fehler, Verlassen des Reiters und Schließen der Einstellungen geben es
// frei. Geklonte Stimmen heißen „<Name> (KI-Stimme)".
//
// Reines JavaScript ohne Build; settings.js bindet es mit
// createVoiceCloneSettings({ api, win, render, h, sectionNode, changed }) ein.

/* exported createVoiceCloneSettings, voiceCloneWav, voiceCloneMono, voiceCloneResample, VOICE_CLONE_UI_TEXT */

const VOICE_CLONE_RATE = 24000;
const VOICE_CLONE_MAX_MS = 30000;
const VOICE_CLONE_MIN_MS = 5000;

const VOICE_CLONE_UI_TEXT = {
  title: "Eigene Stimme",
  intro: "Mit einer eigenen Stimme liest tybo im Sprechmodus mit deiner Stimme vor statt mit einer fertigen. Dafür liest du etwa 15 Sekunden Text vor; die Aufnahme bleibt nur auf diesem Rechner und wird nie an Telegram geschickt.",
  consentHint: "Ohne dieses Häkchen öffnet tybo das Mikrofon nicht und speichert nichts.",
  loading: "Eigene Stimmen werden geladen …",
  failed: "Eigene Stimmen ließen sich nicht laden.",
  none: "Noch keine eigene Stimme.",
  engineReady: "Klon-Engine: ",
  newTitle: "Neue Stimme aufnehmen",
  nameLabel: "Name der Stimme",
  readLabel: "Bitte laut vorlesen:",
  start: "Aufnahme starten",
  stop: "Stopp",
  discard: "Verwerfen",
  again: "Wiederholen",
  save: "Speichern",
  saving: "Wird gespeichert …",
  saved: "Gespeichert.",
  recording: "Aufnahme",
  requesting: "Mikrofon wird freigegeben …",
  listen: "Anhören:",
  tooShort: "Zu kurz: bitte mindestens 5 Sekunden vorlesen.",
  maxReached: "Längste Aufnahme erreicht (30 Sekunden), gestoppt.",
  needName: "Bitte einen Namen angeben.",
  noMic: "Aufnahme geht hier nicht: Der Browser bietet kein Mikrofon an (nur über HTTPS oder auf diesem Rechner).",
  micDenied: "Das Mikrofon ist nicht freigegeben. Bitte im Browser erlauben und noch einmal versuchen.",
  micFailed: "Das Mikrofon ließ sich nicht öffnen.",
  convertFailed: "Die Aufnahme ließ sich nicht umwandeln. Bitte noch einmal aufnehmen.",
  saveFailed: "Die Stimme ließ sich nicht speichern.",
  probe: "Probe anhören",
  probing: "Probe wird erzeugt …",
  probeFailed: "Die Probe ist fehlgeschlagen.",
  use: "Als Stimme verwenden",
  inUse: "Liest im Sprechmodus vor",
  chosen: "Gewählt, aber zum Vorlesen ist eine andere Stimme eingestellt",
  used: "Der Sprechmodus liest jetzt mit dieser Stimme vor.",
  useFailed: "Die Stimme ließ sich nicht einstellen.",
  remove: "Löschen",
  removeQuestion: "Löschen? Aufnahme, Text und Einwilligung werden entfernt.",
  removeConfirm: "Löschen",
  cancel: "Abbrechen",
  removeFailed: "Die Stimme ließ sich nicht löschen.",
  noEngine: "Ohne Klon-Engine lassen sich Stimmen aufnehmen, aber noch nicht anhören oder verwenden.",
};

/** Mehrkanal zu mono (Mittelwert); channels: Float32Array je Kanal */
function voiceCloneMono(channels) {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Linear auf eine andere Abtastrate umrechnen (reicht für eine Sprach-Referenz) */
function voiceCloneResample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = pos - left;
    out[i] = (samples[left] || 0) * (1 - frac) + (samples[right] || 0) * frac;
  }
  return out;
}

/** WAV aus Gleitkomma-Werten (-1 bis 1): PCM 16 Bit, mono, nur Kopf und Daten */
function voiceCloneWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function createVoiceCloneSettings(deps) {
  const win = deps.win;
  const T = VOICE_CLONE_UI_TEXT;
  const state = {
    phase: "idle",
    data: null,
    seq: 0,
    consent: false,
    name: "",
    rec: null,
    saving: false,
    error: "",
    notice: "",
    rows: new Map(),
    confirm: null,
    /** Audio-Elemente je Adresse: ein neues Zeichnen unterbricht das Abspielen nicht */
    audios: new Map(),
  };

  function audioFor(h, url, label) {
    let node = state.audios.get(url);
    if (!node) {
      node = h("audio", { className: "voice-clone-audio", controls: true, preload: "auto", src: url, "aria-label": label });
      state.audios.set(url, node);
    }
    return node;
  }

  function forgetUrl(url) {
    if (!url) return;
    state.audios.delete(url);
    try {
      win.URL.revokeObjectURL(url);
    } catch {
      // egal
    }
  }

  function render() {
    if (typeof deps.render === "function") deps.render();
  }

  function canRecord() {
    try {
      return !!(win.isSecureContext !== false && win.navigator && win.navigator.mediaDevices && typeof win.navigator.mediaDevices.getUserMedia === "function" && typeof win.MediaRecorder === "function");
    } catch {
      return false;
    }
  }

  function rowOf(id) {
    if (!state.rows.has(id)) state.rows.set(id, { busy: "", error: "", audio: "", notice: "" });
    return state.rows.get(id);
  }

  async function load() {
    const seq = ++state.seq;
    if (!state.data) state.phase = "loading";
    render();
    try {
      const res = await deps.api("GET", "/api/speech/voices");
      if (seq !== state.seq) return;
      if (res.ok && res.data && Array.isArray(res.data.voices)) {
        state.data = res.data;
        state.phase = "ok";
      } else if (!state.data) state.phase = "failed";
    } catch {
      if (seq !== state.seq) return;
      if (!state.data) state.phase = "failed";
    }
    render();
  }

  // --- Aufnahme ---------------------------------------------------------------

  function stopTracks(stream) {
    if (!stream) return;
    try {
      for (const track of stream.getTracks()) track.stop();
    } catch {
      // schon frei
    }
  }

  function releaseUrl(rec) {
    if (rec && rec.url) forgetUrl(rec.url);
  }

  /** Aufnahme beenden ohne Ergebnis: Mikrofon frei, Zeitgeber weg */
  function dropRecording() {
    const rec = state.rec;
    state.rec = null;
    if (!rec) return;
    rec.dropped = true;
    clearTimeout(rec.limit);
    clearInterval(rec.tick);
    try {
      if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
    } catch {
      // schon gestoppt
    }
    stopTracks(rec.stream);
    releaseUrl(rec);
  }

  function recordingFormat() {
    const MR = win.MediaRecorder;
    for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]) {
      try {
        if (typeof MR.isTypeSupported !== "function" || MR.isTypeSupported(type)) return type;
      } catch {
        // nächster
      }
    }
    return "";
  }

  async function startRecording() {
    // Ohne Einwilligung kein Mikrofon
    if (!state.consent || state.rec || state.saving || !canRecord()) return;
    dropRecording();
    state.error = "";
    state.notice = "";
    const rec = { phase: "requesting", stream: null, recorder: null, chunks: [], startedAt: 0, ms: 0, blob: null, url: "", limit: null, tick: null, dropped: false, maxReached: false };
    state.rec = rec;
    render();
    let stream;
    try {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch (err) {
      if (state.rec !== rec) return;
      state.rec = null;
      state.error = err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? T.micDenied : T.micFailed;
      render();
      return;
    }
    // Inzwischen verworfen, Häkchen entfernt oder Reiter verlassen: sofort wieder frei
    if (state.rec !== rec || rec.dropped || !state.consent) {
      stopTracks(stream);
      if (state.rec === rec) state.rec = null;
      render();
      return;
    }
    rec.stream = stream;
    try {
      const type = recordingFormat();
      const recorder = type ? new win.MediaRecorder(stream, { mimeType: type }) : new win.MediaRecorder(stream);
      rec.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!rec.dropped && event && event.data && event.data.size > 0) rec.chunks.push(event.data);
      };
      recorder.onstop = () => finishRecording(rec);
      recorder.start();
    } catch {
      dropRecording();
      state.error = T.micFailed;
      render();
      return;
    }
    rec.phase = "recording";
    rec.startedAt = Date.now();
    rec.limit = setTimeout(() => {
      rec.maxReached = true;
      stopRecording();
    }, VOICE_CLONE_MAX_MS);
    rec.tick = setInterval(() => {
      if (state.rec === rec && rec.phase === "recording") render();
    }, 1000);
    render();
  }

  function stopRecording() {
    const rec = state.rec;
    if (!rec || rec.phase !== "recording") return;
    rec.ms = Date.now() - rec.startedAt;
    rec.phase = "stopping";
    clearTimeout(rec.limit);
    clearInterval(rec.tick);
    try {
      rec.recorder.stop();
    } catch {
      finishRecording(rec);
    }
    stopTracks(rec.stream);
    render();
  }

  function finishRecording(rec) {
    stopTracks(rec.stream);
    if (rec.dropped || state.rec !== rec) return;
    rec.phase = "done";
    rec.blob = new win.Blob(rec.chunks, { type: rec.recorder && rec.recorder.mimeType ? rec.recorder.mimeType : "audio/webm" });
    try {
      rec.url = win.URL.createObjectURL(rec.blob);
    } catch {
      rec.url = "";
    }
    if (rec.maxReached) state.notice = T.maxReached;
    else if (rec.ms < VOICE_CLONE_MIN_MS) state.notice = T.tooShort;
    render();
  }

  /** Aufnahme zu WAV (24 kHz mono PCM16): dekodieren, mischen, umrechnen */
  async function toWav(blob) {
    const Ctx = win.AudioContext || win.webkitAudioContext;
    if (typeof Ctx !== "function") throw new Error("kein AudioContext");
    const ctx = new Ctx();
    try {
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      const channels = [];
      for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
      return voiceCloneWav(voiceCloneResample(voiceCloneMono(channels), buffer.sampleRate, VOICE_CLONE_RATE), VOICE_CLONE_RATE);
    } finally {
      try {
        await ctx.close();
      } catch {
        // egal
      }
    }
  }

  async function save() {
    const rec = state.rec;
    const name = state.name.trim();
    if (!rec || rec.phase !== "done" || state.saving) return;
    if (!state.consent) return;
    if (!name) {
      state.error = T.needName;
      render();
      return;
    }
    state.saving = true;
    state.error = "";
    state.notice = "";
    render();
    try {
      let wav;
      try {
        wav = await toWav(rec.blob);
      } catch {
        state.error = T.convertFailed;
        return;
      }
      // Während des Umrechnens Häkchen entfernt, verworfen oder Reiter verlassen: kein Upload
      if (state.rec !== rec || rec.dropped || !state.consent) return;
      const res = await win.fetch("/api/speech/voices?name=" + encodeURIComponent(name) + "&consent=ja", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        // keine JSON-Antwort
      }
      if (!res.ok) {
        state.error = data && typeof data.error === "string" ? data.error : T.saveFailed;
        return;
      }
      dropRecording();
      state.name = "";
      state.notice = T.saved;
      await load();
    } catch {
      state.error = T.saveFailed;
    } finally {
      state.saving = false;
      render();
    }
  }

  // --- Stimmen ----------------------------------------------------------------

  async function probe(id) {
    const row = rowOf(id);
    if (row.busy) return;
    row.busy = "probe";
    row.error = "";
    row.notice = "";
    forgetUrl(row.audio);
    row.audio = "";
    render();
    try {
      const res = await win.fetch("/api/speech/voices/" + encodeURIComponent(id) + "/probe", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch {
          // keine JSON-Antwort
        }
        row.error = data && typeof data.error === "string" ? data.error + "." : T.probeFailed;
        return;
      }
      const blob = await res.blob();
      row.audio = win.URL.createObjectURL(blob);
      row.autoplay = true;
    } catch {
      row.error = T.probeFailed;
    } finally {
      row.busy = "";
      render();
    }
  }

  async function use(id) {
    const row = rowOf(id);
    if (row.busy) return;
    row.busy = "use";
    row.error = "";
    render();
    try {
      const res = await deps.api("POST", "/api/speech/voices/" + encodeURIComponent(id) + "/use", {});
      if (!res.ok) row.error = res.data && typeof res.data.error === "string" ? res.data.error + "." : T.useFailed;
      else {
        row.notice = T.used;
        if (typeof deps.changed === "function") deps.changed();
        await load();
      }
    } catch {
      row.error = T.useFailed;
    } finally {
      row.busy = "";
      render();
    }
  }

  async function remove(id) {
    const row = rowOf(id);
    if (row.busy) return;
    row.busy = "remove";
    row.error = "";
    render();
    try {
      const res = await deps.api("DELETE", "/api/speech/voices/" + encodeURIComponent(id));
      if (!res.ok && res.status !== 404) {
        row.error = T.removeFailed;
        return;
      }
      state.confirm = null;
      forgetUrl(row.audio);
      state.rows.delete(id);
      if (typeof deps.changed === "function") deps.changed();
      await load();
    } catch {
      row.error = T.removeFailed;
    } finally {
      row.busy = "";
      render();
    }
  }

  // --- Anzeige ----------------------------------------------------------------

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function dateText(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "numeric", year: "numeric" });
  }

  function voiceRow(h, v, engineReady, inUse) {
    const row = rowOf(v.id);
    const meta = [dateText(v.createdAt) ? "aufgenommen am " + dateText(v.createdAt) : "", Math.round(v.seconds) + " s"].filter(Boolean).join(", ");
    const status = v.active ? (inUse ? T.inUse : T.chosen) : "";
    const name = h("span", { className: "settings-device-name" }, [
      h("span", { className: "voice-clone-name", text: v.label }),
      h("span", { className: "settings-device-meta", text: meta }),
      status ? h("span", { className: "settings-device-meta", "data-voice-active": "true", text: status }) : null,
    ].filter(Boolean));
    const actions = h("span", { className: "settings-device-actions" });
    if (state.confirm === v.id) {
      actions.appendChild(h("span", { className: "actions-question", text: T.removeQuestion }));
      const yes = h("button", { type: "button", className: "quiet-button settings-device-confirm", "data-focus-key": "voice-clone:remove-yes:" + v.id, disabled: row.busy === "remove", text: T.removeConfirm });
      yes.addEventListener("click", () => void remove(v.id));
      const no = h("button", { type: "button", className: "quiet-button", "data-focus-key": "voice-clone:remove-no:" + v.id, text: T.cancel });
      no.addEventListener("click", () => {
        state.confirm = null;
        render();
      });
      actions.append(yes, no);
    } else {
      const probeButton = h("button", { type: "button", className: "quiet-button", "data-focus-key": "voice-clone:probe:" + v.id, disabled: !engineReady || !!row.busy, text: row.busy === "probe" ? T.probing : T.probe });
      probeButton.addEventListener("click", () => void probe(v.id));
      const useButton = h("button", { type: "button", className: "quiet-button", "data-focus-key": "voice-clone:use:" + v.id, disabled: !engineReady || !!row.busy || (v.active && inUse), text: T.use });
      useButton.addEventListener("click", () => void use(v.id));
      const removeButton = h("button", { type: "button", className: "quiet-button", "data-focus-key": "voice-clone:remove:" + v.id, disabled: !!row.busy, text: T.remove });
      removeButton.addEventListener("click", () => {
        state.confirm = v.id;
        render();
      });
      actions.append(probeButton, useButton, removeButton);
    }
    const li = h("li", { "data-voice-id": v.id }, [name, actions]);
    if (row.audio) {
      const audio = audioFor(h, row.audio, "Probe von " + v.label);
      if (row.autoplay) {
        row.autoplay = false;
        try {
          const p = audio.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
          // Abspielen nur nach Tipp: die Steuerung steht da
        }
      }
      li.appendChild(audio);
    }
    if (row.notice) li.appendChild(h("p", { className: "settings-status", role: "status", text: row.notice }));
    if (row.error) li.appendChild(h("p", { className: "actions-error", role: "alert", text: row.error }));
    return li;
  }

  function recorderNodes(h) {
    const nodes = [];
    const rec = state.rec;
    const texts = state.data && state.data.texts ? state.data.texts : null;
    const blocked = !state.consent;
    // Pflicht-Häkchen
    const box = h("input", { type: "checkbox", id: "voice-clone-consent", "data-focus-key": "voice-clone:consent", "aria-describedby": "voice-clone-consent-hint" });
    box.checked = state.consent;
    box.addEventListener("change", () => {
      state.consent = !!box.checked;
      // Häkchen weg: eine laufende oder fertige Aufnahme ist verworfen, das Mikrofon frei
      if (!state.consent) dropRecording();
      render();
    });
    nodes.push(h("label", { className: "setup-check voice-clone-consent", for: "voice-clone-consent" }, [box, h("span", { text: texts ? texts.consent : "" })]));
    nodes.push(h("p", { className: "actions-hint", id: "voice-clone-consent-hint", text: T.consentHint }));
    if (blocked) return nodes;

    const nameInput = h("input", { type: "text", id: "voice-clone-name", className: "settings-input", maxlength: "40", autocomplete: "off", "data-focus-key": "voice-clone:name", disabled: state.saving });
    nameInput.value = state.name;
    nameInput.addEventListener("input", () => {
      state.name = nameInput.value;
    });
    nodes.push(h("div", { className: "settings-field" }, [h("label", { className: "settings-label", for: "voice-clone-name", text: T.nameLabel }), nameInput]));
    nodes.push(h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", text: T.readLabel }),
      h("blockquote", { className: "voice-clone-reading", text: texts ? texts.reading : "" }),
    ]));

    if (!canRecord()) {
      nodes.push(h("p", { className: "actions-hint", "data-voice-clone": "no-mic", text: T.noMic }));
      return nodes;
    }
    if (!rec) {
      const start = h("button", { type: "button", className: "primary-button voice-clone-start", "data-focus-key": "voice-clone:start", disabled: state.saving, text: T.start });
      start.addEventListener("click", () => void startRecording());
      nodes.push(h("div", { className: "settings-actions" }, [start]));
    } else if (rec.phase === "requesting" || rec.phase === "recording" || rec.phase === "stopping") {
      const elapsed = rec.phase === "recording" ? Date.now() - rec.startedAt : rec.ms;
      const stop = h("button", { type: "button", className: "recorder-button recorder-stop", "data-focus-key": "voice-clone:stop", disabled: rec.phase !== "recording", text: T.stop });
      stop.addEventListener("click", () => stopRecording());
      const discard = h("button", { type: "button", className: "recorder-button", "data-focus-key": "voice-clone:discard", text: T.discard });
      discard.addEventListener("click", () => {
        dropRecording();
        render();
      });
      nodes.push(h("div", { className: "voice-clone-recorder", role: "status" }, [
        rec.phase === "requesting" ? null : h("span", { className: "recorder-dot", "aria-hidden": "true" }),
        h("span", { className: "recorder-label", text: rec.phase === "requesting" ? T.requesting : T.recording }),
        rec.phase === "requesting" ? null : h("span", { className: "recorder-time", text: clock(elapsed) }),
        discard,
        stop,
      ].filter(Boolean)));
    } else {
      const tooShort = rec.ms < VOICE_CLONE_MIN_MS;
      if (rec.url) nodes.push(h("div", { className: "settings-field" }, [h("p", { className: "settings-label", text: T.listen }), audioFor(h, rec.url, "Aufnahme anhören")]));
      const again = h("button", { type: "button", className: "quiet-button", "data-focus-key": "voice-clone:again", disabled: state.saving, text: T.again });
      again.addEventListener("click", () => {
        dropRecording();
        void startRecording();
      });
      const saveButton = h("button", { type: "button", className: "primary-button", "data-focus-key": "voice-clone:save", disabled: state.saving || tooShort, text: state.saving ? T.saving : T.save });
      saveButton.addEventListener("click", () => void save());
      nodes.push(h("div", { className: "settings-actions" }, [saveButton, again]));
    }
    return nodes;
  }

  function nodes() {
    const h = deps.h;
    const children = [];
    const data = state.data;
    if (!data) {
      children.push(h("p", { className: state.phase === "failed" ? "actions-error" : "actions-hint", role: "status", text: state.phase === "failed" ? T.failed : T.loading }));
      return [deps.sectionNode("voice-clone", T.title, [T.intro], children)];
    }
    const engine = data.engine || { ready: false };
    children.push(h("p", { className: "actions-hint", "data-voice-engine": engine.ready ? "ready" : "missing", text: engine.ready ? T.engineReady + engine.label + (engine.note ? ". " + engine.note + "." : ".") : engine.reason || T.noEngine }));
    if (data.voices.length) {
      const list = h("ul", { className: "settings-devices voice-clone-list" });
      for (const v of data.voices) list.appendChild(voiceRow(h, v, !!engine.ready, !!data.inUse));
      children.push(list);
    } else children.push(h("p", { className: "actions-hint", text: T.none }));
    children.push(h("h4", { className: "settings-label", text: T.newTitle }));
    children.push(...recorderNodes(h));
    if (state.notice) children.push(h("p", { className: "settings-status", role: "status", text: state.notice }));
    if (state.error) children.push(h("p", { className: "actions-error", role: "alert", text: state.error }));
    return [deps.sectionNode("voice-clone", T.title, [T.intro], children)];
  }

  /** Beim Öffnen des Reiters: Stimmen frisch laden */
  function open() {
    void load();
  }

  /** Reiter verlassen oder Einstellungen geschlossen: Mikrofon frei, Aufnahme verworfen */
  function close() {
    dropRecording();
    state.confirm = null;
  }

  function isBusy() {
    return !!state.rec || state.saving;
  }

  return { nodes, open, close, isBusy, load, state };
}
