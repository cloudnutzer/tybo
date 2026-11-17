// Bereich „Sprachagenten“ (/sprachagenten, Issue #495), hinter dem Login.
// Liste wie /sprachagent liste, Detail unter /sprachagenten#<kennung> mit dem
// Rezept in Klartext, dem letzten Testlauf, den Versionen und den Minuten im
// Browser. Knöpfe: Sprechen (öffnet die Gesprächsseite /sa/<kennung>, nur dort
// erlaubt die CSP die Verbindung zum Anbieter), Testen, Link kopieren und
// Löschen mit Rückfrage auf der Seite. „Neu“ und offene Entwürfe kommen vom
// Wizard (Issue #515, sprachagent-wizard.js) unter #/neu und
// #/entwurf/<kennung>; fehlt sein Skript, bleibt der Bereich wie zuvor.
// Gebaut wird nur mit textContent, nie mit HTML aus dem Server.
// Jede Ansicht (Liste, Detail, Version) hat eine eigene Nummer: Antworten,
// die erst nach einem Wechsel ankommen, ändern die neue Ansicht nicht.
"use strict";

const VOICE_AGENTS_TEXT = {
  loading: "Wird geladen …",
  loadFailed: "Die Sprachagenten ließen sich nicht laden. Bitte später noch einmal versuchen.",
  notConfigured: "Sprachagenten gibt es in diesem tybo nicht.",
  empty: "Noch keine Sprachagenten.",
  unknown: "Diesen Sprachagenten gibt es nicht (mehr).",
  back: "Zurück zu tybo",
  backList: "Alle Sprachagenten",
  talk: "Sprechen",
  test: "Testen",
  copy: "Link kopieren",
  remove: "Löschen",
  removeQuestion: (name) => `Sprachagent ${name} löschen?`,
  removeHint: "Agent und Tests beim Anbieter werden gelöscht, das Rezept kommt ins Archiv.",
  removeConfirm: "Löschen",
  cancel: "Abbrechen",
  removed: (name) => `${name} ist gelöscht, das Rezept liegt im Archiv.`,
  copied: "Link kopiert.",
  copyManual: "Kopieren ging nicht. Der Link:",
  testRunning: (clock) => `Testlauf läuft seit ${clock} …`,
  testOrphan: "Ein Testlauf wurde gestartet, aber nicht abgeholt (etwa wegen eines Neustarts).",
  noTest: "Noch kein Testlauf.",
  sectionTest: "Letzte Testläufe",
  earlierTests: "Davor",
  sectionMinutes: "Minuten im Monat",
  sectionVersions: "Versionen",
  sectionRecipe: "Rezept",
  current: "aktuell",
  showing: (v) => `Du siehst Version ${v}.`,
  showCurrent: "Aktuelle Fassung zeigen",
  noVersions: "Noch keine Versionen.",
  versionLabel: (v, current) => `Version ${v}${current ? " (aktuell)" : ""}`,
  budget: (limit) => `Budget: ${limit} Minuten im Monat.`,
  webMinutes: (used, limit) => `Im Browser diesen Monat: ${used} von ${limit} Minuten, offene Gespräche zählen schon mit.`,
  webUnknown: "Wie viele Minuten im Browser verbraucht sind, ist gerade nicht bekannt.",
  phoneNote: "Minuten am Telefon zählt tybo hier nicht.",
  noWeb: "Kein Gespräch im Browser: Der Web-Zugang ist im Rezept aus.",
  busy: "Einen Moment …",
  failed: "Das ist fehlgeschlagen. Bitte noch einmal versuchen.",
};

const VOICE_AGENT_TEMPLATES = { anrufannahme: "Anrufannahme", jarvis: "Persönlicher Assistent", experte: "Experte zum Üben" };
const VOICE_AGENT_RESULTS = {
  bestanden: "bestanden",
  durchgefallen: "durchgefallen",
  abgebrochen: "abgebrochen",
  zeitueberschreitung: "kein Ergebnis innerhalb der Frist",
  fehler: "Abfrage gescheitert",
};

/** Kennung aus #<kennung>; null ohne oder bei Unsinn */
function voiceAgentsHashKennung(hash) {
  const match = /^#([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(hash || ""));
  return match ? match[1] : null;
}

