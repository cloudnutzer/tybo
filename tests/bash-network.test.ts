/**
 * Issue #525: Merk-Vorschläge nur noch bei Inhalten aus dem Netz. Welche
 * Bash-Befehle als Netzabruf zählen, vor allem gh gegen eigene und fremde
 * Repos, und dass ein fremder Teil hinter der Befehlskürzung nicht
 * verschwindet. Reine Funktionen, kein Netz, kein Prozess.
 */
import { describe, expect, test } from "bun:test";
import { bashNetworkReason, GH_REASON, lexShell, NETWORK_REASON, trustedGithubOwners } from "../src/lib/bash-network";
import { bashToolUse, classifyTurnTools, MAX_COMMAND_CHARS, toolUseFromBlock, toolUsesFromEvent } from "../src/lib/turn-tools";
import { parseCodexEvent } from "../src/lib/engines/codex";
import { openCodeToolUse } from "../src/lib/engines/opencode";

const OWNERS = ["cloudnutzer"];
const reason = (command: string, owners: readonly string[] = OWNERS) => bashNetworkReason(command, owners);
const own = (command: string) => expect(reason(command)).toBeNull();
const foreign = (command: string) => expect(reason(command)).not.toBeNull();

describe("trustedGithubOwners", () => {
  test("Komma oder Leerzeichen, klein geschrieben, ungültige Namen fallen weg", () => {
    expect(trustedGithubOwners({ TYBO_TRUSTED_GITHUB_OWNERS: "CloudNutzer, mia-2 alex" })).toEqual(["cloudnutzer", "mia-2", "alex"]);
    expect(trustedGithubOwners({ TYBO_TRUSTED_GITHUB_OWNERS: "a/b,*,-x,../y" })).toEqual([]);
    expect(trustedGithubOwners({})).toEqual([]);
  });

  test("ohne eigene Konten ist jeder gh-Abruf fremd", () => {
    expect(reason("gh issue list -R cloudnutzer/tybo", [])).toBe(GH_REASON);
    expect(reason("gh api repos/cloudnutzer/tybo/issues", [])).toBe(GH_REASON);
  });
});

describe("eigene Repos: keine Nachfrage", () => {
  test.each([
    "gh issue list -R cloudnutzer/tybo",
    "gh issue view 525 --repo cloudnutzer/tybo --json body -q .body",
    "gh pr list --repo=cloudnutzer/werkzeugkiste",
    "gh release list -Rcloudnutzer/tybo",
    "gh -R cloudnutzer/tybo issue list",
    "gh issue list -R CloudNutzer/tybo",
    "gh issue list -R 'cloudnutzer/tybo' --state open",
    'gh issue create -R cloudnutzer/tybo --title "Fehler; Teil 2" --body "$(cat /tmp/text.md)"',
    "gh api repos/cloudnutzer/tybo/issues",
    "gh api '/repos/cloudnutzer/tybo/issues?per_page=100' --paginate --jq '.[] | .title'",
    "gh api -X PATCH repos/cloudnutzer/tybo/issues/3 -f state=closed",
    "gh issue list -R cloudnutzer/tybo | head -5",
    "gh issue list -R cloudnutzer/a && gh pr list -R cloudnutzer/b",
    "gh issue list -R cloudnutzer/tybo 2>/dev/null > /tmp/liste.txt",
    "gh issue view 3 -R cloudnutzer/tybo # alter Kommentar: gh api repos/fremd/x",
    "/opt/homebrew/bin/gh issue list -R cloudnutzer/tybo",
    "gh auth status && gh run list && gh repo clone cloudnutzer/tybo",
    // Werte bekannter Optionen und das Optionsende verdecken kein echtes -R
    "gh issue view 3 --comments -R cloudnutzer/tybo",
    'gh issue list --search "-Rfremd/x" -R cloudnutzer/tybo',
    "gh issue view -R cloudnutzer/tybo -- 3",
    'gh issue comment 3 -R cloudnutzer/tybo --body "$TEXT"',
    'gh api repos/cloudnutzer/tybo/issues -f body="$(cat /tmp/text.md)"',
    // ausgeführte Zeichenkette mit eigenem Aufruf
    "bash -c 'gh issue list -R cloudnutzer/tybo'",
    // Zitierte Muster sind feste Optionswerte, keine zusätzlichen Argumente
    "gh issue list -R cloudnutzer/tybo --jq '.[] | {a,b}'",
    "env NO_COLOR=1 gh issue list -R cloudnutzer/tybo",
    // Kurzflag-Bündel ohne R und Muster, die nicht zu gh werden oder in Anführungszeichen stehen
    "gh issue view 3 -R cloudnutzer/tybo -cw",
    "gh issue list -R cloudnutzer/tybo; ls *.md",
    "gh issue list -R cloudnutzer/tybo; ls src/[a-f]*.ts",
    "gh issue list -R cloudnutzer/tybo; echo 'g[h]' \"g?\"",
    // eval mit eigenem Aufruf, auch über mehrere Argumente verteilt
    "eval 'gh issue list' '-R cloudnutzer/tybo'",
    "eval gh api repos/cloudnutzer/tybo/issues",
    // Git-Revisionen werden nicht als Programm oder gh-Option gelesen
    "gh issue list -R cloudnutzer/tybo; git log HEAD^ HEAD~1",
  ])("%s", command => own(command));
});

