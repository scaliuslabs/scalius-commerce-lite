import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

describe("Agent Access UI security boundaries", () => {
  it("keeps raw tokens in one-time component state and out of browser persistence", () => {
    const combined = [
      "AgentAccessSettingsPage.tsx",
      "ConnectionDetails.tsx",
      "CreateTokenDialog.tsx",
      "PurgeRevokedDialog.tsx",
      "OneTimeSecretDialog.tsx",
      "AuthorizationApprovalPage.tsx",
      "DevicePairingPage.tsx",
    ]
      .map(source)
      .join("\n");

    expect(combined).not.toContain("localStorage");
    expect(combined).not.toContain("sessionStorage");
    expect(combined).not.toContain("URLSearchParams");
    expect(combined).not.toContain("console.log");
    expect(source("OneTimeSecretDialog.tsx")).toContain(
      "This is the last time Scalius displays the complete token.",
    );
  });

  it("requires pairing codes in a body-backed form instead of URL state", () => {
    const pairing = source("DevicePairingPage.tsx");
    const api = source("api.ts");

    expect(pairing).toContain('autoComplete="off"');
    expect(pairing).toContain("normalizeUserCode");
    expect(pairing).not.toContain("useSearch");
    expect(api).toContain('{ userCode }');
    expect(api).not.toContain("?userCode");
  });

  it("offers full automation while preserving explicit narrowing and revocation", () => {
    expect(source("types.ts")).toContain('label: "Full automation"');
    expect(source("ConnectionDetails.tsx")).toContain("Narrow connection access");
    expect(source("RevokeDialog.tsx")).toContain("Reason (optional)");
  });

  it("hides revoked and expired connections by default while keeping explicit filters", () => {
    const settings = source("AgentAccessSettingsPage.tsx");

    expect(settings).toContain('const DEFAULT_STATUS: StatusFilter = "current"');
    expect(settings).toContain("useState<StatusFilter>(DEFAULT_STATUS)");
    expect(settings).toContain('<SelectItem value="current">Current</SelectItem>');
    expect(settings).toContain('<SelectItem value="revoked">Revoked</SelectItem>');
    expect(settings).toContain('<SelectItem value="expired">Expired</SelectItem>');
    expect(settings).toContain("<SelectItem value={ALL}>All statuses</SelectItem>");
    // Clearing filters returns to the clean default, not to "all".
    expect(settings).not.toContain("setStatus(ALL);\n                  setKind(ALL);");
    expect(settings).toContain("setStatus(DEFAULT_STATUS);");
  });

  it("offers a confirmed, permission-gated purge that is disabled when nothing is clearable", () => {
    const settings = source("AgentAccessSettingsPage.tsx");
    const dialog = source("PurgeRevokedDialog.tsx");

    expect(settings).toContain("<PurgeRevokedDialog");
    expect(settings).toContain("disabled={!canManage}");
    expect(settings).toContain("agentClearableConnectionsQueryOptions()");
    expect(settings).toContain("await invalidateConnections(queryClient);");
    expect(dialog).toContain("disabled={disabled || pending || nothingToClear}");
    expect(dialog).toContain("const nothingToClear = clearable === undefined || total === 0;");
    expect(dialog).toContain("Permanently delete revoked and expired connections?");
    expect(dialog).toContain("audit history");
    expect(dialog).toContain("cannot be undone");
    expect(dialog).toContain("Active and pending connections are not affected.");
  });

  it("uses the dashboard permission registry for view and management gates", () => {
    const settings = source("AgentAccessSettingsPage.tsx");
    const route = readFileSync(
      join(DIR, "../../../routes/admin/settings/agent-access.tsx"),
      "utf8",
    );
    const permissions = readFileSync(
      join(DIR, "../../../lib/admin-permissions.ts"),
      "utf8",
    );

    expect(permissions).toContain('AGENT_ACCESS_VIEW: "agent_access.view"');
    expect(permissions).toContain('AGENT_ACCESS_MANAGE: "agent_access.manage"');
    expect(settings).toContain("canManage: boolean");
    expect(route).toContain("ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE");
    expect(route).toContain("context.isSuperAdmin &&");
  });
});