/** Datum und Uhrzeit kurz, etwa 8.11. 14:05; "" bei allem anderen */
function voiceAgentsWhen(iso) {
  const at = new Date(String(iso || ""));
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getDate()}.${at.getMonth() + 1}. ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** „bestanden 2 von 2“ wie im Chat */
function voiceAgentsPassed(run) {
  const tests = (run && Array.isArray(run.tests) && run.tests) || [];
  return `bestanden ${tests.filter((t) => t && t.status === "bestanden").length} von ${tests.length}`;
}

/** Eine Zeile zum letzten Testlauf für Liste und Detail */
function voiceAgentsTestSummary(agent) {
  if (agent.laufenderTest) {
    return agent.laufenderTest.verfolgt ? VOICE_AGENTS_TEXT.testRunning(voiceAgentsWhen(agent.laufenderTest.gestartetAm)) : VOICE_AGENTS_TEXT.testOrphan;
  }
  const run = agent.letzterTest;
  if (!run) return VOICE_AGENTS_TEXT.noTest;
  const word = VOICE_AGENT_RESULTS[run.ergebnis] || String(run.ergebnis || "");
  const counted = run.ergebnis === "fehler" ? "" : `, ${voiceAgentsPassed(run)}`;
  return `Test ${word}${counted} (${voiceAgentsWhen(run.beendetAm)})`;
}

/** Meta-Zeile eines Listeneintrags; withTest false: ohne den Testlauf (Detail) */
function voiceAgentsMeta(agent, withTest = true) {
  const parts = [VOICE_AGENT_TEMPLATES[agent.vorlage] || agent.vorlage];
  const ways = [];
  if (agent.web) ways.push("Browser");
  if (agent.telefon) ways.push("Telefon");
  parts.push(ways.length ? ways.join(" und ") : "ohne Zugang");
  if (!agent.angelegt) parts.push("beim Anbieter nicht angelegt");
  if (withTest) parts.push(voiceAgentsTestSummary(agent));
  return parts.join(" · ");
}

/** Je eine Zeile zu den Läufen vor dem letzten (fruehereTests, neueste zuerst) */
function voiceAgentsEarlierTests(detail) {
  const runs = (detail && Array.isArray(detail.fruehereTests) && detail.fruehereTests) || [];
  return runs.filter((run) => run && typeof run === "object").map((run) => voiceAgentsTestSummary({ letzterTest: run }));
}

/** Zeilen eines Testlaufs wie im Chat, ohne Zeichen */
function voiceAgentsTestLines(run) {
  if (!run || !Array.isArray(run.tests)) return [];
  return run.tests.map((t) => {
    if (t.status === "durchgefallen") return `${t.name}: durchgefallen${t.kriterium ? `, verfehlt: ${t.kriterium}` : ""}`;
    return `${t.name}: ${t.status === "offen" ? "noch offen" : t.status}`;
  });
}

/** Sätze zu den Minuten; minutenWeb nur mit Web-Zugang (Browser-Minuten samt Reservierungen) */
function voiceAgentsMinutesLines(detail) {
  const lines = [VOICE_AGENTS_TEXT.budget(detail.minutenMonat)];
  if (detail.web) {
    const m = detail.minutenWeb;
    lines.push(m && typeof m.verbraucht === "number" ? VOICE_AGENTS_TEXT.webMinutes(m.verbraucht, m.limit) : VOICE_AGENTS_TEXT.webUnknown);
  }
  if (detail.telefon) lines.push(VOICE_AGENTS_TEXT.phoneNote);
  return lines;
}

/** Fehlersatz aus einer Antwort des Servers */
async function voiceAgentsError(res) {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || VOICE_AGENTS_TEXT.failed;
}

