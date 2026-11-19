/* Pipelines: lesender Status, eigenes Ablaufdatum und Abgleich ohne Neuladen. */
(function () {
  "use strict";
  const STALE_MS = 5 * 60_000;
  const QUESTION_MS = 14 * 24 * 3_600_000;
  const STATES = { waiting: "wartet auf dich", halted: "angehalten", running: "läuft", resting: "ruht" };
  const STEPS = { plan: "Worker plant", build: "Worker baut", fix: "Worker bessert nach", checks: "Prüflauf", ci: "wartet auf CI",
    review: "Prüfer prüft", ux: "UX-Prüfung", "review-lock": "wartet auf Prüfsperre", network: "wartet auf Netz", prerequisite: "wartet auf Vorbedingung" };
  const EVENTS = { ...STEPS, issue: "Issue übernommen", "worker-done": "Worker fertig", "review-done": "Prüfergebnis liegt vor",
    resumed: "Warten beendet", halted: "Pipeline angehalten", waiting: "Wartet auf Abnahme oder neue Issues", merged: "Änderung übernommen" };
  function age(since, now) {
    const ms = now - Date.parse(since);
    if (!Number.isFinite(ms)) return "";
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (!minutes) return "weniger als 1 Min";
    if (minutes < 60) return minutes + " Min";
    const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? days + (days === 1 ? " Tag " : " Tagen ") + hours % 24 + " Std" : hours + " Std " + minutes % 60 + " Min";
  }
  function create(deps) {
    const byId = id => document.getElementById(id);
    const el = { view: byId("pipelines-view"), body: byId("pipelines-body"), title: byId("pipelines-title"), entry: byId("open-pipelines"), count: byId("pipelines-count"), status: byId("pipelines-status") };
    if (!el.view || !el.entry) return null;
    const state = { open: false, data: null, error: "", seq: 0, poll: null, clock: null, stopped: false, expanded: new Set(), signature: "", renderedStale: false };
    const now = deps.now || Date.now;
    const visible = () => document.visibilityState !== "hidden";
    const stale = () => !!state.data && (state.data.stale || !!state.error || now() - Date.parse(state.data.generatedAt) > STALE_MS);
    function node(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    function date(at) {
      return new Date(at).toLocaleString("de-DE", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    function time(at) {
      const n = node("time", "", date(at));
      n.setAttribute("datetime", at);
      return n;
    }
    function button(text, key, click) {
      const b = node("button", "quiet-button", text);
      b.type = "button"; b.setAttribute("data-pipeline-focus", key);
      b.addEventListener("click", click);
      return b;
    }
    function disclosure(key, label, cls) {
      const details = node("details", cls);
      details.open = state.expanded.has(key);
      const summary = node("summary", "quiet-button", label);
      summary.setAttribute("data-pipeline-focus", key);
      details.appendChild(summary);
      details.addEventListener("toggle", () => {
        if (details.open) state.expanded.add(key); else state.expanded.delete(key);
      });
      return details;
    }
    function entry() {
      const data = state.data;
      el.entry.hidden = !data || !data.pipelines.length;
      const count = data ? data.waiting || data.running || 0 : 0;
      const waiting = !!data && data.waiting > 0;
      el.count.hidden = !count;
      el.count.textContent = count ? String(count) : "";
      el.count.setAttribute("data-waiting", String(waiting && !stale()));
      el.count.setAttribute("aria-label", (stale() ? "Letzter bekannter Stand: " : "") + count + (waiting ? " Pipelines warten auf dich" : " Pipelines laufen"));
    }
    function updateTimes() {
      for (const n of el.body.querySelectorAll("[data-pipeline-since]")) {
        const duration = age(n.getAttribute("data-pipeline-since"), now());
        n.textContent = duration ? n.getAttribute("data-pipeline-prefix") + " seit " + duration : "Dauer unbekannt";
      }
    }
    function clock() {
      clearTimeout(state.clock);
      if (state.stopped || !visible()) return;
      entry();
      if (state.open) {
        const questionExpired = [...el.body.querySelectorAll("[data-pipeline-question-at]")]
          .some(n => now() - Date.parse(n.getAttribute("data-pipeline-question-at")) > QUESTION_MS);
        if (stale() !== state.renderedStale || questionExpired) render();
        updateTimes();
      }
      // Unabhängig von einem hängenden Abruf: ein alter Stand wird von selbst sichtbar.
      state.clock = setTimeout(clock, 1000);
    }
    function schedule() {
      clearTimeout(state.poll);
      if (!state.stopped && visible()) state.poll = setTimeout(() => void load(), state.open ? 10_000 : 30_000);
    }
    async function load() {
      state.stopped = false;
      const seq = ++state.seq;
      clock();
      try {
        const res = await deps.api("GET", "/api/pipelines");
        if (seq !== state.seq) return;
        if (!res.ok || !res.data || !Array.isArray(res.data.pipelines)) throw new Error(res.data && res.data.error || "Pipeline-Status konnte nicht geladen werden.");
        const recovered = !!state.error;
        state.data = res.data; state.error = "";
        entry();
        const signature = JSON.stringify(state.data);
        if (recovered || signature !== state.signature || stale() !== state.renderedStale) { state.signature = signature; render(); }
      } catch (e) {
        if (seq !== state.seq) return;
        state.error = e.message || "Verbindung unterbrochen. Bitte erneut versuchen.";
        entry(); render();
      } finally { if (seq === state.seq) schedule(); }
    }
    function row(p) {
      const li = node("li", "job-item pipeline-item");
      li.setAttribute("data-pipeline-id", p.id); li.setAttribute("data-state", p.state);
      const heading = node("div", "job-heading");
      heading.appendChild(node("h3", "job-title", p.name));
      const badge = node("span", "job-state", STATES[p.state] + (p.hanging ? " · hängt vermutlich" : ""));
      badge.setAttribute("data-waiting", String(p.state === "waiting" && !stale()));
      heading.appendChild(badge); li.appendChild(heading);
      if (p.description) li.appendChild(node("p", "thread-context", p.description));
      const meta = node("p", "thread-meta");
      const duration = node("span", "", "Dauer unbekannt");
      if (p.since) {
        duration.setAttribute("data-pipeline-since", p.since);
        duration.setAttribute("data-pipeline-prefix", p.state === "waiting" ? "wartet" : STATES[p.state]);
      }
      meta.appendChild(duration);
      if (p.restingState) meta.appendChild(node("span", "", " · zuletzt: " + STATES[p.restingState]));
      li.appendChild(meta);
      if (p.milestone) li.appendChild(node("p", "thread-context", "Meilenstein: " + p.milestone));
      if (p.issue) {
        const issue = node("p", "pipeline-issue");
        const label = "#" + p.issue.number + (p.issue.title ? " · " + p.issue.title : "");
        if (p.issue.url) {
          const link = node("a", "", label);
          link.href = p.issue.url; link.target = "_blank"; link.rel = "noopener noreferrer";
          link.setAttribute("data-pipeline-focus", p.id + ":issue"); issue.appendChild(link);
        } else issue.textContent = label;
        li.appendChild(issue);
      }
      if (p.step) li.appendChild(node("p", "thread-meta", (p.state === "running" ? "Schritt: " : "Letzter Schritt: ") + STEPS[p.step.kind] + (p.step.round ? " · Runde " + p.step.round : "")));
      if (p.reason) li.appendChild(node("p", "thread-context pipeline-reason", p.reason));
      if (p.question && now() - Date.parse(p.question.at) <= QUESTION_MS) {
        const q = disclosure(p.id + ":question", "Letzte Frage · " + date(p.question.at), "job-question pipeline-question");
        const summary = q.children[0];
        summary.appendChild(node("span", "pipeline-preview", p.question.text.length > 150 ? p.question.text.slice(0, 149) + "…" : p.question.text));
        const text = node("p", "thread-question pipeline-question-text", p.question.text);
        text.setAttribute("data-pipeline-question-at", p.question.at);
        q.appendChild(text);
        q.appendChild(node("p", "actions-hint", "Antworte im Gespräch. Die Frage kann inzwischen beantwortet sein."));
        li.appendChild(q);
      }
      if (p.conversation) {
        const actions = node("div", "settings-actions job-actions");
        const b = button("Zum Gespräch", p.id + ":open", () => deps.openConversation(p.conversation.id));
        b.setAttribute("aria-label", "Zum Gespräch: " + p.conversation.name);
        actions.appendChild(b); li.appendChild(actions);
      }
      if (p.events.length) {
        const details = disclosure(p.id + ":events", "Letzte Ereignisse (" + p.events.length + ")", "pipeline-events");
        const list = node("ol", "pipeline-event-list");
        for (const e of [...p.events].reverse()) {
          const item = node("li"); item.appendChild(time(e.at));
          item.appendChild(node("span", "", EVENTS[e.type] + (e.round ? " · Runde " + e.round : "")));
          list.appendChild(item);
        }
        details.appendChild(list); li.appendChild(details);
      }
      return li;
    }
    function render() {
      if (!state.open) return;
      const active = document.activeElement;
      const focusKey = active && active.getAttribute("data-pipeline-focus");
      const scroll = el.view.querySelector(".settings-scroll"), top = scroll ? scroll.scrollTop : 0;
      state.renderedStale = stale();
      el.body.textContent = "";
      if (state.error) {
        const error = node("p", "actions-error", state.error + (state.data ? " Der letzte bekannte Stand bleibt sichtbar." : ""));
        error.setAttribute("role", "alert"); el.body.appendChild(error);
        el.body.appendChild(button("Erneut laden", "retry", () => void load()));
      }
      const data = state.data;
      if (data && data.generatedAt) {
        el.status.textContent = "Stand von " + date(data.generatedAt) + (stale() ? ", der Statusdienst läuft nicht oder liefert keinen neuen Stand." : " · wird automatisch aktualisiert");
        el.status.setAttribute("data-stale", String(stale()));
      } else el.status.textContent = "";
      if (!data) el.body.appendChild(node("p", "settings-empty", state.error ? "Noch kein verlässlicher Stand." : "Pipelines werden geladen…"));
      else if (!data.pipelines.length) el.body.appendChild(node("p", "settings-empty", "Keine Pipelines vorhanden."));
      else {
        if (data.supervisors && Object.values(data.supervisors).every(value => value === false)) {
          el.body.appendChild(node("p", "pipeline-stopped settings-warning", (stale() ? "Letzter bekannter Stand: " : "") + "Pipelines gestoppt: Die Wächter sind aus, von selbst läuft nichts wieder an."));
        }
        for (const [kind, label] of [["waiting", "Warten auf dich"], ["halted", "Angehalten"], ["running", "Läuft"], ["resting", "Ruht"]]) {
          const pipelines = data.pipelines.filter(p => p.state === kind);
          if (!pipelines.length) continue;
          const section = kind === "resting" ? disclosure("resting", "Ruht (" + pipelines.length + ")", "job-group pipeline-resting") : node("section", "job-group");
          if (kind !== "resting") section.appendChild(node("h2", "group-label", label));
          const list = node("ul", "thread-list");
          for (const p of pipelines) list.appendChild(row(p));
          section.appendChild(list); el.body.appendChild(section);
        }
      }
      updateTimes();
      if (focusKey) {
        const target = [...el.body.querySelectorAll("[data-pipeline-focus]")].find(n => n.getAttribute("data-pipeline-focus") === focusKey);
        (target || el.title).focus({ preventScroll: true });
      }
      if (scroll) scroll.scrollTop = top;
    }
    return {
      load, isOpen: () => state.open,
      show() { state.open = true; el.view.hidden = false; el.entry.setAttribute("aria-current", "page"); render(); el.title.focus(); void load(); },
      hide() { state.open = false; el.view.hidden = true; el.entry.removeAttribute("aria-current"); schedule(); },
      stop() { state.stopped = true; state.seq++; clearTimeout(state.poll); clearTimeout(state.clock); },
      visibility() { if (visible()) void load(); else { clearTimeout(state.poll); clearTimeout(state.clock); } },
    };
  }
  window.TyboPipelines = { create, age };
})();
