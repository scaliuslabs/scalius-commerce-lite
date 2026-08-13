import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./storefront-agent-contexts.ts", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(
  fileURLToPath(new URL("../app.ts", import.meta.url)),
  "utf8",
);

describe("storefront agent context security boundaries", () => {
  it("requires a storefront agent principal and grant ownership", () => {
    expect(source).toContain('principal.resource !== "storefront"');
    expect(source).toContain("principal.grantId");
    expect(source).not.toContain("X-Receipt-Token");
    expect(source).not.toContain("X-Customer-Session");
    expect(source).toContain("maximumExpiresAt: principal.expiresAt");
  });

  it("mounts the agent middleware before exposing the route", () => {
    const middleware = 'app.use("/storefront/agent-contexts/*", agentPrincipalMiddleware)';
    const route = 'app.route("/storefront/agent-contexts", storefrontAgentContextRoutes)';
    expect(appSource).toContain(middleware);
    expect(appSource).toContain(route);
    expect(appSource.indexOf(middleware)).toBeLessThan(appSource.indexOf(route));
  });

  it("keeps every response private and excludes checkout/payment secret terms", () => {
    expect(source).toContain('Cache-Control", "private, no-store"');
    expect(source).not.toMatch(/receiptToken|statusToken|checkoutToken|clientSecret|cs_tok|chk_|cst_/);
  });
});
