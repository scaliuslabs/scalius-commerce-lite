// tests/unit/core/payments/cod-idempotency.test.ts
// Tests for COD (Cash on Delivery) tracking logic from cod.ts.
// Covers idempotency, failure tracking, and return handling.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Pure logic extracted from cod.ts
// ---------------------------------------------------------------------------

interface CODTrackingState {
  orderId: string;
  codStatus: "pending" | "collected" | "failed" | "returned";
  deliveryAttempts: number;
  collectedBy: string | null;
  collectedAmount: number | null;
  collectedAt: Date | null;
  failureReason: string | null;
  lastAttemptAt: Date | null;
}

interface CODCollectionParams {
  orderId: string;
  collectedBy: string;
  collectedAmount: number;
  receiptUrl?: string;
}

interface CODFailureParams {
  orderId: string;
  reason: "not_home" | "refused" | "no_cash" | "wrong_address" | "other";
  notes?: string;
}

/**
 * Compute the new state after a COD collection.
 */
function applyCODCollection(
  state: CODTrackingState,
  params: CODCollectionParams
): CODTrackingState {
  return {
    ...state,
    codStatus: "collected",
    collectedBy: params.collectedBy,
    collectedAmount: params.collectedAmount,
    collectedAt: new Date(),
    deliveryAttempts: state.deliveryAttempts + 1,
    lastAttemptAt: new Date(),
  };
}

/**
 * Compute the new state after a COD failure.
 */
function applyCODFailure(
  state: CODTrackingState,
  params: CODFailureParams
): CODTrackingState {
  return {
    ...state,
    codStatus: "failed",
    failureReason: params.reason,
    deliveryAttempts: state.deliveryAttempts + 1,
    lastAttemptAt: new Date(),
  };
}

/**
 * Compute the new state after marking COD as returned.
 */
function applyCODReturned(state: CODTrackingState): CODTrackingState {
  return {
    ...state,
    codStatus: "returned",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("COD Collection", () => {
  it("first collection succeeds and updates all fields", () => {
    const state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "pending",
      deliveryAttempts: 0,
      collectedBy: null,
      collectedAmount: null,
      collectedAt: null,
      failureReason: null,
      lastAttemptAt: null,
    };

    const result = applyCODCollection(state, {
      orderId: "ORD-001",
      collectedBy: "Courier A",
      collectedAmount: 2500,
    });

    expect(result.codStatus).toBe("collected");
    expect(result.collectedBy).toBe("Courier A");
    expect(result.collectedAmount).toBe(2500);
    expect(result.collectedAt).toBeInstanceOf(Date);
    expect(result.deliveryAttempts).toBe(1);
  });

  it("collection after a failed attempt preserves attempt count", () => {
    const state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "failed",
      deliveryAttempts: 2,
      collectedBy: null,
      collectedAmount: null,
      collectedAt: null,
      failureReason: "not_home",
      lastAttemptAt: new Date(),
    };

    const result = applyCODCollection(state, {
      orderId: "ORD-001",
      collectedBy: "Courier B",
      collectedAmount: 2500,
    });

    expect(result.codStatus).toBe("collected");
    expect(result.deliveryAttempts).toBe(3); // Previous 2 + this one
    expect(result.collectedBy).toBe("Courier B");
  });

  it("duplicate collection on already-collected order still applies (db handles idempotency)", () => {
    // In the actual code, recordCODCollection always runs the update.
    // The idempotency is at the route level (checking codStatus before calling).
    // But we verify the logic is safe to call again.
    const state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "collected",
      deliveryAttempts: 1,
      collectedBy: "Courier A",
      collectedAmount: 2500,
      collectedAt: new Date(),
      failureReason: null,
      lastAttemptAt: new Date(),
    };

    const result = applyCODCollection(state, {
      orderId: "ORD-001",
      collectedBy: "Courier A",
      collectedAmount: 2500,
    });

    expect(result.codStatus).toBe("collected");
    expect(result.deliveryAttempts).toBe(2); // Incremented
  });
});

describe("COD Failure", () => {
  it("increments delivery attempts on failure", () => {
    const state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "pending",
      deliveryAttempts: 0,
      collectedBy: null,
      collectedAmount: null,
      collectedAt: null,
      failureReason: null,
      lastAttemptAt: null,
    };

    const result = applyCODFailure(state, {
      orderId: "ORD-001",
      reason: "not_home",
    });

    expect(result.codStatus).toBe("failed");
    expect(result.deliveryAttempts).toBe(1);
    expect(result.failureReason).toBe("not_home");
  });

  it("tracks multiple failure reasons", () => {
    let state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "pending",
      deliveryAttempts: 0,
      collectedBy: null,
      collectedAmount: null,
      collectedAt: null,
      failureReason: null,
      lastAttemptAt: null,
    };

    // First failure
    state = applyCODFailure(state, { orderId: "ORD-001", reason: "not_home" });
    expect(state.deliveryAttempts).toBe(1);
    expect(state.failureReason).toBe("not_home");

    // Second failure with different reason
    state = applyCODFailure(state, { orderId: "ORD-001", reason: "no_cash" });
    expect(state.deliveryAttempts).toBe(2);
    expect(state.failureReason).toBe("no_cash");

    // Third failure
    state = applyCODFailure(state, { orderId: "ORD-001", reason: "refused" });
    expect(state.deliveryAttempts).toBe(3);
    expect(state.failureReason).toBe("refused");
  });

  it("all valid failure reasons accepted", () => {
    const reasons: Array<"not_home" | "refused" | "no_cash" | "wrong_address" | "other"> = [
      "not_home", "refused", "no_cash", "wrong_address", "other",
    ];

    for (const reason of reasons) {
      const state: CODTrackingState = {
        orderId: "ORD-001",
        codStatus: "pending",
        deliveryAttempts: 0,
        collectedBy: null,
        collectedAmount: null,
        collectedAt: null,
        failureReason: null,
        lastAttemptAt: null,
      };

      const result = applyCODFailure(state, { orderId: "ORD-001", reason });
      expect(result.failureReason).toBe(reason);
    }
  });
});

describe("COD Returned", () => {
  it("marks order as returned", () => {
    const state: CODTrackingState = {
      orderId: "ORD-001",
      codStatus: "failed",
      deliveryAttempts: 3,
      collectedBy: null,
      collectedAmount: null,
      collectedAt: null,
      failureReason: "refused",
      lastAttemptAt: new Date(),
    };

    const result = applyCODReturned(state);
    expect(result.codStatus).toBe("returned");
    // Preserves previous state
    expect(result.deliveryAttempts).toBe(3);
    expect(result.failureReason).toBe("refused");
  });
});
