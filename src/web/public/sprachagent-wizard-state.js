// Wizard für Sprachagenten (Issue #515): Zustand ohne DOM, damit er sich ohne
// Browser prüfen lässt (tests/voice-agent-wizard-state.test.ts). Die
// Oberfläche steht in sprachagent-wizard.js.
//
// - Schritte, Pflichtfelder je Vorlage (vor dem Bauen mindestens die aus
//   missingForBuild des Servers, beim Experten genau drei Kriterien), Weiter
//   und Zurück.
// - Felder zum Senden: ohne Gedächtnis (der Server setzt es je Vorlage, so
//   bleibt nach einem Vorlagenwechsel kein altes zurück), Regeln nur die
//   eigenen, leere Einträge weg. Felder anderer Vorlagen bleiben gespeichert.
//   Schalter, die die Seite als aus zeigt (Browser-Zugang, Denkauftrag), gehen
//   ausdrücklich als false mit, sonst behielte das Rezept den Wert des Jobs.
// - Unfertige Eingaben (halber Link, Telefon ohne fertige Kennung der Nummer)
//   gehen getrennt als „offen“ mit (vaWizardOpenInputs) und kommen beim Laden
//   zurück auf die Seite (vaWizardWithOpen): Neuladen verliert nichts, gebaut
//   wird nur aus gültigen Vorgaben.
// - Vorschlag: füllt nur Felder, die der Nutzer nicht angefasst hat und die
//   leer sind; sonst „Vorschlag verworfen, Ihre Eingaben bleiben“.
// - Speichern (vaWizardSaver): nacheinander, nie parallel, entprellt, mit der
//   aktuellen revision, dazu Satz und Schritt; nach Anhängen gilt deren revision. Bei 409 „veraltet“
//   den Entwurf neu laden, die ungespeicherten Eingaben darüberlegen und
//   einmal erneut speichern; scheitert das, bleibt alles auf der Seite. Nach
//   dem Bauen sendet er nichts mehr.
// - Kennung: Das erste Speichern legt den Entwurf an und reserviert sie
//   (vaWizardCreate). Ändert der Nutzer sie danach, zieht der Server den
//   Entwurf mit Feldern und Anhängen um (rename); bei einem Konflikt bleibt
//   alles unter der alten Kennung und auf der Seite.
// - Adressen: /sprachagenten#/neu und #/entwurf/<kennung> (vaWizardRoute).
//   Mit dem Schrägstrich kollidieren sie mit keiner Kennung eines Agenten.
"use strict";

const VA_WIZARD_STEPS = ["Zweck", "Stimme", "Wissen und Verhalten", "Zugang", "Prüfen und Starten"];
const VA_WIZARD_TEMPLATES = {
  anrufannahme: { label: "Anrufannahme", hint: "Nimmt Anrufe an, wenn Sie nicht abheben, und notiert, was der Anrufer will." },
  jarvis: { label: "Persönlicher Assistent", hint: "Spricht mit Ihnen, kennt Ihr Gedächtnis und Ihre Termine." },
  experte: { label: "Experte zum Üben", hint: "Ein Gesprächspartner mit recherchiertem Wissen, etwa für Verhandlungen." },
};
const VA_WIZARD_KENNUNG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VA_WIZARD_RESERVED = ["session", "rezept", "test", "link", "loeschen", "vorschlag", "entwuerfe", "stimmen", "hoerprobe"];
/** Kennung einer Nummer beim Anbieter, wie im Schema des Servers */
const VA_WIZARD_NUMBER = /^[A-Za-z0-9_-]{1,64}$/;
const VA_WIZARD_LIMITS = { fragen: 8, frage: 200, abschlusssatz: 466, kriterien: 3, links: 10, rollen: 10, einwaende: 10 };
/** Felder, die der Vorschlag füllen darf (Pfad mit Punkten) */
const VA_WIZARD_PROPOSAL_PATHS = [
  "vorlage",
  "name",
  "zweck",
  "persona.rolle",
  "persona.anrede",
  "persona.sprachen",
  "persona.ersterSatz",
  "regeln",
  "training.rollen",
  "training.einwaende",
  "training.kriterien",
  "training.abschlussfrage",
  "thema",
  "anrufannahme.fragen",
  "anrufannahme.abschlusssatz",
  "gehirn.denkauftrag",
];

