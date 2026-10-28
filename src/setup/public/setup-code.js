// Code-Seite des Einrichtungsmodus (Issue #66): schickt den Einmal-Code als
// JSON an /api/setup/code, wie login.js das Passwort.
"use strict";

const form = document.getElementById("code-form");
const input = document.getElementById("code");
const button = document.getElementById("code-button");
const errorBox = document.getElementById("code-error");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  if (!input.value.trim()) {
    showError("Bitte den Code aus dem Terminal eingeben.");
    return;
  }
  button.disabled = true;
  try {
    const res = await fetch("/api/setup/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: input.value }),
      credentials: "same-origin",
    });
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.finished) showError("Die Einrichtung ist abgeschlossen. Der Code gilt nicht mehr.");
    else if (res.status === 401) showError("Falscher Code.");
    else if (res.status === 429) showError("Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.");
    else showError("Anmeldung fehlgeschlagen (Fehler " + res.status + ").");
  } catch {
    showError(window.TYBO_BRAND.name + " ist nicht erreichbar. Läuft die Einrichtung noch?");
  } finally {
    button.disabled = false;
    input.select();
  }
});
