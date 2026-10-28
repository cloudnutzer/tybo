/**
 * Agenten-Basis (Issue #358): Profil, gemeinsamer Anfang der Prompts,
 * Kanalregeln je Kanal, Konsultationsregeln aus dem Katalog, Tags und das
 * eine Zeitformat. Der Katalog liegt in temporären Dateien.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import * as base from "../src/agents/base";
import { createAgent, deleteAgent, getBuiltinCodePrompt, listAgents, mayConsult, setPrompt } from "../src/agents/catalog";
import { AGENT_ALIASES, AGENT_NAMES } from "../src/agents/names";
import { forgetUserProfile, getUserProfile } from "../src/agents/profile";
import {
  BASE_CONTEXT,
  CHANNEL_HEADING,
  CONSULTATION_HEADING,
  CONSULTATION_OVERRIDE,
  DEFAULT_PROMPT_CHANNEL,
  formatChannelRules,
  formatConsultationRules,
  formatPromptTime,
  IMAGE_TAG_SECTION,
  LONG_TASK_RULES,
  LONG_TASKS_HEADING,
  MEMORY_TAGS_SECTION,
  promptTimeZone,
  STATIC_CONSULTATION_HEADING,
  TEAMWORK_HEADING,
  withoutStaticConsultation,
} from "../src/agents/prompt-parts";
import { parseAssetDescTag } from "../src/lib/assets/tags";
import { parseMemoryIntents } from "../src/lib/memory/intents";
import { TELEGRAM_FORMAT_RULES } from "../src/lib/telegram";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

describe("Nutzerprofil", () => {
  const cwd = process.cwd();
  let dir = "";
  afterEach(() => {
    process.chdir(cwd);
    forgetUserProfile();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("liest config/profile.md einmal und merkt sich den Text", async () => {
    dir = mkdtempSync(join(tmpdir(), "tybo-profil-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "profile.md"), "Name: Alex");
    process.chdir(dir);
    forgetUserProfile();
    expect(await getUserProfile()).toBe("Name: Alex");
    writeFileSync(join(dir, "config", "profile.md"), "Name: Mia");
    expect(await getUserProfile()).toBe("Name: Alex");
    forgetUserProfile();
    expect(await getUserProfile()).toBe("Name: Mia");
  });

  test("ohne Datei leer, auch über base und index erreichbar", async () => {
    dir = mkdtempSync(join(tmpdir(), "tybo-profil-"));
    process.chdir(dir);
    forgetUserProfile();
    expect(await getUserProfile()).toBe("");
    expect(base.getUserProfile).toBe(getUserProfile);
    expect((await import("../src/agents")).getUserProfile).toBe(getUserProfile);
  });
});

describe("gemeinsamer Anfang (BASE_CONTEXT)", () => {
  test("nennt den Namen, endet mit LONG TASKS, Zusammenarbeit davor", () => {
    expect(BASE_CONTEXT).toContain(`You are ${BRAND.name}`);
    expect(BASE_CONTEXT.endsWith(`\n${LONG_TASK_RULES}\n`)).toBe(true);
    expect(BASE_CONTEXT.split(LONG_TASKS_HEADING).length - 1).toBe(1);
    expect(BASE_CONTEXT.indexOf(TEAMWORK_HEADING)).toBeGreaterThan(-1);
    expect(BASE_CONTEXT.indexOf(TEAMWORK_HEADING)).toBeLessThan(BASE_CONTEXT.indexOf(LONG_TASKS_HEADING));
  });

  test("keine Kanalregeln mehr im Basis-Teil, keine Gedankenstriche", () => {
    expect(BASE_CONTEXT).not.toContain(TELEGRAM_FORMAT_RULES);
    expect(BASE_CONTEXT).not.toContain("Telegram");
    expect(BASE_CONTEXT).not.toContain("—");
    expect(BASE_CONTEXT).toContain("channel section");
  });

  test("Erste Person und kurze Antworten bleiben Regel", () => {
    expect(BASE_CONTEXT).toContain("first person");
    expect(BASE_CONTEXT).toMatch(/brief and direct/);
  });

  test("jeder mitgelieferte und eigene Agent beginnt mit dem Basis-Teil", async () => {
    for (const name of AGENT_NAMES) expect(getBuiltinCodePrompt(name)!.startsWith(BASE_CONTEXT)).toBe(true);
    await createAgent({ name: "reise-planer", description: "Plant Reisen", systemPrompt: "Du planst Reisen." });
    expect(base.getAgentConfig("reise-planer")!.systemPrompt.startsWith(BASE_CONTEXT)).toBe(true);
  });

  test("base reicht dieselben Bausteine weiter wie prompt-parts", () => {
    expect(base.BASE_CONTEXT).toBe(BASE_CONTEXT);
    expect(base.LONG_TASK_RULES).toBe(LONG_TASK_RULES);
  });
});

describe("Kanalregeln", () => {
  test("Telegram: Formatregeln samt Tabellenverbot", () => {
    const rules = formatChannelRules("telegram");
    expect(rules.startsWith(CHANNEL_HEADING)).toBe(true);
    expect(rules).toContain(TELEGRAM_FORMAT_RULES);
    expect(rules).toMatch(/NEVER use tables/);
  });

  test("WebUI: Tabellen erlaubt, kein Telegram-Verbot", () => {
    const rules = formatChannelRules("web");
    expect(rules.startsWith(CHANNEL_HEADING)).toBe(true);
    expect(rules).not.toContain(TELEGRAM_FORMAT_RULES);
    expect(rules).not.toContain("Telegram");
    expect(rules).toContain("web app");
    expect(rules).toMatch(/table is fine/i);
  });

  test("ohne Angabe Telegram; beide sagen, dass nur der aktuelle Kanal zählt", () => {
    expect(DEFAULT_PROMPT_CHANNEL).toBe("telegram");
    expect(formatChannelRules()).toBe(formatChannelRules("telegram"));
    for (const channel of ["telegram", "web"] as const) {
      expect(formatChannelRules(channel)).toContain("only the rules above count");
      expect(formatChannelRules(channel)).not.toContain("—");
    }
  });
});

/** Ziele aus dem erzeugten Abschnitt */
function listed(section: string): string[] {
  return [...section.matchAll(/^- ([a-z][a-z0-9-]*): /gm)].map(m => m[1]);
}

