// Offline-Seite (Issue #224): „Erneut versuchen" lädt die Startseite neu.
// Der Service Worker (sw.js) zeigt diese Seite aus seinem Cache, wenn tybo
// nicht erreichbar ist; klappt es beim nächsten Versuch, kommt die WebUI.
"use strict";

const retry = document.getElementById("retry");
if (retry) {
  retry.addEventListener("click", () => {
    retry.disabled = true;
    window.location.href = "/";
  });
}
