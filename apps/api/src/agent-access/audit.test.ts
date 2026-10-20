import { describe, expect, it, vi } from "vitest";
import { writeAgentAuditEvent } from "./audit";

describe("safe agent audit metadata", () => {
  it("persists only code-owned non-sensitive metadata keys", async () => {
    const auditStatement = { kind: "audit" };
    const values = vi.fn(() => ({ onConflictDoNothing: () => auditStatement }));
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
      id: expect.stringMatching(/^aae_[0-9a-f]{20}$/),
      metadataJson: JSON.stringify({ resultCount: 2, transport: "json", rollup: "hour" }),
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

  it("records every write as its own row and rolls successful reads up per principal, operation and hour", async () => {
    const inserted: Array<{ id: string; ignored: boolean }> = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((row: { id: string }) => {
          const statement = { id: row.id, ignored: false };
          inserted.push(statement);
          return Object.assign(statement, { onConflictDoNothing: () => Object.assign(statement, { ignored: true }) });
        }),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({})) })) })),
      batch: vi.fn().mockResolvedValue([]),
    };
    const call = (operationId: string, risk: "read" | "write", outcome: "success" | "denied" = "success", grantId = "agr_0123456789abcdefghij") =>
      writeAgentAuditEvent(db as never, { grantId, operationId, risk, outcome });
    await call("dashboard.products.list", "read");
    await call("dashboard.products.list", "read");
    await call("dashboard.products.list", "read", "success", "agr_other0123456789abcd");
    await call("dashboard.products.list", "read", "denied");
    await call("dashboard.products.update", "write");
    await call("dashboard.products.update", "write");
    const [first, again, otherGrant, denied, write, secondWrite] = inserted;
    // The hour's reads share one row id (insert-or-ignore); another principal has its own.
    expect(first!.ignored && again!.ignored).toBe(true);
    expect(again!.id).toBe(first!.id);
    expect(otherGrant!.id).not.toBe(first!.id);
    // Denials and writes are recorded one row per call.
    for (const row of [denied, write, secondWrite]) {
      expect(row!.ignored).toBe(false);
      expect(row!.id).toMatch(/^aae_/);
    }
    expect(secondWrite!.id).not.toBe(write!.id);
  });
});
