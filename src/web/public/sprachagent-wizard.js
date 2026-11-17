// Wizard für Sprachagenten (Issue #515): Oberfläche der fünf Schritte im
// Bereich /sprachagenten, unter #/neu und #/entwurf/<kennung>. Der Zustand
// (Pflichtfelder, Vorlagenwechsel, Speichern mit revision, Vorschlag) steht in
// sprachagent-wizard-state.js und ist dort ohne Browser geprüft; hier steht
// nur, was das DOM braucht. Gebaut wird mit textContent, nie mit HTML aus dem
// Server.
//
// - Der Entwurf entsteht, sobald eine gültige Kennung dasteht (entprellt beim
//   Tippen, spätestens mit „Weiter“ oder beim Verlassen) und reserviert sie.
//   Danach speichert jeder Schrittwechsel sofort und jede Änderung entprellt,
//   auch Satz und Kennung (umziehen per rename). Was davor getippt ist, etwa
//   nur der Satz, hält die Seite im Browser (localStorage) bis zum Anlegen.
// - Jeder Entwurf hat seinen eigenen Zustand (st). Speichern, Umziehen und
//   Anhänge lesen nur ihn, nie die gerade gezeigte Seite: Wer schließt oder
//   einen anderen Entwurf öffnet, während noch etwas läuft, schreibt nie in
//   einen fremden Entwurf, und das Offene wird trotzdem gespeichert.
// - Rückfragen (Stimmwahl, Freigabe, Trotzdem freischalten, Erneut versuchen)
//   beantwortet der Wizard nie selbst: Schritt 5 sagt, was offen ist, und
//   verlinkt den Direktchat.
// - Nach dem Bauen sind die Schritte 1 bis 4 nur zum Ansehen (fieldset
//   disabled), gespeichert wird nichts mehr.
// - Jede Ansicht hat eine Nummer (token): Antworten, die nach einem Wechsel
//   ankommen, ändern die neue Ansicht nicht.
"use strict";

const VA_WIZARD_UI = {
  titleNew: "Neuer Sprachagent",
  drafts: "Entwürfe",
  finished: "Zuletzt beendet",
  loading: "Wird geladen …",
  loadFailed: "Der Entwurf ließ sich nicht laden. Bitte später noch einmal versuchen.",
  gone: "Diesen Entwurf gibt es nicht (mehr).",
  notConfigured: "Den Wizard gibt es in diesem tybo nicht.",
  backList: "Alle Sprachagenten",
  stepOf: (n, total, title) => `Schritt ${n} von ${total}: ${title}`,
  next: "Weiter",
  back: "Zurück",
  build: "Bauen",
  building: "Wird gestartet …",
  discard: "Entwurf verwerfen",
  discardQuestion: (name) => `Entwurf ${name} verwerfen?`,
  discardHint: "Eingaben und Dateien werden gelöscht, die Kennung wird wieder frei.",
  discardConfirm: "Verwerfen",
  cancel: "Abbrechen",
  discarded: (name) => `Der Entwurf ${name} ist verworfen.`,
  readOnly: (kennung) => `Nur zum Ansehen: Der Sprachagent wird schon gebaut. Änderungen gehen danach im Chat mit /sprachagent aendern ${kennung}.`,
  fixedTitle: "Fest eingestellt",
  fixedHint: "Diese Regeln setzt tybo selbst. Sie lassen sich nicht abschalten.",
  // Schritt 1
  sentenceLabel: "Was soll der Sprachagent tun?",
  sentenceHelp: "Ein Satz genügt. Daraus füllt tybo die weiteren Schritte vor, Sie korrigieren nur noch.",
  sentencePlaceholder: "Zum Beispiel: Ein Trainer, mit dem ich Preisverhandlungen übe.",
  propose: "Vorschlag holen",
  proposing: "tybo überlegt, das dauert einige Sekunden …",
  proposalNeedsSentence: "Bitte zuerst den Satz schreiben.",
  proposalFailed: "Der Vorschlag ließ sich nicht holen. Sie können die Felder selbst ausfüllen.",
  proposalDone: "Vorschlag übernommen. Bitte prüfen und korrigieren.",
  templateLabel: "Vorlage",
  nameLabel: "Name",
  kennungLabel: "Kennung",
  kennungHelp: "Kleinbuchstaben, Ziffern und Bindestriche. Unter ihr finden Sie den Agenten später, etwa im Link zum Gespräch.",
  purposeLabel: "Zweck",
  purposeHelp: "Ein bis zwei Sätze, wofür der Agent da ist.",
  // Schritt 2
  voiceLegend: "Stimme",
  voiceStandard: "Standardstimme",
  voiceStandardHint: "aus den Einstellungen",
  voiceClone: "geklonte Stimme",
  voiceAccount: "Stimme Ihres Kontos",
  voicesLoading: "Die Stimmen werden geladen …",
  voicesFailed: "Die Stimmen ließen sich nicht laden.",
  retry: "Noch einmal laden",
  probe: "Hörprobe",
  probeOf: (name) => `Hörprobe von ${name}`,
  probeLoading: "Die Hörprobe wird geholt …",
  probeFailed: "Die Hörprobe ist nicht möglich. Bitte später noch einmal versuchen.",
  probePlaying: (name) => `Hörprobe: ${name}`,
  kiHint: "Damit beginnt jedes Gespräch. Die Hörprobe spricht genau diesen Satz.",
  // Schritt 3
  personaTitle: "Auftreten",
  roleLabel: "Rolle",
  roleHelp: "Wie der Agent auftritt, etwa „Kritischer Einkäufer“.",
  addressLabel: "Anrede",
  languageLabel: "Sprache",
  firstLabel: "Erster Satz",
  firstHelp: "Kommt direkt nach dem KI-Hinweis.",
  rulesLabel: "Eigene Regeln",
  rulesHelp: "Optional. Kurze Sätze, an die sich der Agent halten soll.",
  rulesAdd: "Regel hinzufügen",
  topicLabel: "Thema",
  topicHelp: "Was tybo für den Experten recherchieren soll.",
  rolesLabel: "Rollen",
  rolesHelp: "Wen der Experte spielen kann.",
  rolesAdd: "Rolle hinzufügen",
  objectionsLabel: "Einwände",
  objectionsHelp: "Womit er Sie im Gespräch fordert.",
  objectionsAdd: "Einwand hinzufügen",
  criteriaLabel: "Drei Kriterien",
  criteriaHelp: "Daran misst der Experte Ihr Gespräch. Es müssen genau drei sein.",
  criterion: (n) => `Kriterium ${n}`,
  filesLabel: "Dateien",
  filesHelp: "Bis zu fünf Dateien als Material für die Recherche: PDF bis 10 MB, Text oder Markdown bis 1 MB.",
  filesAdd: "Datei hinzufügen",
  filesNeedDraft: "Dateien lassen sich hinzufügen, sobald der Entwurf gespeichert ist.",
  fileUploading: (name) => `${name} wird hochgeladen …`,
  fileFailed: "Die Datei ließ sich nicht hochladen.",
  fileRemoveFailed: "Die Datei ließ sich nicht entfernen.",
  linksLabel: "Links",
  linksHelp: "Seiten, die tybo bei der Recherche lesen soll. Nur Adressen mit https.",
  linksAdd: "Link hinzufügen",
  questionsLabel: "Fragen an den Anrufer",
  questionsHelp: "Was der Agent von jedem Anrufer wissen will, höchstens acht.",
  questionsAdd: "Frage hinzufügen",
  closingLabel: "Abschlusssatz",
  closingHelp: (max) => `Der letzte Satz des Gesprächs, höchstens ${max} Zeichen.`,
  thinkLabel: "Denkauftrag",
  thinkCheck: "Schwierige Fragen zum Nachdenken an tybo weitergeben",
  thinkHelp: "Der Agent sagt dann, dass er kurz nachdenkt, und antwortet mit tybos Hilfe.",
  remove: "Entfernen",
  removeOf: (what) => `${what} entfernen`,
  // Schritt 4
  webCheck: "Im Browser sprechen",
  webHelp: "Sie sprechen auf einer eigenen Seite von tybo mit dem Agenten.",
  phoneCheck: "Per Telefon erreichbar",
  phoneHelp: "Braucht eine Telefonnummer in Ihrem Konto beim Anbieter.",
  numberLabel: "Kennung der Nummer beim Anbieter",
  numberHelp: "Das ist die Kennung, unter der der Anbieter Ihre Telefonnummer führt, keine Rufnummer. Sie steht in Ihrem Konto beim Anbieter bei den Telefonnummern.",
  callersLegend: "Wer anrufen darf",
  callersAllowed: "Nur freigegebene Anrufer",
  callersAll: "Alle Anrufer",
  pinCheck: "PIN verlangen",
  pinFixed: "Fest an: Mit vollem Gedächtnis am Telefon ist die PIN Pflicht.",
  costLabel: "Geschätzte Kosten",
  // Schritt 5
  summaryTitle: "Zusammenfassung",
  missingTitle: "Vor dem Bauen fehlt noch:",
  buildHint: "Beim Bauen schreibt tybo Rezept und Tests und legt den Agenten nach Ihrer Freigabe an. Rückfragen kommen in den Direktchat.",
  background: "Das läuft im Hintergrund weiter, Sie können die Seite schließen. tybo meldet sich im Direktchat.",
  progressTitle: "Stand",
  toChat: "Zum Direktchat",
  testsTitle: "Testergebnisse",
  talk: "Sprechen",
  noWeb: "Kein Gespräch im Browser: Der Web-Zugang ist aus.",
  notUnlocked: "Der Agent ist noch nicht freigeschaltet, deshalb gibt es hier kein „Sprechen“.",
  toAgent: "Zum Sprachagenten",
  changeHint: (kennung) => `Änderungen gehen jetzt im Chat mit /sprachagent aendern ${kennung}.`,
  aborted: "Der Entwurf wurde abgebrochen. Für einen neuen Anlauf legen Sie einen neuen Sprachagenten an.",
  progressFailed: "Der Stand ließ sich nicht abrufen. Die Seite versucht es weiter.",
  reason: (text) => `Grund: ${text}`,
  attempt: (n) => `Versuch ${n}`,
};

