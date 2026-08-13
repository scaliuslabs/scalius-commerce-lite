import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./agent-access.service.ts", import.meta.url), "utf8");

describe("agent access management commit-time authority", () => {
  it("guards child credential creation against parent revocation at commit", () => {
    expect(source).toContain("AGENT_PARENT_AUTHORITY_INACTIVE");
    expect(source).toContain("parent_grant.status = 'active'");
    expect(source).toContain("parent_grant.expires_at > unixepoch()");
    expect(source).toContain("parent_credential.revoked_at IS NULL");
    expect(source).toContain("parent_credential.expires_at > unixepoch()");
    expect(source).toContain("parent_grant.kind = 'oauth'");
    expect(source).toContain("parent_grant.owner_user_id = ${input.parentAuthority.ownerUserId}");
    expect(source).toContain("parent_grant.resource = ${input.parentAuthority.resource}");
    expect(source).toContain("parent_grant.authority_revision = ${input.parentAuthority.authorityRevision}");
    expect(source.indexOf("...(parentGuard ? [parentGuard] : [])")).toBeLessThan(
      source.indexOf("grantInsert,\n    credentialInsert"),
    );
  });

  it("requires a monotonic grant authority CAS for narrowing", () => {
    expect(source).toContain("authorityRevision");
    expect(source).toContain("AGENT_GRANT_AUTHORITY_CHANGED");
  });
});
