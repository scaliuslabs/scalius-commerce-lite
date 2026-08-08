import { describe, expect, it, vi } from "vitest";

import {
  collectRepositoryHygieneFailures,
  isSecretBearingEnvPath,
} from "./repository-hygiene.mjs";

describe("repository hygiene", () => {
  it("blocks environment secrets while allowing explicit templates", () => {
    expect(isSecretBearingEnvPath(".env.production")).toBe(true);
    expect(isSecretBearingEnvPath("apps/api/.env.staging")).toBe(true);
    expect(isSecretBearingEnvPath("apps/api/.dev.vars.production")).toBe(true);
    expect(isSecretBearingEnvPath("apps/api/.dev.vars")).toBe(true);
    expect(isSecretBearingEnvPath("apps/api/.dev.vars.example")).toBe(false);
    expect(isSecretBearingEnvPath("apps/storefront/.env.development.example")).toBe(false);
  });

  it("reports a force-tracked secret without attempting to read it", () => {
    const readText = vi.fn(() => "");
    expect(collectRepositoryHygieneFailures([
      "apps/api/.env.production",
      "apps/api/.dev.vars.example",
    ], { readText })).toEqual([
      "apps/api/.env.production: secret-bearing environment file must not be tracked",
    ]);
    expect(readText).not.toHaveBeenCalled();
  });
});