function voiceAgentsElement(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function startVoiceAgentsPage() {
  const doc = document;
  const el = {
    title: doc.getElementById("va-title"),
    back: doc.getElementById("va-back"),
    backLabel: doc.getElementById("va-back-label"),
    intro: doc.getElementById("va-intro"),
    status: doc.getElementById("va-status"),
    list: doc.getElementById("va-list"),
    broken: doc.getElementById("va-broken"),
    brokenList: doc.getElementById("va-broken-list"),
    detail: doc.getElementById("va-detail"),
  };
  const backText = el.backLabel.textContent;
  const listTitle = el.title.textContent;
  const pageTitle = doc.title;
  let poll = null;
  let shownKennung = null;
  /** Gezeigte Version im Detail; null für die aktuelle Fassung */
  let shownVersion = null;
  /** Nummer der aktuellen Ansicht; jede Liste, jedes Detail und jede Version zählt hoch */
  let view = 0;

  // Wizard (Issue #515): eigene Fläche, Knopf „Neu“ und Entwürfe unter der Liste
  const wizardRoot = doc.getElementById("va-wizard");
  const wizard =
    wizardRoot && typeof startVoiceAgentWizard === "function" && typeof vaWizardRoute === "function"
      ? startVoiceAgentWizard({
          doc,
          api,
          root: wizardRoot,
          drafts: doc.getElementById("va-drafts"),
          newButton: doc.getElementById("va-new"),
          setTitle: (text) => {
            el.title.textContent = text;
            doc.title = `${text} · ${pageTitle}`;
          },
          leaveToList: async (message) => {
            // Ohne hashchange: ein zweites Laden der Liste überschriebe die Meldung
            window.history.replaceState(null, "", window.location.pathname);
            wizard.close();
            await showList();
            setStatus(message);
            el.title.focus();
          },
        })
      : null;

  async function api(path, init) {
    const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json" }, ...init });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("abgemeldet");
    }
    return res;
  }

  function setStatus(text) {
    el.status.textContent = text;
    el.status.hidden = !text;
  }

  function stopPoll() {
    if (poll) clearTimeout(poll);
    poll = null;
  }

  async function showList() {
    stopPoll();
    const mine = ++view;
    shownKennung = null;
    if (wizard) wizard.hideList();
    el.detail.hidden = true;
    el.detail.replaceChildren();
    el.intro.hidden = false;
    el.title.textContent = listTitle;
    doc.title = pageTitle;
    el.back.href = "/";
    el.backLabel.textContent = backText;
    setStatus(VOICE_AGENTS_TEXT.loading);
    let res;
    try {
      res = await api("/api/voice-agents");
    } catch {
      if (mine === view) setStatus(VOICE_AGENTS_TEXT.loadFailed);
      return;
    }
    if (mine !== view) return;
    if (res.status === 503) return setStatus(VOICE_AGENTS_TEXT.notConfigured);
    if (!res.ok) {
      const error = await voiceAgentsError(res);
      if (mine === view) setStatus(error);
      return;
    }
    const body = await res.json().catch(() => null);
    if (mine !== view) return;
    const agents = (body && Array.isArray(body.agents) && body.agents) || [];
    const broken = (body && Array.isArray(body.kaputt) && body.kaputt) || [];
    el.list.replaceChildren(
      ...agents.map((agent) => {
        const li = voiceAgentsElement(doc, "li");
        const link = voiceAgentsElement(doc, "a", "voice-agents-item");
        link.href = `#${agent.kennung}`;
        link.append(voiceAgentsElement(doc, "span", "voice-agents-name", agent.name), voiceAgentsElement(doc, "span", "settings-device-meta", voiceAgentsMeta(agent)));
        li.append(link);
        if (agent.problem) li.append(voiceAgentsElement(doc, "p", "actions-error", agent.problem));
        return li;
      })
    );
    el.list.hidden = agents.length === 0;
    el.brokenList.replaceChildren(
      ...broken.map((b) => {
        const li = voiceAgentsElement(doc, "li");
        li.append(voiceAgentsElement(doc, "span", "settings-device-name", b.datei), voiceAgentsElement(doc, "p", "actions-error", (b.fehler || []).join("; ")));
        return li;
      })
    );
    el.broken.hidden = broken.length === 0;
    setStatus(agents.length === 0 ? VOICE_AGENTS_TEXT.empty : "");
    if (wizard) wizard.list(() => mine === view);
  }

  /** Fläche des Wizards: Liste und Detail treten zurück */
  function showWizard(target) {
    stopPoll();
    ++view;
    shownKennung = null;
    el.detail.hidden = true;
    el.detail.replaceChildren();
    el.intro.hidden = true;
    el.list.hidden = true;
    el.broken.hidden = true;
    wizard.hideList();
    setStatus("");
    el.back.href = "#";
    el.backLabel.textContent = VOICE_AGENTS_TEXT.backList;
    wizard.open(target);
  }

  function section(title) {
    const s = voiceAgentsElement(doc, "section", "settings-section");
    s.append(voiceAgentsElement(doc, "h2", "group-label", title));
    return s;
  }

  /** Detail bzw. ältere Version; true, wenn genau diese Ansicht gezeigt wird */
  async function showDetail(kennung, version) {
    stopPoll();
    const mine = ++view;
    const first = shownKennung !== kennung;
    shownKennung = kennung;
    shownVersion = version || null;
    el.intro.hidden = true;
    el.list.hidden = true;
    el.broken.hidden = true;
    if (wizard) wizard.hideList();
    el.back.href = "#";
    el.backLabel.textContent = VOICE_AGENTS_TEXT.backList;
    if (first) {
      el.detail.replaceChildren();
      setStatus(VOICE_AGENTS_TEXT.loading);
    }
    let res;
    try {
      res = await api(`/api/voice-agents/${kennung}/rezept${version ? `?version=${version}` : ""}`);
    } catch {
      if (mine === view) setStatus(VOICE_AGENTS_TEXT.loadFailed);
      return false;
    }
    if (mine !== view) return false;
    if (!res.ok) {
      const error = res.status === 404 ? VOICE_AGENTS_TEXT.unknown : res.status === 503 ? VOICE_AGENTS_TEXT.notConfigured : await voiceAgentsError(res);
      if (mine !== view) return false;
      el.detail.hidden = true;
      el.title.textContent = listTitle;
      setStatus(error);
      return false;
    }
    const d = await res.json().catch(() => null);
    if (mine !== view) return false;
    if (!d) {
      setStatus(VOICE_AGENTS_TEXT.loadFailed);
      return false;
    }
    setStatus("");
    renderDetail(d, version);
    if (first) el.title.focus();
    // Während ein Test läuft, holt die Seite den Stand alle drei Sekunden nach
    if (d.laufenderTest && d.laufenderTest.verfolgt) poll = setTimeout(() => showDetail(kennung, version), 3000);
    return true;
  }

  function renderDetail(d, version) {
    // Antworten auf Knöpfe dieser Ansicht gelten nur, solange sie gezeigt wird
    const at = view;
    const current = () => view === at;
    el.title.textContent = d.name;
    doc.title = `${d.name} · ${pageTitle}`;
    const parts = [];
    parts.push(voiceAgentsElement(doc, "p", "settings-intro", voiceAgentsMeta(d, false)));

    // Knöpfe
    const actions = voiceAgentsElement(doc, "div", "settings-actions voice-agent-detail-actions");
    const feedback = voiceAgentsElement(doc, "p", "actions-hint voice-agent-feedback");
    feedback.setAttribute("role", "status");
    const error = voiceAgentsElement(doc, "p", "actions-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const say = (text, isError) => {
      feedback.textContent = isError ? "" : text;
      error.textContent = isError ? text : "";
      error.hidden = !isError;
    };
    if (d.web) {
      const talk = voiceAgentsElement(doc, "a", "primary-button voice-agent-talk", VOICE_AGENTS_TEXT.talk);
      talk.href = `/sa/${d.kennung}`;
      actions.append(talk);
    }
    const test = voiceAgentsElement(doc, "button", "quiet-button", VOICE_AGENTS_TEXT.test);
    test.type = "button";
    test.disabled = Boolean(d.laufenderTest && d.laufenderTest.verfolgt);
    test.addEventListener("click", async () => {
      test.disabled = true;
      say(VOICE_AGENTS_TEXT.busy, false);
      try {
        const res = await api(`/api/voice-agents/${d.kennung}/test`, { method: "POST", body: "{}" });
        const body = await res.json().catch(() => null);
        // Inzwischen eine andere Version desselben Agenten: die gezeigte neu laden,
        // damit sie den laufenden Test zeigt und weiter abfragt
        const sameAgent = !current() && res.ok && shownKennung === d.kennung;
        if (!current() && !sameAgent) return;
        if (res.ok) {
          // Neu geladen wird nur, solange niemand zu einem anderen Agenten oder zur Liste geschaltet hat
          if (!(await showDetail(d.kennung, sameAgent ? shownVersion : version))) return;
          // renderDetail hat neu gebaut: der Hinweis gehört in die neue Ansicht
          const fresh = el.detail.querySelector(".voice-agent-feedback");
          if (fresh) fresh.textContent = (body && body.text) || "";
          return;
        }
        say((body && body.error) || VOICE_AGENTS_TEXT.failed, true);
      } catch {
        if (current()) say(VOICE_AGENTS_TEXT.failed, true);
      }
      test.disabled = false;
    });
    actions.append(test);
    if (d.web) {
      const copy = voiceAgentsElement(doc, "button", "quiet-button", VOICE_AGENTS_TEXT.copy);
      copy.type = "button";
      copy.addEventListener("click", async () => {
        say(VOICE_AGENTS_TEXT.busy, false);
        let url = "";
        try {
          const res = await api(`/api/voice-agents/${d.kennung}/link`, { method: "POST", body: "{}" });
          const body = await res.json().catch(() => null);
          if (!current()) return;
          if (!res.ok || !body || typeof body.url !== "string") return say((body && body.error) || VOICE_AGENTS_TEXT.failed, true);
          url = body.url;
          await navigator.clipboard.writeText(url);
          if (current()) say(VOICE_AGENTS_TEXT.copied, false);
        } catch {
          if (!current()) return;
          if (url) say(`${VOICE_AGENTS_TEXT.copyManual} ${url}`, false);
          else say(VOICE_AGENTS_TEXT.failed, true);
        }
      });
      actions.append(copy);
    }
    const remove = voiceAgentsElement(doc, "button", "quiet-button", VOICE_AGENTS_TEXT.remove);
    remove.type = "button";
    actions.append(remove);
    // Rückfrage in derselben Fläche, neutral wie bei Web-Gesprächen
    const confirm = voiceAgentsElement(doc, "div", "voice-agent-confirm");
    confirm.hidden = true;
    confirm.setAttribute("role", "group");
    confirm.setAttribute("aria-label", VOICE_AGENTS_TEXT.removeQuestion(d.name));
    const yes = voiceAgentsElement(doc, "button", "quiet-button settings-device-confirm", VOICE_AGENTS_TEXT.removeConfirm);
    yes.type = "button";
    const no = voiceAgentsElement(doc, "button", "quiet-button", VOICE_AGENTS_TEXT.cancel);
    no.type = "button";
    const confirmActions = voiceAgentsElement(doc, "div", "settings-actions");
    confirmActions.append(yes, no);
    confirm.append(
      voiceAgentsElement(doc, "p", "actions-question", VOICE_AGENTS_TEXT.removeQuestion(d.name)),
      voiceAgentsElement(doc, "p", "actions-hint", VOICE_AGENTS_TEXT.removeHint),
      confirmActions
    );
    remove.addEventListener("click", () => {
      actions.hidden = true;
      confirm.hidden = false;
      say("", false);
      no.focus();
    });
    no.addEventListener("click", () => {
      confirm.hidden = true;
      actions.hidden = false;
      remove.focus();
    });
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      no.disabled = true;
      say(VOICE_AGENTS_TEXT.busy, false);
      try {
        const res = await api(`/api/voice-agents/${d.kennung}/loeschen`, { method: "POST", body: JSON.stringify({ bestaetigt: true }) });
        if (!current()) {
          // Inzwischen steht die Liste da: neu laden, damit der gelöschte Agent verschwindet
          if (res.ok && shownKennung === null) await showList();
          return;
        }
        if (res.ok) {
          // Ohne hashchange: ein zweites Laden der Liste überschriebe die Meldung
          window.history.replaceState(null, "", window.location.pathname);
          await showList();
          setStatus(VOICE_AGENTS_TEXT.removed(d.name));
          return;
        }
        const message = await voiceAgentsError(res);
        if (!current()) return;
        say(message, true);
      } catch {
        if (!current()) return;
        say(VOICE_AGENTS_TEXT.failed, true);
      }
      yes.disabled = false;
      no.disabled = false;
    });
    parts.push(actions, confirm, feedback, error);
    if (!d.web) parts.push(voiceAgentsElement(doc, "p", "actions-hint", VOICE_AGENTS_TEXT.noWeb));
    if (d.problem) parts.push(voiceAgentsElement(doc, "p", "actions-error", d.problem));

    // Letzter Testlauf
    const tests = section(VOICE_AGENTS_TEXT.sectionTest);
    tests.append(voiceAgentsElement(doc, "p", "voice-agent-line", voiceAgentsTestSummary(d)));
    if (!d.laufenderTest && d.letzterTest) {
      const ul = voiceAgentsElement(doc, "ul", "voice-agent-lines");
      for (const line of voiceAgentsTestLines(d.letzterTest)) ul.append(voiceAgentsElement(doc, "li", "", line));
      tests.append(ul);
      if (d.letzterTest.grund) tests.append(voiceAgentsElement(doc, "p", "actions-hint", d.letzterTest.grund));
    }
    // Ein laufender Test steht oben; die abgeschlossenen davor darunter
    const earlier = d.laufenderTest && d.letzterTest ? [voiceAgentsTestSummary({ letzterTest: d.letzterTest }), ...voiceAgentsEarlierTests(d)] : voiceAgentsEarlierTests(d);
    if (earlier.length > 0) {
      tests.append(voiceAgentsElement(doc, "h3", "voice-agent-recipe-title", VOICE_AGENTS_TEXT.earlierTests));
      const ul = voiceAgentsElement(doc, "ul", "voice-agent-lines voice-agent-earlier");
      for (const line of earlier) ul.append(voiceAgentsElement(doc, "li", "", line));
      tests.append(ul);
    }
    parts.push(tests);

    // Minuten
    const minutes = section(VOICE_AGENTS_TEXT.sectionMinutes);
    for (const line of voiceAgentsMinutesLines(d)) minutes.append(voiceAgentsElement(doc, "p", "voice-agent-line", line));
    parts.push(minutes);

    // Versionen
    const versions = section(VOICE_AGENTS_TEXT.sectionVersions);
    const list = Array.isArray(d.versionen) ? d.versionen : [];
    if (list.length === 0) versions.append(voiceAgentsElement(doc, "p", "actions-hint", VOICE_AGENTS_TEXT.noVersions));
    else {
      const row = voiceAgentsElement(doc, "div", "settings-actions");
      for (const v of list) {
        const b = voiceAgentsElement(doc, "button", "quiet-button voice-agent-version", VOICE_AGENTS_TEXT.versionLabel(v.version, v.aktuell));
        b.type = "button";
        const selected = version ? v.version === version : v.aktuell;
        b.setAttribute("aria-pressed", selected ? "true" : "false");
        b.disabled = !v.lesbar;
        b.addEventListener("click", () => showDetail(d.kennung, v.aktuell ? null : v.version));
        row.append(b);
      }
      versions.append(row);
    }
    if (version) {
      versions.append(voiceAgentsElement(doc, "p", "actions-hint", VOICE_AGENTS_TEXT.showing(version)));
      const back = voiceAgentsElement(doc, "button", "quiet-button", VOICE_AGENTS_TEXT.showCurrent);
      back.type = "button";
      back.addEventListener("click", () => showDetail(d.kennung, null));
      versions.append(back);
    }
    parts.push(versions);

    // Rezept in Klartext
    const recipe = section(version ? `${VOICE_AGENTS_TEXT.sectionRecipe}, Version ${version}` : VOICE_AGENTS_TEXT.sectionRecipe);
    for (const s of Array.isArray(d.rezept) ? d.rezept : []) {
      recipe.append(voiceAgentsElement(doc, "h3", "voice-agent-recipe-title", s.titel));
      const dl = voiceAgentsElement(doc, "dl", "voice-agent-recipe");
      for (const z of s.zeilen || []) dl.append(voiceAgentsElement(doc, "dt", "", z.feld), voiceAgentsElement(doc, "dd", "", z.wert));
      recipe.append(dl);
    }
    parts.push(recipe);

    el.detail.replaceChildren(...parts);
    el.detail.hidden = false;
  }

  function route() {
    const target = wizard ? vaWizardRoute(window.location.hash) : null;
    if (target) return showWizard(target);
    if (wizard) wizard.close();
    const kennung = voiceAgentsHashKennung(window.location.hash);
    if (kennung) showDetail(kennung, null);
    else showList();
  }

  window.addEventListener("hashchange", route);
  route();
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById("va-list")) {
  startVoiceAgentsPage();
}
