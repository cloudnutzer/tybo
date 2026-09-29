// Login-Formular: schickt das Passwort als JSON an /api/login.
// Registriert den Service Worker der installierbaren Web-App (Issue #224).
// Ein Direktlink (#/gespraech/<id>, Issue #226), ein Einstellungs-Reiter oder
// geteilte Inhalte (#/teilen, Issue #229) in der Adresse bleiben über die
// Anmeldung erhalten.
"use strict";

/** Wie keptHash in app.js: Direktlinks auf Gespräche, Einstellungen und Teilen (Issue #229) */
function keptHash(hash) {
  const value = String(hash || "");
  return /^#\/gespraech\/[^/?#]{1,80}$/.test(value) || /^#\/teilen(\/fehler)?$/.test(value) || /^#\/einstellungen(\/[a-z-]{1,40})?$/.test(value)
    ? value
    : "";
}

// Nur im sicheren Kontext (HTTPS, localhost); über http://<LAN-IP> bleibt es
// eine normale Webseite. Einen Hinweis „Neue Version" gibt es hier nicht: ein
// neuer Worker übernimmt, sobald keine Seite mehr den alten nutzt.
(function registerServiceWorker() {
  try {
    const container = window.isSecureContext && window.navigator ? window.navigator.serviceWorker : null;
    if (!container || typeof container.register !== "function") return;
    container.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  } catch {
    // gesperrt oder nicht unterstützt: das Login geht auch ohne
  }
})();

const form = document.getElementById("login-form");
const input = document.getElementById("password");
const button = document.getElementById("login-button");
const errorBox = document.getElementById("login-error");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  if (!input.value) {
    showError("Bitte das Passwort eingeben.");
    return;
  }
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
      credentials: "same-origin",
    });
    if (res.ok) {
      window.location.href = "/" + keptHash(window.location.hash);
      return;
    }
    if (res.status === 401) showError("Falsches Passwort.");
    else if (res.status === 429) showError("Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.");
    else showError("Anmeldung fehlgeschlagen (Fehler " + res.status + ").");
  } catch {
    showError("Server nicht erreichbar.");
  } finally {
    button.disabled = false;
    input.select();
  }
});