describe("Konsultationsregeln aus dem Katalog", () => {
  test("jeder mitgelieferte Agent: genau die Agenten, die mayConsult erlaubt", () => {
    const names = listAgents().map(a => a.name);
    for (const self of AGENT_NAMES) {
      const allowed = names.filter(t => t !== self && mayConsult(self, t));
      const section = formatConsultationRules(self);
      expect({ self, targets: listed(section) }).toEqual({ self, targets: allowed });
      if (allowed.length === 0) expect(section).toBe("");
      else {
        expect(section.startsWith(CONSULTATION_HEADING)).toBe(true);
        expect(section).toContain("[INVOKE:agent|your question]");
      }
    }
  });

  test("General fragt alle anderen, Critic niemanden, Beschreibung aus dem Katalog", () => {
    expect(listed(formatConsultationRules("general"))).toEqual(AGENT_NAMES.filter(n => n !== "general"));
    expect(formatConsultationRules("critic")).toBe("");
    const research = listAgents().find(a => a.name === "research")!;
    expect(formatConsultationRules("general")).toContain(`- research: ${research.description}`);
  });

  test("Aliasse zählen wie die Kennung, unbekannte Agenten wie General", () => {
    for (const [alias, name] of Object.entries(AGENT_ALIASES)) {
      expect(formatConsultationRules(alias)).toBe(formatConsultationRules(name));
    }
    expect(formatConsultationRules("gibt-es-nicht")).toBe(formatConsultationRules("general"));
  });

  test("gelöschte Agenten fehlen, eigene Agenten erscheinen", async () => {
    await deleteAgent("research");
    await createAgent({ name: "reise-planer", description: "Plant Reisen", systemPrompt: "Du planst Reisen." });
    const general = listed(formatConsultationRules("general"));
    expect(general).not.toContain("research");
    expect(general).toContain("reise-planer");
    expect(formatConsultationRules("general")).toContain("- reise-planer: Plant Reisen");
    expect(listed(formatConsultationRules("cto"))).toEqual(["critic"]);
    // Eigene Agenten fragen nur critic und research, research ist gelöscht
    expect(listed(formatConsultationRules("reise-planer"))).toEqual(["critic"]);
    // Gelöschter Agent selbst: wie General
    expect(formatConsultationRules("research")).toBe(formatConsultationRules("general"));
  });

  test("Quelle austauschbar: niemand erlaubt ergibt keinen Abschnitt", () => {
    const source = {
      agents: () => [{ name: "general", description: "G" }, { name: "x", description: "X" }],
      mayConsult: () => false,
      resolve: (n: string) => n,
    };
    expect(formatConsultationRules("general", source)).toBe("");
    expect(formatConsultationRules("general", { ...source, mayConsult: () => true })).toBe(
      `${CONSULTATION_HEADING}\nTo get another agent's view, put [INVOKE:agent|your question] into your reply, using the agent's id from this list:\n- x: X\n${CONSULTATION_OVERRIDE}\nThe agent answers visibly in this conversation. Your own reply stands as it is; do not wait for the answer.`
    );
  });

  test("keine statischen Listen mehr in den Code-Prompts, die den Rechten widersprechen könnten (Issue #359, #360)", () => {
    for (const self of AGENT_NAMES) {
      const prompt = getBuiltinCodePrompt(self)!;
      expect({ self, heading: prompt.includes(STATIC_CONSULTATION_HEADING) }).toEqual({ self, heading: false });
      // Feste Ziele: Aufzählung **kennung** oder [INVOKE:kennung|...] mit echter Kennung
      expect({ self, list: /^- \*\*[a-z-]+\*\*/m.test(prompt) }).toEqual({ self, list: false });
      const targets = [...prompt.matchAll(/\[INVOKE:([a-z-]+)\|/g)].map(m => m[1]).filter(n => n !== "agent");
      expect({ self, targets }).toEqual({ self, targets: [] });
    }
  });

  test("withoutStaticConsultation: fester Abschnitt fällt weg, mitten im Prompt wie am Ende, der Rest bleibt", () => {
    const middle = "A\n\n## ROLE\nx\n\n## CROSS-AGENT CONSULTATION (VISIBLE)\n- **research** — R\n[INVOKE:research|q]\n\n## CONSTRAINTS\n- kurz\n";
    expect(withoutStaticConsultation(middle)).toBe("A\n\n## ROLE\nx\n\n## CONSTRAINTS\n- kurz\n");
    const end = "A\n\n## ROLE\nx\n\n## CROSS-AGENT CONSULTATION (VISIBLE)\n- **research** — R\n";
    expect(withoutStaticConsultation(end)).toBe("A\n\n## ROLE\nx\n");
    expect(withoutStaticConsultation("ohne Abschnitt")).toBe("ohne Abschnitt");
    for (const self of AGENT_NAMES) {
      const stripped = base.getAgentConfig(self, { consultationHints: false })!.systemPrompt;
      expect(stripped).not.toContain(STATIC_CONSULTATION_HEADING);
      expect(stripped).not.toMatch(/\[INVOKE:[a-z-]+\|/);
      // Alles andere bleibt: BASE_CONTEXT, Rolle, LONG TASKS
      expect(stripped).toContain(LONG_TASK_RULES);
      expect(stripped.length).toBeGreaterThan(BASE_CONTEXT.length);
    }
    // Ohne Option wie bisher (Sprach-Gehirn und andere Aufrufer): seit #360 hat
    // auch der cto-Prompt keinen festen Abschnitt mehr, beide Fassungen sind gleich
    expect(base.getAgentConfig("cto")!.systemPrompt).toBe(base.getAgentConfig("cto", { consultationHints: false })!.systemPrompt);
  });

  test("ohne Konsultationshinweise: gespeicherter Prompt bleibt wortgleich, Zusätze für eigene Agenten fallen weg", async () => {
    const stored = "Du bist mein Technik-Agent.\n\n## CROSS-AGENT CONSULTATION (VISIBLE)\n- **research** — Recherche\n[INVOKE:research|Was ist neu?]";
    await setPrompt("cto", stored);
    expect(base.getAgentConfig("cto", { consultationHints: false })!.systemPrompt).toBe(`${stored}\n\n${LONG_TASK_RULES}\n`);
    await createAgent({ name: "reise-planer", description: "Plant Reisen", systemPrompt: "Du planst Reisen." });
    expect(base.getAgentConfig("reise-planer")!.systemPrompt).toContain(STATIC_CONSULTATION_HEADING);
    expect(base.getAgentConfig("reise-planer", { consultationHints: false })!.systemPrompt).toBe(`${BASE_CONTEXT}\n\nDu planst Reisen.`);
    expect(base.getAgentConfig("general")!.systemPrompt).toContain("## ADDITIONAL AGENTS");
    expect(base.getAgentConfig("general", { consultationHints: false })!.systemPrompt).not.toContain("## ADDITIONAL AGENTS");
  });
});

describe("Tags", () => {
  test("Merk-Tags wortgleich und vom Parser lesbar", () => {
    for (const syntax of [
      "[GOAL: description | DEADLINE: deadline]",
      "[DONE: partial match]",
      "[CANCEL: partial match]",
      "[REMEMBER: fact]",
      "[FORGET: partial match]",
      "[REMIND: when | text]",
    ]) {
      expect(MEMORY_TAGS_SECTION).toContain(syntax);
    }
    const reply = [
      "[GOAL: Steuererklärung abgeben | DEADLINE: 31.10.]",
      "[DONE: Steuererklärung]",
      "[CANCEL: Marathon laufen]",
      "[REMEMBER: Alex mag kurze Antworten]",
      "[FORGET: alte Adresse]",
      "[REMIND: morgen 9 Uhr | Zahnarzt anrufen]",
    ].join("\n");
    expect(parseMemoryIntents(reply).map(i => i.type).sort()).toEqual(["cancel", "done", "fact", "forget", "goal", "remind"]);
  });

  test("Bildbeschreibung: Syntax und Beispiel passen zum Parser", () => {
    expect(IMAGE_TAG_SECTION).toContain("[ASSET_DESC: one or two sentences | tag1, tag2, tag3]");
    const example = IMAGE_TAG_SECTION.split("For example: ")[1];
    expect(parseAssetDescTag(example)).toEqual({
      description: "Hand-drawn map of a school garden with three raised beds",
      tags: ["garden", "school", "map"],
    });
  });

  test("keine Gedankenstriche in den Tag-Abschnitten", () => {
    expect(MEMORY_TAGS_SECTION + IMAGE_TAG_SECTION).not.toContain("—");
  });
});

describe("ein Zeitformat", () => {
  const instant = new Date("2026-10-22T12:05:00Z");

  test("Wochentag, Datum, 24-Stunden-Zeit, Zone", () => {
    expect(formatPromptTime(instant, "Europe/Berlin")).toBe("Thursday, Oct 22, 2026 at 14:05 GMT+2");
    expect(formatPromptTime(new Date("2026-10-23T00:30:00Z"), "UTC")).toBe("Friday, Oct 23, 2026 at 00:30 UTC");
  });

  test("ungültige Zone ergibt UTC statt eines Fehlers", () => {
    expect(formatPromptTime(instant, "Mond/Basis")).toBe(formatPromptTime(instant, "UTC"));
  });

  test("Zeitzone aus USER_TIMEZONE beim Aufruf, sonst UTC", () => {
    const before = process.env.USER_TIMEZONE;
    try {
      process.env.USER_TIMEZONE = "Asia/Tokyo";
      expect(promptTimeZone()).toBe("Asia/Tokyo");
      expect(formatPromptTime(instant)).toBe("Thursday, Oct 22, 2026 at 21:05 GMT+9");
      delete process.env.USER_TIMEZONE;
      expect(promptTimeZone()).toBe("UTC");
    } finally {
      if (before === undefined) delete process.env.USER_TIMEZONE;
      else process.env.USER_TIMEZONE = before;
    }
  });
});
