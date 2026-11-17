/**
 * Herkunft von Bash-Ausgaben (Issue #525).
 *
 * Die Ausnahme für eigene gh-Repos braucht einen vollständigen Nachweis:
 * Der Lexer trennt feste Wörter von offenen Expansionen; die Auswertung
 * verbraucht jedes Argument nach einer bekannten Grammatik. Nur ausdrücklich
 * unterstützte Wrapper dürfen einen weiteren Aufruf bilden. Ein gh-Wort in
 * irgendeinem Argument ist niemals selbst ein nachgewiesener Aufruf.
 *
 * In einer Kette müssen alle Teile verständlich sein. Nicht unterstützte
 * Optionen, Wrapper, Zustandsänderungen oder Shell-Syntax verhindern die
 * gh-Ausnahme. Netzprogramme werden auch nach der Shell-Wortbildung erkannt.
 * Die bisherige Einstufung reiner Befehle ohne gh oder Netzabruf bleibt.
 * Dies ist eine Herkunftsprüfung für Merk-Tags, keine Shell-Sandbox.
 */

/** Liefern Inhalte aus dem Netz, egal mit welchen Argumenten */
const NETWORK_COMMAND = /\b(curl|wget|lynx|w3m|yt-dlp)\b|https?:\/\//i;

/** gh-Unterbefehle, die Inhalte von GitHub lesen */
const GH_NETWORK_SUBCOMMANDS = new Set(["api", "issue", "pr", "release"]);

interface GhFlags {
  values: ReadonlySet<string>;
  booleans: ReadonlySet<string>;
}

const flags = (values: string, booleans = ""): GhFlags => ({
  values: new Set(values.split(" ").filter(Boolean)),
  booleans: new Set(booleans.split(" ").filter(Boolean)),
});
const FORMAT_VALUES = "--json --jq -q --template -t";
const LIST_VALUES = `${FORMAT_VALUES} --assignee -a --author -A --label -l --limit -L --search -S --state -s`;
const BODY_VALUES = "--body -b --body-file -F";

/** Wertigkeiten gelten je Unterbefehl: -c ist bei view boolesch, bei close ein Kommentar. */
const GH_REPO_FLAGS = new Map<string, GhFlags>([
  ["issue list", flags(`${LIST_VALUES} --app --mention --milestone -m --type`, "--web -w")],
  ["pr list", flags(`${LIST_VALUES} --app --base -B --head -H`, "--web -w --draft -d")],
  ["release list", flags(`${FORMAT_VALUES} --limit -L --order -O`, "--exclude-drafts --exclude-pre-releases")],
  ["issue view", flags(FORMAT_VALUES, "--comments -c --web -w")],
  ["pr view", flags(FORMAT_VALUES, "--comments -c --web -w")],
  ["release view", flags(FORMAT_VALUES, "--web -w")],
  ["issue create", flags(`${BODY_VALUES} --title -t --template -T --assignee -a --label -l --milestone -m --project -p --type`)],
  ["issue comment", flags(BODY_VALUES, "--edit-last --create-if-none --delete-last --yes")],
]);

/** Zuweisung vor einem Befehl, etwa NO_COLOR=1 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Obergrenze für verschachtelte Substitutionen und ausgeführte Zeichenketten */
const MAX_DEPTH = 4;

/** Flags von gh api mit Wert im nächsten Wort */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--input",
  "-p",
  "--preview",
  "--cache",
]);

export const NETWORK_REASON = "Bash mit Netzabruf";
export const GH_REASON = "gh mit fremdem oder unklarem Repo";

/** GitHub-Konten aus TYBO_TRUSTED_GITHUB_OWNERS (durch Komma oder Leerzeichen getrennt), klein geschrieben */
export function trustedGithubOwners(env: Record<string, string | undefined> = process.env): string[] {
  return (env.TYBO_TRUSTED_GITHUB_OWNERS ?? "")
    .split(/[\s,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(s));
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export interface ShellWord {
  text: string;
  /** Enthält eine Variable oder Substitution: der echte Wert ist offen */
  unclear: boolean;
  /** Variable oder Substitution ohne Anführungszeichen oder Klammer-Erweiterung ({a,b}, {1..3}): kann zu mehreren oder keinem Wort werden */
  split: boolean;
  /** Dateinamensmuster ohne Anführungszeichen (*, ?, [...]): Bash ersetzt das Wort durch passende Dateinamen */
  glob?: boolean;
}

export interface LexedShell {
  /** Einfache Kommandos, auch die aus Substitutionen */
  commands: ShellWord[][];
  /** Ziele von Umleitungen und Here-Strings (keine Argumente, aber lesbarer Text) */
  redirects: ShellWord[];
  /** Offene Anführung, fehlende oder unerwartete Klammer, zu tiefe Verschachtelung */
  broken: boolean;
  /**
   * Mustersyntax, die der Lexer nicht sicher lesen kann: Klammern in einem
   * Wort oder als Argument (Bash extglob @(gh), zsh (gh|x), Glob-Qualifier)
   */
  pattern: boolean;
  /** Syntax außerhalb der unterstützten Befehlsformen, etwa Here-Docs und Backticks */
  unsupported: boolean;
}

/** Schlüsselwörter, nach denen ( eine Subshell öffnet und kein Muster */
const SUBSHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "{"]);

