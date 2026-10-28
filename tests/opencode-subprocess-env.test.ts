/**
 * Issue #128, Aufgabe 2: Umgebung für OpenCode-Subprozesse. MCP-Verweise
 * ({env:NAME}) kommen aus opencode.json(c) im Konfigurationsordner von
 * OpenCode ($XDG_CONFIG_HOME/opencode vor ~/.config/opencode) und im
 * Projekt; Anbieter-Schlüssel, Telegram und WEB_PASSWORD bleiben draußen.
 * Alle Konfigurationen liegen in Temp-Verzeichnissen; die echte
 * ~/.config/opencode und ~/.claude.json werden nie gelesen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createOpenCodeEngine, opencodeEnv } from "../src/lib/engines/opencode";
import { setSettingsPath } from "../src/lib/settings";
import {
  filterSubprocessEnv,
  isOpenCodeProviderCredential,
  logSubprocessEnvFilter,
  OPENCODE_PROVIDER_KEYS,
  opencodeCacheDir,
  opencodeConfigDir,
  OPENCODE_SDK_CREDENTIALS,
  opencodeMcpReferencedVars,
  opencodeProviderCredentialRefs,
  opencodeProviderVars,
  setMcpReaderForTests,
  setOpenCodeSystemDirsForTests,
  setSubprocessEnvLoggerForTests,
} from "../src/lib/subprocess-env";
import { installOpenCodeFake, oc } from "./opencode-fixture";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tybo-opencodeenv-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  setMcpReaderForTests(null);
  setOpenCodeSystemDirsForTests(null);
});

let home: string;
let project: string;
let configDir: string;
/** Ersatz für den systemweiten OpenCode-Ordner (nie den echten lesen) */
let systemDir: string;
beforeEach(() => {
  setMcpReaderForTests(null);
  home = tmp();
  project = tmp();
  configDir = join(home, ".config", "opencode");
  systemDir = tmp();
  setOpenCodeSystemDirsForTests([systemDir]);
});

describe("gewöhnliche Anbieter-Einstellungen per {env:…} (PR #232)", () => {
  test("options.profile = {env:AWS_PROFILE} und baseURL = {env:MODEL_URL} bleiben erhalten", () => {
    writeFileSync(join(project, "opencode.json"), JSON.stringify({
      provider: {
        "amazon-bedrock": { options: { profile: "{env:AWS_PROFILE}" } },
        eigen: { options: { baseURL: "{env:MODEL_URL}", apiKey: "{env:LOGIN_ACCOUNT}" } },
      },
    }));
    const { env, removed } = opencode({ PATH: "/bin", HOME: home, AWS_PROFILE: "work", MODEL_URL: "https://modelle.example", LOGIN_ACCOUNT: "geheim-login" });
    expect(env.AWS_PROFILE).toBe("work");
    expect(env.MODEL_URL).toBe("https://modelle.example");
    // Zugangsdatenfeld bleibt freigabepflichtig
    expect(env.LOGIN_ACCOUNT).toBeUndefined();
    expect(removed).toContain("LOGIN_ACCOUNT");
  });
});

