import { describe, expect, it, vi } from "vitest";
import { writeAgentAuditEvent } from "./audit";

describe("safe agent audit metadata", () => {
  it("persists only code-owned non-sensitive metadata keys", async () => {
    const auditStatement = { kind: "audit" };
    const values = vi.fn(() => auditStatement);
    const grantStatement = { kind: "grant" };
    const credentialStatement = { kind: "credential" };
    const where = vi.fn()
      .mockReturnValueOnce(grantStatement)
      .mockReturnValueOnce(credentialStatement);
    const set = vi.fn(() => ({ where }));
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      insert: vi.fn(() => ({ values })),
      update: vi.fn(() => ({ set })),
      batch,
    };

    await writeAgentAuditEvent(db as never, {
      grantId: "agr_0123456789abcdefghij",
      credentialId: "agc_0123456789abcdefghij",
      operationId: "dashboard.products.list",
      risk: "read",
      outcome: "success",
      metadata: {
        resultCount: 2,
        transport: "json",
        token: "sc_pat_secret",
        customerEmail: "buyer@example.com",
        receiptProof: "chk_secret",
        inputBody: "private",
      },
      resourceIds: [
        "prod_0123456789abcdefghij",
        "chk_receipt-proof",
        "cst_status-proof",
        "sc_pat_secret",
        "buyer@example.com",
      ],
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      metadataJson: JSON.stringify({ resultCount: 2, transport: "json" }),
      resourceIdsJson: JSON.stringify(["prod_0123456789abcdefghij"]),
    }));
    const serialized = JSON.stringify(values.mock.calls[0]);
    expect(serialized).not.toContain("buyer@example.com");
    expect(serialized).not.toContain("sc_pat_secret");
    expect(serialized).not.toContain("chk_secret");
    expect(batch).toHaveBeenCalledWith([
      auditStatement,
      grantStatement,
      credentialStatement,
    ]);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      lastUsedAt: expect.any(Date),
      lastOperationId: "dashboard.products.list",
      updatedAt: expect.any(Date),
    }));
  });

  it("records unauthenticated denials without updating grant usage", async () => {
    const auditStatement = { kind: "audit" };
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => auditStatement) })),
      update: vi.fn(),
      batch,
    };

    await writeAgentAuditEvent(db as never, {
      grantId: null,
      operationId: "system.agent_access.authenticate",
      risk: "security",
      outcome: "denied",
      httpStatus: 401,
    });

    expect(batch).toHaveBeenCalledWith([auditStatement]);
    expect(db.update).not.toHaveBeenCalled();
  });
});