export function lexShell(src: string): LexedShell {
  const commands: ShellWord[][] = [];
  const redirects: ShellWord[] = [];
  let broken = false;
  let pattern = false;
  let unsupported = false;

  function lex(start: number, close: ")" | "`" | null, depth = 0): number {
    if (depth > MAX_DEPTH) {
      broken = true;
      return src.length;
    }
    let i = start;
    let cmd: ShellWord[] = [];
    let word: ShellWord | null = null;
    let redirectTarget = false;
    // Klammer-Erweiterung im laufenden Wort: { gesehen, danach , oder ..
    let braceOpen = false;
    let braceSep = false;
    const cur = (): ShellWord => (word ??= { text: "", unclear: false, split: false });
    const markUnclear = (split: boolean) => {
      const w = cur();
      w.unclear = true;
      if (split) w.split = true;
    };
    const endWord = () => {
      braceOpen = braceSep = false;
      if (!word) return;
      if (redirectTarget) {
        redirects.push(word);
        redirectTarget = false;
      } else cmd.push(word);
      word = null;
    };
    const endCmd = () => {
      endWord();
      if (cmd.length > 0) commands.push(cmd);
      cmd = [];
      if (redirectTarget) broken = true;
      redirectTarget = false;
    };
    const substitution = (from: number, until: ")" | "`", quoted: boolean): number => {
      markUnclear(!quoted);
      return lex(from, until, depth + 1);
    };
    const doubleQuoted = (from: number): number => {
      cur();
      let j = from;
      while (j < src.length) {
        const c = src[j]!;
        if (c === '"') return j + 1;
        if (c === "\\") {
          const next = src[j + 1];
          if (next === "\n") j += 2;
          else if (next !== undefined && '$`"\\'.includes(next)) {
            cur().text += next;
            j += 2;
          } else {
            cur().text += c;
            j++;
          }
          continue;
        }
        if (c === "$" && src[j + 1] === "(") {
          j = substitution(j + 2, ")", true);
          continue;
        }
        if (c === "`") {
          unsupported = true;
          j = substitution(j + 1, "`", true);
          continue;
        }
        // Nur eine einfache skalare Variable bildet sicher genau ein Argument.
        // Auch in Anführungszeichen können "$@" und Array-Erweiterungen mehrere bilden.
        if (c === "$") markUnclear(!/^\$[A-Za-z_][A-Za-z0-9_]*/.test(src.slice(j)));
        cur().text += c;
        j++;
      }
      broken = true;
      return j;
    };

    while (i < src.length) {
      const ch = src[i]!;
      if ((close === ")" && ch === ")") || (close === "`" && ch === "`")) {
        endCmd();
        return i + 1;
      }
      if (ch === "\\") {
        if (src[i + 1] === undefined) broken = true;
        if (src[i + 1] !== "\n") cur().text += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        cur().text += src.slice(i + 1, end < 0 ? src.length : end);
        if (end < 0) broken = true;
        i = end < 0 ? src.length : end + 1;
        continue;
      }
      if (ch === '"') {
        i = doubleQuoted(i + 1);
        continue;
      }
      if (ch === "$" && src[i + 1] === "(") {
        i = substitution(i + 2, ")", false);
        continue;
      }
      if (ch === "`") {
        unsupported = true;
        i = substitution(i + 1, "`", false);
        continue;
      }
      if (ch === "$") {
        markUnclear(true);
        cur().text += ch;
        i++;
        continue;
      }
      if ((ch === "<" || ch === ">") && src[i + 1] === "(") {
        // Prozess-Substitution: ein Argument (Dateiname) mit offenem Inhalt
        markUnclear(false);
        i = lex(i + 2, ")", depth + 1);
        continue;
      }
      if (ch === "<" || ch === ">") {
        if (ch === "<") unsupported = true;
        // Dateideskriptor vor der Umleitung (2>, 1>&2) ist kein Argument
        const before = word as ShellWord | null;
        if (before && !before.unclear && /^\d+$/.test(before.text)) {
          word = null;
          braceOpen = braceSep = false;
        } else endWord();
        while (src[i] === "<" || src[i] === ">" || src[i] === "&") i++;
        redirectTarget = true;
        continue;
      }
      if (ch === "\r") unsupported = true;
      if (ch === " " || ch === "\t" || ch === "\r") {
        endWord();
        i++;
        continue;
      }
      if (ch === "(") {
        // ( mitten im Wort oder als Argument ist Mustersyntax (extglob, zsh), keine Subshell
        if (word || cmd.some(w => w.unclear || !SUBSHELL_KEYWORDS.has(w.text))) pattern = true;
        endCmd();
        // Jede öffnende Klammer besitzt ihre eigene Ebene. Nur deren passende
        // Schlussklammer beendet die Rekursion, nie die einer inneren Subshell.
        // Alle Befehle bleiben Teil desselben Nachweises, auch nach (true) in
        // "$( (true); gh ... )". Die Tiefengrenze gilt ebenso für diese Gruppen.
        i = lex(i + 1, ")", depth + 1);
        continue;
      }
      if (ch === ")") {
        // Eine passende Schlussklammer wäre bereits am Anfang behandelt worden.
        // Ohne zugehörige Ebene ist die gesamte Zerlegung unvollständig.
        broken = true;
        endCmd();
        i++;
        continue;
      }
      if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
        endCmd();
        i++;
        continue;
      }
      if (ch === "#" && !word) {
        const end = src.indexOf("\n", i);
        i = end < 0 ? src.length : end;
        continue;
      }
      // Dateinamensmuster ohne Anführungszeichen (g[h], g?, *): Bash setzt passende Dateinamen ein.
      // Dazu zsh mit EXTENDED_GLOB: ^ verneint, # wiederholt, ~ schließt aus (nicht am Wortanfang,
      // dort ist # ein Kommentar und ~ das Home-Verzeichnis)
      if (ch === "*" || ch === "?" || ch === "[" || ch === "^") cur().glob = true;
      else if ((ch === "#" || ch === "~") && (word as ShellWord | null)?.text) cur().glob = true;
      // Klammer-Erweiterung ohne Anführungszeichen ({--repo=x,--state=open}, {1..3}):
      // ein Wort wird zu mehreren, die Bash erst beim Ausführen bildet
      if (ch === "{") braceOpen = true;
      else if (braceOpen && (ch === "," || (ch === "." && src[i + 1] === "."))) braceSep = true;
      else if (ch === "}" && braceSep) {
        cur().unclear = true;
        cur().split = true;
      }
      cur().text += ch;
      i++;
    }
    if (close) broken = true;
    endCmd();
    return i;
  }

  lex(0, null);
  return { commands, redirects, broken, pattern, unsupported };
}

