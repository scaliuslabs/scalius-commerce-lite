import { describe, expect, it } from "vitest";
import { AdminApiResponseError } from "../../../lib/admin-api-error";
import {
  executeManualOrderCreateWithRecovery,
  planManualOrderCreateRecovery,
} from "./manual-order-create-recovery";

function mismatch(
  state: "failed" | "processing" | "committed",
  options: { orderId?: string; canRetryWithNewKey?: boolean } = {},
) {
  return new AdminApiResponseError(
    "Manual-order request mismatch",
    409,
    "ADMIN_ORDER_CREATE_REQUEST_MISMATCH",
    {
      state,
      canRetryWithNewKey: options.canRetryWithNewKey ?? state === "failed",
      ...(options.orderId ? { orderId: options.orderId } : {}),
    },
  );
}

describe("manual order create recovery plan", () => {
  it("retries corrected details once with a fresh request key", () => {
    expect(planManualOrderCreateRecovery(mismatch("failed"), false)).toEqual({
      action: "retry-with-new-key",
    });
    expect(planManualOrderCreateRecovery(mismatch("failed"), true)).toEqual({
      action: "surface-error",
    });
  });

  it("opens the already committed order instead of risking a duplicate", () => {
    expect(planManualOrderCreateRecovery(
      mismatch("committed", { orderId: "01ABCDEF23456789" }),
      false,
    )).toEqual({
      action: "open-existing",
      orderId: "01ABCDEF23456789",
    });
  });

  it("preserves the form while an earlier request is still processing", () => {
    expect(planManualOrderCreateRecovery(mismatch("processing"), false)).toEqual({
      action: "wait",
    });
  });

  it("surfaces unknown and malformed failures without rotating the key", () => {
    expect(planManualOrderCreateRecovery(new Error("network failed"), false)).toEqual({
      action: "surface-error",
    });
    expect(planManualOrderCreateRecovery(
      mismatch("committed", { orderId: "", canRetryWithNewKey: false }),
      false,
    )).toEqual({ action: "surface-error" });
  });

  it("executes one fresh-key retry and returns the created order", async () => {
    const submittedKeys: string[] = [];
    const result = await executeManualOrderCreateWithRecovery({
      requestKey: "request-original",
      submit: async (requestKey) => {
        submittedKeys.push(requestKey);
        if (submittedKeys.length === 1) throw mismatch("failed");
        return { id: "01ABCDEF23456789" };
      },
      replaceRequestKey: () => "request-replacement",
    });

    expect(submittedKeys).toEqual(["request-original", "request-replacement"]);
    expect(result).toEqual({
      outcome: "created",
      order: { id: "01ABCDEF23456789" },
      requestKey: "request-replacement",
    });
  });

  it("does not loop when the replacement request also conflicts", async () => {
    let submissions = 0;
    const secondError = mismatch("failed");
    const result = await executeManualOrderCreateWithRecovery({
      requestKey: "request-original",
      submit: async () => {
        submissions += 1;
        if (submissions === 1) throw mismatch("failed");
        throw secondError;
      },
      replaceRequestKey: () => "request-replacement",
    });

    expect(submissions).toBe(2);
    expect(result).toEqual({
      outcome: "error",
      error: secondError,
      requestKey: "request-replacement",
    });
  });

  it("returns committed and processing recovery without another submission", async () => {
    for (const expected of [
      {
        error: mismatch("committed", { orderId: "01ABCDEF23456789" }),
        result: {
          outcome: "open-existing",
          orderId: "01ABCDEF23456789",
          requestKey: "request-original",
        },
      },
      {
        error: mismatch("processing"),
        result: {
          outcome: "wait",
          requestKey: "request-original",
        },
      },
    ] as const) {
      let submissions = 0;
      const result = await executeManualOrderCreateWithRecovery({
        requestKey: "request-original",
        submit: async () => {
          submissions += 1;
          throw expected.error;
        },
        replaceRequestKey: () => {
          throw new Error("must not replace the request key");
        },
      });
      expect(submissions).toBe(1);
      expect(result).toEqual(expected.result);
    }
  });
});
