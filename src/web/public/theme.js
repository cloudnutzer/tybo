// Hell/Dunkel-Wahl der WebUI (Issue #15). Läuft als normales Skript im <head>
// von index.html und login.html, vor dem ersten Zeichnen, damit der falsche
// Modus nicht kurz aufblitzt. Setzt data-theme auf <html> ("light" oder
// "dark"); bei "system" fehlt das Attribut und prefers-color-scheme gilt.
// Die Wahl liegt pro Browser in localStorage. Lese- und Schreibfehler (z.B.
// privater Modus) brechen nichts ab: Lesen ergibt "system", Schreiben wirkt
// dann nur bis zum Neuladen.
// Der Schalter in der Seitenleiste (app.js) nutzt window.WebTheme.
"use strict";

(function () {
  // Schlüssel bleibt trotz Umbenennung in tybo (Issue #100), sonst wäre die Wahl weg
  const STORAGE_KEY = "tybo-theme";
  const CHOICES = ["system", "light", "dark"];
  // Wie in den theme-color-Meta-Tags und --bg in style.css
  const THEME_COLORS = { light: "#ffffff", dark: "#1f2023" };

  /** "light" | "dark" | "system"; alles andere gilt als "system". */
  function normalize(value) {
    return value === "light" || value === "dark" ? value : "system";
  }

  function storage() {
    // Schon der Zugriff auf window.localStorage kann werfen (Cookies gesperrt)
    return window.localStorage;
  }

  function read() {
    try {
      return normalize(storage().getItem(STORAGE_KEY));
    } catch {
      return "system";
    }
  }

  /** Speichert die Wahl; false, wenn der Browser das nicht zulässt. */
  function save(choice) {
    try {
      storage().setItem(STORAGE_KEY, normalize(choice));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wendet die Wahl an: data-theme und die Meta-Tags für die Browserleiste.
   * Bei Hell oder Dunkel tragen beide theme-color-Tags denselben festen Wert,
   * bei System wieder je ihren Wert für die Media-Abfrage.
   */
  function apply(choice) {
    const theme = normalize(choice);
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const media = meta.getAttribute("media") || "";
      const own = media.includes("dark") ? THEME_COLORS.dark : THEME_COLORS.light;
      meta.setAttribute("content", theme === "system" ? own : THEME_COLORS[theme]);
    }
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute("content", theme === "system" ? "light dark" : theme);
    return theme;
  }

  /** Aktuell angewendete Wahl, abgelesen am Dokument. */
  function current() {
    return normalize(document.documentElement.dataset.theme);
  }

  /** Wahl des Nutzers: sofort anwenden, dann speichern. */
  function choose(choice) {
    const theme = apply(choice);
    save(theme);
    return theme;
  }

  window.WebTheme = { CHOICES, STORAGE_KEY, normalize, read, save, apply, current, choose };
  apply(read());
})();
