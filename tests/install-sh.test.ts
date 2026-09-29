/**
 * Issue #144: install.sh (curl … | sh). Läuft in einem Temp-HOME mit einem
 * eigenen PATH, der nur Attrappen (git, bun, curl, uname, id, sudo, unzip)
 * und einige harmlose Werkzeuge (sed, ls, mktemp, …) enthält. Jede Attrappe
 * schreibt ihren Namen, ihr Arbeitsverzeichnis und ihre Argumente in ein
 * Protokoll. Echtes Bun, Git oder curl erreicht das Skript so nie; auch der
 * „heruntergeladene“ Bun-Installer ist eine Attrappe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { repoCloneUrl } from "../src/lib/repo-remote";
import { CLAUDE_INSTALL, MIN_BUN_VERSION } from "../src/setup/steps/prerequisites";

const SCRIPT = resolve(import.meta.dir, "..", "install.sh");
const SOURCE = await readFile(SCRIPT, "utf8");
const pkg = await Bun.file(resolve(import.meta.dir, "..", "package.json")).json();

const SHELLS = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
const SEP = "\x1f";

/** Protokollzeile einer Attrappe: Name, Arbeitsverzeichnis, Argumente */
const LOG_LINE = `printf '%s' "$(basename "$0")${SEP}$(pwd)" >>"$MOCK_LOG"; for a in "$@"; do printf '${SEP}%s' "$a" >>"$MOCK_LOG"; done; printf '\\n' >>"$MOCK_LOG"`;

const MOCKS: Record<string, string> = {
  id: `${LOG_LINE}\n[ "$1" = "-u" ] && echo "\${FAKE_UID:-1000}"\nexit 0`,
  uname: `${LOG_LINE}\necho "\${FAKE_UNAME:-Linux}"`,
  sudo: `${LOG_LINE}\nexit 1`,
  unzip: `${LOG_LINE}\nexit 0`,
  curl: `${LOG_LINE}
[ -n "\${FAKE_CURL_FAIL:-}" ] && exit 22
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=$2; shift; done
[ -n "$out" ] || exit 2
cat >"$out" <<'EOF'
#!/bin/bash
printf 'bun-installer\\x1f%s\\x1f%s\\n' "$(pwd)" "$BUN_INSTALL" >>"$MOCK_LOG"
[ -n "\${FAKE_INSTALLER_FAIL:-}" ] && exit 1
mkdir -p "$BUN_INSTALL/bin"
cp "$FAKE_BUN_SRC" "$BUN_INSTALL/bin/bun"
exit 0
EOF`,
  bun: `${LOG_LINE}
state="$FAKE_STATE/bun-version"
case "$1" in
  --version) if [ -f "$state" ]; then cat "$state"; else echo "\${FAKE_BUN_VERSION:-1.3.10}"; fi ;;
  upgrade) [ -n "\${FAKE_UPGRADE_FAIL:-}" ] && exit 1; echo "\${FAKE_UPGRADE_TO:-1.4.0}" >"$state" ;;
  install) [ -n "\${FAKE_INSTALL_FAIL:-}" ] && exit 1; exit 0 ;;
  link) exit 0 ;;
  --no-env-file)
    IFS= read -r line || true
    printf 'setup-stdin${SEP}%s\\n' "$line" >>"$MOCK_LOG"
    # was tybo setup sieht: Projektordner und das Bun, das which findet
    printf 'setup-env${SEP}%s${SEP}%s\\n' "\${TYBO_ROOT:-}" "$(command -v bun || true)" >>"$MOCK_LOG"
    [ -n "\${FAKE_SETUP_FAIL:-}" ] && exit 1 ;;
esac
exit 0`,
  git: `${LOG_LINE}
if [ "$1" = "clone" ]; then
  [ -n "\${FAKE_CLONE_FAIL:-}" ] && exit 128
  mkdir -p "$5/.git" "$5/scripts" && : >"$5/scripts/tybo.ts"; exit 0
fi
[ "$1" = "-C" ] || exit 0
d=$2; shift 2
case "$1 $2" in
  "rev-parse --show-toplevel")
    [ -d "$d/.git" ] || exit 128
    if [ -n "\${FAKE_TOPLEVEL:-}" ]; then echo "$FAKE_TOPLEVEL"; else (cd "$d" && pwd -P); fi ;;
  "remote get-url") [ -n "\${FAKE_ORIGIN:-}" ] || exit 2; echo "$FAKE_ORIGIN" ;;
  "symbolic-ref --short") echo "\${FAKE_BRANCH:-master}" ;;
  "status --porcelain") [ -n "\${FAKE_DIRTY:-}" ] && echo " M src/bot.ts"; exit 0 ;;
  "fetch origin") [ -n "\${FAKE_FETCH_FAIL:-}" ] && exit 1; exit 0 ;;
  "merge-base --is-ancestor") [ -n "\${FAKE_DIVERGED:-}" ] && exit 1; exit 0 ;;
  "pull --ff-only") exit 0 ;;
  "rev-parse --short") echo abc1234 ;;
esac
exit 0`,
};

/** Echte Werkzeuge, die das Skript und die Attrappen brauchen; bash nur für den Attrappen-Installer */
const REAL_TOOLS = ["sed", "tr", "ls", "mktemp", "rm", "mkdir", "cat", "cp", "basename", "bash", "sleep"];