/** Nur feste Shell-Wörter dürfen Programm, Option, Repo oder Endpunkt bestimmen. */
function literal(word: ShellWord | undefined): word is ShellWord & { unclear: false; split: false; glob?: false } {
  return !!word && !word.unclear && !word.split && !word.glob;
}

/** Ein bekannter Optionswert darf offen sein, solange er genau ein Argument bleibt. */
function singleArgument(word: ShellWord | undefined): word is ShellWord {
  return !!word && !word.split && !word.glob;
}

function baseName(text: string): string {
  return (text.split("/").pop() ?? "").toLowerCase();
}

function ownRepo(word: ShellWord, owners: ReadonlySet<string>): boolean {
  if (!literal(word)) return false;
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(word.text);
  return !!match && owners.has(match[1]!.toLowerCase()) && match[2] !== "." && match[2] !== "..";
}

function ownEndpoint(word: ShellWord, owners: ReadonlySet<string>): boolean {
  if (!literal(word) || /\.\.|%|\\|[{}\s]/.test(word.text)) return false;
  const match = /^\/?repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:[/?#].*)?$/.exec(word.text);
  return !!match && owners.has(match[1]!.toLowerCase());
}

type RepoFlag = { value: ShellWord; next: number } | null;

function repoFlag(args: ShellWord[], index: number): RepoFlag {
  const word = args[index]!;
  if (!literal(word)) return null;
  if (word.text === "-R" || word.text === "--repo") {
    const value = args[index + 1];
    return literal(value) ? { value, next: index + 2 } : null;
  }
  if (word.text.startsWith("--repo=")) return { value: { ...word, text: word.text.slice(7) }, next: index + 1 };
  if (word.text.startsWith("-R") && word.text.length > 2) return { value: { ...word, text: word.text.slice(2) }, next: index + 1 };
  return null;
}

const GH_API_BOOL_FLAGS = new Set(["--paginate", "--slurp", "--include", "-i", "--silent", "--verbose"]);

/**
 * Geschlossene Optionsgrammatik: nichts wird übersprungen, ohne die Wertigkeit
 * zu kennen. Insbesondere sind unbekannte Flags und offene Optionsnamen kein
 * Nachweis. Optionen mit einem Wert verbrauchen genau dieses eine Argument.
 */
function ghArguments(args: ShellWord[], api: boolean, grammar: GhFlags): { repos: ShellWord[]; positional: ShellWord[] } | null {
  const repos: ShellWord[] = [];
  const positional: ShellWord[] = [];
  const valueFlags = grammar.values;
  const boolFlags = grammar.booleans;
  let options = true;
  for (let i = 0; i < args.length;) {
    const word = args[i]!;
    if (!literal(word)) return null;
    const text = word.text;
    if (options && text === "--") {
      options = false;
      i++;
    } else if (!options || !text.startsWith("-") || text === "-") {
      positional.push(word);
      i++;
    } else {
      const repo = api ? null : repoFlag(args, i);
      if (repo) {
        repos.push(repo.value);
        i = repo.next;
      } else if (valueFlags.has(text)) {
        if (!singleArgument(args[i + 1])) return null;
        i += 2;
      } else if (boolFlags.has(text)) {
        i++;
      } else if (text.startsWith("--") && text.includes("=") && valueFlags.has(text.slice(0, text.indexOf("=")))) {
        i++;
      } else if (/^-[^-].+/.test(text) && valueFlags.has(text.slice(0, 2))) {
        // Ein Kurzflag mit Wert verbraucht den ganzen angehängten Rest.
        i++;
      } else if (/^-[^-]+$/.test(text) && [...text.slice(1)].every(char => boolFlags.has(`-${char}`))) {
        i++;
      } else return null;
    }
  }
  return { repos, positional };
}

/** null: bisher nicht als Netzabruf eingestufter gh-Unterbefehl. */
function ownGhCall(args: ShellWord[], owners: ReadonlySet<string>): boolean | null {
  if (args.length === 1 && literal(args[0]) && ["--help", "-h", "--version"].includes(args[0].text)) return null;
  const repos: ShellWord[] = [];
  let i = 0;
  while (args[i]?.text.startsWith("-")) {
    const repo = repoFlag(args, i);
    if (!repo) return false;
    repos.push(repo.value);
    i = repo.next;
  }
  const subcommand = args[i];
  if (!subcommand) return null;
  if (!literal(subcommand)) return false;
  const name = subcommand.text.toLowerCase();
  if (!GH_NETWORK_SUBCOMMANDS.has(name)) return null;
  if (name === "api") {
    const parsed = ghArguments(args.slice(i + 1), true, { values: GH_API_VALUE_FLAGS, booleans: GH_API_BOOL_FLAGS });
    return !!parsed && repos.length === 0 && parsed.positional.length === 1 && ownEndpoint(parsed.positional[0]!, owners);
  }
  i++;
  while (args[i]?.text.startsWith("-")) {
    const repo = repoFlag(args, i);
    if (!repo) return false;
    repos.push(repo.value);
    i = repo.next;
  }
  const action = args[i];
  if (!literal(action)) return false;
  const grammar = GH_REPO_FLAGS.get(`${name} ${action.text === "ls" ? "list" : action.text}`);
  if (!grammar) return false;
  const parsed = ghArguments(args.slice(i + 1), false, grammar);
  if (!parsed) return false;
  repos.push(...parsed.repos);
  return repos.length > 0 && repos.every(repo => ownRepo(repo, owners)) && !parsed.positional.some(word => /github\./i.test(word.text));
}

interface ShellScan {
  /** Ein sicherer eigener Aufruf oder ein gh-Hinweis in einer nicht verstandenen Form. */
  gh: boolean;
  /** Jeder Teil wurde vollständig einer unterstützten Befehlsform zugeordnet. */
  safe: boolean;
  foreign: boolean;
  network: boolean;
}

/** Nur zur vorsichtigen Erkennung, nie zur Freigabe eines Aufrufs. */
function mentionsGh(text: string): boolean {
  return /(?:^|[^A-Za-z0-9_-])gh(?![A-Za-z0-9_-])/i.test(text.replace(/['"\\$]/g, ""));
}

/** Diese Programme führen ihre Argumente nicht als weitere Befehle aus. */
const LOCAL_PROGRAMS = new Set(["cat", "head", "tail", "wc", "ls", "echo", "true", "false", "pwd", "grep", "cut", "tr", "uniq"]);
const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

function scanShell(text: string, owners: ReadonlySet<string>, depth: number): ShellScan {
  const scan: ShellScan = { gh: false, safe: true, foreign: false, network: NETWORK_COMMAND.test(text) };
  const merge = (other: ShellScan) => {
    scan.gh ||= other.gh;
    scan.safe &&= other.safe;
    scan.foreign ||= other.foreign;
    scan.network ||= other.network;
  };
  if (depth > MAX_DEPTH) return { ...scan, gh: mentionsGh(text), safe: false };
  const lexed = lexShell(text);
  scan.safe = !lexed.broken && !lexed.pattern && !lexed.unsupported;
  const words = [...lexed.commands.flat(), ...lexed.redirects];
  // Auch cu''rl, wge\t und verschachtelt zitierter Text dürfen keine Ausnahme erhalten.
  scan.network ||= words.some(word => NETWORK_COMMAND.test(word.text.replace(/['"\\]/g, "")));
  if (!scan.safe) scan.gh = mentionsGh(text) || words.some(word => mentionsGh(word.text));
  if (lexed.redirects.some(word => !literal(word) || /^\/dev\/(tcp|udp)\//.test(word.text))) scan.safe = false;

  const command = (args: ShellWord[], level: number, assignments = false): ShellScan => {
    const opaque: ShellScan = { gh: args.some(word => mentionsGh(word.text)), safe: false, foreign: false, network: false };
    const local: ShellScan = { gh: false, safe: true, foreign: false, network: false };
    if (level > MAX_DEPTH || args.length === 0) return opaque;
    const program = args[0]!;
    if (!literal(program)) return { ...opaque, gh: opaque.gh || !!program.glob };
    const name = baseName(program.text);
    if (assignments && ASSIGNMENT.test(program.text)) {
      // Nur diese bekannte, inhaltsneutrale Einstellung ist Teil der Grammatik.
      // PATH, Shell-Optionen und gh-Konfiguration werden nicht erraten.
      return /^NO_COLOR=/.test(program.text) ? command(args.slice(1), level + 1, true) : opaque;
    }
    if (name === "gh") {
      const own = ownGhCall(args.slice(1), owners);
      // Andere Unterbefehle bleiben für sich wie bisher; sie beweisen aber
      // keine sichere Umgebung für einen zusätzlichen eigenen Netzabruf.
      if (own === null) return { ...local, safe: false };
      return { ...local, gh: true, safe: own, foreign: !own };
    }
    // Diese Wrapper reichen genau das verbleibende argv unverändert weiter.
    // Unbekannte Optionen, insbesondere env -S, werden niemals weggeraten.
    if (name === "env" || name === "command" || name === "exec") {
      const rest = args.slice(literal(args[1]) && args[1].text === "--" ? 2 : 1);
      if (!literal(rest[0]) || rest[0].text.startsWith("-")) return opaque;
      return command(rest, level + 1, name === "env");
    }
    if (SHELL_PROGRAMS.has(name)) {
      if (args.length !== 3 || !literal(args[1]) || args[1].text !== "-c" || !literal(args[2])) return opaque;
      return scanShell(args[2].text, owners, level + 1);
    }
    if (name === "eval") {
      if (!args.slice(1).every(literal)) return opaque;
      return scanShell(args.slice(1).map(word => word.text).join(" "), owners, level + 1);
    }
    if (LOCAL_PROGRAMS.has(name) && args.slice(1).every(word => !word.unclear)) return local;
    // Nur die hier benannten lesenden Git-Formen, keine Konfiguration,
    // Aliase oder Unterbefehle, die Programme aus Argumenten starten.
    if (name === "git" && args.slice(1).every(literal)) {
      if (args[1]?.text === "status" && args.slice(2).every(word => ["--short", "--branch"].includes(word.text))) return local;
    }
    if (name === "git" && args[1]?.text === "log" && args.slice(2).every(word => !word.unclear && /^(?:--oneline|HEAD(?:\^|~\d+)?)$/.test(word.text))) return local;
    return opaque;
  };

  for (const args of lexed.commands) merge(command(args, depth, true));
  return scan;
}

/** Grund für fremde Inhalte; null, wenn kein Netzabruf oder vollständig belegte gh-Ausnahme. */
export function bashNetworkReason(command: string, owners: readonly string[] = trustedGithubOwners()): string | null {
  const scan = scanShell(command, new Set(owners.map(owner => owner.toLowerCase())), 0);
  if (scan.network) return NETWORK_REASON;
  if (scan.foreign || (scan.gh && !scan.safe)) return GH_REASON;
  return null;
}
