import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(
  new URL("../routes/admin/agent-access.ts", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL(
    "../../../../packages/core/src/modules/agent-access/agent-access.service.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("one-time agent credential lifecycle", () => {
  it("returns create/rotate secrets once while persistence receives only hash and hint", () => {
    expect(routeSource.match(/token: issued\.token/g)).toHaveLength(2);
    expect(routeSource).toContain("tokenHash: issued.tokenHash");
    expect(routeSource).toContain("tokenHint: issued.tokenHint");
    expect(serviceSource).toContain("tokenHash: input.issued.tokenHash");
    expect(serviceSource).toContain("tokenHint: input.issued.tokenHint");
    expect(serviceSource).not.toContain("input.issued.token,");
    expect(serviceSource).not.toContain("token: input.issued");
  });

  it("keeps later connection reads hint-only and every management response no-store", () => {
    expect(serviceSource).toContain("tokenHint: agentCredentials.tokenHint");
    expect(serviceSource).not.toContain("tokenHash: agentCredentials.tokenHash");
    expect(routeSource).toContain('app.use("*"');
    expect(routeSource).toContain('c.header("Cache-Control", "private, no-store")');
  });

  it("does not log or audit response bodies or raw credentials", () => {
    expect(routeSource).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(serviceSource).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(routeSource).not.toMatch(/metadata:\s*[^\n]*(?:token|body)/i);
  });
});
