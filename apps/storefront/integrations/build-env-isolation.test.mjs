import { describe, expect, it } from "vitest";

import { isLocalEnvFileName, restrictImportMetaEnv } from "./build-env-isolation.mjs";

describe("restrictImportMetaEnv", () => {
  it("keeps the built-in keys and turns every other key into undefined", () => {
    expect(restrictImportMetaEnv("if (import.meta.env.SSR && import.meta.env.DEV) f(import.meta.env.BASE_URL);"))
      .toBe("if (import.meta.env.SSR && import.meta.env.DEV) f(import.meta.env.BASE_URL);");
    expect(restrictImportMetaEnv("const s = import.meta.env.SCALIUS_SECRET ?? import.meta.env.PUBLIC_API_URL;"))
      .toBe("const s = undefined ?? undefined;");
  });

  it("replaces a bare import.meta.env, even in a comment, with the built-in keys only", () => {
    const out = restrictImportMetaEnv("// reads import.meta.env\nconst keys = Object.keys(import.meta.env); import.meta.env?.MODE;");
    expect(out).not.toMatch(/import\.meta\.env(?!\.(?:ASSETS_PREFIX|BASE_URL|DEV|MODE|PROD|SITE|SSR)\b)/);
    expect(out).toContain("Object.keys(({ASSETS_PREFIX:import.meta.env.ASSETS_PREFIX,");
    expect(out).toContain("SSR:import.meta.env.SSR})?.MODE");
  });
});

describe("isLocalEnvFileName", () => {
  it("matches .dev.vars and .env files only", () => {
    for (const name of [".dev.vars", ".dev.vars.production", ".env", ".env.production.local"]) {
      expect(isLocalEnvFileName(name)).toBe(true);
    }
    for (const name of ["entry.mjs", "wrangler.json", "env.mjs", ".assetsignore"]) {
      expect(isLocalEnvFileName(name)).toBe(false);
    }
  });
});
