/** Rückgabe an den Chat: Status je Job und Lauf, übernommen erst unmittelbar vor dem Turn. */
import { randomUUID } from "node:crypto";
import { isRestartPendingError } from "../execution-context";
import { logSafe, type NoticeDeps } from "./notice";
import { ownProcessRef, processGone } from "./process";
import { readAllStatuses, updateStatus, type JobStatus } from "./store";

export type ReturnResult = "done" | "retry" | "gone";
/** claim erst unter der Gesprächssperre, vor Speicherung und Modellaufruf aufrufen. */
export type RunJobReport = (status: JobStatus, claim: () => Promise<boolean>) => Promise<ReturnResult>;

function eligible(s: JobStatus): boolean {
  return s.returnToChat === true && s.phase === "ended" && s.outcome === "success" &&
    (s.notice?.state === "sent" || s.notice?.state === "failed");
}

export function createJobReturnQueue(deps: Pick<NoticeDeps, "root" | "proc" | "notify" | "secrets" | "log">, run: RunJobReport) {
  const active = new Map<string, Promise<void>>();

  async function consume(previous: JobStatus): Promise<void> {
    const id = previous.id;
    const expectedRun = previous.run ?? 1;
    const token = randomUUID();
    let claimed = false;
    // Auch alte oder vom Aufräumen abgeschlossene Jobs ohne Rückgabe-Feld aufnehmen.
    const prepared = await updateStatus(deps.root, id, s => {
      if ((s.run ?? 1) !== expectedRun || !eligible(s) || s.returnDelivery) return null;
      s.returnDelivery = { run: expectedRun, state: "pending" };
      return s;
    });
    const status = prepared.status;
    if (!status || (status.run ?? 1) !== expectedRun || !eligible(status)) return;
    const delivery = status.returnDelivery;
    if (!delivery || delivery.run !== expectedRun) return;
    if (delivery.state === "claimed") {
      if (!processGone(delivery.owner, deps.proc)) return;
      // Unklarer Ausgang: niemals ein zweiter Modelllauf mit Werkzeugen. Der
      // Hinweis wird vor dem Versand verbucht, bei Sendefehlern bleibt das Log.
      const abandoned = await updateStatus(deps.root, id, s => {
        const d = s.returnDelivery;
        if (d?.run !== expectedRun || d.state !== "claimed" || !processGone(d.owner, deps.proc)) return null;
        d.state = "discarded";
        return s;
      });
      if (!abandoned.changed) return;
      const text = `Job ${id}, Lauf ${expectedRun}: Die Weiterverarbeitung des Berichts wurde unterbrochen. ` +
        "Sie wird nicht automatisch wiederholt, weil bereits Werkzeuge gelaufen sein können. Bitte den Bericht im Gespräch prüfen.";
      logSafe(deps, `[job] ${text}`);
      const sent = await deps.notify({ ...status.target, source: "job", format: "plain", text }).catch(() => null);
      if (!sent || (!sent.sent && !sent.recorded)) logSafe(deps, `[job] ${id}: Hinweis zur unterbrochenen Rückgabe nicht zugestellt`);
      return;
    }
    if (delivery.state !== "pending") return;

    const claim = async () => {
      const result = await updateStatus(deps.root, id, s => {
        if ((s.run ?? 1) !== expectedRun || !eligible(s) || s.returnDelivery?.run !== expectedRun || s.returnDelivery.state !== "pending") return null;
        s.returnDelivery = { run: expectedRun, state: "claimed", owner: { ...ownProcessRef(deps.proc), token } };
        return s;
      });
      claimed = result.changed;
      return claimed;
    };
    let result: ReturnResult;
    try { result = await run(status, claim); }
    catch (e) {
      // Neustart lehnt vor dem Modellaufruf ab. Andere Fehler nach claim sind
      // endgültig, sonst könnten bereits gestartete Folge-Jobs doppelt laufen.
      result = isRestartPendingError(e) || !claimed ? "retry" : "done";
      logSafe(deps, `[job] ${id}: Rückgabe ${result === "retry" ? "wartet" : "beendet"} (${e instanceof Error ? e.name : "Fehler"})`);
    }
    // Ein Abbruch beim Warten beendet den Turn, hat den Bericht aber noch nicht übernommen.
    if (result === "done" && !claimed) return;
    await updateStatus(deps.root, id, s => {
      const d = s.returnDelivery;
      if ((s.run ?? 1) !== expectedRun || d?.run !== expectedRun) return null;
      if (claimed ? d.owner?.token !== token : d.state !== "pending") return null;
      if (result === "retry") { d.state = "pending"; delete d.owner; }
      else d.state = result === "gone" ? "discarded" : "done";
      return s;
    });
    if (result === "gone") logSafe(deps, `[job] ${id}: Rückgabe verworfen (Gespräch oder Bericht fehlt)`);
  }

  /** Andere Gespräche bleiben frei, auch wenn ein Turn lange auf seinen Platz wartet. */
  async function poll(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const status of await readAllStatuses(deps.root)) {
      if (!eligible(status)) continue;
      const key = `${status.id}:${status.run ?? 1}`;
      if (active.has(key)) continue;
      const task = consume(status).catch(e => logSafe(deps, `[job] ${status.id}: Rückgabe nicht abgeholt (${e instanceof Error ? e.name : "Fehler"})`));
      active.set(key, task);
      void task.finally(() => active.delete(key));
      work.push(task);
    }
    await Promise.all(work);
  }
  return { poll };
}
