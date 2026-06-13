import { describe, expect, it } from "vitest";
import {
  assertLocalSecretSync,
  collectLocalSecretSyncIssues,
  getArgValue,
  parseEnvFileContent,
  resolveLocalStatePath,
  resolveSharedLocalSecrets,
} from "./dev-local-utils.mjs";

describe("local dev script helpers", () => {
  it("parses simple .dev.vars files without leaking comments into values", () => {
    expect(parseEnvFileContent(`
      # comment
      export API_TOKEN=api-token # trailing note
      JWT_SECRET="jwt-secret"
      EMPTY=
    `)).toEqual({
      API_TOKEN: "api-token",
      JWT_SECRET: "jwt-secret",
      EMPTY: "",
    });
  });

  it("reuses existing API secrets when generating missing local env files", () => {
    const secrets = resolveSharedLocalSecrets({
      apiVars: {
        BETTER_AUTH_SECRET: "auth-secret",
        JWT_SECRET: "jwt-secret",
        API_TOKEN: "api-token",
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
        PURGE_TOKEN: "purge-token",
      },
      env: {},
    });

    expect(secrets).toEqual({
      betterAuthSecret: "auth-secret",
      jwtSecret: "jwt-secret",
      apiToken: "api-token",
      purgeToken: "purge-token",
      credentialEncryptionKey: "credential-key",
    });
  });

  it("reports shared-secret drift without including secret values", () => {
    const issues = collectLocalSecretSyncIssues({
      apiVars: { JWT_SECRET: "api-jwt", API_TOKEN: "same-token" },
      adminVars: { JWT_SECRET: "admin-jwt", API_TOKEN: "same-token" },
      storefrontVars: { JWT_SECRET: "api-jwt", API_TOKEN: "same-token", PURGE_TOKEN: "purge" },
    });

    expect(issues).toContain("JWT_SECRET differs between local .dev.vars files");
    expect(issues.join("\n")).not.toContain("api-jwt");
    expect(issues.join("\n")).not.toContain("admin-jwt");
  });

  it("resolves relative Wrangler state paths from the repo root", () => {
    expect(resolveLocalStatePath("/repo", "tmp/state")).toBe("/repo/tmp/state");
    expect(resolveLocalStatePath("/repo", "/tmp/state")).toBe("/tmp/state");
  });

  it("rejects missing values for value-style CLI flags", () => {
    expect(() => getArgValue(["--admin-password"], "--admin-password")).toThrow(
      /requires a value/,
    );
    expect(() =>
      getArgValue(["--admin-password", "--skip-admin"], "--admin-password"),
    ).toThrow(/requires a value/);
  });

  it("points shared-secret drift repair at env-only setup", () => {
    expect(() => assertLocalSecretSync({
      apiVars: { JWT_SECRET: "api-jwt" },
      adminVars: { JWT_SECRET: "admin-jwt" },
      storefrontVars: { JWT_SECRET: "api-jwt" },
    })).toThrow(/pnpm dev:setup --force --env-only/);
  });
});
