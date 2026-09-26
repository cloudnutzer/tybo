// Einrichtungsmodus im Browser (Issue #66, Entscheidung 0011). Links die
// Schritte mit Status, rechts der aktuelle Schritt mit Feldern, Hilfetexten,
// „Testen“ und „Speichern“. Die Schritte kommen als Daten vom Server
// (src/setup/web-server.ts); Werte kommen nie zurück, Felder sind nie mit
// gespeicherten Werten vorausgefüllt, leer heißt „vorhandenen Wert behalten“.
//
// Issue #161: Felder mit Standard (field.default) sind damit vorausgefüllt,
// solange kein Wert gesetzt ist. Auswahlen vom Anbieter (field.loadChoices)
// lädt der Knopf „Auswahl laden“; ändert sich ein Feld davor, ist die Liste
// verworfen, eine verspätete Antwort wird ignoriert. Meldet der Server
// mode "ablauf", heißt der Knopf „Einrichten“: erst der Plan, dann „Jetzt
// ausführen“, danach Fortschritt mit „Abbrechen“ (Abfrage alle 2 s).
// Der Plan gilt nur für den Eingabestand, zu dem er angezeigt wurde: jede
// Feldänderung verwirft ihn, gestartet wird mit genau diesen Eingaben.
// view-Antworten zu einem älteren Stand werden ignoriert.
//
// Alles über createElement und textContent, nie innerHTML. createSetupView
// lässt sich ohne Browser testen (tests/setup-web-app.test.ts): api,
// navigate und scrollTop kommen von außen.
"use strict";

/** Name aus src/brand.ts, gesetzt von /brand.js (Issue #100); erst beim Gebrauch gelesen */
function brandName() {
  return window.TYBO_BRAND.name;
}

const STATE_TEXT = { erledigt: "erledigt", teilweise: "teilweise", fehlt: "fehlt" };