describe("systemweite OpenCode-Konfiguration (PR #232)", () => {
  const SYS = { provider: { openrouter: { options: { apiKey: "{env:LOGIN_ACCOUNT}" } } } };
  test("ohne Freigabe entfernt", () => {
    writeFileSync(join(systemDir, "opencode.json"), JSON.stringify(SYS));
    const { env, removed } = opencode({ PATH: "/bin", HOME: home, LOGIN_ACCOUNT: "geheim-login" });
    expect(env.LOGIN_ACCOUNT).toBeUndefined();
    expect(removed).toContain("LOGIN_ACCOUNT");
  });
  test("trotz MCP-Verweis entfernt, mit Freigabe vorhanden", () => {
    writeFileSync(join(systemDir, "opencode.jsonc"), `// verwaltet\n${JSON.stringify(SYS)}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ mcp: { x: { environment: { A: "{env:LOGIN_ACCOUNT}" } } } }));
    expect(opencode({ PATH: "/bin", HOME: home, LOGIN_ACCOUNT: "geheim-login" }).env.LOGIN_ACCOUNT).toBeUndefined();
    const frei = opencode({ PATH: "/bin", HOME: home, LOGIN_ACCOUNT: "geheim-login", TYBO_SUBPROCESS_ENV_ALLOW: "LOGIN_ACCOUNT" });
    expect(frei.env.LOGIN_ACCOUNT).toBe("geheim-login");
  });
});

const BOT_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  LANG: "de_DE.UTF-8",
  TELEGRAM_BOT_TOKEN: "123:geheim-telegram",
  TELEGRAM_BOT_TOKEN_RESEARCH: "456:geheim-research",
  TELEGRAM_USER_ID: "4711",
  SUPABASE_SERVICE_ROLE_KEY: "geheim-supabase",
  WEB_PASSWORD: "geheim-web",
  OPENROUTER_API_KEY: "geheim-openrouter",
  OPENAI_API_KEY: "geheim-openai",
  ANTHROPIC_API_KEY: "geheim-anthropic",
  GEMINI_API_KEY: "geheim-gemini",
  NOTION_TOKEN: "geheim-notion",
  LINEAR_API_KEY: "geheim-linear",
  GITHUB_PAT_TOKEN: "geheim-github",
  CLAUDECODE: "1",
};

/** Schreibt eine Datei mit eindeutiger Änderungszeit (Zwischenspeicher nach mtime und Größe) */
let tick = 1_000;
function writeConfig(dir: string, name: string, content: string | object): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  tick += 10;
  utimesSync(file, tick, tick);
}

const GLOBAL = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    notion: { type: "local", command: ["bunx", "notion-mcp"], environment: { NOTION_TOKEN: "{env:NOTION_TOKEN}", MODUS: "fest" } },
    github: { type: "remote", url: "https://mcp.example.test/github", headers: { Authorization: "Bearer {env:GITHUB_PAT_TOKEN}" } },
    gefaehrlich: {
      type: "local",
      command: ["x"],
      environment: {
        A: "{env:OPENROUTER_API_KEY}",
        B: "{env:OPENAI_API_KEY}",
        C: "{env:ANTHROPIC_API_KEY}",
        D: "{env:TELEGRAM_BOT_TOKEN}",
        E: "{env:TELEGRAM_BOT_TOKEN_RESEARCH}",
        F: "{env:WEB_PASSWORD}",
        G: "{env:GEMINI_API_KEY}",
      },
    },
  },
};

const PROJECT_JSONC = `{
  // MCP im Projekt, mit Kommentaren und Komma am Ende
  "mcp": {
    "linear": {
      "type": "local",
      "command": ["linear-mcp", "--url", "https://x.test/a//b"], /* kein Kommentar im String */
      "environment": { "LINEAR": "{env:LINEAR_API_KEY}", },
    },
  },
}`;

function opencode(env: Record<string, string>, extra: Partial<Parameters<typeof filterSubprocessEnv>[0]> = {}) {
  return filterSubprocessEnv({ env, cwd: project, home, engine: "opencode", ...extra });
}

describe("Konfigurationsordner", () => {
  test("XDG_CONFIG_HOME (absolut) vor <home>/.config/opencode, ohne beides leer", () => {
    expect(opencodeConfigDir({}, "/home/alex")).toBe("/home/alex/.config/opencode");
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/alex")).toBe("/xdg/opencode");
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "relativ" }, "/home/alex")).toBe("/home/alex/.config/opencode");
    expect(opencodeConfigDir({}, "")).toBe("");
  });
});

describe("opencode.json(c) von OpenCode", () => {
  test("liest {env:NAME} aus environment, command und headers der MCP-Einträge", () => {
    writeConfig(configDir, "opencode.json", GLOBAL);
    expect([...opencodeMcpReferencedVars(configDir, project)].sort()).toEqual([
      "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GITHUB_PAT_TOKEN", "NOTION_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
      "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_RESEARCH", "WEB_PASSWORD",
    ]);
  });

  test("JSONC im Projekt: Kommentare und Komma am Ende", () => {
    writeConfig(project, "opencode.jsonc", PROJECT_JSONC);
    expect([...opencodeMcpReferencedVars(configDir, project)]).toEqual(["LINEAR_API_KEY"]);
  });

  test("global .jsonc und Projekt .json zusammen", () => {
    writeConfig(configDir, "opencode.jsonc", PROJECT_JSONC);
    writeConfig(project, "opencode.json", { mcp: { n: { type: "local", command: ["n"], environment: { T: "{env:NOTION_TOKEN}" } } } });
    expect([...opencodeMcpReferencedVars(configDir, project)].sort()).toEqual(["LINEAR_API_KEY", "NOTION_TOKEN"]);
  });

  test("andere Abschnitte, feste Werte, $VAR und ${VAR} zählen nicht", () => {
    writeConfig(configDir, "opencode.json", {
      provider: { openrouter: { options: { apiKey: "{env:PROVIDER_TOKEN}" } } },
      agent: { x: { prompt: "{env:AGENT_TOKEN}" } },
      mcp: { a: { type: "local", command: ["$BEFEHL_TOKEN", "${ARG_TOKEN}"], environment: { WERT: "FEST_TOKEN", F: "{file:~/geheim}" } } },
    });
    expect([...opencodeMcpReferencedVars(configDir, project)]).toEqual([]);
  });

  test("defekte, fehlende oder falsch geformte Dateien tragen nichts bei, die übrigen zählen", () => {
    writeConfig(configDir, "opencode.json", "{ kaputt");
    writeConfig(configDir, "opencode.jsonc", { mcp: ["kein", "objekt"] });
    writeConfig(project, "opencode.json", "[1, 2]");
    writeConfig(project, "opencode.jsonc", { mcp: { n: { environment: { T: "{env:NOTION_TOKEN}" } }, leer: null, text: "x" } });
    expect([...opencodeMcpReferencedVars(configDir, project)]).toEqual(["NOTION_TOKEN"]);
    expect([...opencodeMcpReferencedVars(join(home, "fehlt"), join(home, "fehlt-auch"))]).toEqual([]);
  });

  test("Änderung der Datei wird beim nächsten Aufruf gelesen", () => {
    writeConfig(configDir, "opencode.json", { mcp: { n: { environment: { T: "{env:NOTION_TOKEN}" } } } });
    expect([...opencodeMcpReferencedVars(configDir, project)]).toEqual(["NOTION_TOKEN"]);
    writeConfig(configDir, "opencode.json", { mcp: { l: { environment: { T: "{env:LINEAR_API_KEY}" } } } });
    expect([...opencodeMcpReferencedVars(configDir, project)]).toEqual(["LINEAR_API_KEY"]);
  });

  test("Claude-Dateien und die config.toml von Codex zählen für OpenCode nicht", () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { n: { env: { T: "${NOTION_TOKEN}" } } } }));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { l: { env: { T: "${LINEAR_API_KEY}" } } } }));
    writeConfig(join(home, ".codex"), "config.toml", '[mcp_servers.g]\nenv_vars = ["GITHUB_PAT_TOKEN"]\n');
    const { env } = opencode(BOT_ENV);
    expect(env.NOTION_TOKEN).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.GITHUB_PAT_TOKEN).toBeUndefined();
  });
});

describe("Filter für OpenCode", () => {
  test("Akzeptanz: referenzierte Variable ist da, TELEGRAM_BOT_TOKEN und WEB_PASSWORD fehlen", () => {
    writeConfig(configDir, "opencode.json", GLOBAL);
    const { env, removed } = opencode(BOT_ENV);
    expect(env.NOTION_TOKEN).toBe("geheim-notion");
    expect(env.GITHUB_PAT_TOKEN).toBe("geheim-github");
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.WEB_PASSWORD).toBeUndefined();
    // Anbieter-Schlüssel und Telegram trotz MCP-Referenz draußen
    for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN_RESEARCH", "TELEGRAM_USER_ID"]) {
      expect(env[k]).toBeUndefined();
      expect(removed).toContain(k);
    }
    // Nicht referenzierte Geheimnisse bleiben draußen, gewöhnliche Variablen bleiben
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.LANG).toBe("de_DE.UTF-8");
    expect(env.TYBO_SUBPROCESS).toBe("1");
    expect(removed).toContain("WEB_PASSWORD");
    expect(removed).not.toContain("NOTION_TOKEN");
  });

  test("ohne Konfiguration: alle Geheimnisse draußen", () => {
    const { env } = opencode(BOT_ENV);
    for (const k of Object.keys(BOT_ENV)) {
      if (/TOKEN|KEY|PASSWORD|TELEGRAM_|SUPABASE_/.test(k)) expect(env[k]).toBeUndefined();
    }
  });

  test("Anbieter-Schlüssel nur über die Freigabeliste; WEB_PASSWORD auch dann nie", () => {
    writeConfig(configDir, "opencode.json", GLOBAL);
    const { env } = opencode({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN,WEB_PASSWORD" });
    expect(env.OPENROUTER_API_KEY).toBe("geheim-openrouter");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("123:geheim-telegram");
    expect(env.WEB_PASSWORD).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("feste Liste der Anbieter-Schlüssel", () => {
    expect([...OPENCODE_PROVIDER_KEYS]).toEqual([
      "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "GEMINI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY",
    ]);
    // Jeder Anbieter-Schlüssel bleibt draußen, auch wenn eine MCP-Konfiguration ihn nennt
    const all = Object.fromEntries(OPENCODE_PROVIDER_KEYS.map((k) => [k, "geheim"]));
    writeConfig(project, "opencode.json", { mcp: { x: { environment: Object.fromEntries(OPENCODE_PROVIDER_KEYS.map((k) => [k, `{env:${k}}`])) } } });
    const { env } = opencode({ PATH: "/bin", ...all });
    for (const k of OPENCODE_PROVIDER_KEYS) expect(env[k]).toBeUndefined();
  });

  describe("Anbieter außerhalb der festen Liste", () => {
    const ANBIETER: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: "geheim-cloudflare",
      AWS_ACCESS_KEY_ID: "geheim-aws-id",
      AWS_SECRET_ACCESS_KEY: "geheim-aws",
      HF_TOKEN: "geheim-hf",
      TOGETHER_API_KEY: "geheim-together",
      CLARIFAI_PAT: "geheim-clarifai",
    };
    const VERWEISE = { mcp: { cf: { type: "local", command: ["cf-mcp"], environment: Object.fromEntries(Object.keys(ANBIETER).map((k) => [k, `{env:${k}}`])) } } };

    test("Fehlerfall aus dem Review: leere Freigabeliste, CLOUDFLARE_API_TOKEN mit MCP-Verweis bleibt draußen", () => {
      writeConfig(configDir, "opencode.json", { mcp: { cf: { type: "local", command: ["cf-mcp"], environment: { CLOUDFLARE_API_TOKEN: "{env:CLOUDFLARE_API_TOKEN}" } } } });
      const { env, removed } = opencode({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "", CLOUDFLARE_API_TOKEN: "geheim-cloudflare" });
      expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(removed).toContain("CLOUDFLARE_API_TOKEN");
      expect(env.NOTION_TOKEN).toBeUndefined();
    });

    test("ohne Freigabe entfernt, auch Namen, die nicht nach Geheimnis aussehen", () => {
      const { env, removed } = opencode({ ...BOT_ENV, ...ANBIETER });
      for (const k of Object.keys(ANBIETER)) {
        expect(env[k]).toBeUndefined();
        expect(removed).toContain(k);
      }
    });

    test("trotz MCP-Verweis entfernt, andere referenzierte Geheimnisse bleiben", () => {
      writeConfig(configDir, "opencode.json", GLOBAL);
      writeConfig(project, "opencode.json", VERWEISE);
      const { env } = opencode({ ...BOT_ENV, ...ANBIETER });
      for (const k of Object.keys(ANBIETER)) expect(env[k]).toBeUndefined();
      expect(env.NOTION_TOKEN).toBe("geheim-notion");
    });

    test("mit ausdrücklicher Freigabe vorhanden", () => {
      writeConfig(project, "opencode.json", VERWEISE);
      const { env } = opencode({ ...BOT_ENV, ...ANBIETER, TYBO_SUBPROCESS_ENV_ALLOW: Object.keys(ANBIETER).join(",") });
      for (const [k, v] of Object.entries(ANBIETER)) expect(env[k]).toBe(v);
    });

    test("Einstellungen der Anbieter (Region, Projekt, Konto) sind keine Zugangsdaten", () => {
      expect(isOpenCodeProviderCredential("AWS_REGION")).toBe(false);
      expect(isOpenCodeProviderCredential("CLOUDFLARE_ACCOUNT_ID")).toBe(false);
      expect(isOpenCodeProviderCredential("GOOGLE_VERTEX_PROJECT")).toBe(false);
      expect(isOpenCodeProviderCredential("NOTION_TOKEN")).toBe(false);
      const { env } = opencode({ PATH: "/bin", AWS_REGION: "eu-central-1", CLOUDFLARE_ACCOUNT_ID: "abc" });
      expect(env.AWS_REGION).toBe("eu-central-1");
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("abc");
    });

    test("neuere Anbieter aus OpenCodes models.json und eigene Anbieter aus opencode.json", () => {
      const cache = join(home, ".cache", "opencode");
      writeConfig(cache, "models.json", { neu: { id: "neu", env: ["NEUANBIETER_API_KEY", "NEUANBIETER_REGION"] }, kaputt: { env: "x" } });
      writeConfig(project, "opencode.jsonc", `{
        "provider": { "eigen": { "env": ["EIGEN_ZUGANG"], "options": { "apiKey": "{env:EIGEN_TOKEN}" } } },
        "mcp": { "x": { "environment": { "A": "{env:NEUANBIETER_API_KEY}", "B": "{env:EIGEN_TOKEN}", "C": "{env:NOTION_TOKEN}" } } },
      }`);
      // {env:…} im apiKey zählt seit PR #232 über opencodeProviderCredentialRefs, nicht über die Anbieter-Variablen
      expect([...opencodeProviderVars(configDir, project, cache)].sort()).toEqual(["EIGEN_ZUGANG", "NEUANBIETER_API_KEY", "NEUANBIETER_REGION"]);
      expect(opencodeProviderCredentialRefs(configDir, project).has("EIGEN_TOKEN")).toBe(true);
      const quelle = { ...BOT_ENV, NEUANBIETER_API_KEY: "geheim-neu", NEUANBIETER_REGION: "eu", EIGEN_TOKEN: "geheim-eigen", EIGEN_ZUGANG: "geheim-zugang" };
      const { env } = opencode(quelle);
      expect(env.NEUANBIETER_API_KEY).toBeUndefined();
      expect(env.EIGEN_TOKEN).toBeUndefined();
      expect(env.EIGEN_ZUGANG).toBeUndefined();
      expect(env.NEUANBIETER_REGION).toBe("eu");
      expect(env.NOTION_TOKEN).toBe("geheim-notion");
      // XDG_CACHE_HOME bestimmt den Cache-Ordner
      expect(opencodeCacheDir({ XDG_CACHE_HOME: "/xdg-cache" }, home)).toBe("/xdg-cache/opencode");
      expect(opencodeCacheDir({}, "")).toBe("");
      const freigegeben = opencode({ ...quelle, TYBO_SUBPROCESS_ENV_ALLOW: "NEUANBIETER_API_KEY,EIGEN_TOKEN" }).env;
      expect(freigegeben.NEUANBIETER_API_KEY).toBe("geheim-neu");
      expect(freigegeben.EIGEN_TOKEN).toBe("geheim-eigen");
    });

    describe("Zugangsdaten der Anbieter-SDKs außerhalb von models.dev", () => {
      const MCP_AWS = { mcp: { aws: { type: "local", command: ["aws-mcp"], environment: { T: "{env:AWS_SESSION_TOKEN}" } } } };

      test("Fehlerfall aus dem Review: AWS_SESSION_TOKEN ohne Freigabe entfernt", () => {
        const { env, removed } = opencode({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "", AWS_SESSION_TOKEN: "geheim-session" });
        expect(env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(removed).toContain("AWS_SESSION_TOKEN");
      });

      test("AWS_SESSION_TOKEN trotz MCP-Verweis entfernt", () => {
        writeConfig(configDir, "opencode.json", MCP_AWS);
        const { env, removed } = opencode({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "", AWS_SESSION_TOKEN: "geheim-session" });
        expect(env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(removed).toContain("AWS_SESSION_TOKEN");
      });

      test("mit ausdrücklicher Freigabe vorhanden", () => {
        writeConfig(configDir, "opencode.json", MCP_AWS);
        const { env } = opencode({ ...BOT_ENV, AWS_SESSION_TOKEN: "geheim-session", TYBO_SUBPROCESS_ENV_ALLOW: "AWS_SESSION_TOKEN" });
        expect(env.AWS_SESSION_TOKEN).toBe("geheim-session");
      });

      test("alle SDK-Zugangsdaten zählen, Einstellungen wie AWS_PROFILE nicht", () => {
        for (const k of OPENCODE_SDK_CREDENTIALS) expect(isOpenCodeProviderCredential(k)).toBe(true);
        expect(isOpenCodeProviderCredential("AWS_PROFILE")).toBe(false);
      });
    });

    describe("Verweise in Zugangsdatenfeldern eigener Anbieter", () => {
      const EIGEN = {
        provider: {
          eigen: {
            options: {
              apiKey: "{env:LOGIN_ACCOUNT}",
              headers: { Authorization: "Bearer {env:KOPF_REGION}" },
              accountId: "{env:EIGEN_ACCOUNT_ID}",
              region: "{env:EIGEN_REGION}",
            },
          },
        },
      };

      test("Fehlerfall aus dem Review: apiKey = {env:LOGIN_ACCOUNT} ohne Freigabe entfernt, auch ohne MCP-Verweis", () => {
        writeConfig(project, "opencode.json", EIGEN);
        expect([...opencodeProviderCredentialRefs(configDir, project)].sort()).toEqual(["KOPF_REGION", "LOGIN_ACCOUNT"]);
        const { env, removed } = opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login", KOPF_REGION: "geheim-kopf" });
        expect(env.LOGIN_ACCOUNT).toBeUndefined();
        expect(env.KOPF_REGION).toBeUndefined();
        expect(removed).toContain("LOGIN_ACCOUNT");
        expect(removed).toContain("KOPF_REGION");
      });

      test("trotz MCP-Verweis entfernt, mit Freigabe vorhanden", () => {
        writeConfig(configDir, "opencode.json", { mcp: { x: { environment: { A: "{env:LOGIN_ACCOUNT}" } } } });
        writeConfig(project, "opencode.json", EIGEN);
        expect(opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login" }).env.LOGIN_ACCOUNT).toBeUndefined();
        const frei = opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login", TYBO_SUBPROCESS_ENV_ALLOW: "LOGIN_ACCOUNT" });
        expect(frei.env.LOGIN_ACCOUNT).toBe("geheim-login");
      });

      describe("Fehlerfall aus dem Review (PR #232): provider.<x>.env nennt den Schlüssel", () => {
        const ENV_LISTE = { provider: { openrouter: { env: ["LOGIN_ACCOUNT"] } } };
        test("ohne Freigabe entfernt, auch ohne MCP-Verweis", () => {
          writeConfig(project, "opencode.json", ENV_LISTE);
          expect(opencodeProviderCredentialRefs(configDir, project).has("LOGIN_ACCOUNT")).toBe(true);
          const { env, removed } = opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login" });
          expect(env.LOGIN_ACCOUNT).toBeUndefined();
          expect(removed).toContain("LOGIN_ACCOUNT");
        });
        test("trotz MCP-Verweis entfernt, mit ausdrücklicher Freigabe vorhanden", () => {
          writeConfig(configDir, "opencode.json", { mcp: { x: { environment: { A: "{env:LOGIN_ACCOUNT}" } } } });
          writeConfig(project, "opencode.json", ENV_LISTE);
          expect(opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login" }).env.LOGIN_ACCOUNT).toBeUndefined();
          const frei = opencode({ ...BOT_ENV, LOGIN_ACCOUNT: "geheim-login", TYBO_SUBPROCESS_ENV_ALLOW: "LOGIN_ACCOUNT" });
          expect(frei.env.LOGIN_ACCOUNT).toBe("geheim-login");
        });
        test("Region- und Kontoeinstellungen außerhalb der Liste bleiben erlaubt", () => {
          writeConfig(project, "opencode.json", ENV_LISTE);
          const { env } = opencode({ PATH: "/bin", AWS_REGION: "eu-central-1", CLOUDFLARE_ACCOUNT_ID: "abc" });
          expect(env.AWS_REGION).toBe("eu-central-1");
          expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("abc");
        });
      });

      test("echte Region- und Kontoeinstellungen bleiben erlaubt", () => {
        writeConfig(project, "opencode.json", EIGEN);
        const { env } = opencode({
          PATH: "/bin",
          EIGEN_ACCOUNT_ID: "konto-1",
          EIGEN_REGION: "eu",
          AWS_REGION: "eu-central-1",
          CLOUDFLARE_ACCOUNT_ID: "abc",
          GOOGLE_VERTEX_LOCATION: "europe-west4",
        });
        expect(env.EIGEN_ACCOUNT_ID).toBe("konto-1");
        expect(env.EIGEN_REGION).toBe("eu");
        expect(env.AWS_REGION).toBe("eu-central-1");
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("abc");
        expect(env.GOOGLE_VERTEX_LOCATION).toBe("europe-west4");
      });
    });

    describe("zusätzliche Konfigurationsquellen: Umgebung, übergeordnete Ordner, .opencode, config.json", () => {
      const LOGIN = { provider: { openrouter: { options: { apiKey: "{env:LOGIN_ACCOUNT}" } } } };
      const CUSTOM = { provider: { eigen: { env: ["CUSTOM_PROVIDER_TOKEN"] } } };
      const MCP = { mcp: { x: { environment: { A: "{env:LOGIN_ACCOUNT}", B: "{env:CUSTOM_PROVIDER_TOKEN}" } } } };
      const SECRETS = { LOGIN_ACCOUNT: "geheim-login", CUSTOM_PROVIDER_TOKEN: "geheim-custom" };

      /**
       * Je Quelle: legt die Anbieter-Konfiguration ab und liefert die Variablen,
       * die sie setzen, sowie das Arbeitsverzeichnis (sonst `project`)
       */
      function sources(): Record<string, (cfg: object) => { extra: Record<string, string>; cwd?: string }> {
        return {
          OPENCODE_CONFIG_CONTENT: cfg => ({ extra: { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) } }),
          OPENCODE_CONFIG: cfg => {
            const dir = tmp();
            writeConfig(dir, "eigene.jsonc", cfg);
            return { extra: { OPENCODE_CONFIG: join(dir, "eigene.jsonc") } };
          },
          OPENCODE_CONFIG_DIR: cfg => {
            const dir = tmp();
            writeConfig(dir, "opencode.json", cfg);
            return { extra: { OPENCODE_CONFIG_DIR: dir } };
          },
          "<projekt>/.opencode/opencode.json": cfg => {
            writeConfig(join(project, ".opencode"), "opencode.json", cfg);
            return { extra: {} };
          },
          "<projekt>/.opencode/opencode.jsonc": cfg => {
            writeConfig(join(project, ".opencode"), "opencode.jsonc", cfg);
            return { extra: {} };
          },
          "opencode.json im übergeordneten Ordner": cfg => {
            writeConfig(project, "opencode.json", cfg);
            const cwd = join(project, "unter", "ordner");
            mkdirSync(cwd, { recursive: true });
            return { extra: {}, cwd };
          },
          "opencode.jsonc im übergeordneten Ordner": cfg => {
            writeConfig(project, "opencode.jsonc", cfg);
            const cwd = join(project, "unter");
            mkdirSync(cwd, { recursive: true });
            return { extra: {}, cwd };
          },
          ".opencode im übergeordneten Ordner": cfg => {
            writeConfig(join(project, ".opencode"), "opencode.json", cfg);
            const cwd = join(project, "unter");
            mkdirSync(cwd, { recursive: true });
            return { extra: {}, cwd };
          },
          "~/.opencode/opencode.json": cfg => {
            writeConfig(join(home, ".opencode"), "opencode.json", cfg);
            return { extra: {} };
          },
          "~/.opencode/opencode.jsonc": cfg => {
            writeConfig(join(home, ".opencode"), "opencode.jsonc", cfg);
            return { extra: {} };
          },
          "<Konfigurationsordner>/config.json": cfg => {
            writeConfig(configDir, "config.json", cfg);
            return { extra: {} };
          },
        };
      }
      const merged = { provider: { ...LOGIN.provider, ...CUSTOM.provider } };

      for (const [name, set] of Object.entries(sources())) {
        test(`${name}: Fehlerfall aus dem Review, ohne Freigabe entfernt`, () => {
          const { extra, cwd = project } = set(merged);
          // provider.<x>.env zählt seit PR #232 ebenfalls als Zugangsdatum
          expect([...opencodeProviderCredentialRefs(configDir, cwd, extra, home)].sort()).toEqual(["CUSTOM_PROVIDER_TOKEN", "LOGIN_ACCOUNT"]);
          expect(opencodeProviderVars(configDir, cwd, "", extra, home).has("CUSTOM_PROVIDER_TOKEN")).toBe(true);
          const { env, removed } = opencode({ ...BOT_ENV, ...SECRETS, ...extra, TYBO_SUBPROCESS_ENV_ALLOW: "" }, { cwd });
          expect(env.LOGIN_ACCOUNT).toBeUndefined();
          expect(env.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
          expect(removed).toContain("LOGIN_ACCOUNT");
          expect(removed).toContain("CUSTOM_PROVIDER_TOKEN");
          // Die Quelle selbst bleibt: sie enthält nur Verweise, OpenCode braucht sie
          for (const [k, v] of Object.entries(extra)) expect(env[k]).toBe(v);
        });

        test(`${name}: trotz MCP-Verweis entfernt`, () => {
          writeConfig(configDir, "opencode.json", MCP);
          const { extra, cwd = project } = set(merged);
          const { env } = opencode({ ...BOT_ENV, ...SECRETS, ...extra }, { cwd });
          expect(env.LOGIN_ACCOUNT).toBeUndefined();
          expect(env.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
        });

        test(`${name}: mit ausdrücklicher Freigabe vorhanden`, () => {
          writeConfig(configDir, "opencode.json", MCP);
          const { extra, cwd = project } = set(merged);
          const { env } = opencode(
            { ...BOT_ENV, ...SECRETS, ...extra, TYBO_SUBPROCESS_ENV_ALLOW: "LOGIN_ACCOUNT,CUSTOM_PROVIDER_TOKEN" },
            { cwd },
          );
          expect(env.LOGIN_ACCOUNT).toBe("geheim-login");
          expect(env.CUSTOM_PROVIDER_TOKEN).toBe("geheim-custom");
        });

        test(`${name}: MCP-Einträge dort geben nichts frei`, () => {
          const { extra, cwd = project } = set({ mcp: { y: { environment: { N: "{env:NOTION_TOKEN}" } } } });
          const { env } = opencode({ ...BOT_ENV, ...extra }, { cwd });
          expect(env.NOTION_TOKEN).toBeUndefined();
        });
      }

      test("relativer OPENCODE_CONFIG gilt vom Arbeitsverzeichnis aus; defekte oder fehlende Quellen tragen nichts bei", () => {
        writeConfig(join(project, "cfg"), "oc.json", LOGIN);
        expect([...opencodeProviderCredentialRefs(configDir, project, { OPENCODE_CONFIG: "cfg/oc.json" })]).toEqual(["LOGIN_ACCOUNT"]);
        const kaputt = { OPENCODE_CONFIG_CONTENT: "{kaputt", OPENCODE_CONFIG: join(project, "fehlt.json"), OPENCODE_CONFIG_DIR: join(project, "fehlt") };
        expect([...opencodeProviderCredentialRefs(configDir, project, kaputt)]).toEqual([]);
        expect(opencode({ PATH: "/bin", ...kaputt }).env.PATH).toBe("/bin");
      });
    });

    test("Claude und Codex bleiben unverändert", () => {
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { cf: { env: { T: "${CLOUDFLARE_API_TOKEN}" } } } }));
      const claude = filterSubprocessEnv({ env: { ...BOT_ENV, ...ANBIETER }, cwd: project, home, engine: "claude" });
      expect(claude.env.CLOUDFLARE_API_TOKEN).toBe("geheim-cloudflare");
      expect(claude.env.AWS_ACCESS_KEY_ID).toBe("geheim-aws-id");
    });
  });

  test("XDG_CONFIG_HOME aus der Quelle bestimmt den Konfigurationsordner", () => {
    const xdg = tmp();
    writeConfig(join(xdg, "opencode"), "opencode.json", { mcp: { n: { environment: { T: "{env:NOTION_TOKEN}" } } } });
    expect(opencode(BOT_ENV).env.NOTION_TOKEN).toBeUndefined();
    expect(opencode({ ...BOT_ENV, XDG_CONFIG_HOME: xdg }).env.NOTION_TOKEN).toBe("geheim-notion");
  });

  test("Claude und Codex bleiben unverändert: Claude behält ANTHROPIC_API_KEY, OpenCode nicht", () => {
    const claude = filterSubprocessEnv({ env: BOT_ENV, cwd: project, home, engine: "claude" });
    expect(claude.env.ANTHROPIC_API_KEY).toBe("geheim-anthropic");
    expect(opencode(BOT_ENV).env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("Log nennt OpenCode und nur Namen, nie Werte", () => {
    const lines: string[] = [];
    setSubprocessEnvLoggerForTests((l) => lines.push(l));
    try {
      writeConfig(configDir, "opencode.json", GLOBAL);
      logSubprocessEnvFilter({ env: BOT_ENV, cwd: project, home, engine: "opencode" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("OpenCode-Subprozesse erben");
      expect(lines[0]).toContain("OPENROUTER_API_KEY");
      expect(lines[0]).not.toContain("NOTION_TOKEN");
      expect(lines[0]).not.toContain("geheim");
    } finally {
      setSubprocessEnvLoggerForTests(null);
    }
  });
});

describe("Aufruf mit Spawn-Attrappe", () => {
  const KEYS = ["XDG_CONFIG_HOME", "NOTION_TOKEN", "TELEGRAM_BOT_TOKEN", "WEB_PASSWORD", "OPENROUTER_API_KEY", "TYBO_SUBPROCESS_ENV_ALLOW"];
  const saved: Record<string, string | undefined> = {};
  let errSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    setSettingsPath(join(project, "keine-einstellungen.json"));
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setSettingsPath();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("Akzeptanz: der Lauf bekommt die referenzierte Variable, aber weder TELEGRAM_BOT_TOKEN noch WEB_PASSWORD noch den Anbieter-Schlüssel", async () => {
    const xdg = tmp();
    writeConfig(join(xdg, "opencode"), "opencode.json", GLOBAL);
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.NOTION_TOKEN = "erfunden-notion";
    process.env.TELEGRAM_BOT_TOKEN = "erfunden-telegram";
    process.env.WEB_PASSWORD = "erfunden-web";
    process.env.OPENROUTER_API_KEY = "erfunden-openrouter";
    const fake = installOpenCodeFake();
    try {
      fake.next({ events: oc.reply("ses_x", "ok") });
      const r = await createOpenCodeEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, cwd: project });
      expect(r.isError).toBe(false);
      const env = fake.spawns.at(-1)!.env!;
      expect(env.NOTION_TOKEN).toBe("erfunden-notion");
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.WEB_PASSWORD).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.PWD).toBe(project);
    } finally {
      fake.restore();
    }
    // opencodeEnv ohne Lauf: dasselbe Ergebnis
    const env = opencodeEnv(project);
    expect(env.NOTION_TOKEN).toBe("erfunden-notion");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});
