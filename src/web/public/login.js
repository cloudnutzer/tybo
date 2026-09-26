// Login-Formular: schickt das Passwort als JSON an /api/login.
"use strict";

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
      window.location.href = "/";
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
