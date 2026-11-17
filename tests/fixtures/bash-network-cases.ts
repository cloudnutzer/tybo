/** Issue #525: neueste Befunde und die gemeinsame Klasse unvollständig geprüfter Aufrufe. */
export const UNPROVEN_GH_COMMANDS = [
  // env zerlegt die Zeichenkette und hängt die restlichen Argumente an.
  "env -S 'gh issue list -R cloudnutzer/y' '-Rfremd/x'",
  "env --split-string='gh pr list -R cloudnutzer/y' '--repo=fremd/x'",
  "env -S 'gh api repos/cloudnutzer/y' '--hostname=enterprise.example'",
  "gh issue list -R cloudnutzer/y; env -S 'gh api repos/cloudnutzer/y' '--hostname=enterprise.example'",
  // Netzprogramme zählen nach der Wortbildung, auch ohne http(s)-Adresse.
  "gh issue list -R cloudnutzer/y; cu''rl example.com",
  'gh pr list -R cloudnutzer/y && wge""t example.com',
  "gh release list -R cloudnutzer/y | c\\url example.com",
  "gh issue list -R cloudnutzer/y; bash -c \"cu''rl example.com\"",
  // Dateimuster verändern jede Argumentposition, nicht nur den Programmnamen.
  "gh api repos/cloudnutzer/y --[h]ostname=enterprise.example",
  "gh issue list -R cloudnutzer/y --[r]epo=fremd/x",
  "gh pr list -R cloudnutzer/y --[r]epo=fremd/x",
  "gh release list -R cloudnutzer/y --[r]epo=fremd/x",
  "gh issue list -R cloudnutzer/y --search *",
  "gh api repos/cloudnutzer/y --method *",
  // Unbekannte Wrapper dürfen keine Teilfreigabe aus einem Argument erben.
  "dispatch 'gh issue list -R cloudnutzer/y' '-Rfremd/x'",
  "dispatch gh issue list -R cloudnutzer/y",
  "gh issue list -R cloudnutzer/y; dispatch request.txt",
  "env --unbekannt 'gh issue list -R cloudnutzer/y'",
  'env "--$(cat /tmp/env-option)" gh issue list -R cloudnutzer/y',
  "gh issue list -R cloudnutzer/y --unbekannt=wert",
  "gh api repos/cloudnutzer/y --unbekannt=wert",
  // Globale Optionslisten verlieren die Wertigkeit des jeweiligen Unterbefehls.
  "gh issue close 1 -R cloudnutzer/y --comment -Rfremd/x",
  "gh issue close 1 -c -Rcloudnutzer/y",
  // Auch zitierte Arrays können mehrere Argumente bilden; Parameter können die Umgebung ändern.
  'gh issue comment 1 -R cloudnutzer/y --body "$@"',
  'gh api repos/cloudnutzer/y --method "${METHODS[@]}"',
  'echo "${GH_HOST:=enterprise.example}"; gh issue list -R cloudnutzer/y',
  "gh api repos/cloudnutzer/y --header 'Host: enterprise.example'",
] as const;

/** Runde 6: ausgeführte Befehle hinter inneren Klammern dürfen nicht zum Optionswert werden. */
export const NESTED_SUBSTITUTION_CASES = [
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( (true); gh api repos/fremd/x )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( (true); gh issue list )"',
    nested: ["gh", "issue", "list"],
  },
  {
    command: 'gh issue comment 1 -R cloudnutzer/y --body "$( (true); gh api repos/fremd/x )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh api repos/cloudnutzer/y -f x="$( (true); gh api repos/fremd/x )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y; gh api repos/cloudnutzer/y -f x="$( (true); gh api repos/fremd/x )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh pr list -R cloudnutzer/y --search "$( ( (true) ); gh api repos/fremd/x )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( ( (true); gh api repos/fremd/x ) )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( (true) && gh api repos/fremd/x | cat )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( (true) # ) gehört zum Kommentar\n gh api repos/fremd/x\n)"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: `gh issue list -R cloudnutzer/y --search "$( (echo ')' >/dev/null); g''h api repos/fremd/x )"`,
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: String.raw`gh issue list -R cloudnutzer/y --search "$( (echo \) >/dev/null); gh api repos/fremd/x )"`,
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: 'gh issue list -R cloudnutzer/y --search "$( gh api repos/cloudnutzer/y -f x="$( (true); gh api repos/fremd/x )" )"',
    nested: ["gh", "api", "repos/fremd/x"],
  },
  {
    command: `bash -c 'gh issue list -R cloudnutzer/y --search "$( (true); gh api repos/fremd/x )"'`,
    nested: ["gh", "api", "repos/fremd/x"],
  },
] as const;
