/** All callers create an isolated POSIX process group with detached: true. */
export function terminateProcessTree(proc: { pid: number; kill: (signal?: number) => void }): void {
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"]);
      else process.kill(-proc.pid, value);
    } catch { try { proc.kill(value === "SIGKILL" ? 9 : 15); } catch {} }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 1500);
  timer.unref();
}
