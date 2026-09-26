# 0007 Agenten im Browser verwalten

Datum: 24.09.2026. Entschieden von: Maintainer.

tybo wird als eigenes Produkt weiterentwickelt. Rücksicht auf Updates eines
anderen Projekts entfällt.

- **System-Prompts sind sichtbar und bearbeitbar.** Die Fassung im Code
  (`src/agents/<name>.ts`) ist der Standard; eine Änderung im Browser liegt in
  `config/agents.json` und gilt vorrangig. „Auf Standard zurücksetzen" entfernt
  sie. Die zusätzlichen Anweisungen (`/agent`, `config/agent-overrides.json`)
  bleiben darunter bestehen. Änderungen greifen ab der nächsten frischen
  Session, wie bei `/agent`.
- **Neue Agenten** haben Name (Kennung), eine Zeile Beschreibung,
  System-Prompt, Modell und Effort. Sie antworten über den Haupt-Bot (eigene
  Bot-Tokens erst mit M6), sind sofort bei „Neues Gespräch" und in der
  Topic-Zuordnung wählbar, General kann sie per `[INVOKE:]` fragen, bei
  `/board` sind sie nur dabei, wenn im Browser eingeschaltet.
- **Löschen:** Jeder Agent außer General lässt sich nach Rückfrage löschen,
  auch die mitgelieferten. General bleibt, weil Direktchat und nicht
  zugeordnete Topics ihn als Rückfall brauchen. Vor dem Löschen zeigt die
  Seite die Topics, die den Agenten nutzen; sie wechseln zu General.
  Gelöschte mitgelieferte Agenten lassen sich wiederherstellen (ihr Code
  bleibt als Vorlage), selbst angelegte sind endgültig weg.
- Vor jedem Schreiben von `config/agents.json` wird die vorige Fassung nach
  `data/backups/` gesichert.