const VA_WIZARD_TEXT = {
  proposalDropped: "Vorschlag verworfen, Ihre Eingaben bleiben.",
  saveFailed: "Speichern ging nicht. Ihre Eingaben bleiben auf der Seite, bitte später noch einmal versuchen.",
  saveStale: "Der Entwurf wurde inzwischen anderswo geändert. Ihre Eingaben bleiben auf der Seite, bitte die Seite neu laden.",
  saveGone: "Diesen Entwurf gibt es nicht mehr.",
  saveBuilt: "Der Entwurf wird schon gebaut und lässt sich nicht mehr ändern.",
  createFailed: "Der Entwurf ließ sich nicht anlegen. Ihre Eingaben bleiben auf der Seite, bitte später noch einmal versuchen.",
  renameFailed: "Die Kennung ließ sich nicht ändern. Der Entwurf bleibt unter der bisherigen Kennung.",
  buildFailed: "Das Bauen ließ sich nicht starten. Bitte später noch einmal versuchen.",
  saving: "Wird gespeichert …",
  saved: "Gespeichert.",
  rueckfrage: {
    stimme: "Im Direktchat wartet die Stimmwahl auf Sie.",
    freigabe: "Im Direktchat wartet die Freigabe auf Sie: Dort steht die Zusammenfassung mit „Anlegen“ und „Verwerfen“.",
    freischalten: "Tests sind durchgefallen. Im Direktchat entscheiden Sie, ob Sie trotzdem freischalten oder gesperrt lassen.",
    fortsetzen: "Das Anlegen wurde unterbrochen. Im Direktchat können Sie es erneut versuchen oder verwerfen.",
  },
  testStatus: { bestanden: "bestanden", durchgefallen: "durchgefallen", abgebrochen: "abgebrochen", offen: "noch offen" },
  runStatus: {
    bestanden: "Alle Tests bestanden.",
    durchgefallen: "Mindestens ein Test ist durchgefallen.",
    abgebrochen: "Der Testlauf wurde abgebrochen.",
    zeitueberschreitung: "Kein Testergebnis innerhalb der Frist.",
    fehler: "Die Abfrage der Tests ist gescheitert.",
    laufend: "Der Testlauf läuft noch.",
    fehlt: "Das Ergebnis des Testlaufs liegt nicht (mehr) vor.",
  },
};

// --- Pfade --------------------------------------------------------------------

function vaWizardClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function vaWizardGet(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** Setzt einen Wert; undefined entfernt ihn. Liefert ein neues Objekt */
function vaWizardSet(obj, path, value) {
  const out = vaWizardClone(obj) || {};
  const keys = path.split(".");
  let at = out;
  for (const k of keys.slice(0, -1)) {
    if (!at[k] || typeof at[k] !== "object" || Array.isArray(at[k])) at[k] = {};
    at = at[k];
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete at[last];
  else at[last] = vaWizardClone(value);
  return out;
}

function vaWizardEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every((v) => vaWizardEmpty(v));
  return false;
}

// --- Felder ---------------------------------------------------------------------

/** Felder aus der Antwort des Servers für die Oberfläche: Regeln nur die eigenen als Text */
function vaWizardFromServer(felder) {
  const out = vaWizardClone(felder) || {};
  if (Array.isArray(out.regeln)) {
    const own = out.regeln.filter((r) => typeof r === "string" || (r && !r.fest)).map((r) => (typeof r === "string" ? r : r.text));
    if (own.length) out.regeln = own;
    else delete out.regeln;
  }
  return out;
}

/** Feste Regeln der Vorlage aus der Antwort des Servers (Text) */
function vaWizardFixedRules(felder) {
  return (Array.isArray(felder && felder.regeln) ? felder.regeln : []).filter((r) => r && typeof r === "object" && r.fest).map((r) => r.text);
}

/**
 * Felder zum Senden. Gedächtnis fehlt: Der Server setzt es je Vorlage. Leere
 * Listeneinträge und leere Texte fallen weg. Eigene Regeln gehen zusammen mit
 * den festen der gewählten Vorlage zurück (fixedRules: festeRegeln aus der
 * Antwort des Servers), sonst hielte der Server sie für abgeschaltet; ohne
 * eigene Regeln fehlt das Feld. Was noch nicht gültig ist (Telefon ohne
 * Kennung der Nummer, ein halb getippter Link), bleibt auf der Seite und geht
 * erst mit, wenn es stimmt: Sonst lehnte der Server jedes Speichern ab.
 */
function vaWizardSendFields(felder, fixedRules) {
  const out = vaWizardClone(felder) || {};
  delete out.gedaechtnis;
  const clean = (list) => (Array.isArray(list) ? list.map((v) => (typeof v === "string" ? v.trim() : v)).filter((v) => !vaWizardEmpty(v)) : list);
  if (out.persona) {
    delete out.persona.kiHinweis;
    for (const k of Object.keys(out.persona)) if (typeof out.persona[k] === "string" && out.persona[k].trim() === "") delete out.persona[k];
    if (Object.keys(out.persona).length === 0) delete out.persona;
  }
  if (Array.isArray(out.regeln)) {
    const own = clean(out.regeln);
    const fixed = (fixedRules && (fixedRules[out.vorlage] || (!out.vorlage && fixedRules.basis))) || [];
    if (own.length) out.regeln = [...fixed.map((text) => ({ text, fest: true })), ...own.filter((r) => !fixed.includes(r))];
    else delete out.regeln;
  }
  if (out.training) {
    for (const k of ["rollen", "einwaende", "kriterien"]) if (Array.isArray(out.training[k])) out.training[k] = clean(out.training[k]);
    if (typeof out.training.abschlussfrage === "string" && !out.training.abschlussfrage.trim()) delete out.training.abschlussfrage;
  }
  if (out.anrufannahme) {
    if (Array.isArray(out.anrufannahme.fragen)) out.anrufannahme.fragen = clean(out.anrufannahme.fragen);
    if (typeof out.anrufannahme.abschlusssatz === "string" && !out.anrufannahme.abschlusssatz.trim()) delete out.anrufannahme.abschlusssatz;
  }
  if (Array.isArray(out.links)) out.links = clean(out.links).filter((l) => vaWizardLinkOk(l));
  for (const k of ["name", "zweck", "thema"]) if (typeof out[k] === "string" && !out[k].trim()) delete out[k];
  if (out.zugang && (out.zugang.telefon === null || (out.zugang.telefon && !VA_WIZARD_NUMBER.test(String(out.zugang.telefon.nummer || ""))))) delete out.zugang.telefon;
  // Was die Seite als aus zeigt, ist aus: sonst übernähme das Rezept den Wert des Jobs
  out.zugang = { ...(out.zugang || {}), web: Boolean(out.zugang && out.zugang.web === true) };
  out.gehirn = { ...(out.gehirn || {}), denkauftrag: Boolean(out.gehirn && out.gehirn.denkauftrag === true) };
  return out;
}

/**
 * Unfertige Eingaben: was vaWizardSendFields weglässt, weil es noch keine
 * gültige Vorgabe ist. links ist dann die ganze Liste ohne leere Zeilen,
 * telefon die Angaben zum Telefon. undefined, wenn nichts offen ist.
 */
function vaWizardOpenInputs(felder) {
  const f = felder || {};
  const out = {};
  const links = Array.isArray(f.links) ? f.links.filter((l) => typeof l === "string" && l.trim() !== "") : [];
  if (links.some((l) => !vaWizardLinkOk(l))) out.links = links.slice(0, VA_WIZARD_LIMITS.links).map((l) => l.slice(0, 500));
  const tel = f.zugang && f.zugang.telefon;
  if (tel && !VA_WIZARD_NUMBER.test(String(tel.nummer || ""))) {
    out.telefon = { nummer: String(tel.nummer || "").slice(0, 64), anrufer: tel.anrufer === "alle" ? "alle" : "freigegeben", ...(typeof tel.pin === "boolean" ? { pin: tel.pin } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Unfertige Eingaben aus dem Entwurf wieder auf die Seite legen */
function vaWizardWithOpen(felder, offen) {
  let out = vaWizardClone(felder) || {};
  if (!offen || typeof offen !== "object") return out;
  if (Array.isArray(offen.links) && offen.links.length) out = vaWizardSet(out, "links", offen.links);
  if (offen.telefon && typeof offen.telefon === "object" && !(out.zugang && out.zugang.telefon)) out = vaWizardSet(out, "zugang.telefon", offen.telefon);
  return out;
}

/** Felder einer Antwort des Servers für die Seite: gültige Vorgaben und darüber die unfertigen Eingaben */
function vaWizardFromView(view) {
  return vaWizardWithOpen(vaWizardFromServer(view && view.felder), view && view.offen);
}

/** Inhalt eines PUT: Felder, unfertige Eingaben, dazu Satz und Schritt, wenn bekannt */
function vaWizardPutBody(felder, fixedRules, extra) {
  const body = { ...(extra || {}), felder: vaWizardSendFields(felder, fixedRules) };
  const offen = vaWizardOpenInputs(felder);
  if (offen) body.offen = offen;
  return body;
}

/** Link für die Recherche: https, ohne Zugangsdaten, höchstens 500 Zeichen (wie der Server) */
function vaWizardLinkOk(link) {
  const text = String(link || "").trim();
  if (!text || text.length > 500) return false;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Kennung prüfen; null heißt gültig, sonst der Satz für den Nutzer */
function vaWizardKennungProblem(kennung) {
  const k = String(kennung || "");
  if (!k) return "Bitte eine Kennung angeben.";
  if (k.length > 64 || !VA_WIZARD_KENNUNG.test(k)) return "Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche, höchstens 64 Zeichen.";
  if (VA_WIZARD_RESERVED.includes(k)) return `„${k}“ ist reserviert, bitte eine andere Kennung wählen.`;
  return null;
}

/** Kennung aus einem Namen, wie suggestKennung auf dem Server */
function vaWizardSlug(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return vaWizardKennungProblem(slug) ? "" : slug;
}

/**
 * Was in einem Schritt fehlt: [{ feld, text }]. Schritt 5 prüft alles, was
 * zum Bauen nötig ist (die Pflichtfelder des Servers und die des Wizards).
 */
function vaWizardMissing(state, step) {
  const f = state.felder || {};
  const out = [];
  const add = (feld, text) => out.push({ feld, text });
  const all = step === 5;
  if (step === 1 || all) {
    if (!f.vorlage) add("vorlage", "Bitte eine Vorlage wählen.");
    if (vaWizardEmpty(f.name)) add("name", "Bitte einen Namen angeben.");
    if (vaWizardEmpty(f.zweck)) add("zweck", "Bitte in einem Satz sagen, wofür der Agent da ist.");
    const problem = vaWizardKennungProblem(state.kennung);
    if (problem) add("kennung", problem);
  }
  if (step === 3 || all) {
    if (f.vorlage === "experte") {
      const kriterien = ((f.training && f.training.kriterien) || []).filter((k) => !vaWizardEmpty(k));
      if (kriterien.length !== VA_WIZARD_LIMITS.kriterien) add("training.kriterien", "Der Experte braucht genau drei Kriterien, an denen Sie Ihr Gespräch messen.");
      if ((f.links || []).some((l) => !vaWizardEmpty(l) && !vaWizardLinkOk(l))) add("links", "Ein Link ist keine gültige Adresse mit https.");
    }
    if (f.vorlage === "anrufannahme") {
      const satz = (f.anrufannahme && f.anrufannahme.abschlusssatz) || "";
      if (satz.length > VA_WIZARD_LIMITS.abschlusssatz) add("anrufannahme.abschlusssatz", `Der Abschlusssatz hat höchstens ${VA_WIZARD_LIMITS.abschlusssatz} Zeichen.`);
      const fragen = ((f.anrufannahme && f.anrufannahme.fragen) || []).filter((q) => !vaWizardEmpty(q));
      if (fragen.length > VA_WIZARD_LIMITS.fragen) add("anrufannahme.fragen", `Höchstens ${VA_WIZARD_LIMITS.fragen} Fragen.`);
      if (fragen.some((q) => q.length > VA_WIZARD_LIMITS.frage)) add("anrufannahme.fragen", `Eine Frage hat höchstens ${VA_WIZARD_LIMITS.frage} Zeichen.`);
    }
  }
  if (step === 4 || all) {
    const tel = f.zugang && f.zugang.telefon;
    if (tel) {
      if (!VA_WIZARD_NUMBER.test(String(tel.nummer || ""))) add("zugang.telefon.nummer", "Bitte die Kennung der Nummer beim Anbieter eintragen (Buchstaben, Ziffern, _ und -).");
      if (f.vorlage === "experte" && tel.anrufer === "alle") add("zugang.telefon.anrufer", "Ein Experte nimmt nur freigegebene Anrufer an; bei allen Anrufern hätte er kein Wissen.");
    }
  }
  return out;
}

/** Nächster Schritt; bleibt stehen, solange im aktuellen etwas fehlt */
function vaWizardNext(state) {
  const missing = vaWizardMissing(state, state.schritt);
  if (missing.length) return { schritt: state.schritt, fehlt: missing };
  return { schritt: Math.min(VA_WIZARD_STEPS.length, state.schritt + 1), fehlt: [] };
}

/** Zurück geht immer, vor und nach dem Bauen; nach dem Bauen nur zum Ansehen */
function vaWizardBack(state) {
  return { schritt: Math.max(1, state.schritt - 1) };
}

/** Nach dem Bauen (Phase nicht mehr „wizard“) ist nichts mehr zu ändern */
function vaWizardReadOnly(state) {
  return Boolean(state.phase) && state.phase !== "wizard";
}

/** In welchem Schritt sich ein Entwurf öffnet */
function vaWizardResumeStep(entry) {
  if (!entry || entry.phase !== "wizard") return 5;
  const s = Number(entry.schritt);
  return Number.isInteger(s) && s >= 1 && s <= 5 ? s : 1;
}

/**
 * Vorlage wechseln: Felder anderer Vorlagen bleiben gespeichert (Training,
 * Thema, Links, Fragen, Denkauftrag), das Gedächtnis setzt der Server neu.
 */
function vaWizardSwitchTemplate(felder, vorlage) {
  const out = vaWizardClone(felder) || {};
  out.vorlage = vorlage;
  delete out.gedaechtnis;
  return out;
}

/**
 * Vorschlag einarbeiten. touched: Pfade, die der Nutzer schon geändert hat.
 * Gefüllt werden nur Felder, die nicht angefasst und leer sind. dropped: ob
 * ein Teil des Vorschlags wegen eigener Eingaben verworfen wurde.
 */
function vaWizardMergeProposal(state, proposal, touched) {
  const changed = new Set(touched || []);
  const incoming = vaWizardFromServer(proposal && proposal.felder);
  let felder = vaWizardClone(state.felder) || {};
  let dropped = false;
  const isTouched = (path) => [...changed].some((t) => t === path || path.startsWith(`${t}.`) || t.startsWith(`${path}.`));
  for (const path of VA_WIZARD_PROPOSAL_PATHS) {
    const value = vaWizardGet(incoming, path);
    if (vaWizardEmpty(value)) continue;
    const current = vaWizardGet(felder, path);
    if (isTouched(path) || !vaWizardEmpty(current)) {
      if (JSON.stringify(current) !== JSON.stringify(value)) dropped = true;
      continue;
    }
    felder = vaWizardSet(felder, path, value);
  }
  let kennung = state.kennung || "";
  const proposed = String((proposal && proposal.kennung) || "");
  if (proposed && proposed !== kennung) {
    if (state.kennungFest || isTouched("kennung") || kennung) dropped = true;
    else kennung = proposed;
  }
  return { felder, kennung, dropped };
}

// --- Klartext -------------------------------------------------------------------

/** Zusammenfassung für Schritt 5: Abschnitte mit Zeilen, nur Klartext, nie JSON oder Feldnamen */
function vaWizardSummary(view, voices) {
  const f = vaWizardFromServer(view.felder);
  const v = f.vorlage;
  const yes = (b) => (b ? "ja" : "nein");
  const list = (items) => (items && items.length ? items.join("; ") : "keine");
  const sections = [];
  sections.push({
    titel: "Allgemein",
    zeilen: [
      { feld: "Vorlage", wert: (VA_WIZARD_TEMPLATES[v] && VA_WIZARD_TEMPLATES[v].label) || "noch nicht gewählt" },
      { feld: "Name", wert: f.name || "noch leer" },
      { feld: "Kennung", wert: view.kennung || "noch leer" },
      { feld: "Zweck", wert: f.zweck || "noch leer" },
    ],
  });
  let stimme = "Wahl im Direktchat nach dem Bauen";
  if (f.stimme && f.stimme.wahl === "standard") stimme = "Standardstimme aus den Einstellungen";
  if (f.stimme && f.stimme.wahl === "konto") {
    const found = ((voices && voices.konto) || []).find((x) => x.voiceId === f.stimme.voiceId);
    stimme = `${(found && found.name) || f.stimme.name || "Stimme des Kontos"} (Stimme Ihres Kontos beim Anbieter)`;
  }
  const p = f.persona || {};
  const lang = { de: "Deutsch", en: "Englisch" };
  sections.push({
    titel: "Stimme und Auftreten",
    zeilen: [
      { feld: "Stimme", wert: stimme },
      { feld: "Rolle", wert: p.rolle || "ergänzt tybo beim Bauen" },
      { feld: "Anrede", wert: p.anrede === "sie" ? "Sie" : p.anrede === "du" ? "du" : "ergänzt tybo beim Bauen" },
      { feld: "Sprache", wert: Array.isArray(p.sprachen) && p.sprachen.length ? p.sprachen.map((s) => lang[s] || s).join(", ") : "ergänzt tybo beim Bauen" },
      { feld: "Erster Satz", wert: p.ersterSatz || "ergänzt tybo beim Bauen" },
    ],
  });
  const know = [];
  if (v === "experte") {
    const t = f.training || {};
    know.push({ feld: "Thema", wert: f.thema || "ergänzt tybo beim Bauen" });
    know.push({ feld: "Rollen", wert: list(t.rollen) });
    know.push({ feld: "Einwände", wert: list(t.einwaende) });
    know.push({ feld: "Kriterien", wert: list(t.kriterien) });
    know.push({ feld: "Links", wert: list(f.links) });
    know.push({ feld: "Dateien", wert: list((view.anhaenge || []).map((a) => a.name)) });
  } else if (v === "anrufannahme") {
    const a = f.anrufannahme || {};
    know.push({ feld: "Fragen an den Anrufer", wert: list(a.fragen) });
    know.push({ feld: "Abschlusssatz", wert: a.abschlusssatz || "keiner" });
  } else if (v === "jarvis") {
    know.push({ feld: "Denkauftrag", wert: f.gehirn && f.gehirn.denkauftrag ? "an: Schwierige Fragen gibt der Agent zum Nachdenken an tybo weiter" : "aus" });
  }
  if (f.regeln && f.regeln.length) know.push({ feld: "Eigene Regeln", wert: list(f.regeln) });
  sections.push({ titel: "Wissen und Verhalten", zeilen: know });
  const z = f.zugang || {};
  const tel = z.telefon;
  const access = [
    { feld: "Im Browser", wert: yes(z.web) },
    { feld: "Telefon", wert: tel ? `ja, Nummer beim Anbieter ${tel.nummer || "noch leer"}` : "nein" },
  ];
  if (tel) {
    access.push({ feld: "Anrufer", wert: tel.anrufer === "alle" ? "alle" : "nur freigegebene" });
    access.push({ feld: "PIN verlangen", wert: yes(tel.pin) });
  }
  if (z.maxMinuten) access.push({ feld: "Höchstens je Gespräch", wert: `${z.maxMinuten} Minuten` });
  if (z.minutenMonat) access.push({ feld: "Höchstens im Monat", wert: `${z.minutenMonat} Minuten` });
  access.push({ feld: "Geschätzte Kosten", wert: vaWizardCostText(view.kosten) });
  sections.push({ titel: "Zugang", zeilen: access });
  sections.push({ titel: "Feste Regeln", zeilen: (view.feste || []).map((e) => ({ feld: e.grund, wert: vaWizardFixedValue(e) })) });
  return sections;
}

/** Wert einer festen Regel in Klartext */
function vaWizardFixedValue(entry) {
  if (entry.feld === "gedaechtnis") return { keins: "kein Gedächtnis", thema: "nur das recherchierte Wissen", voll: "volles Gedächtnis" }[entry.wert] || String(entry.wert);
  if (entry.feld === "zugang.telefon.pin") return "PIN ist Pflicht";
  return String(entry.wert);
}

/** Kosten aus dem Entwurf in einem Satz */
function vaWizardCostText(kosten) {
  if (!kosten || kosten.status !== "ok" || typeof kosten.jeMinute !== "number") return "nicht bekannt";
  const money = (n) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${kosten.waehrung || ""}`.trim();
  const parts = [`etwa ${money(kosten.jeMinute)} je Minute`];
  if (typeof kosten.jeGespraech === "number") parts.push(`höchstens ${money(kosten.jeGespraech)} je Gespräch`);
  if (kosten.credits && typeof kosten.credits.jeMinute === "number") parts.push(`${kosten.credits.jeMinute.toLocaleString("de-DE")} Credits je Minute`);
  return parts.join(", ");
}

/** Hinweise zur Kostenschätzung ohne Feldnamen: Die Höchstdauer heißt im Rezept maxMinuten, hier nicht */
function vaWizardCostNotes(kosten) {
  const lines = (kosten && Array.isArray(kosten.hinweise) && kosten.hinweise) || [];
  return lines.map((line) => (/maxMinuten/.test(String(line)) ? "Ohne Höchstdauer je Gespräch gibt es keine Schätzung je Gespräch" : String(line)));
}

/** Satz zur offenen Rückfrage; "" ohne */
function vaWizardQuestionText(progress) {
  return (progress && VA_WIZARD_TEXT.rueckfrage[progress.rueckfrage]) || "";
}

/** Testergebnisse: { satz, zeilen: [{ name, status, grund? }] } oder null */
function vaWizardTests(progress) {
  const t = progress && progress.tests;
  if (!t || typeof t !== "object") return null;
  const zeilen = (Array.isArray(t.liste) ? t.liste : []).map((x) => ({
    name: String(x.name || ""),
    status: VA_WIZARD_TEXT.testStatus[x.status] || String(x.status || ""),
    ...(x.status === "durchgefallen" ? { grund: x.grund || "Der Anbieter nennt keinen Grund." } : {}),
  }));
  const satz = [VA_WIZARD_TEXT.runStatus[t.status] || "", t.grund || t.text || ""].filter(Boolean).join(" ");
  return { satz, zeilen };
}

/** „Sprechen“ nur mit Freischaltung und Web-Zugang */
function vaWizardCanTalk(progress) {
  return Boolean(progress && progress.freigeschaltet === true && progress.web === true);
}

/** Läuft im Hintergrund noch etwas, das die Seite nachfragen soll? */
function vaWizardPolling(progress) {
  return Boolean(progress) && ["job", "stimme", "freigabe", "anlegen"].includes(progress.phase);
}

/** Fehler des Servers ohne Feldnamen: „name: Pflicht zum Bauen“ wird zu „Pflicht zum Bauen“ mit Klartext davor */
function vaWizardPlainErrors(fehler) {
  const names = {
    vorlage: "Vorlage",
    name: "Name",
    zweck: "Zweck",
    stimme: "Stimme",
    "zugang.telefon.anrufer": "Anrufer",
    "zugang.telefon.nummer": "Nummer beim Anbieter",
    "zugang.telefon.pin": "PIN",
    gedaechtnis: "Gedächtnis",
    "persona.kiHinweis": "KI-Hinweis",
    regeln: "Regeln",
    "anrufannahme.abschlusssatz": "Abschlusssatz",
    "anrufannahme.fragen": "Fragen an den Anrufer",
    "training.kriterien": "Kriterien",
    thema: "Thema",
    links: "Links",
    tests: "Tests",
  };
  return (Array.isArray(fehler) ? fehler : []).map((raw) => {
    const text = String(raw || "");
    const m = /^([A-Za-z][A-Za-z0-9_.\[\]]*):\s*(.+)$/.exec(text);
    if (!m) return text;
    const field = m[1].replace(/\[\d+\]/g, "");
    const key = Object.keys(names)
      .filter((k) => field === k || field.startsWith(`${k}.`))
      .sort((x, y) => y.length - x.length)[0];
    const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return key ? `${names[key]}: ${rest}` : rest;
  });
}

/** Adresse des Wizards: { neu: true }, { kennung } oder null (dann Liste oder Detail eines Agenten) */
function vaWizardRoute(hash) {
  const h = String(hash || "");
  if (h === "#/neu") return { neu: true };
  const m = /^#\/entwurf\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(h);
  return m && m[1].length <= 64 ? { kennung: m[1] } : null;
}

function vaWizardHash(kennung) {
  return kennung ? `#/entwurf/${kennung}` : "#/neu";
}

/** Darf der Schritt geöffnet werden? Zurück immer, vor nur, wenn davor nichts fehlt; nach dem Bauen jeder */
function vaWizardCanOpen(state, step) {
  if (step < 1 || step > VA_WIZARD_STEPS.length) return false;
  if (vaWizardReadOnly(state) || step <= state.schritt) return true;
  for (let s = 1; s < step; s++) if (vaWizardMissing(state, s).length) return false;
  return true;
}

/**
 * Stimme beim ersten Öffnen von Schritt 2: Gibt es eine Standardstimme und ist
 * noch nichts gewählt, ist sie vorausgewählt. Eine Stimme des Kontos, die es
 * nicht mehr gibt, fällt ebenso darauf zurück (ohne Standardstimme: keine Wahl).
 */
function vaWizardDefaultVoice(felder, voices) {
  const hasStandard = Boolean(voices && voices.standard);
  const konto = (voices && Array.isArray(voices.konto) && voices.konto) || [];
  const v = felder && felder.stimme;
  if (v && v.wahl === "konto" && konto.some((x) => x.voiceId === v.voiceId)) return v;
  if (v && v.wahl === "standard" && hasStandard) return v;
  if (v && v.wahl === "konto" && !voices) return v;
  return hasStandard ? { wahl: "standard" } : undefined;
}

/** Anfrage der Hörprobe: genau die Stimme der Zeile, dazu die erste Sprache des Agenten */
function vaWizardProbeBody(choice, felder) {
  const sprache = felder && felder.persona && Array.isArray(felder.persona.sprachen) && /^[a-z]{2}$/.test(String(felder.persona.sprachen[0] || "")) ? felder.persona.sprachen[0] : "de";
  return choice && choice.voiceId ? { voiceId: choice.voiceId, sprache } : { standard: true, sprache };
}

/** Meta-Zeile eines Entwurfs in der Liste: Vorlage und Phase in Klartext */
function vaWizardDraftMeta(entry) {
  const template = VA_WIZARD_TEMPLATES[entry && entry.vorlage];
  return [template ? template.label : "Vorlage noch offen", (entry && entry.phaseText) || ""].filter(Boolean).join(" · ");
}

/** Feste Regeln für einen Schritt: 2 der KI-Hinweis, 3 Regeln und Gedächtnis, 4 PIN und Gedächtnis bei Fremden am Telefon */
function vaWizardFixedFor(view, step) {
  const feste = (view && Array.isArray(view.feste) && view.feste) || [];
  const telefon = Boolean(view && view.felder && view.felder.zugang && view.felder.zugang.telefon);
  return feste
    .filter((e) => {
      if (step === 2) return e.feld === "persona.kiHinweis";
      if (step === 3) return e.feld === "regeln" || e.feld === "gedaechtnis";
      if (step === 4) return e.feld === "zugang.telefon.pin" || (telefon && e.feld === "gedaechtnis");
      return false;
    })
    .map((e) => ({ grund: e.grund, wert: vaWizardFixedValue(e), feld: e.feld }));
}

/** Ist die PIN fest (Gedächtnis voll am Telefon)? Dann zeigt der Schalter „an“ und ist gesperrt */
function vaWizardPinFixed(view) {
  return ((view && view.feste) || []).some((e) => e.feld === "zugang.telefon.pin");
}

// --- Speichern ------------------------------------------------------------------

/** Antwort einer Anfrage; ein Netzfehler wird zu Status 0 statt zu einem Wurf */
async function vaWizardCall(fn) {
  try {
    const res = await fn();
    return res && typeof res.status === "number" ? res : { status: 0, body: null };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Entwurf anlegen (erstes Speichern): reserviert die Kennung. Bei einem
 * Konflikt (vergeben, belegt, schon ein Wizard) oder Fehler bleibt alles auf
 * der Seite; der Satz des Servers steht in error.
 */
async function vaWizardCreate(request, kennung, state) {
  const res = await vaWizardCall(() =>
    request("PUT", `/api/voice-agents/wizard/${encodeURIComponent(kennung)}`, vaWizardPutBody(state.felder, state.festeRegeln, { ...(state.satz ? { satz: state.satz } : {}), schritt: state.schritt })),
  );
  if (res.status === 201 && res.body) return { ok: true, view: res.body };
  const reason = (res.body && res.body.reason) || "fehler";
  return { ok: false, reason, error: (res.body && res.body.error) || VA_WIZARD_TEXT.createFailed, fehler: vaWizardPlainErrors(res.body && res.body.fehler), kennung: ["vergeben", "belegt", "existiert", "kennung"].includes(reason) };
}

/**
 * Speichern nacheinander. deps:
 * - request(method, path, body): Promise<{ status, body }> (Fetch-Hülle)
 * - kennung, revision: Stand nach dem Anlegen
 * - fields(): aktuelle Felder des Entwurfs; dirty(): Pfade, die noch nicht gespeichert sind
 * - satz(): optional, der Satz aus Schritt 1; geht mit jedem Speichern mit ("" löscht ihn)
 * - fixedRules(): feste Regeln je Vorlage (festeRegeln des Servers), für eigene Regeln
 * - schritt(): aktueller Schritt; onSaved(view, gespeichertePfade, gesendeteFelder, gesendeterSatz),
 *   onMerged(felder) nach einem 409, onState(text, isError)
 * Alle Abfragen gehören zu genau einem Entwurf: Die Oberfläche bindet sie an
 * dessen Zustand, nie an die gerade gezeigte Seite.
 * - upload(path, name, bytes): Promise<{ status, body }>
 * - setTimer, clearTimer, debounceMs
 */
function vaWizardSaver(deps) {
  let revision = deps.revision;
  let chain = Promise.resolve();
  let timer = null;
  let frozen = false;
  const debounceMs = deps.debounceMs === undefined ? 600 : deps.debounceMs;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  let kennung = deps.kennung;
  let path = `/api/voice-agents/wizard/${encodeURIComponent(kennung)}`;
  const request = (method, url, body) => vaWizardCall(() => deps.request(method, url, body));

  /** Eine Aufgabe hinten anstellen; Fehler brechen die Kette nicht */
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  async function putOnce(felder, satz) {
    return request("PUT", path, vaWizardPutBody(felder, deps.fixedRules ? deps.fixedRules() : undefined, { revision, ...(typeof satz === "string" ? { satz } : {}), schritt: deps.schritt() }));
  }

  async function save() {
    if (frozen) return { ok: false, reason: "gebaut" };
    const snapshot = deps.fields();
    const pending = deps.dirty();
    const satz = deps.satz ? deps.satz() : undefined;
    deps.onState && deps.onState(VA_WIZARD_TEXT.saving, false);
    let res = await putOnce(snapshot, satz);
    if (res.status === 409 && res.body && res.body.reason === "veraltet") {
      // Neu laden, eigene ungespeicherte Eingaben darüberlegen, einmal erneut
      const fresh = await request("GET", path);
      if (fresh.status === 200 && fresh.body) {
        revision = fresh.body.revision;
        let merged = vaWizardFromView(fresh.body);
        for (const p of pending) merged = vaWizardSet(merged, p, vaWizardGet(snapshot, p));
        if (fresh.body.phase && fresh.body.phase !== "wizard") {
          frozen = true;
          deps.onState && deps.onState(VA_WIZARD_TEXT.saveBuilt, true);
          return { ok: false, reason: "gebaut" };
        }
        res = await putOnce(merged, satz);
        if (res.status === 200) deps.onMerged && deps.onMerged(merged);
      }
    }
    if (res.status === 200 && res.body) {
      revision = res.body.revision;
      deps.onSaved && deps.onSaved(res.body, pending, snapshot, satz);
      deps.onState && deps.onState(VA_WIZARD_TEXT.saved, false);
      return { ok: true };
    }
    const reason = (res.body && res.body.reason) || "fehler";
    if (reason === "gebaut") frozen = true;
    const text = reason === "veraltet" ? VA_WIZARD_TEXT.saveStale : reason === "unbekannt" ? VA_WIZARD_TEXT.saveGone : reason === "gebaut" ? VA_WIZARD_TEXT.saveBuilt : (res.body && res.body.error) || VA_WIZARD_TEXT.saveFailed;
    deps.onState && deps.onState(text, true);
    return { ok: false, reason, fehler: (res.body && res.body.fehler) || [] };
  }

  return {
    get revision() {
      return revision;
    },
    get frozen() {
      return frozen;
    },
    /** Entprellt speichern (jede Änderung) */
    schedule() {
      if (frozen) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        enqueue(save);
      }, debounceMs);
    },
    /** Sofort speichern (Wechsel des Schritts); wartet auf alles davor */
    flush() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      return enqueue(save);
    },
    /** Anhang hochladen, in derselben Reihe; danach gilt die revision der Antwort */
    upload(name, bytes) {
      return enqueue(async () => {
        if (frozen) return { ok: false, reason: "gebaut" };
        const res = await vaWizardCall(() => deps.upload(`${path}/anhaenge`, name, bytes));
        if (res.status === 201 && res.body) {
          revision = res.body.revision;
          return { ok: true, anhang: res.body.anhang };
        }
        return { ok: false, reason: (res.body && res.body.reason) || "fehler", error: res.body && res.body.error };
      });
    },
    removeAttachment(datei) {
      return enqueue(async () => {
        if (frozen) return { ok: false, reason: "gebaut" };
        const res = await request("DELETE", `${path}/anhaenge/${encodeURIComponent(datei)}`);
        if (res.status === 200 && res.body) {
          revision = res.body.revision;
          return { ok: true };
        }
        return { ok: false, reason: (res.body && res.body.reason) || "fehler", error: res.body && res.body.error };
      });
    },
    get kennung() {
      return kennung;
    },
    /** Ende der Reihe, wie sie gerade steht; was danach angestellt wird, gehört nicht dazu */
    idle() {
      return chain;
    },
    /**
     * Kennung ändern, in derselben Reihe: Der Server zieht Felder und Anhänge
     * um. Bei einem Konflikt bleibt der Entwurf unter der alten Kennung.
     */
    rename(next) {
      return enqueue(async () => {
        if (frozen) return { ok: false, reason: "gebaut", error: VA_WIZARD_TEXT.saveBuilt };
        if (next === kennung) return { ok: true, kennung };
        const res = await request("POST", `${path}/umbenennen`, { revision, kennung: next });
        if (res.status === 200 && res.body && res.body.kennung === next) {
          kennung = next;
          path = `/api/voice-agents/wizard/${encodeURIComponent(kennung)}`;
          revision = res.body.revision;
          deps.onRenamed && deps.onRenamed(res.body);
          return { ok: true, kennung };
        }
        const reason = (res.body && res.body.reason) || "fehler";
        if (reason === "gebaut") frozen = true;
        return { ok: false, reason, error: (res.body && res.body.error) || VA_WIZARD_TEXT.renameFailed };
      });
    },
    /** Bauen: erst alles Offene speichern, dann mit der revision bauen; danach nichts mehr senden */
    build() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      const saved = enqueue(save);
      return enqueue(async () => {
        if (frozen) return { status: 409, body: { reason: "gebaut", error: VA_WIZARD_TEXT.saveBuilt } };
        // Gebaut wird nur, was gespeichert ist: Scheitert das Speichern, bleibt der Entwurf offen
        const before = await saved.catch(() => ({ ok: false }));
        if (!before.ok) return { status: 0, body: { reason: before.reason || "fehler", error: VA_WIZARD_TEXT.saveFailed, fehler: before.fehler || [] } };
        const res = await request("POST", `${path}/bauen`, { revision });
        if (res.status === 202 || (res.status === 409 && res.body && res.body.reason === "gebaut")) frozen = true;
        return res;
      });
    },
    /** Nach dem Bauen (Phase nicht mehr „wizard“): kein PUT mehr */
    freeze() {
      frozen = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
    /** Warten, bis alles in der Reihe erledigt ist */
    idle() {
      return chain;
    },
  };
}
