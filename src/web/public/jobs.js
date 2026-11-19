/* Jobs (Issue #626): gemeinsame Rückfragen, laufgebundene Aktionen und Abgleich bei offener Ansicht. */
(function () {
  "use strict";
  function createJobsView(deps) {
    const byId = id => document.getElementById(id);
    const el = { view: byId("jobs-view"), body: byId("jobs-body"), title: byId("jobs-title"), status: byId("jobs-status"), count: byId("jobs-count"), entry: byId("open-jobs") };
    if (!el.view || !el.entry) return null;
    const state = { open: false, data: null, error: "", seq: 0, timer: null, pending: new Set(), requests: new Map(), confirm: null, file: null, questions: new Set(), signature: "" };
    const visible = () => document.visibilityState !== "hidden";
    function node(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    function button(text, key, click, disabled) {
      const b = node("button", "quiet-button", text);
      b.type = "button";
      b.setAttribute("data-job-action", key);
      b.setAttribute("data-job-focus", key);
      b.disabled = !!disabled;
      b.addEventListener("click", click);
      return b;
    }
    function focus(key) {
      const target = [...el.body.querySelectorAll("[data-job-focus]")].find(n => n.getAttribute("data-job-focus") === key);
      if (target) target.focus();
    }
    function entry() {
      const count = state.data ? state.data.waiting || state.data.running || 0 : 0;
      el.count.hidden = !count;
      el.count.textContent = count ? String(count) : "";
      const waiting = !!state.data && state.data.waiting > 0;
      el.count.setAttribute("data-waiting", String(waiting));
      el.count.setAttribute("aria-label", count + (waiting ? " Jobs warten auf dich" : " Jobs laufen"));
    }
    function schedule() {
      clearTimeout(state.timer);
      state.timer = null;
      if (state.open && visible()) state.timer = setTimeout(() => void load(), 10_000);
    }
    async function load() {
      const seq = ++state.seq;
      try {
        const res = await deps.api("GET", "/api/jobs");
        if (seq !== state.seq) return;
        if (!res.ok || !res.data || !Array.isArray(res.data.jobs)) throw new Error(res.data && res.data.error || "Jobs konnten nicht geladen werden.");
        const recovered = !!state.error;
        state.data = res.data;
        state.error = "";
        // Inhalte eines älteren Laufs und dessen Bestätigung sofort verwerfen.
        for (const key of ["file", "confirm"]) {
          const current = state[key];
          if (current && !state.data.jobs.some(j => j.id === current.id && j.run === current.run)) state[key] = null;
        }
        entry();
        const signature = JSON.stringify(state.data);
        if (recovered || signature !== state.signature) { state.signature = signature; render(); }
      } catch (e) {
        if (seq !== state.seq) return;
        state.error = e.message || "Verbindung unterbrochen. Bitte erneut versuchen.";
        render();
      } finally { if (seq === state.seq) schedule(); }
    }
    function row(j) {
      const li = node("li", "job-item");
      li.setAttribute("data-job-id", j.id);
      li.setAttribute("data-phase", j.phase);
      const heading = node("div", "job-heading");
      heading.appendChild(node("h3", "job-title", j.title));
      const status = node("span", "job-state", j.status);
      status.setAttribute("data-waiting", String(j.phase === "waiting"));
      heading.appendChild(status);
      li.appendChild(heading);
      li.appendChild(node("p", "thread-meta", "Arbeitszeit " + j.duration + " · Lauf " + j.run + " · " + j.conversation.name));
      const busy = state.pending.has(j.id) || !!state.error;
      if (j.question) {
        const q = j.question;
        const details = node("details", "job-question");
        details.open = state.questions.has(j.id);
        const summary = node("summary", "quiet-button", "Frage " + q.number + " beantworten");
        summary.setAttribute("data-job-focus", j.id + ":question");
        details.appendChild(summary);
        details.appendChild(node("p", "thread-question", q.text));
        if (q.context) details.appendChild(node("p", "thread-context", q.context));
        const choice = q.choice && deps.settledChoice(q.choice);
        if (choice && q.conversationId) {
          const ui = { pending: deps.choicePending, errors: deps.choiceErrors, notices: deps.choiceNotices,
            pick: (id, option) => void answer(j, id, option), open: deps.openConversation };
          const box = deps.choiceElement(choice, ui);
          for (const b of box.querySelectorAll("button")) {
            b.setAttribute("data-job-focus", j.id + ":choice:" + b.getAttribute("data-key"));
            if (busy) b.disabled = true;
          }
          details.appendChild(box);
        } else {
          details.appendChild(node("p", "actions-hint", "Die Knöpfe sind hier noch nicht verfügbar. Bitte die Frage im ursprünglichen Gespräch öffnen."));
          if (q.answers.length) details.appendChild(node("p", "thread-context", q.answers.join(" · ")));
        }
        details.addEventListener("toggle", () => {
          if (details.open) state.questions.add(j.id); else state.questions.delete(j.id);
        });
        li.appendChild(details);
      }
      const actions = node("div", "settings-actions job-actions");
      if (j.conversation.id) actions.appendChild(button("Zum Gespräch", j.id + ":open", () => deps.openConversation(j.conversation.id)));
      const names = { resume: "Fortsetzen", stop: "Stoppen", log: "Log", report: "Bericht" };
      for (const action of j.actions) {
        if (!names[action]) continue;
        const b = button(names[action], j.id + ":" + action, () => {
          if (action === "log" || action === "report") void content(j, action);
          else if (action === "stop") { state.confirm = { id: j.id, run: j.run }; render(); focus(j.id + ":cancel"); }
          else void act(j, action);
        }, busy);
        if (action === "log" || action === "report") b.setAttribute("aria-expanded", String(!!state.file && state.file.id === j.id && state.file.kind === action));
        actions.appendChild(b);
      }
      li.appendChild(actions);
      if (state.confirm && state.confirm.id === j.id) {
        const confirm = node("div", "settings-routine-confirm");
        confirm.setAttribute("role", "group");
        confirm.setAttribute("aria-label", "Job stoppen");
        confirm.appendChild(node("p", "", "„" + j.title + "“ stoppen? Dieser Job kann danach nicht fortgesetzt werden."));
        const buttons = node("div", "settings-actions job-actions");
        buttons.appendChild(button("Abbrechen", j.id + ":cancel", () => { state.confirm = null; render(); focus(j.id + ":stop"); }, busy));
        buttons.appendChild(button(busy ? "Wird gestoppt…" : "Job stoppen", j.id + ":confirm", () => void act(j, "stop"), busy));
        confirm.appendChild(buttons);
        li.appendChild(confirm);
      }
      if (state.file && state.file.id === j.id) {
        const f = state.file;
        const section = node("section", "job-file");
        section.appendChild(node("h4", "job-title", (f.kind === "log" ? "Log · letzte 200 Zeilen" : "Bericht") + " · Lauf " + f.run));
        if (f.loading || f.error) section.appendChild(node("p", "actions-hint", f.error || "Wird geladen…"));
        else if (f.kind === "log") section.appendChild(node("pre", "job-log", f.text));
        else {
          const markdown = node("div", "content");
          // Nur das serverseitig maskierte und gegen HTML gesicherte Markdown.
          markdown.innerHTML = f.html;
          section.appendChild(markdown);
        }
        section.appendChild(button("Schließen", j.id + ":file-close", () => { state.file = null; render(); focus(j.id + ":" + f.kind); }));
        li.appendChild(section);
      }
      return li;
    }
    function render() {
      if (!state.open) return;
      const active = document.activeElement;
      const focusKey = active && active.getAttribute("data-job-focus");
      el.body.textContent = "";
      if (state.error) {
        const error = node("p", "actions-error", state.error + (state.data ? " Der letzte bekannte Stand bleibt sichtbar." : ""));
        error.setAttribute("role", "alert");
        el.body.appendChild(error);
        el.body.appendChild(button("Erneut laden", "retry", () => { state.signature = ""; void load(); }));
      }
      if (!state.data) el.body.appendChild(node("p", "settings-empty", state.error ? "Noch kein verlässlicher Stand." : "Jobs werden geladen…"));
      else if (!state.data.jobs.length) el.body.appendChild(node("p", "settings-empty", "Keine Hintergrund-Jobs. Lange Aufträge kannst du im Gespräch beauftragen."));
      else {
        const groups = [ ["Warten auf dich", j => j.phase === "waiting"], ["In Arbeit", j => j.phase === "starting" || j.phase === "running"], ["Zuletzt beendet", j => j.phase === "ended"] ];
        for (const [label, matches] of groups) {
          const jobs = state.data.jobs.filter(matches);
          if (!jobs.length) continue;
          const section = node("section", "job-group");
          section.appendChild(node("h2", "group-label", label));
          const list = node("ul", "thread-list");
          for (const j of jobs) list.appendChild(row(j));
          section.appendChild(list);
          el.body.appendChild(section);
        }
      }
      if (focusKey) focus(focusKey);
    }
    async function act(j, action) {
      if (state.pending.has(j.id)) return;
      state.pending.add(j.id);
      const key = j.id + ":" + j.run + ":" + action;
      if (!state.requests.has(key)) state.requests.set(key, deps.requestId());
      render();
      try {
        const res = await deps.api("POST", "/api/jobs/" + j.id + "/" + action,
          { request: state.requests.get(key), expectedRun: j.run, ...(action === "stop" ? { confirm: true } : {}) });
        state.requests.delete(key);
        el.status.textContent = res.data && (res.data.text || res.data.error) || "Die Aktion konnte nicht abgeschlossen werden.";
      } catch {
        el.status.textContent = "Verbindung unterbrochen. Der Ausgang ist noch unbekannt; der aktuelle Stand wird geladen.";
      } finally {
        state.pending.delete(j.id); state.confirm = null; state.signature = "";
        await load(); render(); if (state.open) el.title.focus();
      }
    }
    async function answer(j, id, option) {
      if (deps.choicePending.has(id)) return;
      deps.choicePending.add(id); deps.choiceErrors.delete(id); render();
      try {
        const res = await deps.api("POST", "/api/conversations/" + encodeURIComponent(j.question.conversationId) + "/choices/" + encodeURIComponent(id), { option });
        if (res.data && res.data.choice) deps.settledChoice(res.data.choice);
        el.status.textContent = res.ok ? "Antwort angenommen. Der Job wird fortgesetzt." : res.data && (res.data.message || res.data.error) || "Die Frage ist bereits entschieden.";
      } catch { deps.choiceErrors.set(id, "Antwort nicht bestätigt. Bitte den aktuellen Stand prüfen."); }
      finally { deps.choicePending.delete(id); state.signature = ""; await load(); render(); }
    }
    async function content(j, kind) {
      if (state.file && state.file.id === j.id && state.file.kind === kind) { state.file = null; render(); return; }
      const current = { id: j.id, run: j.run, kind, loading: true };
      state.file = current; render();
      try {
        const res = await deps.api("GET", "/api/jobs/" + j.id + "/" + kind + "?run=" + j.run);
        if (state.file !== current) return;
        if (!res.ok) current.error = res.data && res.data.error || "Die Datei konnte nicht geladen werden.";
        else { current.text = res.data.text; current.html = res.data.html; }
      } catch { current.error = "Verbindung unterbrochen. Bitte die Datei erneut öffnen."; }
      finally { current.loading = false; render(); }
    }
    return {
      load, isOpen: () => state.open,
      show() { state.open = true; el.view.hidden = false; el.entry.setAttribute("aria-current", "page"); render(); el.title.focus(); void load(); },
      hide() { state.open = false; el.view.hidden = true; el.entry.removeAttribute("aria-current"); clearTimeout(state.timer); state.timer = null; },
      visibility() { if (visible()) void load(); else { clearTimeout(state.timer); state.timer = null; } },
    };
  }
  window.TyboJobs = { create: createJobsView };
})();