describe("fremde oder unklare Repos: Nachfrage", () => {
  test.each([
    // Kein vollständiger Nachweis für diese bisher zu großzügig freigegebenen Formen.
    "gh api /repos/cloudnutzer/tybo/issues?per_page=100 --paginate --jq '.[] | .title'",
    "{ gh issue list -R cloudnutzer/tybo; }",
    "export PATH=$PATH:/opt/bin; gh issue list -R cloudnutzer/tybo",
    "gh issue list -R cloudnutzer/tybo; /opt/homebrew/bin/'g[h]' api repos/fremd/x",
    "gh issue list -R cloudnutzer/tybo; g\\[h] api repos/fremd/x",
    "if (true); then gh issue list -R cloudnutzer/tybo; fi",
  ])("nicht unterstützte Befehlsform: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // fremd oder ohne erkennbares Repo
    "gh api repos/fremd/x",
    "gh issue list",
    "gh pr view 12",
    "gh issue list -R fremd/tybo",
    // genaue Besitzergrenzen
    "gh issue list -R cloudnutzer-evil/tybo",
    "gh issue list -R xcloudnutzer/tybo",
    "gh issue list -R cloudnutzer",
    "gh issue list -R cloudnutzer/tybo/extra",
    "gh issue list -R github.com/cloudnutzer/tybo",
    "gh issue list -R evil.example/cloudnutzer/tybo",
    "gh api repos/cloudnutzer-evil/x",
    "gh api repos/cloudnutzer/../fremd/x",
    "gh api repos/cloudnutzer/x/../../fremd/y",
    "gh api repos/cloudnutzer%2Fx/../fremd/y",
    "gh api orgs/cloudnutzer/repos",
    "gh api graphql -f query='{ viewer { login } }'",
    "gh api 'repos/{owner}/{repo}/issues'",
    // mehrere Repos im selben Aufruf, ein fremdes genügt
    "gh issue list -R cloudnutzer/a -R fremd/b",
    "gh -R fremd/b issue list -R cloudnutzer/a",
    "gh issue list -wR fremd/b -R cloudnutzer/a",
    "gh api repos/cloudnutzer/x repos/fremd/y",
    "gh api --hostname evil.example repos/cloudnutzer/x",
    "gh pr view github.com/fremd/x/pull/1 -R cloudnutzer/tybo",
    // Repo aus Variable oder Substitution
    "gh issue list -R $REPO",
    'gh issue list -R "$(cat repo.txt)"',
    "gh api repos/cloudnutzer/$NAME/../../fremd/x",
    "gh $(echo api) repos/fremd/x",
    // andere Instanz oder anderes Repo über die Umgebung
    "GH_HOST=evil.example gh issue list -R cloudnutzer/tybo",
    "export GH_HOST=evil.example; gh api repos/cloudnutzer/tybo",
  ])("%s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Ketten, Pipes, Zeilenumbrüche: jeder Teil zählt
    "gh api repos/fremd/x; gh issue list -R cloudnutzer/y",
    "gh issue list -R cloudnutzer/y; gh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y && gh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y || gh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y | gh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y & gh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y\ngh api repos/fremd/x",
    "gh issue list -R cloudnutzer/y \\\n  && gh api repos/fremd/x",
    "(gh api repos/fremd/x)",
    "{ gh api repos/fremd/x; }",
    // Substitutionen
    "echo $(gh api repos/fremd/x)",
    'echo "$(gh api repos/fremd/x)"',
    "echo `gh api repos/fremd/x`",
    "cat <(gh api repos/fremd/x)",
    "gh issue create -R cloudnutzer/y --body \"$(gh api repos/fremd/x --jq .body)\"",
    // gh in einer Zeichenkette, die ausgeführt wird
    "bash -c 'gh api repos/fremd/x'",
    'sh -c "gh issue list -R cloudnutzer/y; gh api repos/fremd/x"',
    "eval 'gh api repos/fremd/x'",
    "bash <<< 'gh api repos/fremd/x'",
    // Anführungszeichen mit Trennzeichen verstecken kein weiteres -R
    "gh issue list -R cloudnutzer/y --jq '.[] | .title' -R fremd/x",
    'gh issue list -R cloudnutzer/y --search "a;b" -R fremd/x',
    // Schreibweisen von gh
    "GH api repos/fremd/x",
    "g\\h api repos/fremd/x",
    '"gh" api repos/fremd/x',
    "xargs gh api < liste.txt",
    // unvollständig
    "gh issue list -R 'cloudnutzer/y",
    "echo $(gh issue list -R cloudnutzer/y",
  ])("Umgehung: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Werte anderer Optionen sind keine Repo-Auswahl
    'gh issue list --template "-Rcloudnutzer/tybo"',
    'gh issue list --search "-Rcloudnutzer/tybo"',
    "gh issue list -S -Rcloudnutzer/tybo",
    "gh pr list --jq -R cloudnutzer/tybo",
    // unbekannte Option direkt vor -R: das -R könnte ihr Wert sein
    "gh issue list --unbekannt -R cloudnutzer/tybo",
    "gh issue list --unbekannt --repo=cloudnutzer/tybo",
    // nach dem Optionsende ist -R nur Text
    "gh issue list -- -R cloudnutzer/tybo",
    "gh issue view 3 -R cloudnutzer/y -- github.com/fremd/x/issues/1",
  ])("Optionswert statt Repo: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // zusätzliche Argumente aus Variablen oder Substitutionen können -R überschreiben
    'args="-R fremd/x"; gh issue list -R cloudnutzer/y $args',
    'gh issue list -R cloudnutzer/y $(printf -- "-R fremd/x")',
    "gh issue list -R cloudnutzer/y `printf -- -Rfremd/x`",
    'gh issue list -R cloudnutzer/y "$args"',
    'gh issue view "$NR" -R cloudnutzer/y',
    "gh issue create -R cloudnutzer/y --body $(cat /tmp/text.md)",
    "gh issue list -R cloudnutzer/y <(echo x)",
    // übersprungene Optionswerte in gh api
    "gh api repos/cloudnutzer/x -X $METHODE",
    "gh api repos/cloudnutzer/x -f body=$(cat /tmp/text.md)",
    "gh api repos/cloudnutzer/x -- $REST",
    // weitere Argumente von außen
    'echo "-R fremd/x" | xargs gh issue list -R cloudnutzer/y',
    "find . -name '*.txt' -exec gh issue view {} -R cloudnutzer/y \\;",
  ])("unklare Argumente: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // zitierte und maskierte gh-Aufrufe in ausgeführten Zeichenketten
    "bash -c 'gh \"api\" repos/fremd/x'",
    "bash -c 'gh \"api\" repos/fremd/x'; gh issue list -R cloudnutzer/y",
    "bash -c 'g\\h api repos/fremd/x'; gh issue list -R cloudnutzer/y",
    "sh -c \"g''h api repos/fremd/x\"; gh issue list -R cloudnutzer/y",
    "eval 'G\"H\" api repos/fremd/x' && gh issue list -R cloudnutzer/y",
    "bash -c \"bash -c 'gh api repos/fremd/x'\"",
    "bash <<< 'gh \"api\" repos/fremd/x'; gh issue list -R cloudnutzer/y",
    "bash -c 'gh api repos/fremd/x $X'",
    // nicht lesbar, zusammen mit einem eigenen Aufruf: fremd
    "bash -c \"g\\$'h' api repos/fremd/x\"; gh issue list -R cloudnutzer/y",
    "bash -c \"gh $(echo api) repos/fremd/x\"; gh issue list -R cloudnutzer/y",
    "X='gh api repos/fremd/x'; bash -c \"$X\"; gh issue list -R cloudnutzer/y",
    "G=gh; $G api repos/fremd/x; gh issue list -R cloudnutzer/y",
    "$PROG api repos/fremd/x; gh issue list -R cloudnutzer/y",
    'eval "$BEFEHL"; gh issue list -R cloudnutzer/y',
  ])("ausgeführte Zeichenkette: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Klammer-Erweiterung bildet zusätzliche Repo- oder Host-Schalter
    "gh issue list -R cloudnutzer/y {--repo=fremd/x,--state=open}",
    "gh pr list -R cloudnutzer/y {--repo=fremd/x,--state=open}",
    "gh release list -R cloudnutzer/y {-R,fremd/x}",
    "gh issue list -R{cloudnutzer/y,fremd/x}",
    "gh {-R,fremd/x} issue list -R cloudnutzer/y",
    "gh issue list -R cloudnutzer/y --state {open,-Rfremd/x}",
    "gh api repos/cloudnutzer/x --{hostname=enterprise.example,paginate}",
    "gh api repos/cloudnutzer/{x,../../fremd/y}",
    "gh api repos/cloudnutzer/x -X {GET,--hostname=enterprise.example}",
    "gh api repos/cloudnutzer/x {--hostname=enterprise.example,--paginate}",
    "gh issue list -R cloudnutzer/a && gh pr list -R cloudnutzer/b {--repo=fremd/x,--state=open}",
    "gh api repos/cloudnutzer/x; gh issue list -R cloudnutzer/y {-R,fremd/x}",
  ])("Klammer-Erweiterung: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // GH_HOST und Co. in jeder Schreibweise, die die Shell zum selben Namen macht
    "env GH_HOS''T=enterprise.example gh issue list -R cloudnutzer/y",
    'env GH_HO"S"T=enterprise.example gh issue list -R cloudnutzer/y',
    "env GH_HO\\ST=enterprise.example gh issue list -R cloudnutzer/y",
    "env 'GH_HOST=enterprise.example' gh api repos/cloudnutzer/y",
    "env -u X GH_RE''PO=fremd/x gh issue list -R cloudnutzer/y",
    "env GH_HO$(echo S)T=enterprise.example gh issue list -R cloudnutzer/y",
    "env {GH_HOST,X}=enterprise.example gh issue list -R cloudnutzer/y",
    "export GH_HOS''T=enterprise.example; gh issue list -R cloudnutzer/y",
    "export GH_HO\\ST=enterprise.example && gh api repos/cloudnutzer/y",
    'export "GH_CONFIG_DIR"=/tmp/x; gh pr list -R cloudnutzer/y',
    "export GH_HOS$'T'=enterprise.example; gh issue list -R cloudnutzer/y",
    "export GH_HO`echo S`T=enterprise.example; gh issue list -R cloudnutzer/y",
    "declare -x GH_HO''ST=enterprise.example; gh issue list -R cloudnutzer/y",
    "eval 'export GH_HO\"\"ST=enterprise.example'; gh issue list -R cloudnutzer/y",
    "eval \"export GH_HO\\$'\\\\x53'T=enterprise.example\"; gh issue list -R cloudnutzer/y",
  ])("Instanz über die Umgebung: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Kurzflag-Bündel mit angehängtem Repo-Wert: gh liest das Repo nach R
    "gh issue view 1 -R cloudnutzer/y -cRfremd/x",
    "gh pr view 1 -R cloudnutzer/y -cRfremd/x",
    "gh release list -R cloudnutzer/y -cRfremd/x",
    "gh -cRfremd/x issue list -R cloudnutzer/y",
    "gh issue view 1 -R cloudnutzer/y -cR=fremd/x",
  ])("Kurzflag-Bündel: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Dateinamensmuster ohne Anführungszeichen, die Bash zu gh macht
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/g[h] api repos/fremd/x",
    "gh issue list -R cloudnutzer/y && g[h] api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/g? api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/*h api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/[!x]h api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/[[:alpha:]]h api repos/fremd/x",
    'gh issue list -R cloudnutzer/y; "/opt/homebrew/bin/"g[h] api repos/fremd/x',
    "gh issue list -R cloudnutzer/y; 'g'[h] api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; nohup g[h] api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; sudo g[h] api repos/fremd/x",
    "bash -c '/opt/homebrew/bin/g[h] api repos/fremd/x'; gh issue list -R cloudnutzer/y",
  ])("Dateinamensmuster: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // Erweiterte Muster (Bash extglob, zsh), die der Lexer nicht sicher liest
    "gh issue list -R cloudnutzer/y; bash -O extglob -c '/opt/homebrew/bin/@(gh) api repos/fremd/x'",
    "gh issue list -R cloudnutzer/y; bash -O extglob -c '/opt/homebrew/bin/@(g)@(h) api repos/fremd/x'",
    "gh issue list -R cloudnutzer/y; zsh -c '/opt/homebrew/bin/(gh|zz-no-command) api repos/fremd/x'",
    "gh issue list -R cloudnutzer/y; /opt/homebrew/bin/+(gh) api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; env (gh|x) api repos/fremd/x",
    "gh issue list -R cloudnutzer/y; zsh -o extendedglob -c '/opt/homebrew/bin/gh# api repos/fremd/x'",
    "gh issue list -R cloudnutzer/y; zsh -o extendedglob -c '/opt/homebrew/bin/^git api repos/fremd/x'",
    "gh issue list -R cloudnutzer/y; zsh -o extendedglob -c '/opt/homebrew/bin/gh~x api repos/fremd/x'",
  ])("erweiterte Muster: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    // eval verbindet seine Argumente zu einem Befehl: Repo- und Hostwechsel im nächsten Argument
    "eval 'gh issue list -R cloudnutzer/y' '-Rfremd/x'",
    "eval 'gh issue list -R cloudnutzer/y' '-R' 'fremd/x'",
    "eval 'gh api repos/cloudnutzer/y' '--hostname=enterprise.example'",
    "eval gh issue list -R cloudnutzer/y \"'-Rfremd/x'\"",
    "eval 'gh issue list -R cloudnutzer/y' \"\\$(printf -- -Rfremd/x)\"",
    "eval 'gh issue list -R cloudnutzer/y' $ARGS",
    "gh issue list -R cloudnutzer/a; eval 'gh pr list -R cloudnutzer/b' '-Rfremd/x'",
  ])("eval: %s", command => expect(reason(command)).toBe(GH_REASON));

  test.each([
    "curl -s https://example.com",
    "wget -q example.com/datei",
    "yt-dlp abc",
    "lynx -dump example.com",
    "w3m example.com",
    "gh issue view https://github.com/cloudnutzer/tybo/issues/3",
    "gh api repos/cloudnutzer/x; curl example.com",
    "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\")'",
  ])("Netzabruf: %s", command => expect(reason(command)).toBe(NETWORK_REASON));
});