let root: string;
let mockDir: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tybo-install-"));
  mockDir = join(root, "mocks");
  await mkdir(mockDir);
  for (const [name, body] of Object.entries(MOCKS)) {
    await writeFile(join(mockDir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(mockDir, name), 0o755);
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface RunOptions {
  args?: string[];
  env?: Record<string, string>;
  shell?: string;
  /** false = keine Bun-Attrappe im PATH */
  bunInPath?: boolean;
  /** Attrappen, die fehlen sollen */
  without?: string[];
  /** Inhalt der TYBO_TTY-Datei; null = kein Terminal */
  tty?: string | null;
  /** Skript über die Standardeingabe (wie curl … | sh) */
  viaPipe?: boolean;
  /** anderes Skript statt install.sh */
  script?: string;
  /** vor dem Lauf, mit HOME */
  prepare?: (home: string) => Promise<void>;
  /** zusätzliche PATH-Einträge hinter dem Attrappen-Ordner */
  extraPath?: (home: string) => string[];
}

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
  home: string;
  calls: string[][];
}

async function run(opts: RunOptions = {}): Promise<RunResult> {
  const dir = join(root, `run-${++counter}`);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(home, { recursive: true });
  await Promise.all([mkdir(bin), mkdir(state)]);
  for (const tool of REAL_TOOLS) {
    const real = Bun.which(tool, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    if (!real) throw new Error(`Werkzeug fehlt: ${tool}`);
    await symlink(real, join(bin, tool));
  }
  const without = new Set(opts.without ?? []);
  for (const name of Object.keys(MOCKS)) {
    if (without.has(name) || (name === "bun" && opts.bunInPath === false)) continue;
    await symlink(join(mockDir, name), join(bin, name));
  }
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  const ttyFile = join(dir, "tty");
  if (opts.tty !== null) await writeFile(ttyFile, opts.tty ?? "");
  await opts.prepare?.(home);

  const env: Record<string, string> = {
    PATH: [bin, ...(opts.extraPath?.(home) ?? [])].join(":"),
    HOME: home,
    TMPDIR: dir,
    MOCK_LOG: log,
    FAKE_STATE: state,
    FAKE_BUN_SRC: join(mockDir, "bun"),
    TYBO_TTY: opts.tty === null ? join(dir, "kein-terminal") : ttyFile,
    ...opts.env,
  };
  const script = opts.script ?? SCRIPT;
  const shell = opts.shell ?? "/bin/sh";
  const cmd = opts.viaPipe ? [shell, "-s", "--", ...(opts.args ?? [])] : [shell, script, ...(opts.args ?? [])];
  const child = Bun.spawn(cmd, {
    cwd: home,
    env,
    stdin: opts.viaPipe ? Bun.file(script) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const calls = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(line => line.split(SEP));
  // In keinem Fall sudo
  expect(calls.filter(c => c[0] === "sudo")).toEqual([]);
  return { exit, stdout, stderr, home, calls };
}

/** Name und Argumente ohne Arbeitsverzeichnis */
const argv = (c: string[]) => [c[0], ...c.slice(2)];
const named = (r: RunResult, name: string) => r.calls.filter(c => c[0] === name).map(argv);
const has = (r: RunResult, ...prefix: string[]) =>
  r.calls.some(c => prefix.every((p, i) => argv(c)[i] === p));

/** Setzt den ersten ausgegebenen Befehl „cd <pfad> && …“ in sh ein und liefert den Pfad, den sh daraus macht */
function cdTarget(text: string): string {
  const m = /cd (.+?) && /.exec(text);
  if (!m) throw new Error(`kein cd-Befehl in: ${text}`);
  const p = Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${m[1]}`]);
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

/** Wertet die ausgegebene Zeile „export BUN_INSTALL=…“ in sh aus und liefert den Wert */
function exportedBunInstall(text: string): string {
  const m = /^ {2}(export BUN_INSTALL=.*)$/m.exec(text);
  if (!m) throw new Error(`keine export-BUN_INSTALL-Zeile in: ${text}`);
  const p = Bun.spawnSync(["/bin/sh", "-c", `${m[1]}\nprintf '%s' "$BUN_INSTALL"`], { env: { HOME: "/home/demo", PATH: "/usr/bin:/bin" } });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

/** Ausführbare Attrappe, die nichts tut */
async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

/** Verhalten von ~/.local/bin/claude bei „claude --version“ */
const CLAUDE_BODIES = {
  /** meldet eine Version wie die echte CLI */
  ok: 'echo "2.1.300 (Claude Code)"',
  /** startet, scheitert aber */
  fails: 'echo "Error: cannot find module" >&2\nexit 1',
  /** Exit 0, aber keine Version */
  silent: "exit 0",
  /** hängt */
  hangs: "exec sleep 30",
  /** hängt und ignoriert TERM (PR #223) */
  hangsIgnoringTerm: "trap '' TERM\nsleep 30",
  /** meldet eine Version, hängt dann und beendet sich bei TERM mit Exit 0 (PR #223) */
  versionThenHang: 'echo "2.1.300 (Claude Code)"\ntrap "exit 0" TERM\nsleep 30 & wait',
} as const;

/** ~/.local/bin/claude anlegen: ausführbare Attrappe mit Verhalten oder (false) nicht ausführbar */
const localClaude = (body: keyof typeof CLAUDE_BODIES | false) => async (home: string) => {
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  const file = join(home, ".local", "bin", "claude");
  if (body === false) {
    await writeFile(file, "kein Programm");
    return;
  }
  await writeFile(file, `#!/bin/sh\n${CLAUDE_BODIES[body]}\n`);
  await chmod(file, 0o755);
};

const setupEnv = (r: RunResult) => r.calls.find(c => c[0] === "setup-env");

/** Legt einen vorhandenen Klon an (für den zweiten Lauf) */
const existingClone = (sub = "tybo") => async (home: string) => {
  await mkdir(join(home, sub, ".git"), { recursive: true });
  await writeFile(join(home, sub, "README.md"), "tybo");
};

describe("install.sh: statische Prüfungen", () => {
  test("sh -n", async () => {
    const p = Bun.spawnSync(["/bin/sh", "-n", SCRIPT]);
    expect(p.exitCode).toBe(0);
  });

  test("dash -n", () => {
    if (!existsSync("/bin/dash")) {
      console.log("dash fehlt, übersprungen");
      return;
    }
    expect(Bun.spawnSync(["/bin/dash", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("shellcheck -s sh ohne Befund", () => {
    const sc = Bun.which("shellcheck");
    if (!sc) {
      console.log("shellcheck fehlt, übersprungen (die CI prüft es)");
      return;
    }
    const p = Bun.spawnSync([sc, "-s", "sh", SCRIPT]);
    expect(p.stdout.toString() + p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
  });

  test("POSIX-sh mit set -eu, main \"$@\" in der letzten Zeile", () => {
    const lines = SOURCE.trimEnd().split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(SOURCE).toMatch(/^set -eu$/m);
    expect(lines[lines.length - 1]).toBe('main "$@"');
    // Sonst kein Aufruf auf oberster Ebene: nur Zuweisungen, Funktionen, Kommentare
    let depth = 0;
    for (const line of lines.slice(1, -1)) {
      const t = line.trim();
      if (depth === 0 && t && !t.startsWith("#") && !/^set -eu$/.test(t) && !/^[A-Z_]+="[^"$`]*"$/.test(t)) {
        expect(t).toMatch(/^[a-z_]+\(\) \{$/);
      }
      if (/^[a-z_]+\(\) \{$/.test(line)) depth++;
      if (line === "}") depth--;
    }
    expect(depth).toBe(0);
  });

  test("kein sudo-Aufruf im Skript, nur in Hinweistexten", () => {
    for (const line of SOURCE.split("\n")) {
      if (!line.includes("sudo") || line.trim().startsWith("#")) continue;
      expect(line).toMatch(/(die|say) "[^"]*sudo/);
    }
  });
});

describe("install.sh: Gleichlauf", () => {
  test("Standard von TYBO_REPO_URL = https://github.com/${BRAND.repo}.git", () => {
    const m = /^TYBO_DEFAULT_REPO_URL="([^"]+)"$/m.exec(SOURCE);
    expect(m?.[1]).toBe(`https://github.com/${BRAND.repo}.git`);
    expect(m?.[1]).toBe(repoCloneUrl());
    expect(SOURCE).toContain("repo_url=${TYBO_REPO_URL:-$TYBO_DEFAULT_REPO_URL}");
  });

  test("Mindestversion = MIN_BUN_VERSION = engines.bun", () => {
    const m = /^TYBO_MIN_BUN_VERSION="([^"]+)"$/m.exec(SOURCE);
    expect(m?.[1]).toBe(MIN_BUN_VERSION);
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  });

  test("Claude-CLI-Befehl wie im Schritt Voraussetzungen: der native Installer", () => {
    expect(SOURCE).toContain(`CLAUDE_INSTALL_CMD="${CLAUDE_INSTALL}"`);
    expect(SOURCE).toContain('CLAUDE_INSTALL_CMD="curl -fsSL https://claude.ai/install.sh | bash"');
    expect(SOURCE).not.toContain("npm install -g @anthropic-ai/claude-code");
  });
});

describe("install.sh --help", () => {
  test("zeigt alle Optionen, ruft nichts auf", async () => {
    const r = await run({ args: ["--help"] });
    expect(r.exit).toBe(0);
    for (const opt of ["--dir <pfad>", "--yes", "--no-setup", "--help", "TYBO_DIR", "TYBO_REPO_URL", "TYBO_BRANCH", "TYBO_TTY", "BUN_INSTALL"]) {
      expect(r.stdout).toContain(opt);
    }
    expect(r.calls).toEqual([]);
  });

  test("unbekannte Option: Abbruch mit Hinweis auf --help", async () => {
    const r = await run({ args: ["--foo"] });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("tybo: unbekannte Option: --foo");
    expect(r.stderr).toContain("--help");
    expect(r.calls).toEqual([]);
  });
});

describe("install.sh: halber Download", () => {
  test("nur die erste Hälfte per sh: keine Attrappe wird aufgerufen", async () => {
    const lines = SOURCE.split("\n");
    const half = join(root, "half.sh");
    await writeFile(half, lines.slice(0, Math.floor(lines.length / 2)).join("\n") + "\n");
    const r = await run({ script: half });
    expect(r.calls).toEqual([]);
  });

  test("alles außer der letzten Zeile: nichts ausgeführt, auch nicht per Pipe", async () => {
    const cut = join(root, "cut.sh");
    await writeFile(cut, SOURCE.trimEnd().split("\n").slice(0, -1).join("\n") + "\n");
    const r = await run({ script: cut });
    expect(r.exit).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toBe("");
    const p = await run({ script: cut, viaPipe: true });
    expect(p.calls).toEqual([]);
  });
});

for (const shell of SHELLS) {
  describe(`install.sh unter ${shell}`, () => {
    test("neue Installation: Klon nach ~/tybo, bun install, bun link, setup in dieser Reihenfolge", async () => {
      const r = await run({ shell, tty: "Antwort für setup\n" });
      expect(r.exit).toBe(0);
      const dir = join(r.home, "tybo");
      const relevant = r.calls
        .filter(c => (c[0] === "git" && c[2] === "clone") || (c[0] === "bun" && c[2] !== "--version") || c[0] === "setup-stdin")
        .map(c => {
          if (c[0] === "setup-stdin") return c;
          return c[0] === "bun" && (c[2] === "install" || c[2] === "link") ? c : argv(c);
        });
      expect(relevant).toEqual([
        ["git", "clone", "--branch", "master", "https://github.com/cloudnutzer/tybo.git", dir],
        ["bun", dir, "install", "--frozen-lockfile"],
        ["bun", dir, "link"],
        ["bun", "--no-env-file", join(dir, "scripts/tybo.ts"), "setup"],
        // setup liest aus TYBO_TTY, nicht aus der Pipe
        ["setup-stdin", "Antwort für setup"],
      ]);
      expect(named(r, "curl")).toEqual([]);
      expect(r.stdout).toContain("tybo: tybo ist installiert. Jetzt startet die Einrichtung");
    });

    test("TYBO_DIR bestimmt den Zielordner", async () => {
      const target = join(root, `per env ${Date.now()}`);
      const r = await run({ shell, env: { TYBO_DIR: target }, tty: "" });
      expect(r.exit).toBe(0);
      expect(named(r, "git")[0]).toEqual(["git", "clone", "--branch", "master", "https://github.com/cloudnutzer/tybo.git", target]);
    });

    test("--dir mit Leerzeichen, TYBO_REPO_URL und TYBO_BRANCH", async () => {
      const r = await run({
        shell,
        tty: "",
        env: { TYBO_DIR: "ignoriert", TYBO_REPO_URL: "/srv/eigene kopie.git", TYBO_BRANCH: "test" },
        args: ["--dir", "mein tybo"],
      });
      expect(r.exit).toBe(0);
      // relativ zum Arbeitsverzeichnis (hier HOME)
      const target = join(realpathSync(r.home), "mein tybo");
      expect(named(r, "git")[0]).toEqual(["git", "clone", "--branch", "test", "/srv/eigene kopie.git", target]);
      expect(has(r, "bun", "--no-env-file", join(target, "scripts/tybo.ts"), "setup")).toBe(true);
    });

    test("--no-setup: kein Setup, stattdessen der nächste Befehl", async () => {
      const r = await run({ shell, args: ["--no-setup"], tty: "" });
      expect(r.exit).toBe(0);
      expect(has(r, "bun", "link")).toBe(true);
      expect(r.calls.some(c => c[2] === "--no-env-file")).toBe(false);
      expect(r.stdout).toContain(`Weiter mit: cd ${join(r.home, "tybo")} && tybo setup`);
    });

    test("ohne Terminal (auch mit --yes): kein Setup", async () => {
      const r = await run({ shell, args: ["--yes"], tty: null });
      expect(r.exit).toBe(0);
      expect(r.calls.some(c => c[2] === "--no-env-file")).toBe(false);
      expect(r.stdout).toContain("Weiter mit: cd");
    });

    test("zweiter Lauf (SSH-origin): git pull --ff-only, kein Klon, kein Setup", async () => {
      const r = await run({
        shell,
        tty: "",
        env: { FAKE_ORIGIN: "git@github.com:cloudnutzer/tybo.git" },
        prepare: existingClone(),
      });
      expect(r.exit).toBe(0);
      const dir = join(r.home, "tybo");
      expect(has(r, "git", "-C", dir, "pull", "--ff-only", "origin", "master")).toBe(true);
      expect(named(r, "git").some(c => c[1] === "clone")).toBe(false);
      expect(r.calls.some(c => c[2] === "--no-env-file")).toBe(false);
      expect(has(r, "bun", "install", "--frozen-lockfile")).toBe(true);
      expect(r.stdout).toContain(`Aktualisiert auf abc1234. Läuft tybo schon, einmal neu starten: cd ${dir} && bun run restart:request "Update"`);
    });

    test("zweiter Lauf: HTTPS-origin ohne .git und ssh:// gelten als dasselbe Repo", async () => {
      for (const origin of ["https://github.com/cloudnutzer/tybo", "ssh://git@github.com/CloudNutzer/tybo.git/"]) {
        const r = await run({ shell, tty: "", env: { FAKE_ORIGIN: origin }, prepare: existingClone() });
        expect(r.exit).toBe(0);
        expect(has(r, "git", "-C", join(r.home, "tybo"), "pull", "--ff-only", "origin", "master")).toBe(true);
      }
    });

    const abortCases: [string, Record<string, string>, string][] = [
      ["lokale Änderungen", { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git", FAKE_DIRTY: "1" }, "lokale Änderungen in"],
      ["fremder origin", { FAKE_ORIGIN: "https://github.com/jemand/tybo.git" }, "gehört nicht zu tybo, nichts geändert"],
      ["Host, der nur ähnlich aussieht", { FAKE_ORIGIN: "https://github.com.evil.example/cloudnutzer/tybo.git" }, "gehört nicht zu tybo"],
      ["kein origin", {}, "gehört nicht zu tybo"],
      ["anderer Branch", { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git", FAKE_BRANCH: "eigener" }, "steht auf Branch eigener, nicht auf master, nichts geändert"],
      ["divergierte Historie", { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git", FAKE_DIVERGED: "1" }, "weicht vom Stand auf origin/master ab"],
      ["fetch fehlgeschlagen", { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git", FAKE_FETCH_FAIL: "1" }, "git fetch fehlgeschlagen"],
      ["Unterordner eines Klons", { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git", FAKE_TOPLEVEL: "/anderswo" }, "gehört nicht zu tybo"],
    ];
    for (const [name, env, message] of abortCases) {
      test(`zweiter Lauf, ${name}: Abbruch ohne weiteren Aufruf, auch ohne Bun`, async () => {
        const r = await run({ shell, tty: "j\n", env, prepare: existingClone(), bunInPath: false });
        expect(r.exit).toBe(1);
        expect(r.stderr).toContain(`tybo: `);
        expect(r.stderr).toContain(message);
        expect(named(r, "bun")).toEqual([]);
        expect(named(r, "curl")).toEqual([]);
        expect(named(r, "git").some(c => c.includes("pull") || c.includes("clone"))).toBe(false);
      });
    }

    test("Einrichtung scheitert: Exit 1 mit Fortsetzungsbefehl", async () => {
      const r = await run({ shell, tty: "", env: { FAKE_SETUP_FAIL: "1" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain(`tybo: Einrichtung nicht abgeschlossen. Später weiter mit: cd ${join(r.home, "tybo")} && tybo setup`);
    });

    test("fremdes TYBO_ROOT und abweichendes --dir: Setup arbeitet im Zielordner", async () => {
      const r = await run({ shell, tty: "", env: { TYBO_ROOT: join(root, "andere installation") }, args: ["--dir", "neu"] });
      expect(r.exit).toBe(0);
      expect(setupEnv(r)?.[1]).toBe(join(realpathSync(r.home), "neu"));
    });

    test("Bun nicht im ursprünglichen PATH: Setup findet das installierte Bun, PATH-Hinweis bleibt", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "" });
      expect(r.exit).toBe(0);
      const bunHome = join(r.home, ".bun");
      expect(setupEnv(r)?.[2]).toBe(join(bunHome, "bin/bun"));
      expect(r.stdout).toContain(`${bunHome}/bin ist nicht im PATH`);
      expect(exportedBunInstall(r.stdout)).toBe(bunHome);
    });

    test("Bun nicht im ursprünglichen PATH, Einrichtung scheitert: Exit 1, PATH- und Voraussetzungshinweise bleiben", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "", env: { FAKE_SETUP_FAIL: "1" } });
      expect(r.exit).toBe(1);
      const bunHome = join(r.home, ".bun");
      expect(r.stderr).toContain("Einrichtung nicht abgeschlossen. Später weiter mit: cd ");
      expect(r.stdout).toContain(`${bunHome}/bin ist nicht im PATH`);
      expect(exportedBunInstall(r.stdout)).toBe(bunHome);
      expect(r.stdout).toContain('export PATH="$BUN_INSTALL/bin:$PATH"');
      expect(r.stdout).toContain("Claude CLI");
    });

    for (const [name, sub] of [
      ["Dollarzeichen und Backticks", "bun $HOME `printf MARKER`"],
      ["einfache Anführungszeichen", "bun 'x' y"],
      ["doppelte Anführungszeichen", 'bun "x" $(printf MARKER)'],
    ] as const) {
      test(`BUN_INSTALL mit ${name}: ausgegebener export-Befehl ergibt genau den Pfad`, async () => {
        const bunHome = join(root, `${sub} ${counter}`);
        const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "", env: { BUN_INSTALL: bunHome } });
        expect(r.exit).toBe(0);
        expect(exportedBunInstall(r.stdout)).toBe(bunHome);
      });
    }

    const odd = `mein tybo $HOME 'x' \`y\` "z"`;
    test("Pfad mit Leerzeichen und Sonderzeichen: ausgegebene Befehle sind ausführbar", async () => {
      const noSetup = await run({ shell, tty: "", args: ["--no-setup", "--dir", odd] });
      expect(noSetup.exit).toBe(0);
      const target = join(realpathSync(noSetup.home), odd);
      expect(noSetup.stdout).toMatch(/Weiter mit: cd '.*' && tybo setup/);
      expect(cdTarget(noSetup.stdout.slice(noSetup.stdout.indexOf("Weiter mit")))).toBe(target);

      const failed = await run({ shell, tty: "", args: ["--dir", odd], env: { FAKE_SETUP_FAIL: "1" } });
      expect(failed.exit).toBe(1);
      expect(failed.stderr).toContain("&& tybo setup");
      expect(cdTarget(failed.stderr)).toBe(join(realpathSync(failed.home), odd));

      const update = await run({
        shell,
        tty: "",
        args: ["--dir", odd],
        env: { FAKE_ORIGIN: "https://github.com/cloudnutzer/tybo.git" },
        prepare: existingClone(odd),
      });
      expect(update.exit).toBe(0);
      expect(update.stdout).toContain('&& bun run restart:request "Update"');
      expect(cdTarget(update.stdout.slice(update.stdout.indexOf("Aktualisiert")))).toBe(join(realpathSync(update.home), odd));
    });

    test("fremder, nicht leerer Ordner ohne Git: Abbruch mit Hinweis auf --dir", async () => {
      const r = await run({
        shell,
        prepare: async home => {
          await mkdir(join(home, "tybo"));
          await writeFile(join(home, "tybo", "notizen.txt"), "privat");
        },
      });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain(`tybo: ${join(r.home, "tybo")} gehört nicht zu tybo, nichts geändert`);
      expect(r.stderr).toContain("--dir");
      expect(named(r, "git").some(c => c.includes("clone") || c.includes("pull"))).toBe(false);
      expect(named(r, "bun")).toEqual([]);
    });

    test("leerer Zielordner: neue Installation", async () => {
      const r = await run({ shell, tty: "", prepare: async home => { await mkdir(join(home, "tybo")); } });
      expect(r.exit).toBe(0);
      expect(named(r, "git")[0]?.[1]).toBe("clone");
    });

    test("Bun fehlt, --yes: offizieller Installer, danach Bun aus ~/.bun/bin", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "" });
      expect(r.exit).toBe(0);
      const curl = named(r, "curl");
      expect(curl.length).toBe(1);
      expect(curl[0].slice(0, 3)).toEqual(["curl", "-fsSL", "https://bun.sh/install"]);
      const bunHome = join(r.home, ".bun");
      expect(r.calls.find(c => c[0] === "bun-installer")?.[2]).toBe(bunHome);
      // unzip wird geprüft, nicht aufgerufen
      expect(named(r, "unzip")).toEqual([]);
      expect(has(r, "bun", "install", "--frozen-lockfile")).toBe(true);
      expect(r.stdout).toContain(`Bun 1.3.10 gefunden: ${join(bunHome, "bin/bun")}`);
      // PATH-Hinweis mit dem tatsächlichen Bun-Ordner
      expect(exportedBunInstall(r.stdout)).toBe(bunHome);
      expect(r.stdout).toContain('export PATH="$BUN_INSTALL/bin:$PATH"');
      expect(r.stdout).toContain("~/.zshrc");
    });

    test("Bun fehlt, Antwort „j“: Installer läuft", async () => {
      const r = await run({ shell, bunInPath: false, tty: "j\n" });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("Bun jetzt mit dem offiziellen Installer von bun.sh installieren? [J/n]");
      expect(named(r, "curl")[0]?.slice(0, 3)).toEqual(["curl", "-fsSL", "https://bun.sh/install"]);
    });

    test("Bun fehlt, Antwort „n“: Abbruch ohne curl", async () => {
      const r = await run({ shell, bunInPath: false, tty: "n\n" });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
      expect(named(r, "curl")).toEqual([]);
      expect(named(r, "git").some(c => c[1] === "clone")).toBe(false);
    });

    test("Bun fehlt, ohne Terminal und ohne --yes: Abbruch ohne curl", async () => {
      const r = await run({ shell, bunInPath: false, tty: null });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("ohne Terminal");
      expect(r.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
      expect(named(r, "curl")).toEqual([]);
    });

    test("eigenes BUN_INSTALL: Installer, Bun-Aufrufe und PATH-Hinweis nutzen es", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "", env: { BUN_INSTALL: join(root, `eigenes bun ${counter}`) } });
      expect(r.exit).toBe(0);
      const bunHome = r.calls.find(c => c[0] === "bun-installer")?.[2] ?? "";
      expect(bunHome).toContain("eigenes bun");
      expect(r.stdout).toContain(`Bun 1.3.10 gefunden: ${bunHome}/bin/bun`);
      expect(exportedBunInstall(r.stdout)).toBe(bunHome);
    });

    test("Bun liegt schon unter BUN_INSTALL, nicht im PATH: wird ohne Installer benutzt", async () => {
      const r = await run({
        shell,
        bunInPath: false,
        tty: "",
        prepare: async home => {
          await mkdir(join(home, ".bun", "bin"), { recursive: true });
          await symlink(join(mockDir, "bun"), join(home, ".bun", "bin", "bun"));
        },
      });
      expect(r.exit).toBe(0);
      expect(named(r, "curl")).toEqual([]);
      expect(has(r, "bun", "link")).toBe(true);
    });

    test("~/.bun/bin im PATH: kein PATH-Hinweis", async () => {
      const r = await run({ shell, tty: "", extraPath: home => [join(home, ".bun", "bin")] });
      expect(r.exit).toBe(0);
      expect(r.stdout).not.toContain("export PATH=");
    });

    test("Download des Installers schlägt fehl: Abbruch, nichts weiter", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, env: { FAKE_CURL_FAIL: "1" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("Bun-Installer ließ sich nicht laden");
      expect(r.calls.some(c => c[0] === "bun-installer")).toBe(false);
      expect(named(r, "git").some(c => c[1] === "clone")).toBe(false);
    });

    test("Installer schlägt fehl: Abbruch", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, env: { FAKE_INSTALLER_FAIL: "1" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("der Bun-Installer ist fehlgeschlagen");
      expect(named(r, "git").some(c => c[1] === "clone")).toBe(false);
    });

    test("bash, curl oder unzip fehlt: Abbruch vor dem Download", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, without: ["unzip"] });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("unzip fehlt");
      expect(named(r, "curl")).toEqual([]);
    });

    test("Bun zu alt, --yes: bun upgrade, danach weiter", async () => {
      const r = await run({ shell, args: ["--yes"], tty: "", env: { FAKE_BUN_VERSION: "1.3.9" } });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("Bun 1.3.9 ist zu alt");
      expect(has(r, "bun", "upgrade")).toBe(true);
      expect(r.stdout).toContain("Bun 1.4.0 gefunden");
      expect(has(r, "bun", "link")).toBe(true);
    });

    test("Bun zu alt, Antwort „n“: Abbruch ohne upgrade", async () => {
      const r = await run({ shell, tty: "n\n", env: { FAKE_BUN_VERSION: "1.2.23" } });
      expect(r.exit).toBe(1);
      expect(r.stdout).toContain("Bun jetzt mit bun upgrade aktualisieren? [J/n]");
      expect(has(r, "bun", "upgrade")).toBe(false);
    });

    test("bun upgrade schlägt fehl oder bleibt zu alt: Abbruch", async () => {
      const failed = await run({ shell, args: ["--yes"], env: { FAKE_BUN_VERSION: "1.3.9", FAKE_UPGRADE_FAIL: "1" } });
      expect(failed.exit).toBe(1);
      expect(failed.stderr).toContain("bun upgrade ist fehlgeschlagen");
      const still = await run({ shell, args: ["--yes"], env: { FAKE_BUN_VERSION: "1.3.9", FAKE_UPGRADE_TO: "1.3.9" } });
      expect(still.exit).toBe(1);
      expect(still.stderr).toContain("nach dem Upgrade noch 1.3.9");
      for (const r of [failed, still]) expect(named(r, "git").some(c => c[1] === "clone")).toBe(false);
    });

    test("neuere Bun-Versionen gelten als ausreichend", async () => {
      for (const version of ["1.3.11", "1.10.0", "2.0.0-canary.1"]) {
        const r = await run({ shell, tty: "", args: ["--no-setup"], env: { FAKE_BUN_VERSION: version } });
        expect(r.exit).toBe(0);
        expect(has(r, "bun", "upgrade")).toBe(false);
      }
    });

    test("bun install schlägt fehl: Abbruch, kein link, kein Setup", async () => {
      const r = await run({ shell, tty: "", env: { FAKE_INSTALL_FAIL: "1" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("bun install ist fehlgeschlagen");
      expect(has(r, "bun", "link")).toBe(false);
      expect(r.calls.some(c => c[2] === "--no-env-file")).toBe(false);
    });

    test("git clone schlägt fehl: Abbruch", async () => {
      const r = await run({ shell, tty: "", env: { FAKE_CLONE_FAIL: "1" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("git clone ist fehlgeschlagen");
      expect(has(r, "bun", "install")).toBe(false);
    });

    test("Git fehlt: Abbruch mit Anleitung je System", async () => {
      const linux = await run({ shell, without: ["git"] });
      expect(linux.exit).toBe(1);
      expect(linux.stderr).toContain("tybo: Git fehlt");
      expect(linux.stderr).toContain("sudo apt install git");
      expect(linux.stderr).toContain("sudo dnf install git");
      const mac = await run({ shell, without: ["git"], env: { FAKE_UNAME: "Darwin" } });
      expect(mac.exit).toBe(1);
      expect(mac.stderr).toContain("xcode-select --install");
      for (const r of [linux, mac]) expect(named(r, "bun")).toEqual([]);
    });

    test("als root: Abbruch „bitte ohne sudo ausführen“", async () => {
      const r = await run({ shell, env: { FAKE_UID: "0" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("tybo: bitte ohne sudo ausführen");
      expect(named(r, "git")).toEqual([]);
      expect(named(r, "bun")).toEqual([]);
    });

    test("uname MINGW64_NT: Abbruch mit Hinweis auf die Handanleitung", async () => {
      const r = await run({ shell, env: { FAKE_UNAME: "MINGW64_NT-10.0-19045" } });
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("dieses System (MINGW64_NT-10.0-19045) unterstützt der Installer nicht");
      expect(r.stderr).toContain("docs/einrichtung.md");
      expect(named(r, "git")).toEqual([]);
    });

    test("fehlende Claude CLI: nativer Installer; Node.js nur für PM2, Convex und npm", async () => {
      const r = await run({ shell, tty: "" });
      expect(r.stdout).toContain("tybo: Als Nächstes die Claude CLI installieren: curl -fsSL https://claude.ai/install.sh | bash (braucht weder Node.js noch sudo)");
      expect(r.stdout).not.toContain("npm install -g @anthropic-ai/claude-code");
      expect(r.stdout).not.toContain("Node.js installieren");
      expect(r.stdout).toContain("Node.js ist für tybo selbst nicht nötig, nur für PM2, den Convex-Weg (npx) oder die Claude CLI per npm.");
    });

    test("Claude CLI und Node.js erreichbar: keine Hinweise dazu", async () => {
      const r = await run({
        shell,
        tty: "",
        prepare: async home => {
          await mkdir(join(home, "werkzeuge"));
          for (const name of ["claude", "node"]) await executable(join(home, "werkzeuge", name));
        },
        extraPath: home => [join(home, "werkzeuge")],
      });
      expect(r.exit).toBe(0);
      expect(r.stdout).not.toContain("Claude CLI");
      expect(r.stdout).not.toContain("Node.js");
    });

    test("~/.local/bin/claude vorhanden, nicht im PATH: PATH-Hinweis statt Installationsbefehl", async () => {
      const r = await run({ shell, tty: "", prepare: localClaude("ok") });
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("tybo: Die Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen.");
      expect(r.stdout).toContain('  export PATH="$HOME/.local/bin:$PATH"');
      expect(r.stdout).not.toContain(CLAUDE_INSTALL);
    });

    // Befund Runde 1: -x allein belegt nicht, dass nur der PATH fehlt. Wie im
    // Schritt Voraussetzungen zählt nur ein erfolgreiches claude --version.
    for (const [name, body] of [
      ["nicht ausführbar", false],
      ["ausführbar, scheitert beim Start", "fails"],
      ["ausführbar, Exit 0 ohne Version", "silent"],
    ] as const) {
      test(`~/.local/bin/claude ${name}: Reparaturhinweis mit Installationsbefehl, kein PATH-Hinweis`, async () => {
        const r = await run({ shell, tty: "", prepare: localClaude(body) });
        expect(r.exit).toBe(0);
        expect(r.stdout).toContain(`tybo: Die Claude CLI liegt in ~/.local/bin, startet dort aber nicht (claude --version scheitert). Neu installieren: ${CLAUDE_INSTALL}`);
        expect(r.stdout).not.toContain("noch nicht im PATH");
        expect(r.stdout).not.toContain("$HOME/.local/bin:$PATH");
      });
    }

    test("~/.local/bin/claude hängt: nach der Frist beendet, Reparaturhinweis", async () => {
      // Kopie mit kurzer Frist, sonst dauerte der Test 15 s
      const script = join(root, `install-kurze-frist-${++counter}.sh`);
      expect(SOURCE).toContain('CLAUDE_VERSION_TIMEOUT="15"');
      await writeFile(script, SOURCE.replace('CLAUDE_VERSION_TIMEOUT="15"', 'CLAUDE_VERSION_TIMEOUT="1"'));
      const started = Date.now();
      const r = await run({ shell, tty: "", script, prepare: localClaude("hangs") });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("startet dort aber nicht (claude --version scheitert)");
      expect(r.stdout).not.toContain("noch nicht im PATH");
    });

    test("~/.local/bin/claude meldet Version, hängt, endet bei TERM mit 0: trotzdem Fehler (PR #223)", async () => {
      const script = join(root, `install-kurze-frist-${++counter}.sh`);
      await writeFile(script, SOURCE.replace('CLAUDE_VERSION_TIMEOUT="15"', 'CLAUDE_VERSION_TIMEOUT="1"'));
      const started = Date.now();
      const r = await run({ shell, tty: "", script, prepare: localClaude("versionThenHang") });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("startet dort aber nicht (claude --version scheitert)");
      expect(r.stdout).not.toContain("noch nicht im PATH: neue Sitzung");
    });

    test("~/.local/bin/claude hängt und ignoriert TERM: nach Frist und Schonfrist beendet (PR #223)", async () => {
      const script = join(root, `install-kurze-frist-${++counter}.sh`);
      await writeFile(script, SOURCE.replace('CLAUDE_VERSION_TIMEOUT="15"', 'CLAUDE_VERSION_TIMEOUT="1"'));
      const started = Date.now();
      const r = await run({ shell, tty: "", script, prepare: localClaude("hangsIgnoringTerm") });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("startet dort aber nicht (claude --version scheitert)");
    });

    test("echter Pipe-Aufruf (wie curl … | sh -s --): neue Installation mit Setup", async () => {
      const r = await run({ shell, viaPipe: true, args: ["--dir", "per pipe"], tty: "" });
      expect(r.exit).toBe(0);
      const dir = join(realpathSync(r.home), "per pipe");
      expect(has(r, "git", "clone", "--branch", "master", "https://github.com/cloudnutzer/tybo.git", dir)).toBe(true);
      expect(has(r, "bun", "--no-env-file", join(dir, "scripts/tybo.ts"), "setup")).toBe(true);
    });
  });
}

/** Die Zeilen, die der offizielle Bun-Installer in die Startdatei schreibt */
const BUN_RC = '# bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n';

/** Legt Startdateien in HOME an (Name → Inhalt) */
const rcFiles = (files: Record<string, string>) => async (home: string) => {
  for (const [name, content] of Object.entries(files)) await writeFile(join(home, name), content);
};

const ZEILEN = "Diese zwei Zeilen in ~/.zshrc";

for (const shell of SHELLS) {
  describe(`install.sh unter ${shell}: Bun-PATH-Hinweis je Startdatei (Issue #212)`, () => {
    const found = (r: RunResult, rc: string) => {
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain(`In ${rc} steht schon ein Eintrag dafür: neues Terminal bzw. neue SSH-Sitzung öffnen oder source ${rc} ausführen.`);
      expect(r.stdout).not.toContain("dann wird der Befehl tybo gefunden");
      expect(r.stdout).not.toContain(ZEILEN);
      // Rückfall, weil die Wirksamkeit der Startdatei ohne Ausführen offen bleibt (PR #223)
      expect(r.stdout).toContain(`Fehlt tybo danach trotzdem, diese zwei Zeilen am Ende von ${rc} eintragen:`);
      expect(r.stdout).toContain("export BUN_INSTALL=");
    };
    const missing = (r: RunResult) => {
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain(ZEILEN);
      expect(r.stdout).not.toContain("steht schon ein Eintrag dafür");
    };

    for (const [name, content] of [
      ["danach PATH überschrieben", `${BUN_RC}export PATH=/usr/bin:/bin\n`],
      ["in inaktivem if-Zweig", `if false; then\n${BUN_RC}fi\n`],
      ["in nicht aufgerufener Funktion", `bun_an() {\n${BUN_RC}}\n`],
    ] as const) {
      test(`Bun-Zeilen ${name}: keine Erfolgsbehauptung, Rückfall-Zeilen erscheinen (PR #223)`, async () => {
        const r = await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": content }) });
        expect(r.exit).toBe(0);
        expect(r.stdout).toContain("export BUN_INSTALL=");
        expect(r.stdout).not.toContain("dann wird der Befehl tybo gefunden");
      });
    }

    for (const [login, file] of [
      ["/bin/bash", ".bashrc"],
      ["/usr/bin/bash", ".bash_profile"],
      ["/bin/zsh", ".zshrc"],
    ] as const) {
      test(`${login}, Bun-Zeilen in ~/${file}: kein Zeilen-Hinweis`, async () => {
        const r = await run({ shell, tty: "", env: { SHELL: login }, prepare: rcFiles({ [file]: `alias ll='ls -l'\n${BUN_RC}` }) });
        found(r, `~/${file}`);
      });
    }

    test("Bun installiert erst in diesem Lauf, Zeilen in ~/.bashrc: kein Zeilen-Hinweis", async () => {
      const r = await run({ shell, args: ["--yes"], bunInPath: false, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": BUN_RC }) });
      found(r, "~/.bashrc");
    });

    test("keine Startdatei: die zwei Zeilen, kein Abbruch", async () => {
      missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" } }));
    });

    test("Eintrag auskommentiert: die zwei Zeilen", async () => {
      const commented = BUN_RC.split("\n").map(l => (l ? `# ${l}` : l)).join("\n");
      missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": `  ${commented.replace(/\n/g, "\n  ")}` }) }));
    });

    test("nur Kommentar und BUN_INSTALL, keine PATH-Zeile: die zwei Zeilen", async () => {
      missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": '# bun\nexport BUN_INSTALL="$HOME/.bun"\n' }) }));
    });

    test("Zeilen in ~/.zshrc, Login-Shell bash: zählt nicht", async () => {
      missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".zshrc": BUN_RC }) }));
    });

    test("unbekannte Login-Shell oder SHELL fehlt: die zwei Zeilen", async () => {
      missing(await run({ shell, tty: "", env: { SHELL: "/usr/bin/fish" }, prepare: rcFiles({ ".bashrc": BUN_RC, ".zshrc": BUN_RC }) }));
      missing(await run({ shell, tty: "", prepare: rcFiles({ ".bashrc": BUN_RC }) }));
    });

    for (const [name, line] of [
      ["$HOME/.bun/bin", 'export PATH="$HOME/.bun/bin:$PATH"'],
      ["${HOME}/.bun/bin", "export PATH=${HOME}/.bun/bin:$PATH"],
      ["~/.bun/bin", "PATH=~/.bun/bin:$PATH"],
      ["eingerückt, ${BUN_INSTALL}", '\t export BUN_INSTALL=~/.bun/\n  export PATH="${BUN_INSTALL}/bin:$PATH"'],
    ] as const) {
      test(`PATH-Zeile mit ${name}: erkannt`, async () => {
        found(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": `${line}\n` }) }), "~/.bashrc");
      });
    }

    test("voller Pfad des Bun-Ordners: erkannt", async () => {
      let home = "";
      const r = await run({
        shell,
        tty: "",
        env: { SHELL: "/bin/zsh" },
        prepare: async h => {
          home = h;
          await writeFile(join(h, ".zshrc"), `export PATH="${h}/.bun/bin:$PATH"\n`);
        },
      });
      expect(home).not.toBe("");
      found(r, "~/.zshrc");
    });

    test("eigenes BUN_INSTALL: Zeilen für ~/.bun zählen nicht, Zeilen für den eigenen Ordner schon", async () => {
      const bunHome = join(root, `eigenes rc-bun ${counter}`);
      const wrong = await run({ shell, args: ["--yes"], bunInPath: false, tty: "", env: { SHELL: "/bin/bash", BUN_INSTALL: bunHome }, prepare: rcFiles({ ".bashrc": BUN_RC }) });
      missing(wrong);
      expect(exportedBunInstall(wrong.stdout)).toBe(bunHome);
      const right = await run({
        shell,
        args: ["--yes"],
        bunInPath: false,
        tty: "",
        env: { SHELL: "/bin/bash", BUN_INSTALL: bunHome },
        prepare: rcFiles({ ".bashrc": `export BUN_INSTALL="${bunHome}"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n` }),
      });
      found(right, "~/.bashrc");
    });

    // Befund Runde 1: gezählt wird nur, was die Zuweisungen tatsächlich in den
    // PATH bringen, Eintrag für Eintrag verglichen, nicht ein Teilstring der Zeile
    for (const [name, rc] of [
      ["MANPATH statt PATH", 'export MANPATH="$HOME/.bun/bin:$MANPATH"\n'],
      ["anderer Ordner mit gleichem Anfang", 'export PATH="$HOME/.bun/bin-old:$PATH"\n'],
      ["Bun-Pfad nur im Kommentar hinter der Zuweisung", 'export PATH="$PATH" # $HOME/.bun/bin\n'],
      ["$HOME in einfachen Anführungszeichen", "export PATH='$HOME/.bun/bin':$PATH\n"],
      ["~ in doppelten Anführungszeichen", 'export PATH="~/.bun/bin:$PATH"\n'],
      ["Zuweisung nur für einen Befehl", "PATH=~/.bun/bin:$PATH bun --version\n"],
      ["spätere Zuweisung ersetzt den PATH", `${BUN_RC}export PATH=/usr/bin:/bin\n`],
      ["Befehlsersetzung", 'export PATH="$(printf %s "$HOME/.bun/bin"):$PATH"\n'],
      ["unbekannte Variable statt $HOME", 'export PATH="$ANDERES/.bun/bin:$PATH"\n'],
      ["${HOME:-…} mit Vorgabe", 'export PATH="${HOME:-/tmp}/.bun/bin:$PATH"\n'],
    ] as const) {
      test(`${name}: die zwei Zeilen`, async () => {
        missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": rc }) }));
      });
    }

    for (const [name, rc] of [
      ["~ nach einem Doppelpunkt", "PATH=$PATH:~/.bun/bin\n"],
      ["Kommentar hinter der Zuweisung", 'export PATH="$HOME/.bun/bin:$PATH" # bun\n'],
      ["weiterer, unbekannter Eintrag in derselben Zeile", 'export PATH="$PNPM_HOME:$HOME/.bun/bin:$PATH"\n'],
      ["spätere Zuweisung behält $PATH", `${BUN_RC}export PATH="$HOME/.local/bin:$PATH"\n`],
      ["/ am Ende und doppelte /", 'export PATH="$HOME//.bun/bin/:$PATH"\n'],
    ] as const) {
      test(`${name}: erkannt`, async () => {
        found(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": rc }) }), "~/.bashrc");
      });
    }

    test("BUN_INSTALL zeigt woandershin, PATH über $BUN_INSTALL: zählt nicht", async () => {
      missing(await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": 'export BUN_INSTALL="$HOME/.anderes-bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' }) }));
    });

    test("Startdatei wird nur gelesen, nie ausgeführt; Startdateien bleiben unverändert", async () => {
      const content = `mkdir "$HOME/ausgefuehrt"\n${BUN_RC}`;
      const r = await run({ shell, tty: "", env: { SHELL: "/bin/bash" }, prepare: rcFiles({ ".bashrc": content }) });
      found(r, "~/.bashrc");
      expect(existsSync(join(r.home, "ausgefuehrt"))).toBe(false);
      expect(await readFile(join(r.home, ".bashrc"), "utf8")).toBe(content);
      expect(existsSync(join(r.home, ".bash_profile"))).toBe(false);
      expect(existsSync(join(r.home, ".zshrc"))).toBe(false);
    });

    test("Startdatei nicht lesbar: kein Abbruch, die zwei Zeilen", async () => {
      if (process.getuid?.() === 0) return;
      const r = await run({
        shell,
        tty: "",
        env: { SHELL: "/bin/bash" },
        prepare: async home => {
          await writeFile(join(home, ".bashrc"), BUN_RC);
          await chmod(join(home, ".bashrc"), 0o000);
        },
      });
      missing(r);
    });
  });
}
