import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import {
  DEFAULT_CUSTOMER_REQUEST_POLICY,
  getCustomerRequestPolicy,
  getCustomerRequestPolicyPreview,
  normalizeCustomerRequestPolicy,
  projectCustomerRequestActions,
  saveCustomerRequestPolicy,
} from "./customer-request-policy";

describe("customer request policy", () => {
  it("preserves the existing enabled and eligible-only behavior by default", () => {
    expect(normalizeCustomerRequestPolicy(undefined)).toEqual(
      DEFAULT_CUSTOMER_REQUEST_POLICY,
    );
    expect(normalizeCustomerRequestPolicy("{bad json")).toEqual(
      DEFAULT_CUSTOMER_REQUEST_POLICY,
    );
  });

  it("strictly normalizes booleans, visibility, and concise intro copy", () => {
    expect(normalizeCustomerRequestPolicy({
      cancellationEnabled: false,
      returnEnabled: "false",
      refundEnabled: false,
      visibility: "unexpected",
      introText: "  Contact\n us   and we will help.  ",
    })).toEqual({
      cancellationEnabled: false,
      returnEnabled: true,
      refundEnabled: false,
      visibility: "eligible_only",
      introText: "Contact us and we will help.",
    });
  });

  it("uses one projection for merchant-disabled, ineligible, and hidden actions", () => {
    const actions = [
      { type: "cancel_pre_shipment" as const, eligible: true, disabledReason: null },
      { type: "return" as const, eligible: false, disabledReason: "Not shipped yet." },
      { type: "refund" as const, eligible: true, disabledReason: null },
    ];

    expect(projectCustomerRequestActions({
      ...DEFAULT_CUSTOMER_REQUEST_POLICY,
      refundEnabled: false,
    }, actions)).toEqual([
      expect.objectContaining({
        type: "cancel_pre_shipment",
        label: "Request cancellation",
        eligible: true,
        visible: true,
      }),
    ]);

    expect(projectCustomerRequestActions({
      ...DEFAULT_CUSTOMER_REQUEST_POLICY,
      refundEnabled: false,
      visibility: "show_unavailable",
    }, actions)).toEqual([
      expect.objectContaining({ type: "cancel_pre_shipment", eligible: true, visible: true }),
      expect.objectContaining({
        type: "return",
        eligible: false,
        disabledReason: "Not shipped yet.",
        visible: true,
      }),
      expect.objectContaining({
        type: "refund",
        eligible: false,
        disabledReason: "This store does not accept refund requests online.",
        visible: true,
      }),
    ]);
  });

  it("previews the exact visible actions for representative order states", () => {
    const preview = getCustomerRequestPolicyPreview({
      ...DEFAULT_CUSTOMER_REQUEST_POLICY,
      cancellationEnabled: false,
      visibility: "show_unavailable",
    });

    expect(preview.map((state) => state.id)).toEqual([
      "pre_shipment",
      "shipped_unpaid",
      "delivered_paid",
    ]);
    expect(preview[0]?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "cancel_pre_shipment",
        eligible: false,
        disabledReason: "This store does not accept cancellation requests online.",
      }),
    ]));
    expect(preview[2]?.actions.filter((action) => action.eligible).map((action) => action.type))
      .toEqual(["return", "refund"]);
  });

  it("reads missing settings as defaults and persists the normalized policy", async () => {
    const { db } = createSqliteD1Database();
    await expect(getCustomerRequestPolicy(db)).resolves.toEqual(DEFAULT_CUSTOMER_REQUEST_POLICY);

    const expected = {
      cancellationEnabled: false,
      returnEnabled: true,
      refundEnabled: true,
      visibility: "show_unavailable",
      introText: null,
    };
    await expect(saveCustomerRequestPolicy(db, {
      cancellationEnabled: false,
      visibility: "show_unavailable",
      unexpected: true,
    })).resolves.toEqual(expected);
    await expect(getCustomerRequestPolicy(db)).resolves.toEqual(expected);
  });
});