const VA_WIZARD_CHAT = "/#/gespraech/dm";
const VA_WIZARD_POLL_MS = 3000;
const VA_WIZARD_POLL_SLOW_MS = 10000;
const VA_WIZARD_ACCEPT = ".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown";
const VA_WIZARD_FILES_MAX = 5;
/** Wartezeit nach der letzten Eingabe, bevor ein neuer Entwurf angelegt oder umbenannt wird */
const VA_WIZARD_AUTO_MS = 800;
/** Eingaben eines neuen Entwurfs, solange es noch keine Kennung gibt */
const VA_WIZARD_LOCAL_KEY = "tybo-sprachagent-wizard-neu";

function vwEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * page: { doc, api(path, init), root, drafts, newButton, setTitle(text),
 * enter(), leaveToList(message) }. Liefert open(route), close(), list(current)
 * und hideList().
 */
function startVoiceAgentWizard(page) {
  const doc = page.doc;
  const root = page.root;
  let token = 0;
  let s = null;
  let pollTimer = null;
  let probeUrl = null;

  // --- Anfragen ---------------------------------------------------------------

  /** Fetch-Hülle für das Zustandsmodul: { status, body } */
  async function request(method, path, body) {
    const res = await page.api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(method === "PUT" ? { keepalive: true } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function uploadFile(path, name, bytes) {
    const res = await page.api(path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body: bytes });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  function stopPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function dropProbe() {
    if (probeUrl) window.URL.revokeObjectURL(probeUrl);
    probeUrl = null;
  }

  // --- Zustand ----------------------------------------------------------------

  function fresh() {
    return {
      kennung: "",
      savedKennung: null,
      kennungTouched: false,
      satz: "",
      schritt: 1,
      felder: {},
      view: null,
      phase: "wizard",
      touched: new Set(),
      dirty: new Set(),
      saver: null,
      fixedRules: null,
      buildError: null,
      voices: null,
      voicesState: "offen",
      progress: null,
      progressError: false,
      proposing: false,
      notice: { text: "", error: false },
      save: { text: "", error: false },
      errors: {},
      confirmDiscard: false,
      busy: false,
      upload: { text: "", error: false },
      probe: { text: "", error: false, name: "", key: "" },
      localId: Math.random().toString(36).slice(2),
      satzDirty: false,
      creating: null,
      createTimer: null,
      blockedKennung: "",
      renameTimer: null,
    };
  }

  const state = () => ({ schritt: s.schritt, kennung: s.kennung, felder: s.felder, phase: s.phase });
  const readOnly = () => vaWizardReadOnly({ phase: s.phase });
  const displayName = () => (s.felder && s.felder.name) || s.savedKennung || VA_WIZARD_UI.titleNew;

  /** Ansicht für Zusammenfassung und feste Regeln: letzter Stand des Servers, sonst der der Seite */
  function currentView() {
    return s.view || { kennung: s.kennung, felder: s.felder, feste: [], anhaenge: [], kosten: null };
  }

  /** Was gespeichert ist, gilt nicht mehr als offen; was seither getippt wurde, bleibt offen */
  function markSent(st, paths, sent, satz) {
    for (const path of paths) if (JSON.stringify(vaWizardGet(st.felder, path)) === JSON.stringify(vaWizardGet(sent, path))) st.dirty.delete(path);
    if (typeof satz === "string" && st.satz === satz) st.satzDirty = false;
  }

  /**
   * Saver an genau diesen Entwurf binden: Alles, was er liest und schreibt,
   * steht in st. Gezeichnet wird nur, solange st die gezeigte Seite ist.
   */
  function attachSaver(st, view) {
    st.savedKennung = view.kennung;
    // Beim Anlegen kann die Kennung auf der Seite schon weiter sein; dann zieht der Entwurf danach um
    if (!st.kennung) st.kennung = view.kennung;
    st.view = view;
    if (view.festeRegeln) st.fixedRules = view.festeRegeln;
    st.phase = view.phase || "wizard";
    st.saver = vaWizardSaver({
      kennung: view.kennung,
      revision: view.revision,
      request,
      upload: uploadFile,
      fields: () => st.felder,
      satz: () => st.satz,
      fixedRules: () => st.fixedRules,
      dirty: () => [...st.dirty],
      schritt: () => st.schritt,
      onSaved: (saved, paths, sent, satz) => {
        markSent(st, paths, sent, satz);
        st.view = saved;
        if (st === s) refreshDerived();
      },
      onMerged: (merged) => {
        // Stand des Servers mit den eigenen Eingaben darüber; was seither getippt wurde, bleibt
        let felder = merged;
        for (const path of st.dirty) felder = vaWizardSet(felder, path, vaWizardGet(st.felder, path));
        st.felder = felder;
        if (st === s) render();
      },
      onRenamed: (renamed) => {
        st.savedKennung = renamed.kennung;
        st.view = renamed;
        if (st === s) window.history.replaceState(null, "", vaWizardHash(renamed.kennung));
      },
      onState: (text, isError) => {
        st.save = { text, error: Boolean(isError) };
        if (st === s) refreshSave();
      },
    });
    if (vaWizardReadOnly({ phase: st.phase })) st.saver.freeze();
  }

  // --- Autosave ---------------------------------------------------------------

  function localStore() {
    try {
      return window.localStorage || null;
    } catch {
      return null;
    }
  }

  /** Eingaben eines noch nicht angelegten Entwurfs im Browser halten */
  function keepLocal(st) {
    const store = localStore();
    if (!store || st.savedKennung) return;
    try {
      store.setItem(VA_WIZARD_LOCAL_KEY, JSON.stringify({ id: st.localId, satz: st.satz, kennung: st.kennung, kennungTouched: st.kennungTouched, felder: st.felder }));
    } catch {
      // Speicher voll oder gesperrt: dann eben nur auf der Seite
    }
  }

  /** Die Kopie im Browser entfernen, aber nur die dieses Entwurfs */
  function dropLocal(st) {
    const store = localStore();
    if (!store) return;
    try {
      const raw = JSON.parse(store.getItem(VA_WIZARD_LOCAL_KEY) || "null");
      if (raw && raw.id === st.localId) store.removeItem(VA_WIZARD_LOCAL_KEY);
    } catch {
      store.removeItem(VA_WIZARD_LOCAL_KEY);
    }
  }

  /** Eingaben eines neuen Entwurfs aus dem Browser zurückholen */
  function restoreLocal(st) {
    const store = localStore();
    if (!store) return;
    try {
      const raw = JSON.parse(store.getItem(VA_WIZARD_LOCAL_KEY) || "null");
      if (!raw || typeof raw !== "object" || !raw.felder || typeof raw.felder !== "object" || Array.isArray(raw.felder)) return;
      st.localId = typeof raw.id === "string" ? raw.id : st.localId;
      st.satz = typeof raw.satz === "string" ? raw.satz.slice(0, 500) : "";
      st.kennung = typeof raw.kennung === "string" ? raw.kennung.slice(0, 64) : "";
      st.kennungTouched = raw.kennungTouched === true;
      st.felder = raw.felder;
      for (const key of Object.keys(st.felder)) st.dirty.add(key);
      st.satzDirty = Boolean(st.satz);
    } catch {
      // unlesbar: neu beginnen
    }
  }

  /** Gibt es in einem noch nicht angelegten Entwurf schon etwas zu speichern? */
  const hasInput = (st) => Boolean(st.satz.trim()) || Object.keys(st.felder).some((k) => !vaWizardEmpty(st.felder[k]));

  /**
   * Neuen Entwurf anlegen, sobald die Kennung gültig ist; nur einmal zugleich.
   * schritt: der Schritt, der gespeichert wird. Ergebnis wie vaWizardCreate,
   * { ok: true } wenn es ihn schon gibt, null wenn (noch) nichts anzulegen ist.
   */
  function createNow(st, schritt) {
    if (st.createTimer) clearTimeout(st.createTimer);
    st.createTimer = null;
    if (st.saver) return Promise.resolve({ ok: true });
    if (st.creating) return st.creating;
    if (vaWizardKennungProblem(st.kennung) || !hasInput(st)) return Promise.resolve(null);
    const sent = vaWizardClone(st.felder);
    const satz = st.satz;
    const paths = [...st.dirty];
    st.creating = vaWizardCreate(request, st.kennung, { satz: satz.trim(), schritt: schritt || st.schritt, felder: sent, festeRegeln: st.fixedRules }).then((created) => {
      st.creating = null;
      if (!created.ok) {
        // Vergeben oder belegt: Entprellt wird es mit dieser Kennung nicht noch einmal versucht
        if (created.kennung) st.blockedKennung = st.kennung;
        if (st === s) {
          if (created.kennung) setError("kennung", created.error);
          else {
            st.save = { text: [created.error, ...created.fehler].join(" "), error: true };
            refreshSave();
          }
        }
        return created;
      }
      markSent(st, paths, sent, satz);
      attachSaver(st, created.view);
      dropLocal(st);
      st.save = { text: VA_WIZARD_TEXT.saved, error: false };
      // Was während des Anlegens dazukam, gleich hinterher; nach dem Schließen sofort
      if (st.dirty.size || st.satzDirty) {
        if (st === s) st.saver.schedule();
        else st.saver.flush().catch(() => {});
      }
      if (st.kennung !== st.savedKennung && !vaWizardKennungProblem(st.kennung)) {
        if (st === s) scheduleRename(st);
        else renameNow(st);
      }
      if (st === s) {
        window.history.replaceState(null, "", vaWizardHash(created.view.kennung));
        if (!s.busy) render();
        loadVoices();
      }
      return created;
    });
    return st.creating;
  }

  /** Kennung umziehen (nach dem Anlegen); bei einem Konflikt bleibt der Entwurf unter der alten */
  async function renameNow(st) {
    if (st.renameTimer) clearTimeout(st.renameTimer);
    st.renameTimer = null;
    if (!st.saver || st.kennung === st.savedKennung || vaWizardKennungProblem(st.kennung)) return { ok: true };
    const r = await st.saver.rename(st.kennung);
    if (!r.ok && st === s) {
      if (r.reason === "gebaut") reload();
      else setError("kennung", r.error);
    }
    return r;
  }

  function scheduleRename(st) {
    if (st.renameTimer) clearTimeout(st.renameTimer);
    st.renameTimer = setTimeout(() => {
      st.renameTimer = null;
      renameNow(st);
    }, VA_WIZARD_AUTO_MS);
  }

  /** Nach jeder Eingabe: entprellt speichern, vor dem Anlegen erst im Browser halten */
  function autosave() {
    if (!s || readOnly()) return;
    const st = s;
    if (st.saver) return st.saver.schedule();
    if (!hasInput(st)) return dropLocal(st);
    keepLocal(st);
    if (st.createTimer) clearTimeout(st.createTimer);
    st.createTimer = setTimeout(() => {
      st.createTimer = null;
      if (st.kennung !== st.blockedKennung) createNow(st);
    }, VA_WIZARD_AUTO_MS);
  }

  /**
   * Verlassene Entwürfe, deren Speicherfolge noch läuft. Wer denselben Entwurf
   * wieder öffnet, bekommt diesen Zustand zurück oder lädt erst, wenn die Folge
   * fertig ist; sonst könnte ein alter Auftrag neuere Eingaben überschreiben.
   */
  const leaving = new Set();

  /** Wartet, bis Anlegen und Speicherfolge eines Entwurfs fertig sind, auch was unterwegs dazukommt */
  async function finished(st) {
    for (;;) {
      const creating = st.creating;
      const idle = st.saver ? st.saver.idle() : null;
      if (creating) await creating.catch(() => {});
      if (idle) await idle;
      if (st.creating === creating && (!st.saver || st.saver.idle() === idle)) return;
    }
  }

  function track(st) {
    if (leaving.has(st)) return;
    leaving.add(st);
    finished(st).finally(() => leaving.delete(st));
  }

  /** Beim Verlassen (Schließen, anderer Entwurf, Seite zu): alles Offene dieses Entwurfs sofort speichern */
  function persist(st) {
    if (!st || vaWizardReadOnly({ phase: st.phase })) return;
    if (!st.saver) {
      keepLocal(st);
      createNow(st);
      track(st);
      return;
    }
    if (st.renameTimer) renameNow(st);
    if (st.dirty.size || st.satzDirty) st.saver.flush().catch(() => {});
    track(st);
  }

  /** Eine Eingabe: Feld setzen, als angefasst und ungespeichert merken, entprellt speichern */
  function change(path, value) {
    if (readOnly()) return;
    s.felder = vaWizardSet(s.felder, path, value);
    s.touched.add(path);
    s.dirty.add(path);
    clearError(path);
    autosave();
  }

  // --- Rahmen -----------------------------------------------------------------

  /** Knoten, die sich ohne Neuaufbau aktualisieren (Speicherstand, feste Regeln, Kosten) */
  let live = {};

  function refreshSave() {
    if (!live.save) return;
    live.save.textContent = s.save.error ? "" : s.save.text;
    live.saveError.textContent = s.save.error ? s.save.text : "";
    live.saveError.hidden = !s.save.error;
  }

  function refreshDerived() {
    if (live.fixed) live.fixed();
    if (live.cost) live.cost();
    if (live.pin) live.pin();
  }

  /** Fehler an einem Feld zeigen, ohne die Seite neu aufzubauen */
  function setError(feld, text) {
    s.errors[feld] = text;
    const node = live.errorNodes && live.errorNodes[feld];
    if (node) {
      node.textContent = text;
      node.hidden = false;
    }
  }

  function clearError(feld) {
    if (!s.errors[feld]) return;
    delete s.errors[feld];
    const node = live.errorNodes && live.errorNodes[feld];
    if (node) {
      node.textContent = "";
      node.hidden = true;
    }
  }

  function showErrors(missing) {
    s.errors = {};
    for (const m of missing) if (!s.errors[m.feld]) s.errors[m.feld] = m.text;
    render();
    const first = missing[0] && live.focusOf && live.focusOf[missing[0].feld];
    if (first) first.focus();
  }

  /** Neu aufbauen und den Fokus samt Schreibmarke im selben Feld lassen */
  function render() {
    const active = doc.activeElement;
    const id = active && root.contains(active) ? active.id : "";
    const range = id && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    build();
    if (!id) return;
    const again = doc.getElementById(id);
    if (!again) return;
    again.focus();
    if (range && typeof again.setSelectionRange === "function") {
      try {
        again.setSelectionRange(range[0], range[1]);
      } catch {
        // Feldtyp ohne Schreibmarke
      }
    }
  }

  function build() {
    live = { errorNodes: {}, focusOf: {} };
    page.setTitle(displayName());
    const parts = [];
    parts.push(stepsNav());
    const head = vwEl(doc, "h2", "va-wizard-heading", VA_WIZARD_UI.stepOf(s.schritt, VA_WIZARD_STEPS.length, VA_WIZARD_STEPS[s.schritt - 1]));
    head.id = "vw-heading";
    head.tabIndex = -1;
    parts.push(head);
    const locked = readOnly();
    if (locked && s.schritt < 5) {
      const note = vwEl(doc, "p", "actions-hint va-wizard-readonly", VA_WIZARD_UI.readOnly(s.savedKennung));
      note.id = "vw-readonly";
      parts.push(note);
    }
    const body = vwEl(doc, "fieldset", "va-wizard-body");
    body.id = "vw-body";
    if (locked && s.schritt < 5) body.disabled = true;
    const builder = [stepPurpose, stepVoice, stepKnowledge, stepAccess, stepReview][s.schritt - 1];
    body.append(...builder());
    parts.push(body);
    parts.push(...footer());
    root.replaceChildren(...parts);
    refreshSave();
  }

  function stepsNav() {
    const nav = vwEl(doc, "nav", "va-wizard-steps");
    nav.setAttribute("aria-label", "Schritte");
    const ol = vwEl(doc, "ol", "va-wizard-step-list");
    VA_WIZARD_STEPS.forEach((title, i) => {
      const n = i + 1;
      const li = vwEl(doc, "li");
      const b = vwEl(doc, "button", "va-wizard-step");
      b.type = "button";
      b.id = `vw-step-${n}`;
      b.append(vwEl(doc, "span", "va-wizard-step-mark", String(n)), vwEl(doc, "span", "va-wizard-step-title", title));
      b.setAttribute("aria-label", VA_WIZARD_UI.stepOf(n, VA_WIZARD_STEPS.length, title));
      if (n === s.schritt) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => go(n));
      li.append(b);
      ol.append(li);
    });
    nav.append(ol);
    return nav;
  }

  function footer() {
    const out = [];
    const locked = readOnly();
    const nav = vwEl(doc, "div", "va-wizard-nav");
    if (s.schritt > 1) {
      const back = vwEl(doc, "button", "quiet-button va-wizard-back", VA_WIZARD_UI.back);
      back.type = "button";
      back.id = "vw-back";
      back.addEventListener("click", () => go(vaWizardBack(state()).schritt));
      nav.append(back);
    }
    if (s.schritt < 5) {
      const next = vwEl(doc, "button", "primary-button va-wizard-next", VA_WIZARD_UI.next);
      next.type = "button";
      next.id = "vw-next";
      next.disabled = s.busy;
      next.addEventListener("click", () => forward());
      nav.append(next);
    } else if (!locked) {
      const b = vwEl(doc, "button", "primary-button va-wizard-next", s.busy ? VA_WIZARD_UI.building : VA_WIZARD_UI.build);
      b.type = "button";
      b.id = "vw-build";
      b.disabled = s.busy || vaWizardMissing(state(), 5).length > 0 || !s.saver;
      b.addEventListener("click", () => startBuild());
      nav.append(b);
    }
    out.push(nav);
    const save = vwEl(doc, "p", "actions-hint va-wizard-save");
    save.id = "vw-save";
    save.setAttribute("role", "status");
    const saveError = vwEl(doc, "p", "actions-error va-wizard-save");
    saveError.id = "vw-save-error";
    saveError.setAttribute("role", "alert");
    saveError.hidden = true;
    live.save = save;
    live.saveError = saveError;
    out.push(save, saveError);
    if (!locked && (s.savedKennung || hasInput(s))) out.push(discardBlock());
    return out;
  }

  function discardBlock() {
    const wrap = vwEl(doc, "div", "va-wizard-discard");
    if (!s.confirmDiscard) {
      const b = vwEl(doc, "button", "quiet-button", VA_WIZARD_UI.discard);
      b.type = "button";
      b.id = "vw-discard";
      b.addEventListener("click", () => {
        s.confirmDiscard = true;
        render();
        const no = doc.getElementById("vw-discard-no");
        if (no) no.focus();
      });
      wrap.append(b);
      return wrap;
    }
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", VA_WIZARD_UI.discardQuestion(displayName()));
    const yes = vwEl(doc, "button", "quiet-button settings-device-confirm", VA_WIZARD_UI.discardConfirm);
    yes.type = "button";
    yes.id = "vw-discard-yes";
    const no = vwEl(doc, "button", "quiet-button", VA_WIZARD_UI.cancel);
    no.type = "button";
    no.id = "vw-discard-no";
    const actions = vwEl(doc, "div", "settings-actions");
    actions.append(yes, no);
    wrap.append(vwEl(doc, "p", "actions-question", VA_WIZARD_UI.discardQuestion(displayName())), vwEl(doc, "p", "actions-hint", VA_WIZARD_UI.discardHint), actions);
    no.addEventListener("click", () => {
      s.confirmDiscard = false;
      render();
      const b = doc.getElementById("vw-discard");
      if (b) b.focus();
    });
    yes.addEventListener("click", async () => {
      const mine = token;
      const st = s;
      yes.disabled = true;
      no.disabled = true;
      const name = displayName();
      // Läuft das Anlegen noch, wird erst danach verworfen; ohne Entwurf genügt die Kopie im Browser
      if (st.createTimer) clearTimeout(st.createTimer);
      st.createTimer = null;
      if (st.creating) await st.creating;
      dropLocal(st);
      if (!st.saver) {
        if (mine !== token) return;
        st.phase = "verworfen";
        return page.leaveToList(VA_WIZARD_UI.discarded(name));
      }
      if (st.renameTimer) clearTimeout(st.renameTimer);
      st.renameTimer = null;
      await st.saver.idle();
      let res;
      try {
        res = await request("DELETE", `/api/voice-agents/wizard/${encodeURIComponent(st.savedKennung)}`);
      } catch {
        res = { status: 0, body: null };
      }
      if (res.status === 200 || res.status === 404) {
        // Verworfen: nichts mehr speichern, auch nicht beim Schließen
        st.phase = "verworfen";
        st.saver.freeze();
      }
      if (mine !== token) return;
      if (res.status === 200 || res.status === 404) return page.leaveToList(VA_WIZARD_UI.discarded(name));
      s.confirmDiscard = false;
      s.save = { text: (res.body && res.body.error) || VA_WIZARD_TEXT.saveFailed, error: true };
      if (res.body && res.body.reason === "gebaut") return reload();
      render();
    });
    return wrap;
  }

  // --- Bausteine ----------------------------------------------------------------

  /** Feld mit Label, Hilfe und Fehlerzeile; control bekommt die id */
  function field(id, label, control, help, feld) {
    const wrap = vwEl(doc, "div", "settings-field");
    const l = vwEl(doc, "label", "settings-label", label);
    l.htmlFor = id;
    control.id = id;
    wrap.append(l, control);
    const describedBy = [];
    if (help) {
      const p = vwEl(doc, "p", "setup-help", help);
      p.id = `${id}-help`;
      describedBy.push(p.id);
      wrap.append(p);
    }
    if (feld) {
      const error = vwEl(doc, "p", "actions-error va-wizard-field-error", s.errors[feld] || "");
      error.id = `${id}-error`;
      error.setAttribute("role", "alert");
      error.hidden = !s.errors[feld];
      describedBy.push(error.id);
      wrap.append(error);
      live.errorNodes[feld] = error;
      live.focusOf[feld] = control;
      if (s.errors[feld]) control.setAttribute("aria-invalid", "true");
    }
    if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
    return wrap;
  }

  function textInput(value, onInput, options = {}) {
    const input = vwEl(doc, options.area ? "textarea" : "input", `settings-input${options.area ? " settings-textarea" : ""}`);
    if (!options.area) input.type = options.type || "text";
    if (options.max) input.maxLength = options.max;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.mono) {
      input.autocapitalize = "none";
      input.spellcheck = false;
      input.autocomplete = "off";
    }
    input.value = value || "";
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  /** Auswahl aus wenigen Möglichkeiten als Zeilen mit Radioknopf */
  function choiceGroup(name, legend, options, selected, onChange, feld) {
    const group = vwEl(doc, "fieldset", "va-wizard-choices");
    group.append(vwEl(doc, "legend", "settings-label", legend));
    for (const o of options) {
      const label = vwEl(doc, "label", "va-wizard-choice");
      const input = vwEl(doc, "input");
      input.type = "radio";
      input.name = name;
      input.id = `${name}-${o.value}`;
      input.checked = selected === o.value;
      input.addEventListener("change", () => input.checked && onChange(o.value));
      const text = vwEl(doc, "span", "va-wizard-choice-text");
      text.append(vwEl(doc, "span", "va-wizard-choice-label", o.label));
      if (o.hint) text.append(vwEl(doc, "span", "va-wizard-choice-hint", o.hint));
      label.append(input, text);
      if (o.extra) {
        const row = vwEl(doc, "div", "va-wizard-choice-row");
        row.append(label, o.extra);
        group.append(row);
      } else group.append(label);
      if (feld && !live.focusOf[feld]) live.focusOf[feld] = input;
    }
    if (feld) {
      const error = vwEl(doc, "p", "actions-error va-wizard-field-error", s.errors[feld] || "");
      error.setAttribute("role", "alert");
      error.hidden = !s.errors[feld];
      group.append(error);
      live.errorNodes[feld] = error;
    }
    return group;
  }

  function checkRow(id, label, checked, onChange, help) {
    const wrap = vwEl(doc, "div", "va-wizard-check");
    const l = vwEl(doc, "label", "setup-check va-wizard-check-label");
    const input = vwEl(doc, "input");
    input.type = "checkbox";
    input.id = id;
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    l.append(input, vwEl(doc, "span", "", label));
    wrap.append(l);
    if (help) {
      const p = vwEl(doc, "p", "setup-help", help);
      p.id = `${id}-help`;
      input.setAttribute("aria-describedby", p.id);
      wrap.append(p);
    }
    return { wrap, input };
  }

  /** Liste kurzer Texte mit Hinzufügen und Entfernen; baut nur sich selbst neu */
  function listEditor(idBase, label, help, path, max, itemMax, addLabel, feld, options = {}) {
    const wrap = vwEl(doc, "div", "settings-field va-wizard-list");
    const title = vwEl(doc, "p", "settings-label", label);
    title.id = `${idBase}-label`;
    const rows = vwEl(doc, "div", "va-wizard-list-rows");
    rows.setAttribute("role", "group");
    rows.setAttribute("aria-labelledby", title.id);
    const add = vwEl(doc, "button", "quiet-button va-wizard-add", addLabel);
    add.type = "button";
    add.id = `${idBase}-add`;
    const items = () => {
      const v = vaWizardGet(s.felder, path);
      return Array.isArray(v) ? v.slice() : [];
    };
    function draw(focusIndex) {
      const list = items();
      rows.replaceChildren(
        ...list.map((value, i) => {
          const row = vwEl(doc, "div", "va-wizard-list-row");
          const input = textInput(
            value,
            (v) => {
              const next = items();
              next[i] = v;
              change(path, next);
            },
            { max: itemMax, type: options.type, placeholder: options.placeholder }
          );
          input.id = `${idBase}-${i + 1}`;
          input.setAttribute("aria-label", `${label} ${i + 1}`);
          const remove = vwEl(doc, "button", "quiet-button va-wizard-remove", VA_WIZARD_UI.remove);
          remove.type = "button";
          remove.setAttribute("aria-label", VA_WIZARD_UI.removeOf(`${label} ${i + 1}`));
          remove.addEventListener("click", () => {
            const next = items();
            next.splice(i, 1);
            change(path, next.length ? next : undefined);
            draw();
            add.focus();
          });
          row.append(input, remove);
          return row;
        })
      );
      add.hidden = list.length >= max;
      if (focusIndex !== undefined) {
        const target = doc.getElementById(`${idBase}-${focusIndex + 1}`);
        if (target) target.focus();
      }
    }
    add.addEventListener("click", () => {
      const next = items();
      if (next.length >= max) return;
      next.push("");
      // Ein leerer Eintrag ist noch keine Eingabe: erst das Tippen speichert
      s.felder = vaWizardSet(s.felder, path, next);
      draw(next.length - 1);
    });
    wrap.append(title);
    if (help) wrap.append(vwEl(doc, "p", "setup-help", help));
    wrap.append(rows, add);
    if (feld) {
      const error = vwEl(doc, "p", "actions-error va-wizard-field-error", s.errors[feld] || "");
      error.setAttribute("role", "alert");
      error.hidden = !s.errors[feld];
      wrap.append(error);
      live.errorNodes[feld] = error;
      live.focusOf[feld] = add;
    }
    draw();
    return wrap;
  }

  /** Feste Regeln eines Schritts: sichtbar, ohne Schalter */
  function fixedBox(step) {
    const box = vwEl(doc, "section", "va-wizard-fixed");
    box.id = `vw-fixed-${step}`;
    const draw = () => {
      const entries = vaWizardFixedFor(currentView(), step);
      box.hidden = entries.length === 0;
      const ul = vwEl(doc, "ul", "va-wizard-fixed-list");
      for (const e of entries) {
        const li = vwEl(doc, "li");
        li.append(vwEl(doc, "span", "va-wizard-fixed-reason", e.grund), vwEl(doc, "span", "va-wizard-fixed-value", e.wert));
        ul.append(li);
      }
      box.replaceChildren(vwEl(doc, "h3", "group-label", VA_WIZARD_UI.fixedTitle), vwEl(doc, "p", "setup-help", VA_WIZARD_UI.fixedHint), ul);
    };
    draw();
    live.fixed = draw;
    return box;
  }

  // --- Schritt 1: Zweck -----------------------------------------------------------

  function stepPurpose() {
    const out = [];
    const sentence = textInput(
      s.satz,
      (v) => {
        if (readOnly()) return;
        s.satz = v;
        s.satzDirty = true;
        autosave();
      },
      { area: true, max: 500, placeholder: VA_WIZARD_UI.sentencePlaceholder }
    );
    out.push(field("vw-satz", VA_WIZARD_UI.sentenceLabel, sentence, VA_WIZARD_UI.sentenceHelp));
    const row = vwEl(doc, "div", "settings-actions");
    const propose = vwEl(doc, "button", "quiet-button va-wizard-propose", VA_WIZARD_UI.propose);
    propose.type = "button";
    propose.id = "vw-propose";
    propose.disabled = s.proposing;
    propose.addEventListener("click", () => runProposal());
    row.append(propose);
    out.push(row);
    const notice = vwEl(doc, "p", s.notice.error ? "actions-error" : "actions-hint", s.proposing ? VA_WIZARD_UI.proposing : s.notice.text);
    notice.id = "vw-notice";
    notice.setAttribute("role", "status");
    out.push(notice);

    const options = Object.keys(VA_WIZARD_TEMPLATES).map((value) => ({ value, label: VA_WIZARD_TEMPLATES[value].label, hint: VA_WIZARD_TEMPLATES[value].hint }));
    out.push(
      choiceGroup(
        "vw-vorlage",
        VA_WIZARD_UI.templateLabel,
        options,
        s.felder.vorlage,
        (value) => {
          if (readOnly()) return;
          s.felder = vaWizardSwitchTemplate(s.felder, value);
          s.touched.add("vorlage");
          s.dirty.add("vorlage");
          clearError("vorlage");
          autosave();
        },
        "vorlage"
      )
    );

    const kennung = textInput(
      s.kennung,
      (v) => {
        if (readOnly()) return;
        s.kennung = v.trim();
        s.kennungTouched = true;
        s.touched.add("kennung");
        clearError("kennung");
        kennungChanged();
      },
      { max: 64, mono: true }
    );
    const name = textInput(
      s.felder.name,
      (v) => {
        // Solange niemand die Kennung angefasst hat, folgt sie dem Namen (auch nach dem Anlegen: dann zieht der Entwurf um)
        if (!s.kennungTouched && !readOnly()) {
          s.kennung = vaWizardSlug(v);
          kennung.value = s.kennung;
          clearError("kennung");
        }
        change("name", v);
        if (!s.kennungTouched && s.saver) kennungChanged();
        page.setTitle(displayName());
      },
      { max: 100 }
    );
    out.push(field("vw-name", VA_WIZARD_UI.nameLabel, name, "", "name"));
    out.push(field("vw-kennung", VA_WIZARD_UI.kennungLabel, kennung, VA_WIZARD_UI.kennungHelp, "kennung"));
    out.push(field("vw-zweck", VA_WIZARD_UI.purposeLabel, textInput(s.felder.zweck, (v) => change("zweck", v), { area: true, max: 1000 }), VA_WIZARD_UI.purposeHelp, "zweck"));
    return out;
  }

  /** Kennung geändert: vor dem Anlegen mit dem Entwurf speichern, danach entprellt umziehen */
  function kennungChanged() {
    if (!s.saver) return autosave();
    if (s.kennung === s.savedKennung) {
      if (s.renameTimer) clearTimeout(s.renameTimer);
      s.renameTimer = null;
      return;
    }
    if (!vaWizardKennungProblem(s.kennung)) scheduleRename(s);
  }

  async function runProposal() {
    if (s.proposing || readOnly()) return;
    const satz = s.satz.trim();
    if (!satz) {
      s.notice = { text: VA_WIZARD_UI.proposalNeedsSentence, error: true };
      render();
      const input = doc.getElementById("vw-satz");
      if (input) input.focus();
      return;
    }
    const mine = token;
    s.proposing = true;
    s.notice = { text: "", error: false };
    render();
    let res;
    try {
      res = await request("POST", "/api/voice-agents/wizard/vorschlag", { satz });
    } catch {
      res = { status: 0, body: null };
    }
    if (mine !== token) return;
    s.proposing = false;
    if (res.status !== 200 || !res.body || !res.body.vorschlag) {
      s.notice = { text: (res.body && res.body.error) || VA_WIZARD_UI.proposalFailed, error: true };
      // Ohne Vorschlag geht es trotzdem weiter: Vorlage Experte, wenn noch keine gewählt ist
      if (!s.felder.vorlage) s.felder = vaWizardSet(s.felder, "vorlage", "experte");
      return render();
    }
    if (res.body.vorschlag.festeRegeln) s.fixedRules = res.body.vorschlag.festeRegeln;
    const before = s.felder;
    const merged = vaWizardMergeProposal({ felder: s.felder, kennung: s.kennung, kennungFest: Boolean(s.savedKennung) }, res.body.vorschlag, [...s.touched]);
    s.felder = merged.felder;
    if (!s.savedKennung) s.kennung = merged.kennung;
    for (const path of VA_WIZARD_PROPOSAL_PATHS) if (JSON.stringify(vaWizardGet(before, path)) !== JSON.stringify(vaWizardGet(s.felder, path))) s.dirty.add(path);
    if (s.dirty.size || !s.saver) autosave();
    const texts = [];
    if (res.body.quelle === "leer" && res.body.hinweis) texts.push(res.body.hinweis);
    if (merged.dropped) texts.push(VA_WIZARD_TEXT.proposalDropped);
    s.notice = { text: texts.length ? texts.join(" ") : VA_WIZARD_UI.proposalDone, error: false };
    s.errors = {};
    render();
  }

  // --- Schritt 2: Stimme ------------------------------------------------------------

  async function loadVoices() {
    if (s.voicesState === "laedt" || s.voicesState === "da") return;
    const mine = token;
    s.voicesState = "laedt";
    let res;
    try {
      res = await request("GET", "/api/voice-agents/wizard/stimmen");
    } catch {
      res = { status: 0, body: null };
    }
    if (mine !== token) return;
    if (res.status !== 200 || !res.body) {
      s.voicesState = "fehler";
    } else {
      s.voices = res.body;
      s.voicesState = "da";
      if (!readOnly()) {
        const voice = vaWizardDefaultVoice(s.felder, s.voices);
        if (JSON.stringify(voice) !== JSON.stringify(s.felder.stimme)) {
          s.felder = vaWizardSet(s.felder, "stimme", voice);
          s.dirty.add("stimme");
          if (s.saver) s.saver.schedule();
          else keepLocal(s);
        }
      }
    }
    if (s.schritt === 2 || s.schritt === 5) render();
  }

  function stepVoice() {
    const out = [];
    if (s.voicesState !== "da") {
      const p = vwEl(doc, "p", s.voicesState === "fehler" ? "actions-error" : "settings-empty", s.voicesState === "fehler" ? VA_WIZARD_UI.voicesFailed : VA_WIZARD_UI.voicesLoading);
      p.id = "vw-voices-state";
      p.setAttribute("role", "status");
      out.push(p);
      if (s.voicesState === "offen") loadVoices();
      if (s.voicesState === "fehler") {
        const retry = vwEl(doc, "button", "quiet-button va-wizard-add", VA_WIZARD_UI.retry);
        retry.type = "button";
        retry.id = "vw-voices-retry";
        retry.addEventListener("click", () => {
          s.voicesState = "offen";
          render();
        });
        out.push(retry);
      }
      out.push(fixedBox(2));
      return out;
    }
    const voices = s.voices;
    const konto = Array.isArray(voices.konto) ? voices.konto : [];
    const current = s.felder.stimme;
    const probeButton = (choice, name, key) => {
      const b = vwEl(doc, "button", "quiet-button va-wizard-probe", VA_WIZARD_UI.probe);
      b.type = "button";
      b.id = `vw-probe-${key}`;
      b.setAttribute("aria-label", VA_WIZARD_UI.probeOf(name));
      b.addEventListener("click", () => runProbe(choice, name, key));
      return b;
    };
    const options = [];
    if (voices.standard) options.push({ value: "standard", label: VA_WIZARD_UI.voiceStandard, hint: VA_WIZARD_UI.voiceStandardHint, extra: probeButton({ standard: true }, VA_WIZARD_UI.voiceStandard, "standard") });
    konto.forEach((v, i) => options.push({ value: `konto-${i}`, label: v.name, hint: v.klon ? VA_WIZARD_UI.voiceClone : VA_WIZARD_UI.voiceAccount, extra: probeButton({ voiceId: v.voiceId }, v.name, `konto-${i}`) }));
    const selected = current && current.wahl === "standard" ? "standard" : current && current.wahl === "konto" ? `konto-${konto.findIndex((v) => v.voiceId === current.voiceId)}` : "";
    if (!voices.standard) {
      const p = vwEl(doc, "p", "actions-error", voices.standardText || (s.view && s.view.stimme && s.view.stimme.text) || "");
      p.id = "vw-voice-nostandard";
      out.push(p);
    }
    if (options.length) {
      out.push(
        choiceGroup("vw-stimme", VA_WIZARD_UI.voiceLegend, options, selected, (value) => {
          if (value === "standard") return change("stimme", { wahl: "standard" });
          const v = konto[Number(value.slice("konto-".length))];
          if (v) change("stimme", { wahl: "konto", voiceId: v.voiceId, name: String(v.name).slice(0, 40) });
        })
      );
    }
    if (voices.hinweis) {
      const hint = vwEl(doc, "p", "actions-hint", voices.hinweis);
      hint.id = "vw-voices-hint";
      out.push(hint);
    }
    const state = vwEl(doc, "p", s.probe.error ? "actions-error" : "actions-hint", s.probe.text);
    state.id = "vw-probe-state";
    state.setAttribute("role", s.probe.error ? "alert" : "status");
    out.push(state);
    if (probeUrl) {
      const audio = vwEl(doc, "audio", "setup-probe-audio");
      audio.id = "vw-probe-audio";
      audio.controls = true;
      audio.src = probeUrl;
      audio.setAttribute("aria-label", VA_WIZARD_UI.probePlaying(s.probe.name));
      out.push(audio);
    }
    out.push(fixedBox(2));
    out.push(vwEl(doc, "p", "setup-help", VA_WIZARD_UI.kiHint));
    return out;
  }

  async function runProbe(choice, name, key) {
    if (s.probe.busy) return;
    const mine = token;
    dropProbe();
    s.probe = { text: VA_WIZARD_UI.probeLoading, error: false, name, key, busy: true };
    render();
    let ok = false;
    let message = VA_WIZARD_UI.probeFailed;
    try {
      const res = await page.api("/api/voice-agents/wizard/hoerprobe", { method: "POST", body: JSON.stringify(vaWizardProbeBody(choice, s.felder)) });
      if (res.ok) {
        const blob = await res.blob();
        if (mine !== token) return;
        probeUrl = window.URL.createObjectURL(blob);
        ok = true;
      } else {
        const body = await res.json().catch(() => null);
        if (body && typeof body.error === "string" && body.error) message = body.error;
      }
    } catch {
      // Netzfehler: der allgemeine Satz
    }
    if (mine !== token) return;
    s.probe = ok ? { text: VA_WIZARD_UI.probePlaying(name), error: false, name, key } : { text: message, error: true, name, key };
    if (s.schritt !== 2) return;
    render();
    const audio = doc.getElementById("vw-probe-audio");
    if (ok && audio && typeof audio.play === "function") {
      const playing = audio.play();
      if (playing && typeof playing.catch === "function") playing.catch(() => {});
    }
  }

  // --- Schritt 3: Wissen und Verhalten ------------------------------------------------

  function stepKnowledge() {
    const out = [];
    const v = s.felder.vorlage;
    const p = s.felder.persona || {};
    if (v === "experte") {
      const t = s.felder.training || {};
      out.push(field("vw-thema", VA_WIZARD_UI.topicLabel, textInput(s.felder.thema, (x) => change("thema", x), { area: true, max: 2000 }), VA_WIZARD_UI.topicHelp));
      out.push(listEditor("vw-rolle", VA_WIZARD_UI.rolesLabel, VA_WIZARD_UI.rolesHelp, "training.rollen", VA_WIZARD_LIMITS.rollen, 200, VA_WIZARD_UI.rolesAdd));
      out.push(listEditor("vw-einwand", VA_WIZARD_UI.objectionsLabel, VA_WIZARD_UI.objectionsHelp, "training.einwaende", VA_WIZARD_LIMITS.einwaende, 500, VA_WIZARD_UI.objectionsAdd));
      const criteria = vwEl(doc, "fieldset", "va-wizard-choices va-wizard-criteria");
      criteria.append(vwEl(doc, "legend", "settings-label", VA_WIZARD_UI.criteriaLabel), vwEl(doc, "p", "setup-help", VA_WIZARD_UI.criteriaHelp));
      const list = Array.isArray(t.kriterien) ? t.kriterien : [];
      for (let i = 0; i < VA_WIZARD_LIMITS.kriterien; i++) {
        const input = textInput(
          list[i],
          (x) => {
            const cur = vaWizardGet(s.felder, "training.kriterien");
            const next = Array.isArray(cur) ? cur.slice() : [];
            while (next.length < VA_WIZARD_LIMITS.kriterien) next.push("");
            next[i] = x;
            change("training.kriterien", next);
          },
          { max: 500 }
        );
        input.id = `vw-kriterium-${i + 1}`;
        input.setAttribute("aria-label", VA_WIZARD_UI.criterion(i + 1));
        input.placeholder = VA_WIZARD_UI.criterion(i + 1);
        criteria.append(input);
        if (i === 0) live.focusOf["training.kriterien"] = input;
      }
      const error = vwEl(doc, "p", "actions-error va-wizard-field-error", s.errors["training.kriterien"] || "");
      error.id = "vw-kriterien-error";
      error.setAttribute("role", "alert");
      error.hidden = !s.errors["training.kriterien"];
      live.errorNodes["training.kriterien"] = error;
      criteria.append(error);
      out.push(criteria);
      out.push(filesBlock());
      out.push(listEditor("vw-link", VA_WIZARD_UI.linksLabel, VA_WIZARD_UI.linksHelp, "links", VA_WIZARD_LIMITS.links, 500, VA_WIZARD_UI.linksAdd, "links", { type: "url", placeholder: "https://" }));
    } else if (v === "anrufannahme") {
      const a = s.felder.anrufannahme || {};
      out.push(listEditor("vw-frage", VA_WIZARD_UI.questionsLabel, VA_WIZARD_UI.questionsHelp, "anrufannahme.fragen", VA_WIZARD_LIMITS.fragen, VA_WIZARD_LIMITS.frage, VA_WIZARD_UI.questionsAdd, "anrufannahme.fragen"));
      out.push(
        field(
          "vw-abschluss",
          VA_WIZARD_UI.closingLabel,
          textInput(a.abschlusssatz, (x) => change("anrufannahme.abschlusssatz", x), { area: true, max: VA_WIZARD_LIMITS.abschlusssatz }),
          VA_WIZARD_UI.closingHelp(VA_WIZARD_LIMITS.abschlusssatz),
          "anrufannahme.abschlusssatz"
        )
      );
    } else if (v === "jarvis") {
      const think = checkRow("vw-denkauftrag", VA_WIZARD_UI.thinkCheck, s.felder.gehirn && s.felder.gehirn.denkauftrag, (on) => change("gehirn.denkauftrag", on), VA_WIZARD_UI.thinkHelp);
      const wrap = vwEl(doc, "div", "settings-field");
      wrap.append(vwEl(doc, "p", "settings-label", VA_WIZARD_UI.thinkLabel), think.wrap);
      out.push(wrap);
    }
    const persona = vwEl(doc, "section", "settings-section va-wizard-section");
    persona.append(vwEl(doc, "h3", "group-label", VA_WIZARD_UI.personaTitle));
    persona.append(field("vw-rolle-text", VA_WIZARD_UI.roleLabel, textInput(p.rolle, (x) => change("persona.rolle", x), { area: true, max: 2000 }), VA_WIZARD_UI.roleHelp));
    persona.append(
      choiceGroup(
        "vw-anrede",
        VA_WIZARD_UI.addressLabel,
        [
          { value: "du", label: "du" },
          { value: "sie", label: "Sie" },
        ],
        p.anrede,
        (value) => change("persona.anrede", value)
      )
    );
    const language = vwEl(doc, "select", "settings-input");
    for (const [value, label] of [["de", "Deutsch"], ["en", "Englisch"]]) {
      const o = vwEl(doc, "option", "", label);
      o.value = value;
      language.append(o);
    }
    const langs = Array.isArray(p.sprachen) ? p.sprachen : [];
    language.value = langs[0] === "en" ? "en" : "de";
    language.addEventListener("change", () => {
      const cur = vaWizardGet(s.felder, "persona.sprachen");
      const rest = (Array.isArray(cur) ? cur : []).filter((x) => x !== language.value);
      change("persona.sprachen", [language.value, ...rest]);
    });
    const select = vwEl(doc, "span", "settings-select");
    const languageField = field("vw-sprache", VA_WIZARD_UI.languageLabel, language);
    languageField.replaceChild(select, language);
    select.append(language);
    persona.append(languageField);
    persona.append(field("vw-erster-satz", VA_WIZARD_UI.firstLabel, textInput(p.ersterSatz, (x) => change("persona.ersterSatz", x), { max: 500 }), VA_WIZARD_UI.firstHelp));
    persona.append(listEditor("vw-regel", VA_WIZARD_UI.rulesLabel, VA_WIZARD_UI.rulesHelp, "regeln", 20, 500, VA_WIZARD_UI.rulesAdd));
    out.push(persona);
    out.push(fixedBox(3));
    return out;
  }

  function filesBlock() {
    const wrap = vwEl(doc, "div", "settings-field va-wizard-files");
    wrap.id = "vw-files";
    const title = vwEl(doc, "p", "settings-label", VA_WIZARD_UI.filesLabel);
    wrap.append(title, vwEl(doc, "p", "setup-help", VA_WIZARD_UI.filesHelp));
    const files = (s.view && Array.isArray(s.view.anhaenge) && s.view.anhaenge) || [];
    const ul = vwEl(doc, "ul", "settings-devices va-wizard-file-list");
    for (const a of files) {
      const li = vwEl(doc, "li");
      const name = vwEl(doc, "span", "settings-device-name");
      name.append(vwEl(doc, "span", "", a.name), vwEl(doc, "span", "settings-device-meta", vwSize(a.bytes)));
      const remove = vwEl(doc, "button", "quiet-button", VA_WIZARD_UI.remove);
      remove.type = "button";
      remove.setAttribute("aria-label", VA_WIZARD_UI.removeOf(a.name));
      remove.addEventListener("click", async () => {
        const st = s;
        remove.disabled = true;
        const r = await st.saver.removeAttachment(a.datei);
        if (r.ok) {
          st.view = { ...st.view, anhaenge: st.view.anhaenge.filter((x) => x.datei !== a.datei) };
          st.upload = { text: "", error: false };
        } else st.upload = { text: r.error || VA_WIZARD_UI.fileRemoveFailed, error: true };
        if (st === s && s.schritt === 3) render();
      });
      li.append(name, remove);
      ul.append(li);
    }
    ul.hidden = files.length === 0;
    wrap.append(ul);
    const input = vwEl(doc, "input", "va-wizard-file-input");
    input.type = "file";
    input.id = "vw-file-input";
    input.accept = VA_WIZARD_ACCEPT;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    const add = vwEl(doc, "button", "quiet-button va-wizard-add", VA_WIZARD_UI.filesAdd);
    add.type = "button";
    add.id = "vw-file-add";
    add.hidden = files.length >= VA_WIZARD_FILES_MAX;
    add.disabled = !s.saver;
    add.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file || !s.saver) return;
      const st = s;
      st.upload = { text: VA_WIZARD_UI.fileUploading(file.name), error: false };
      render();
      let r;
      try {
        r = await st.saver.upload(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch {
        r = { ok: false };
      }
      if (r.ok) {
        st.view = { ...st.view, anhaenge: [...((st.view && st.view.anhaenge) || []), r.anhang] };
        st.upload = { text: "", error: false };
      } else st.upload = { text: r.error || VA_WIZARD_UI.fileFailed, error: true };
      if (st === s && s.schritt === 3) render();
    });
    wrap.append(input, add);
    const status = vwEl(doc, "p", s.upload.error ? "actions-error" : "actions-hint", s.saver ? s.upload.text : VA_WIZARD_UI.filesNeedDraft);
    status.id = "vw-file-state";
    status.setAttribute("role", s.upload.error ? "alert" : "status");
    wrap.append(status);
    return wrap;
  }

  function vwSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1_048_576) return `${(n / 1_048_576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
    if (n >= 1024) return `${Math.round(n / 1024).toLocaleString("de-DE")} KB`;
    return `${n} Byte`;
  }

  // --- Schritt 4: Zugang --------------------------------------------------------------

  function stepAccess() {
    const out = [];
    const z = s.felder.zugang || {};
    const tel = z.telefon || null;
    out.push(checkRow("vw-web", VA_WIZARD_UI.webCheck, z.web, (on) => change("zugang.web", on), VA_WIZARD_UI.webHelp).wrap);
    out.push(
      checkRow(
        "vw-telefon",
        VA_WIZARD_UI.phoneCheck,
        Boolean(tel),
        (on) => {
          change("zugang.telefon", on ? { nummer: "", anrufer: "freigegeben", pin: false } : undefined);
          clearError("zugang.telefon.nummer");
          clearError("zugang.telefon.anrufer");
          render();
          const next = doc.getElementById(on ? "vw-nummer" : "vw-telefon");
          if (next) next.focus();
        },
        VA_WIZARD_UI.phoneHelp
      ).wrap
    );
    if (tel) {
      const phone = vwEl(doc, "div", "va-wizard-sub");
      phone.append(field("vw-nummer", VA_WIZARD_UI.numberLabel, textInput(tel.nummer, (x) => change("zugang.telefon.nummer", x.trim()), { max: 64, mono: true }), VA_WIZARD_UI.numberHelp, "zugang.telefon.nummer"));
      phone.append(
        choiceGroup(
          "vw-anrufer",
          VA_WIZARD_UI.callersLegend,
          [
            { value: "freigegeben", label: VA_WIZARD_UI.callersAllowed },
            { value: "alle", label: VA_WIZARD_UI.callersAll },
          ],
          tel.anrufer,
          (value) => change("zugang.telefon.anrufer", value),
          "zugang.telefon.anrufer"
        )
      );
      const pin = checkRow("vw-pin", VA_WIZARD_UI.pinCheck, tel.pin, (on) => change("zugang.telefon.pin", on));
      const pinHint = vwEl(doc, "p", "setup-help", "");
      pinHint.id = "vw-pin-hint";
      pin.wrap.append(pinHint);
      const drawPin = () => {
        const fixed = vaWizardPinFixed(currentView());
        pin.input.disabled = fixed;
        if (fixed) pin.input.checked = true;
        pinHint.textContent = fixed ? VA_WIZARD_UI.pinFixed : "";
        pinHint.hidden = !fixed;
      };
      drawPin();
      live.pin = drawPin;
      phone.append(pin.wrap);
      out.push(phone);
    }
    const cost = vwEl(doc, "div", "settings-field va-wizard-cost");
    const costText = vwEl(doc, "p", "voice-agent-line", "");
    costText.id = "vw-kosten";
    const notes = vwEl(doc, "ul", "voice-agent-lines");
    const drawCost = () => {
      const k = currentView().kosten;
      costText.textContent = vaWizardCostText(k);
      notes.replaceChildren(...vaWizardCostNotes(k).map((line) => vwEl(doc, "li", "", line)));
      notes.hidden = !notes.children.length;
    };
    drawCost();
    live.cost = drawCost;
    cost.append(vwEl(doc, "p", "settings-label", VA_WIZARD_UI.costLabel), costText, notes);
    out.push(cost);
    out.push(fixedBox(4));
    return out;
  }

  // --- Schritt 5: Prüfen und Starten ------------------------------------------------------

  function summaryBlock() {
    const wrap = vwEl(doc, "section", "va-wizard-summary");
    wrap.id = "vw-summary";
    wrap.append(vwEl(doc, "h3", "group-label", VA_WIZARD_UI.summaryTitle));
    for (const section of vaWizardSummary(currentView(), s.voices)) {
      if (!section.zeilen.length) continue;
      wrap.append(vwEl(doc, "h4", "voice-agent-recipe-title", section.titel));
      const dl = vwEl(doc, "dl", "voice-agent-recipe");
      for (const z of section.zeilen) dl.append(vwEl(doc, "dt", "", z.feld), vwEl(doc, "dd", "", z.wert));
      wrap.append(dl);
    }
    return wrap;
  }

  function stepReview() {
    const out = [];
    if (s.voicesState === "offen") loadVoices();
    if (!readOnly()) {
      const missing = vaWizardMissing(state(), 5);
      if (missing.length) {
        const box = vwEl(doc, "div", "va-wizard-missing");
        box.id = "vw-missing";
        box.setAttribute("role", "alert");
        box.append(vwEl(doc, "p", "actions-question", VA_WIZARD_UI.missingTitle));
        const ul = vwEl(doc, "ul", "voice-agent-lines");
        for (const m of missing) ul.append(vwEl(doc, "li", "", m.text));
        box.append(ul);
        out.push(box);
      }
      out.push(summaryBlock());
      out.push(vwEl(doc, "p", "actions-hint", VA_WIZARD_UI.buildHint));
      const error = vwEl(doc, "div", "va-wizard-build-error");
      error.id = "vw-build-error";
      error.setAttribute("role", "alert");
      if (s.buildError) {
        error.append(vwEl(doc, "p", "actions-error", s.buildError.text));
        if (s.buildError.lines.length) {
          const ul = vwEl(doc, "ul", "voice-agent-lines");
          for (const line of s.buildError.lines) ul.append(vwEl(doc, "li", "", line));
          error.append(ul);
        }
      }
      error.hidden = !s.buildError;
      out.push(error);
      return out;
    }
    out.push(progressBlock());
    out.push(summaryBlock());
    return out;
  }

  function progressBlock() {
    const wrap = vwEl(doc, "section", "va-wizard-progress");
    wrap.id = "vw-progress";
    const p = s.progress;
    wrap.append(vwEl(doc, "h3", "group-label", VA_WIZARD_UI.progressTitle));
    const phase = vwEl(doc, "p", "va-wizard-phase", (p && p.phaseText) || (s.view && s.view.phaseText) || VA_WIZARD_UI.loading);
    phase.id = "vw-phase";
    phase.setAttribute("role", "status");
    wrap.append(phase);
    if (s.progressError) wrap.append(vwEl(doc, "p", "actions-error", VA_WIZARD_UI.progressFailed));
    if (!p) return wrap;
    if (vaWizardPolling(p)) {
      const meta = [];
      if (typeof p.versuch === "number" && p.versuch > 1) meta.push(VA_WIZARD_UI.attempt(p.versuch));
      meta.push(VA_WIZARD_UI.background);
      wrap.append(vwEl(doc, "p", "actions-hint", meta.join(" · ")));
    }
    const question = vaWizardQuestionText(p);
    if (question) {
      const box = vwEl(doc, "div", "va-wizard-question");
      box.id = "vw-question";
      const link = vwEl(doc, "a", "primary-button va-wizard-chat", VA_WIZARD_UI.toChat);
      link.id = "vw-chat";
      link.href = VA_WIZARD_CHAT;
      box.append(vwEl(doc, "p", "va-wizard-question-text", question), link);
      wrap.append(box);
    }
    if (p.phase === "abgebrochen" || p.phase === "verworfen") {
      const box = vwEl(doc, "div", "va-wizard-aborted");
      box.id = "vw-aborted";
      box.append(vwEl(doc, "p", "voice-agent-line", VA_WIZARD_UI.aborted));
      if (p.grund) box.append(vwEl(doc, "p", "actions-hint", VA_WIZARD_UI.reason(p.grund)));
      const lines = vaWizardPlainErrors(p.fehler);
      if (lines.length) {
        const ul = vwEl(doc, "ul", "voice-agent-lines");
        for (const line of lines) ul.append(vwEl(doc, "li", "", line));
        box.append(ul);
      }
      wrap.append(box);
    }
    const tests = vaWizardTests(p);
    if (tests) {
      const box = vwEl(doc, "div", "va-wizard-tests");
      box.id = "vw-tests";
      box.append(vwEl(doc, "h4", "voice-agent-recipe-title", VA_WIZARD_UI.testsTitle));
      if (tests.satz) box.append(vwEl(doc, "p", "voice-agent-line", tests.satz));
      if (tests.zeilen.length) {
        const ul = vwEl(doc, "ul", "va-wizard-test-list");
        for (const t of tests.zeilen) {
          const li = vwEl(doc, "li");
          li.append(vwEl(doc, "span", "va-wizard-test-name", `${t.name}: ${t.status}`));
          if (t.grund) li.append(vwEl(doc, "span", "va-wizard-test-reason", t.grund));
          ul.append(li);
        }
        box.append(ul);
      }
      wrap.append(box);
    }
    const actions = vwEl(doc, "div", "settings-actions va-wizard-result");
    if (vaWizardCanTalk(p)) {
      const talk = vwEl(doc, "a", "primary-button voice-agent-talk", VA_WIZARD_UI.talk);
      talk.id = "vw-talk";
      talk.href = `/sa/${encodeURIComponent(s.savedKennung)}`;
      actions.append(talk);
    }
    if (p.version !== undefined && p.phase !== "abgebrochen" && p.phase !== "verworfen") {
      const agent = vwEl(doc, "a", "quiet-button", VA_WIZARD_UI.toAgent);
      agent.id = "vw-agent";
      agent.href = `#${s.savedKennung}`;
      actions.append(agent);
    }
    if (actions.children.length) wrap.append(actions);
    if (p.phase === "fertig" && !vaWizardCanTalk(p)) wrap.append(vwEl(doc, "p", "actions-hint", p.web ? VA_WIZARD_UI.notUnlocked : VA_WIZARD_UI.noWeb));
    if (p.phase !== "abgebrochen" && p.phase !== "verworfen") wrap.append(vwEl(doc, "p", "actions-hint", VA_WIZARD_UI.changeHint(s.savedKennung)));
    return wrap;
  }

  async function pollProgress() {
    stopPoll();
    if (!s || !s.savedKennung || !readOnly()) return;
    const mine = token;
    let res;
    try {
      res = await request("GET", `/api/voice-agents/wizard/${encodeURIComponent(s.savedKennung)}/fortschritt`);
    } catch {
      res = { status: 0, body: null };
    }
    if (mine !== token) return;
    if (res.status === 404) return showGone();
    const before = JSON.stringify(s.progress);
    if (res.status === 200 && res.body) {
      s.progress = res.body;
      s.phase = res.body.phase;
      s.progressError = false;
    } else s.progressError = true;
    if (s.schritt === 5 && (before !== JSON.stringify(s.progress) || s.progressError)) render();
    const p = s.progress;
    const waiting = p && (p.phase === "durchgefallen" || p.phase === "unterbrochen");
    if (!p || vaWizardPolling(p) || s.progressError) pollTimer = setTimeout(pollProgress, VA_WIZARD_POLL_MS);
    else if (waiting) pollTimer = setTimeout(pollProgress, VA_WIZARD_POLL_SLOW_MS);
  }

  async function startBuild() {
    if (s.busy || !s.saver) return;
    const mine = token;
    s.busy = true;
    s.buildError = null;
    render();
    const res = await s.saver.build();
    if (mine !== token) return;
    s.busy = false;
    if (res.status === 202) {
      s.phase = "job";
      s.progress = { phase: "job", phaseText: (res.body && res.body.text) || "", rueckfrageOffen: false };
      s.confirmDiscard = false;
      render();
      focusHeading();
      return pollProgress();
    }
    const reason = res.body && res.body.reason;
    if (res.status === 404) return showGone();
    // Inzwischen anderswo gebaut: den Stand zeigen statt eines Fehlers
    if (reason === "gebaut") return reload();
    s.buildError = { text: (res.body && res.body.error) || VA_WIZARD_TEXT.buildFailed, lines: vaWizardPlainErrors(res.body && res.body.fehler) };
    render();
    const box = doc.getElementById("vw-build-error");
    if (box && typeof box.scrollIntoView === "function") box.scrollIntoView({ block: "nearest" });
  }

  // --- Wechsel der Schritte ---------------------------------------------------------------

  function focusHeading() {
    const head = doc.getElementById("vw-heading");
    if (head) head.focus();
  }

  /** „Weiter“: bleibt stehen, solange im Schritt etwas fehlt */
  function forward() {
    const next = vaWizardNext(state());
    if (next.fehlt.length) return showErrors(next.fehlt);
    return go(next.schritt);
  }

  /** Kennung sichern: anlegen beim ersten Mal, umziehen bei einer Änderung; false bei einem Konflikt */
  async function settleKennung(targetStep) {
    if (readOnly()) return true;
    const st = s;
    if (!st.saver) {
      // Läuft schon ein Anlegen (entprellt), zählt es; sonst jetzt anlegen
      const created = await createNow(st, targetStep);
      if (st !== s) return false;
      if (!created || !created.ok) {
        if (created && created.kennung) s.errors = { kennung: created.error };
        else if (created) s.save = { text: [created.error, ...created.fehler].join(" "), error: true };
        return false;
      }
    }
    if (st.renameTimer) clearTimeout(st.renameTimer);
    st.renameTimer = null;
    if (st.kennung !== st.savedKennung) {
      const renamed = await st.saver.rename(st.kennung);
      if (st !== s) return false;
      if (!renamed.ok) {
        if (renamed.reason === "gebaut") {
          await reload();
          return false;
        }
        s.errors = { kennung: renamed.error };
        return false;
      }
    }
    return true;
  }

  async function go(step) {
    if (!s || s.busy || step === s.schritt) return;
    const mine = token;
    if (!readOnly()) {
      if (step > s.schritt && !vaWizardCanOpen(state(), step)) {
        // Nach vorn nur, wenn bis dahin nichts fehlt: Der erste Schritt mit einer Lücke zeigt sie
        for (let n = 1; n < step; n++) {
          const missing = vaWizardMissing({ ...state(), schritt: n }, n);
          if (missing.length) {
            if (n !== s.schritt) {
              s.schritt = n;
              dropProbe();
            }
            return showErrors(missing);
          }
        }
      }
      const kennungOpen = !s.savedKennung || s.kennung !== s.savedKennung;
      if (kennungOpen && (step > s.schritt || s.savedKennung)) {
        const problem = vaWizardKennungProblem(s.kennung);
        if (problem) {
          s.schritt = 1;
          return showErrors([{ feld: "kennung", text: problem }]);
        }
        s.busy = true;
        render();
        const ok = await settleKennung(step);
        if (mine !== token) return;
        s.busy = false;
        if (!ok) {
          s.schritt = 1;
          render();
          const input = doc.getElementById("vw-kennung");
          if (input && s.errors.kennung) input.focus();
          return;
        }
      }
    }
    s.schritt = step;
    s.errors = {};
    s.confirmDiscard = false;
    s.buildError = null;
    dropProbe();
    s.probe = { text: "", error: false, name: "", key: "" };
    render();
    focusHeading();
    if (s.saver && !readOnly()) {
      // Jeder Wechsel speichert sofort; Schritt 5 zeigt danach den Stand des Servers
      const saved = await s.saver.flush().catch(() => ({ ok: false }));
      if (mine !== token) return;
      if (saved && saved.reason === "gebaut") return reload();
      if (saved && saved.reason === "unbekannt") return showGone();
      if (s.schritt === 5) render();
    }
    if (readOnly() && step === 5) pollProgress();
  }

  // --- Öffnen und Schließen -----------------------------------------------------------------

  function showMessage(text, id) {
    stopPoll();
    page.setTitle(VA_WIZARD_UI.titleNew);
    const p = vwEl(doc, "p", "settings-empty", text);
    p.id = id || "vw-message";
    p.setAttribute("role", "status");
    root.replaceChildren(p);
  }

  function showGone() {
    token++;
    s = null;
    showMessage(VA_WIZARD_UI.gone, "vw-gone");
  }

  /** Entwurf vom Server laden: beim Fortsetzen und wenn er inzwischen gebaut wird */
  async function reload() {
    const kennung = s && s.savedKennung;
    if (!kennung) return;
    return load(kennung);
  }

  async function load(kennung) {
    const mine = ++token;
    stopPoll();
    dropProbe();
    s = null;
    showMessage(VA_WIZARD_UI.loading, "vw-loading");
    // Was ein verlassener Zustand an diesen Entwurf noch schickt, kommt vor dem Laden an
    const before = [...leaving].filter((st) => st.savedKennung === kennung || st.kennung === kennung || (st.saver && st.saver.kennung === kennung));
    if (before.length) {
      await Promise.all(before.map(finished));
      if (mine !== token) return;
    }
    let res;
    try {
      res = await request("GET", `/api/voice-agents/wizard/${encodeURIComponent(kennung)}`);
    } catch {
      res = { status: 0, body: null };
    }
    if (mine !== token) return;
    if (res.status === 404) return showMessage(VA_WIZARD_UI.gone, "vw-gone");
    if (res.status === 503) return showMessage(VA_WIZARD_UI.notConfigured, "vw-gone");
    if (res.status !== 200 || !res.body) return showMessage((res.body && res.body.error) || VA_WIZARD_UI.loadFailed, "vw-gone");
    const view = res.body;
    s = fresh();
    s.satz = view.satz || "";
    s.felder = vaWizardFromView(view);
    s.kennungTouched = true;
    attachSaver(s, view);
    s.schritt = vaWizardResumeStep(view);
    if (readOnly()) s.progress = { phase: view.phase, phaseText: view.phaseText };
    render();
    focusHeading();
    loadVoices();
    if (readOnly()) pollProgress();
  }

  /** Einen verlassenen Zustand wieder zeigen; seine Speicherfolge bleibt die einzige dieses Entwurfs */
  function resume(st) {
    token++;
    stopPoll();
    dropProbe();
    s = st;
    s.proposing = false;
    s.confirmDiscard = false;
    s.probe = { text: "", error: false, name: "", key: "" };
    if (s.voicesState === "laedt") s.voicesState = "offen";
    render();
    focusHeading();
    loadVoices();
  }

  function open(route) {
    root.hidden = false;
    if (route.kennung) {
      if (s && s.savedKennung === route.kennung) return;
      // Ein anderer Entwurf: das Offene des bisherigen gehört weiter ihm
      persist(s);
      // Speichert der Entwurf noch, weil er eben erst verlassen wurde: denselben Zustand weiterführen
      const running = [...leaving].find((st) => st !== s && st.saver && !st.saver.frozen && !st.busy && st.savedKennung === route.kennung);
      if (running) return resume(running);
      return load(route.kennung);
    }
    persist(s);
    token++;
    stopPoll();
    dropProbe();
    s = fresh();
    restoreLocal(s);
    render();
    autosave();
    const first = doc.getElementById("vw-satz");
    if (first) first.focus();
  }

  function close() {
    persist(s);
    token++;
    stopPoll();
    dropProbe();
    s = null;
    root.hidden = true;
    root.replaceChildren();
  }

  // --- Entwürfe in der Liste des Bereichs ---------------------------------------------------

  function hideList() {
    if (page.drafts) page.drafts.hidden = true;
    if (page.newButton) page.newButton.hidden = true;
  }

  /** Knopf „Neu“ und offene Entwürfe unter der Liste; current() sagt, ob die Liste noch gezeigt wird */
  async function list(current) {
    hideList();
    let res;
    try {
      res = await request("GET", "/api/voice-agents/wizard/entwuerfe");
    } catch {
      return;
    }
    if (!current() || res.status !== 200 || !res.body) return;
    if (page.newButton) page.newButton.hidden = false;
    if (!page.drafts) return;
    const open = Array.isArray(res.body.entwuerfe) ? res.body.entwuerfe : [];
    const done = Array.isArray(res.body.beendet) ? res.body.beendet : [];
    const group = (title, entries, id) => {
      const out = [vwEl(doc, "h2", "group-label", title)];
      const ul = vwEl(doc, "ul", "settings-devices voice-agents-list");
      ul.id = id;
      for (const e of entries) {
        const li = vwEl(doc, "li");
        const link = vwEl(doc, "a", "voice-agents-item");
        link.href = vaWizardHash(e.kennung);
        link.append(vwEl(doc, "span", "voice-agents-name", e.name || e.kennung), vwEl(doc, "span", "settings-device-meta", vaWizardDraftMeta(e)));
        li.append(link);
        ul.append(li);
      }
      out.push(ul);
      return out;
    };
    const parts = [];
    if (open.length) parts.push(...group(VA_WIZARD_UI.drafts, open, "va-draft-list"));
    if (done.length) parts.push(...group(VA_WIZARD_UI.finished, done, "va-done-list"));
    page.drafts.replaceChildren(...parts);
    page.drafts.hidden = parts.length === 0;
  }

  // Beim Verlassen der Seite das Offene noch speichern
  window.addEventListener("pagehide", () => persist(s));

  return { open, close, list, hideList };
}