describe("ohne Netz: wie bisher eigen", () => {
  test.each([
    "gh --version",
    "gh --help",
    "bun run check",
    "git status && bun test",
    "ls ~/Downloads",
    "cat /etc/hosts",
    "grep -r gh src",
    "echo gh",
    "git log --oneline | head",
    "cat ~/.config/gh/hosts.yml",
    'git commit -m "it\'s high time"',
    'bash -c "$BEFEHL"',
  ])("%s", command => own(command));
});

describe("lexShell", () => {
  test("Kommandos, Anführungszeichen, Umleitungen und Substitutionen", () => {
    const lexed = lexShell("a 'b c' \"d\" 2>/dev/null; e $(f g) | h <<< 'x'");
    const texts = lexed.commands.map(c => c.map(w => w.text));
    expect(texts).toContainEqual(["a", "b c", "d"]);
    expect(texts).toContainEqual(["f", "g"]);
    expect(texts).toContainEqual(["e", ""]);
    expect(texts).toContainEqual(["h"]);
    expect(lexed.redirects.map(w => w.text)).toEqual(["/dev/null", "x"]);
    expect(lexed.commands.find(c => c[0]!.text === "e")![1]!.unclear).toBe(true);
    expect(lexed.broken).toBe(false);
    expect(lexShell("a 'b").broken).toBe(true);
  });
});

