/**
 * Kurzbeschreibung eines geworfenen Fehlers fürs Log der WebUI (Issue #565):
 * Typ, dazu Fehlercode und Systemaufruf, wenn sie die erwartete Form haben
 * (ENOENT, posix_spawn). Nie die Meldung selbst: die kann Pfade, Nutzerinhalt
 * oder Zugangsdaten enthalten. Ohne Abhängigkeit zu src/lib, wie chat.ts.
 */

const CODE_FORM = /^E[A-Z0-9]{2,15}$/;
const SYSCALL_FORM = /^[a-z_]{2,20}$/;

function field(err: unknown, name: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[name] : undefined;
}

export function errorLogFields(err: unknown): string {
  const kind = err instanceof Error ? err.name : typeof err;
  const code = field(err, "code");
  const syscall = field(err, "syscall");
  return [
    kind,
    typeof code === "string" && CODE_FORM.test(code) ? `code=${code}` : "",
    typeof syscall === "string" && SYSCALL_FORM.test(syscall) ? `syscall=${syscall}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
