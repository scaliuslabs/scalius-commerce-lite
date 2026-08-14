import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./agent-access.ts", import.meta.url), "utf8");

describe("agent access management route boundaries", () => {
  it("scopes agent list totals, detail, and audit reads to owner and resource", () => {
    expect(source).toContain("...getAgentConnectionListScope(principal)");
    expect(source.match(/assertAgentConnectionScope\(connection, c\.get\("agentPrincipal"\)\)/g)).toHaveLength(2);
  });

  it("prevents credential/grant pivots on self mutations", () => {
    expect(source).toContain("principal.credentialId !== c.req.valid(\"param\").credentialId");
    expect(source).toContain("current.grantId !== principal.grantId");
    expect(source.match(/principal\.grantId !== c\.req\.valid\("param"\)\.grantId/g)).toHaveLength(2);
  });

  it("creates subordinate grants from the live principal rather than synthetic super-admin authority", () => {
    expect(source).toContain("principal?.permissions ?? c.get(\"adminPermissions\")");
    expect(source).toContain("assertSubordinateGrantSelection(selection, principal)");
    expect(source).toContain("body.resource !== principal.resource");
  });

  it("keeps consent, device decisions, and revoke-all browser-session-only", () => {
    const browserOnlyCalls = source.match(/assertSuperAdmin\(c\)/g) ?? [];
    expect(browserOnlyCalls.length).toBeGreaterThanOrEqual(7);
    expect(source).toContain("user.twoFactorEnabled !== true");
    expect(source).toContain("session?.twoFactorVerified !== true");
    expect(source).toContain("Agent access management requires a 2FA-verified Super Admin session");
  });

  it("requires live 2FA for both browser and internal-agent mutations", () => {
    expect(source).toContain("if (!principal.isSuperAdmin)");
    expect(source).toContain("user.twoFactorEnabled !== true");
    expect(source).toContain("session?.twoFactorVerified !== true");
    expect(source).toContain("assertSuperAdmin(c);");
  });

  it("keeps sensitive browser handoffs human-only and reauthorizes the source operation", () => {
    expect(source).toContain("Secure browser handoffs require the same 2FA-verified dashboard session");
    expect(source).toContain("c.get(\"agentPrincipal\")");
    expect(source).toContain("principal.authorityRevision !== claimed.authorityRevision");
    expect(source).toContain("operation.exposure !== \"continuation\"");
    expect(source).toContain("operation.sensitiveOutput !== true");
    expect(source).toContain("authorizeOperation(principal, operation, c.env)");
  });
});
