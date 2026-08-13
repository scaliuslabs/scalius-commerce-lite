import { describe, expect, it, vi } from "vitest";
import { writeAgentAuditEvent } from "./audit";

describe("safe agent audit metadata", () => {
  it("persists only code-owned non-sensitive metadata keys", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) };

    await writeAgentAuditEvent(db as never, {
      grantId: "agr_0123456789abcdefghij",
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
  });
});