function createSetupView(deps) {
  const api = deps.api;
  const navigate = deps.navigate || (() => {});
  const scrollTop = deps.scrollTop || (() => {});
  /** Zeitgeber für die Abfrage eines Ablaufs; Tests setzen ihn ein */
  const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
  const POLL_MS = 2000;
  const stepList = document.getElementById("setup-steps");
  const panel = document.getElementById("setup-panel");

  let overview = null;
  let current = null;
  let step = null;
  let busy = false;
  let finished = false;
  /** Schon auf dem Weg zur Code-Seite (mehrere 401 gleichzeitig) */
  let leaving = false;
  /** Feldname → { wrap, input, field } des offenen Schritts */
  let inputs = new Map();
  /** Laufender Ablauf, der gerade angezeigt wird: { id, box, list, cancel } */
  let runView = null;
  /** Zähler der Ladeversuche je Feld (verspätete Antworten erkennen) */
  let loadCounter = 0;
  /** Zählt jede Feldänderung; ein angezeigter Plan gilt nur für seinen Stand */
  let inputVersion = 0;
  /** Letzte view-Anfrage; ältere Antworten werden ignoriert */
  let viewSeq = 0;
  /** Angezeigter Plan: { version, values } oder null */
  let confirming = null;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** Antwort 401: Code abgelaufen oder Einrichtung fertig, zurück zur Code-Seite */
  async function call(method, path, body) {
    const res = await api(method, path, body);
    if (res.status === 401 && !finished) {
      if (!leaving) navigate("/code");
      leaving = true;
      throw new Error("abgemeldet");
    }
    return res;
  }

  // --- Seitenleiste --------------------------------------------------------

  function renderSteps() {
    const items = [];
    for (const [i, s] of overview.steps.entries()) {
      const li = el("li");
      const button = el("button", "setup-step");
      button.type = "button";
      button.setAttribute("data-step", s.id);
      button.setAttribute("data-state", s.state);
      if (s.id === current) button.setAttribute("aria-current", "step");
      button.disabled = finished;
      const mark = el("span", "setup-step-mark");
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = s.state === "erledigt" ? "✓" : String(i + 1);
      const text = el("span", "setup-step-text");
      text.appendChild(el("span", "setup-step-title", s.title));
      const meta = STATE_TEXT[s.state] + (s.optional ? ", optional" : "");
      text.appendChild(el("span", "setup-step-meta", meta));
      button.appendChild(mark);
      button.appendChild(text);
      button.addEventListener("click", () => open(s.id));
      li.appendChild(button);
      items.push(li);
    }
    stepList.replaceChildren(...items);
  }

  // --- Felder --------------------------------------------------------------

  function fieldInput(field) {
    const id = "field-" + field.name;
    const keep = field.set ? "Gesetzt. Leer lassen, um den Wert zu behalten." : "";
    if (field.kind === "choice" || field.kind === "yesno") {
      const wrap = el("span", "settings-select");
      const select = el("select", "settings-input");
      select.id = id;
      const empty = el("option", null, field.set ? "Gesetzt, so lassen" : "Bitte wählen");
      empty.value = "";
      select.appendChild(empty);
      if (field.loadChoices) {
        empty.textContent = "Erst die Auswahl laden";
        select.disabled = true;
      }
      const choices = field.kind === "yesno"
        ? [{ value: "true", label: "Ja" }, { value: "false", label: "Nein" }]
        : field.choices || [];
      for (const c of choices) {
        const o = el("option", null, c.label);
        o.value = c.value;
        select.appendChild(o);
      }
      // Vorschlag nur, solange kein Wert gesetzt ist
      if (!field.set && field.default !== undefined && choices.some(c => c.value === field.default)) select.value = field.default;
      select.addEventListener("change", () => {
        fieldChanged();
        invalidateAfter(field.name);
        refreshVisibility();
      });
      wrap.appendChild(select);
      if (field.loadChoices) {
        // Außerhalb von .settings-select, sonst säße dessen Pfeil falsch
        const load = el("button", "quiet-button setup-load", "Auswahl laden");
        load.type = "button";
        load.setAttribute("data-action", "load-" + field.name);
        load.addEventListener("click", () => loadChoices(field.name));
        return { node: wrap, input: select, extra: load };
      }
      return { node: wrap, input: select };
    }
    const input = el("input", "settings-input");
    input.id = id;
    input.type = field.kind === "secret" ? "password" : "text";
    // Nie vorausfüllen und nie vom Browser merken lassen
    input.setAttribute("autocomplete", field.kind === "secret" ? "new-password" : "off");
    input.setAttribute("spellcheck", "false");
    input.value = "";
    // Vorschlag nur, solange kein Wert gesetzt ist; nie bei geheimen Feldern
    if (!field.set && field.default !== undefined && field.kind === "text") input.value = field.default;
    if (keep) input.setAttribute("placeholder", keep);
    input.addEventListener("input", () => {
      fieldChanged();
      invalidateAfter(field.name);
    });
    // Text kann Sichtbarkeit und Ablauf bestimmen; geheime und transiente
    // Eingaben gehen dafür nur als „eingegeben“ an view, nie als Wert
    input.addEventListener("change", () => {
      if (field.kind === "text" && !field.transient) refreshVisibility();
      else if (step.canRun) refreshVisibility();
    });
    return { node: input, input };
  }

  function renderField(field) {
    const wrap = el("div", "settings-field");
    wrap.setAttribute("data-field", field.name);
    const label = el("label", "settings-label", field.label);
    label.setAttribute("for", "field-" + field.name);
    const head = el("div", "setup-field-head");
    head.appendChild(label);
    head.appendChild(el("span", "setup-field-state", field.set ? "gesetzt" : "nicht gesetzt"));
    wrap.appendChild(head);
    const { node, input, extra } = fieldInput(field);
    wrap.appendChild(node);
    if (extra) wrap.appendChild(extra);
    const help = el("p", "setup-help", field.help);
    if (field.link) {
      help.appendChild(document.createTextNode(" "));
      const a = el("a", null, "Mehr dazu");
      a.href = field.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      help.appendChild(a);
    }
    wrap.appendChild(help);
    let problem = null;
    if (field.loadChoices) {
      problem = el("p", "actions-error setup-choices-error");
      problem.hidden = true;
      wrap.appendChild(problem);
    }
    wrap.hidden = !field.visible;
    inputs.set(field.name, { wrap, input, field, problem, loadSeq: 0 });
    return wrap;
  }

  /** Eingaben vor einem Feld als Vergleichstext (nur im Browser, geht nie weg) */
  function snapshotBefore(name) {
    const parts = [];
    for (const [n, entry] of inputs) {
      if (n === name) break;
      parts.push(n + "=" + (entry.wrap.hidden ? "" : entry.input.value));
    }
    return parts.join("\n");
  }

  /** Eine Eingabe hat sich geändert: ein angezeigter Plan gilt nicht mehr */
  function fieldChanged() {
    inputVersion++;
    if (!confirming) return;
    confirming = null;
    if (step.resultBox && !runView) {
      step.resultBox.hidden = true;
      step.resultBox.replaceChildren();
    }
  }

  /** Ein Feld hat sich geändert: geladene Auswahlen danach verwerfen */
  function invalidateAfter(name) {
    let after = false;
    for (const [n, entry] of inputs) {
      if (after && entry.field.loadChoices) resetChoices(entry);
      if (n === name) after = true;
    }
  }

  function resetChoices(entry) {
    entry.loadSeq = ++loadCounter;
    const select = entry.input;
    const empty = el("option", null, "Erst die Auswahl laden");
    empty.value = "";
    select.replaceChildren(empty);
    select.value = "";
    select.disabled = true;
    if (entry.problem) entry.problem.hidden = true;
  }

  async function loadChoices(name) {
    const entry = inputs.get(name);
    if (!entry || busy) return;
    resetChoices(entry);
    const seq = entry.loadSeq;
    const before = snapshotBefore(name);
    try {
      const res = await call("POST", "/api/setup/steps/" + current + "/choices/" + name, { values: collect() });
      // Verspätet oder inzwischen geänderte Eingaben davor: ignorieren
      if (inputs.get(name) !== entry || entry.loadSeq !== seq || snapshotBefore(name) !== before) return;
      if (!res.ok || !res.data || !Array.isArray(res.data.choices)) {
        entry.problem.textContent = (res.data && res.data.error) || "Die Auswahl ließ sich nicht laden (Fehler " + res.status + ").";
        entry.problem.hidden = false;
        return;
      }
      const empty = el("option", null, "Bitte wählen");
      empty.value = "";
      const options = [empty];
      for (const c of res.data.choices) {
        const o = el("option", null, c.label);
        o.value = c.value;
        options.push(o);
      }
      entry.input.replaceChildren(...options);
      entry.input.value = "";
      entry.input.disabled = false;
      // Genau eine Auswahl: vorausgewählt (Issue #163, etwa die einzige Organisation)
      if (res.data.choices.length === 1) {
        entry.input.value = res.data.choices[0].value;
        fieldChanged();
      }
    } catch (e) {
      if (e.message !== "abgemeldet" && entry.problem) {
        entry.problem.textContent = brandName() + " ist nicht erreichbar.";
        entry.problem.hidden = false;
      }
    }
  }

  /** Eingegebene Werte sichtbarer Felder; leere bleiben weg (= behalten) */
  function collect() {
    const values = {};
    for (const [name, entry] of inputs) {
      if (entry.wrap.hidden) continue;
      const v = entry.input.value;
      if (typeof v === "string" && v.trim() !== "") values[name] = v;
    }
    return values;
  }

  /**
   * Sichtbarkeit (und bei Schritten mit Ablauf: Modus und Plan) neu vom
   * Server. Geschickt werden Auswahl-Felder, bei Schritten mit Ablauf auch
   * Text und in present die Namen geheimer und transienter Felder mit
   * Eingabe; nie deren Werte. true, wenn die Antwort zum jüngsten Stand
   * gehört und übernommen ist.
   */
  async function refreshVisibility() {
    const values = {};
    const present = [];
    for (const [name, entry] of inputs) {
      const kind = entry.field.kind;
      const filled = !!entry.input.value && entry.input.value.trim() !== "";
      if (!filled) continue;
      const hidden = kind === "secret" || !!entry.field.transient;
      if (hidden) {
        if (step.canRun) present.push(name);
      } else if (kind === "choice" || kind === "yesno" || (step.canRun && kind === "text")) {
        values[name] = entry.input.value;
      }
    }
    const seq = ++viewSeq;
    const forStep = step;
    try {
      const res = await call("POST", "/api/setup/steps/" + current + "/view", present.length ? { values, present } : { values });
      // Verspätet: eine neuere Anfrage oder ein anderer Schritt hat Vorrang
      if (seq !== viewSeq || step !== forStep || !res.ok) return false;
      for (const f of res.data.fields) {
        const entry = inputs.get(f.name);
        if (entry) entry.wrap.hidden = !f.visible;
      }
      if (step.canRun && res.data.mode && (res.data.mode !== step.mode || res.data.plan)) {
        const changed = res.data.mode !== step.mode;
        step.mode = res.data.mode;
        step.plan = res.data.plan || [];
        if (changed) renderActions();
      }
      return true;
    } catch {
      // Sichtbarkeit bleibt, wie sie war
      return false;
    }
  }

  // --- Ergebnisse ----------------------------------------------------------

  function renderItems(list) {
    const ul = el("ul", "setup-items");
    for (const item of list || []) {
      const li = el("li");
      li.setAttribute("data-ok", String(item.ok));
      // Offen, aber kein Fehler (optionaler Schritt, Autostart vor „Fertig“)
      if (item.optional) li.setAttribute("data-optional", "true");
      const mark = el("span", "setup-item-mark", item.ok ? "✓" : item.optional ? "–" : "!");
      mark.setAttribute("aria-hidden", "true");
      const body = el("span", "setup-item-body");
      body.appendChild(el("span", "setup-item-label", item.label + ": "));
      body.appendChild(document.createTextNode(item.detail));
      if (!item.ok && item.fix) {
        const fix = el("span", "setup-item-fix", "So geht's: ");
        fix.appendChild(el("code", null, item.fix));
        body.appendChild(fix);
      }
      li.appendChild(mark);
      li.appendChild(body);
      ul.appendChild(li);
    }
    return ul;
  }

  function showResult(box, ok, message, list) {
    const nodes = [el("p", ok ? "setup-result-ok" : "actions-error", message)];
    if (list && list.length) nodes.push(renderItems(list));
    box.replaceChildren(...nodes);
    box.hidden = false;
  }

  // --- Ein Schritt ---------------------------------------------------------

  function stepIndex(id) {
    return overview.steps.findIndex(s => s.id === id);
  }

  function nextStepId() {
    const i = stepIndex(current);
    return i >= 0 && i + 1 < overview.steps.length ? overview.steps[i + 1].id : null;
  }

  function header(s) {
    const head = el("div", "setup-head");
    const i = stepIndex(s.id);
    head.appendChild(el("p", "setup-count", "Schritt " + (i + 1) + " von " + overview.steps.length));
    const h1 = el("h1", "setup-title", s.title);
    h1.tabIndex = -1;
    head.appendChild(h1);
    if (s.optional) head.appendChild(el("span", "settings-badge", "optional"));
    return head;
  }

  function actionButton(text, className, key, onClick) {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("data-action", key);
    b.addEventListener("click", onClick);
    return b;
  }

  /** Knöpfe des offenen Schritts; gesperrte („Fertig“ ohne alle Pflichtschritte) bleiben aus */
  let actionButtons = [];

  function setBusy(value) {
    busy = value;
    for (const b of actionButtons) b.disabled = value || b.getAttribute("data-blocked") === "true";
  }

  function renderStep() {
    inputs = new Map();
    actionButtons = [];
    confirming = null;
    const s = step;
    const nodes = [header(s), el("p", "settings-intro", s.description)];
    const status = el("p", "setup-status", s.detail);
    status.setAttribute("data-state", s.state);
    nodes.push(status);
    if (s.items && s.items.length) nodes.push(renderItems(s.items));

    if (s.id === "pruefung") {
      nodes.push(...renderFinish());
    } else {
      const form = el("form", "setup-form");
      form.setAttribute("novalidate", "");
      for (const f of s.fields) form.appendChild(renderField(f));
      form.addEventListener("submit", e => {
        e.preventDefault();
        if (s.canApply) save();
      });
      if (s.fields.length) nodes.push(form);
      if (s.applyAtFinish) {
        nodes.push(el("p", "setup-note", "Den Autostart richtet " + brandName() + " erst bei „Fertig“ ein. Sonst würde der Bot schon starten, während die Einrichtung noch offen ist."));
      }
      const result = el("div", "setup-result");
      result.setAttribute("role", "status");
      result.hidden = true;
      const actions = el("div", "settings-actions setup-actions");
      step.actionsBox = actions;
      step.resultBox = result;
      renderActions();
      nodes.push(actions, result);
    }
    panel.replaceChildren(...nodes);
    if (overview.running && overview.running.step === s.id) showRun(overview.running.runId);
  }

  /** Knöpfe unter den Feldern: „Einrichten“ im Modus Ablauf, sonst Speichern und Testen */
  function renderActions() {
    const s = step;
    actionButtons = [];
    if (s.canRun && s.mode === "ablauf") {
      actionButtons.push(actionButton("Einrichten", "primary-button settings-save", "run", () => confirmRun()));
    } else {
      if (s.canApply) actionButtons.push(actionButton("Speichern", "primary-button settings-save", "apply", () => save()));
      if (s.canTest) actionButtons.push(actionButton("Testen", "quiet-button", "test", () => test()));
    }
    const next = nextStepId();
    if (next) actionButtons.push(actionButton("Weiter", "quiet-button", "next", () => open(next)));
    s.actionsBox.replaceChildren(...actionButtons);
    setBusy(busy);
  }

  // --- Ablauf --------------------------------------------------------------

  /** Erst der Plan zum aktuellen Eingabestand, dann „Jetzt ausführen“ mit genau diesem Stand */
  async function confirmRun() {
    if (busy) return;
    confirming = null;
    const version = inputVersion;
    const applied = await refreshVisibility();
    // Inzwischen geändert oder Antwort zu einem älteren Stand: kein Plan
    if (!applied || version !== inputVersion || step.mode !== "ablauf") return;
    const confirmed = { version, values: collect() };
    confirming = confirmed;
    const box = step.resultBox;
    const nodes = [el("p", "setup-run-intro", "Das passiert jetzt:")];
    const list = el("ul", "setup-plan");
    for (const sentence of step.plan || []) list.appendChild(el("li", null, sentence));
    nodes.push(list);
    const actions = el("div", "settings-actions setup-actions");
    const go = actionButton("Jetzt ausführen", "primary-button settings-save", "run-confirm", () => startRun(confirmed));
    const back = actionButton("Zurück", "quiet-button", "run-back", () => { confirming = null; box.hidden = true; box.replaceChildren(); });
    actions.appendChild(go);
    actions.appendChild(back);
    nodes.push(actions);
    box.replaceChildren(...nodes);
    box.hidden = false;
    reveal(box);
  }

  /** Plan und Fortschritt stehen unter den Feldern: ins Bild holen (ohne Animation) */
  function reveal(box) {
    if (box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
  }

  /** Startet mit den bestätigten Eingaben; hat sich seitdem etwas geändert, erst ein neuer Plan */
  async function startRun(confirmed) {
    if (busy) return;
    if (confirming !== confirmed || confirmed.version !== inputVersion) {
      await confirmRun();
      return;
    }
    confirming = null;
    setBusy(true);
    const box = step.resultBox;
    try {
      const res = await call("POST", "/api/setup/steps/" + current + "/run", { values: confirmed.values });
      if (res.status !== 202 || !res.data || !res.data.runId) {
        showResult(box, false, (res.data && res.data.error) || "Der Ablauf ließ sich nicht starten (Fehler " + res.status + ").");
        setBusy(false);
        return;
      }
      showRun(res.data.runId);
    } catch (e) {
      if (e.message !== "abgemeldet") showResult(box, false, brandName() + " ist nicht erreichbar.");
      setBusy(false);
    }
  }

  function formatWaited(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const sec = total % 60;
    return Math.floor(total / 60) + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function eventText(e) {
    return "[" + e.at + "/" + e.total + "] " + e.label + (e.detail ? ": " + e.detail : "") + (typeof e.waitedMs === "number" ? " (" + formatWaited(e.waitedMs) + ")" : "");
  }

  /** Fortschritt eines Ablaufs anzeigen und abfragen, bis er endet */
  function showRun(runId) {
    setBusy(true);
    const box = step.resultBox;
    const intro = el("p", "setup-run-intro", "Läuft …");
    const list = el("ol", "setup-run-events");
    list.setAttribute("aria-live", "polite");
    const actions = el("div", "settings-actions setup-actions");
    const cancel = actionButton("Abbrechen", "quiet-button", "run-cancel", () => cancelRun());
    actions.appendChild(cancel);
    box.replaceChildren(intro, list, actions);
    box.hidden = false;
    reveal(box);
    runView = { id: runId, step: current, intro, list, cancel };
    poll();
  }

  async function cancelRun() {
    const view = runView;
    if (!view) return;
    view.cancel.disabled = true;
    view.cancel.textContent = "Breche ab …";
    try {
      await call("POST", "/api/setup/runs/" + view.id + "/abbrechen", {});
    } catch {
      // Abfrage zeigt, wie es ausgeht
    }
  }

  async function poll() {
    const view = runView;
    if (!view) return;
    let res;
    try {
      res = await call("GET", "/api/setup/runs/" + view.id);
    } catch (e) {
      if (e.message === "abgemeldet") return;
      res = null;
    }
    if (runView !== view) return;
    if (!res || !res.ok || !res.data) {
      view.intro.textContent = brandName() + " antwortet gerade nicht, frage weiter nach …";
      schedule(poll, POLL_MS);
      return;
    }
    const data = res.data;
    view.list.replaceChildren(...data.events.map(e => el("li", null, eventText(e))));
    if (data.state === "laeuft") {
      schedule(poll, POLL_MS);
      return;
    }
    runView = null;
    const result = data.result || { ok: false, message: "Der Ablauf ist beendet.", changed: [] };
    const events = data.events;
    setBusy(false);
    try {
      await reload(view.step);
    } catch {
      // Ergebnis trotzdem zeigen
    }
    const box = step.resultBox;
    if (!box) return;
    const nodes = [el("p", result.ok ? "setup-result-ok" : "actions-error", result.message)];
    if (result.changed && result.changed.length) nodes.push(el("p", "setup-note", "Geändert: " + result.changed.join(", ")));
    if (events.length) {
      const list = el("ol", "setup-run-events");
      for (const e of events) list.appendChild(el("li", null, eventText(e)));
      nodes.push(list);
    }
    box.replaceChildren(...nodes);
    box.hidden = false;
  }

  async function test() {
    if (busy) return;
    setBusy(true);
    const box = step.resultBox;
    showResult(box, true, "Teste …");
    try {
      const res = await call("POST", "/api/setup/steps/" + current + "/test", { values: collect() });
      if (!res.ok) showResult(box, false, (res.data && res.data.error) || "Test fehlgeschlagen (Fehler " + res.status + ").");
      else showResult(box, res.data.ok, res.data.message, res.data.items);
    } catch (e) {
      if (e.message !== "abgemeldet") showResult(box, false, brandName() + " ist nicht erreichbar.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    const box = step.resultBox;
    try {
      const res = await call("POST", "/api/setup/steps/" + current + "/apply", { values: collect() });
      const data = res.data || {};
      if (res.status === 200 && data.ok) {
        await reload(current);
        showResult(step.resultBox, true, data.message);
      } else {
        showResult(box, false, data.message || data.error || "Speichern fehlgeschlagen (Fehler " + res.status + ").");
      }
    } catch (e) {
      if (e.message !== "abgemeldet") showResult(box, false, brandName() + " ist nicht erreichbar, nichts gespeichert.");
    } finally {
      setBusy(false);
    }
  }

  // --- Gesamtprüfung und Fertig --------------------------------------------

  function renderFinish() {
    const nodes = [];
    const result = el("div", "setup-result");
    result.setAttribute("role", "status");
    result.hidden = true;
    step.resultBox = result;

    let autostart = null;
    if (!overview.supervisor && overview.autostart !== "erledigt") {
      const label = el("label", "setup-check");
      autostart = el("input");
      autostart.type = "checkbox";
      autostart.id = "setup-autostart";
      label.appendChild(autostart);
      label.appendChild(el("span", null, "Autostart einrichten und " + brandName() + " danach gleich starten"));
      nodes.push(label);
    }
    const hint = overview.supervisor
      ? "Nach „Fertig“ startet " + brandName() + " von selbst neu und ist dann in Telegram erreichbar."
      : "Ohne Autostart steht nach „Fertig“ der Befehl zum Starten da.";
    nodes.push(el("p", "setup-note", hint));
    const actions = el("div", "settings-actions setup-actions");
    const done = actionButton("Fertig", "primary-button settings-save", "finish", () => finish(autostart ? autostart.checked : false));
    if (!overview.ready) {
      done.disabled = true;
      done.setAttribute("data-blocked", "true");
    }
    actionButtons.push(done, actionButton("Alles prüfen", "quiet-button", "test", () => test()));
    for (const b of actionButtons) actions.appendChild(b);
    nodes.push(actions, result);
    return nodes;
  }

  async function finish(autostart) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await call("POST", "/api/setup/finish", { autostart });
      if (res.status !== 200) {
        showResult(step.resultBox, false, (res.data && res.data.error) || "Fertig ging nicht (Fehler " + res.status + ").");
        setBusy(false);
        return;
      }
      finished = true;
      renderDone(res.data);
    } catch (e) {
      if (e.message !== "abgemeldet") showResult(step.resultBox, false, brandName() + " ist nicht erreichbar.");
      setBusy(false);
    }
  }

  function renderDone(data) {
    renderSteps();
    const nodes = [el("h1", "setup-title", "Einrichtung abgeschlossen"), el("p", "settings-intro", data.message)];
    if (data.command) {
      const pre = el("pre", "setup-command");
      pre.appendChild(el("code", null, data.command));
      nodes.push(pre);
    }
    nodes.push(el("p", "setup-note", "Der Einmal-Code gilt jetzt nicht mehr. Dieses Fenster kann zu."));
    panel.replaceChildren(...nodes);
    const h1 = nodes[0];
    h1.tabIndex = -1;
    if (h1.focus) h1.focus();
  }

  // --- Laden ---------------------------------------------------------------

  async function reload(id) {
    const [ov, st] = await Promise.all([call("GET", "/api/setup/overview"), call("GET", "/api/setup/steps/" + id)]);
    if (!ov.ok || !st.ok) throw new Error("laden");
    overview = ov.data;
    step = st.data;
    current = id;
    renderSteps();
    renderStep();
  }

  async function open(id) {
    if (busy || finished) return;
    try {
      await reload(id);
      scrollTop();
      const title = panel.querySelector ? panel.querySelector(".setup-title") : null;
      if (title && title.focus) title.focus();
    } catch (e) {
      if (e.message !== "abgemeldet") panel.replaceChildren(el("p", "actions-error", "Schritt ließ sich nicht laden. Seite neu laden."));
    }
  }

  /** Erster Schritt, der nicht erledigt ist; sonst die Gesamtprüfung */
  async function start() {
    try {
      const res = await call("GET", "/api/setup/overview");
      if (!res.ok) throw new Error("laden");
      overview = res.data;
      const first = overview.steps.find(s => s.state !== "erledigt" && !s.optional) || overview.steps[overview.steps.length - 1];
      await open(first.id);
    } catch (e) {
      if (e.message !== "abgemeldet") panel.replaceChildren(el("p", "actions-error", "Einrichtung ließ sich nicht laden. Seite neu laden."));
    }
  }

  return { start, open, state: () => ({ current, finished, busy, running: runView ? runView.id : null }) };
}

if (typeof window !== "undefined" && window.location && typeof fetch === "function") {
  const api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  };
  createSetupView({
    api,
    navigate: path => { window.location.href = path; },
    scrollTop: () => window.scrollTo(0, 0),
  }).start();
}