describe("Befehlskürzung: ein fremder Teil am Ende verschwindet nicht", () => {
  const filler = `echo ${"x".repeat(MAX_COMMAND_CHARS + 100)}`;
  const tail = "; gh api repos/fremd/x";
  const long = filler + tail;
  const ownTail = `${filler}; gh issue list -R cloudnutzer/y`;
  const classify = (uses: any[]) => classifyTurnTools({ uses }, "/projekt", { githubOwners: OWNERS });

  test("bashToolUse kürzt und merkt sich die Einstufung des vollen Befehls", () => {
    const use = bashToolUse(long, OWNERS);
    expect(use.command!.length).toBe(MAX_COMMAND_CHARS);
    expect(use.command).not.toContain("fremd");
    expect(use.commandCut).toEqual({ reason: GH_REASON });
    expect(classify([use])).toEqual({ status: "foreign", reasons: [GH_REASON] });
    expect(classify([bashToolUse(ownTail, OWNERS)]).status).toBe("own");
    expect(bashToolUse("ls", OWNERS)).toEqual({ name: "Bash", command: "ls" });
    expect(bashToolUse(undefined, OWNERS)).toEqual({ name: "Bash" });
  });

  test("ältere Einträge an der Kürzungsgrenze ohne Einstufung gelten als fremd", () => {
    // so hat die bisherige Erfassung den fremden Teil abgeschnitten
    const legacy = { name: "Bash", command: long.slice(0, MAX_COMMAND_CHARS) };
    expect(legacy.command).not.toContain("fremd");
    expect(classify([legacy])).toEqual({ status: "foreign", reasons: ["Bash mit gekürztem Befehl"] });
    // ein Netzabruf im sichtbaren Teil behält seinen Grund
    const visible = { name: "Bash", command: `curl example.com; ${filler}`.slice(0, MAX_COMMAND_CHARS) };
    expect(classify([visible])).toEqual({ status: "foreign", reasons: [NETWORK_REASON] });
    // genau an der Grenze erfasst: mit Einstufung, also eigen
    const exact = `echo ${"x".repeat(MAX_COMMAND_CHARS - 5)}`;
    expect(exact.length).toBe(MAX_COMMAND_CHARS);
    const use = bashToolUse(exact, OWNERS);
    expect(use).toEqual({ name: "Bash", command: exact, commandCut: { reason: null } });
    expect(classify([use]).status).toBe("own");
    expect(classify([{ name: "Bash", command: exact.slice(0, -1) }]).status).toBe("own");
  });

  test("gekürzter Befehl mit beschädigter Einstufung gilt als fremd", () => {
    expect(classify([{ name: "Bash", command: "ls", commandCut: { reason: "kaputt" as any, extra: 1 } }]).status).toBe("foreign");
    expect(classify([{ name: "Bash", command: "ls", commandCut: null as any }]).status).toBe("foreign");
    expect(classify([{ name: "Bash", command: "ls", commandCut: {} as any }]).status).toBe("foreign");
  });

  test("Claude Code (tool_use-Block und assistant-Ereignis)", () => {
    const saved = process.env.TYBO_TRUSTED_GITHUB_OWNERS;
    process.env.TYBO_TRUSTED_GITHUB_OWNERS = "cloudnutzer";
    try {
      const block = { type: "tool_use", name: "Bash", input: { command: long } };
      expect(classify([toolUseFromBlock(block)]).status).toBe("foreign");
      const event = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: ownTail } }] } };
      expect(classify(toolUsesFromEvent(event)).status).toBe("own");
    } finally {
      if (saved === undefined) delete process.env.TYBO_TRUSTED_GITHUB_OWNERS;
      else process.env.TYBO_TRUSTED_GITHUB_OWNERS = saved;
    }
  });

  test("Codex und OpenCode", () => {
    const codex = parseCodexEvent(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: long } }));
    expect(codex?.type).toBe("item");
    if (codex?.type !== "item") return;
    expect(codex.item.tools[0]!.command!.length).toBe(MAX_COMMAND_CHARS);
    expect(classify(codex.item.tools).status).toBe("foreign");
    const open = openCodeToolUse("bash", { command: long });
    expect(open.tools[0]!.command!.length).toBe(MAX_COMMAND_CHARS);
    expect(classify(open.tools).status).toBe("foreign");
  });
});
