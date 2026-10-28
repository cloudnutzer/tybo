import { describe, expect, test } from "bun:test";
import { loadWebConfig } from "../src/web/config";

const PW = "richtig-langes-pw";

describe("loadWebConfig", () => {
  test("ohne WEB_ENABLED ist die WebUI aus", () => {
    expect(loadWebConfig({})).toEqual({ status: "disabled" });
    expect(loadWebConfig({ WEB_ENABLED: "false", WEB_PASSWORD: PW })).toEqual({ status: "disabled" });
    expect(loadWebConfig({ WEB_ENABLED: "1", WEB_PASSWORD: PW })).toEqual({ status: "disabled" });
  });

  test("aktiviert ohne Passwort startet nicht", () => {
    const r = loadWebConfig({ WEB_ENABLED: "true" });
    expect(r.status).toBe("invalid");
    expect(loadWebConfig({ WEB_ENABLED: "true", WEB_PASSWORD: "" }).status).toBe("invalid");
  });

  test("Passwort kürzer als 12 Zeichen startet nicht, ohne das Passwort zu nennen", () => {
    const r = loadWebConfig({ WEB_ENABLED: "true", WEB_PASSWORD: "elf-zeichen" });
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(r.reason).not.toContain("elf-zeichen");
    expect(loadWebConfig({ WEB_ENABLED: "true", WEB_PASSWORD: "zwoelf-zeich" }).status).toBe("ok");
  });

  test("ungültiger Port startet nicht", () => {
    for (const WEB_PORT of ["0", "65536", "abc", "-1", "31.5", "3100x", "999999"]) {
      expect(loadWebConfig({ WEB_ENABLED: "true", WEB_PASSWORD: PW, WEB_PORT }).status).toBe("invalid");
    }
  });

  test("Standardwerte", () => {
    expect(loadWebConfig({ WEB_ENABLED: "true", WEB_PASSWORD: PW })).toEqual({
      status: "ok",
      config: { host: "127.0.0.1", port: 3100, password: PW, allowedHosts: [], publicOrigin: null, access: null },
    });
  });

  test("übernimmt Host, Port und erlaubte Hosts", () => {
    const r = loadWebConfig({
      WEB_ENABLED: " TRUE ", WEB_PASSWORD: PW, WEB_HOST: "0.0.0.0", WEB_PORT: "3199",
      WEB_ALLOWED_HOSTS: " Mac.local , ,tybo.home ",
    });
    expect(r).toEqual({
      status: "ok",
      config: { host: "0.0.0.0", port: 3199, password: PW, allowedHosts: ["mac.local", "tybo.home"], publicOrigin: null, access: null },
    });
  });
});
