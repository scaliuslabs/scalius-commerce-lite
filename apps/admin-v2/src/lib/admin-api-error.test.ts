import { describe, expect, it } from "vitest";
import { AdminApiResponseError, classifyAdminError, isAdminApiNotFoundError, nullForAdminApiNotFound, readSettingsRevisionConflict } from "./admin-api-error";
import { readPromotionRevisionConflict, readProductMediaSkuReferenceConflict, readProductRevisionConflict, readCustomerPhoneConflict } from "./admin-api-conflicts";
import { isAdminApiRetryableReadError, readAdminOrderCreateRequestMismatch, readManualOrderDiscountLimitError } from "./manual-order-errors";

describe("admin API detail-loader errors", () => {
  it("recognizes transport and serialized 404 failures", () => {
    expect(
      isAdminApiNotFoundError(
        new AdminApiResponseError("Product not found", 404, "not_found"),
      ),
    ).toBe(true);
    expect(isAdminApiNotFoundError({ status: 404 })).toBe(true);
    expect(isAdminApiNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(isAdminApiNotFoundError({ cause: { statusCode: 404 } })).toBe(true);
  });

  it("turns only a 404 into the loader absence sentinel", () => {
    expect(nullForAdminApiNotFound({ status: 404 })).toBeNull();

    for (const status of [401, 403, 409, 500, 503, 504]) {
      const error = new AdminApiResponseError("request failed", status);
      expect(() => nullForAdminApiNotFound(error)).toThrow(error);
    }
  });

  it("does not disguise untyped network failures as absence", () => {
    const timeout = new Error("request timed out");
    expect(() => nullForAdminApiNotFound(timeout)).toThrow(timeout);
  });

  it("retries only failures that can plausibly change without edited input", () => {
    expect(isAdminApiRetryableReadError(new Error("network unavailable"))).toBe(true);
    expect(isAdminApiRetryableReadError(new AdminApiResponseError(
      "Service unavailable",
      503,
      "service_unavailable",
    ))).toBe(true);
    expect(isAdminApiRetryableReadError(new AdminApiResponseError(
      "Try later",
      429,
      "rate_limited",
    ))).toBe(true);
    expect(isAdminApiRetryableReadError(new AdminApiResponseError(
      "Invalid input",
      400,
      "validation_error",
    ))).toBe(false);
    expect(isAdminApiRetryableReadError(new AdminApiResponseError(
      "Not signed in",
      401,
      "unauthorized",
    ))).toBe(false);
    expect(isAdminApiRetryableReadError({ code: "unauthorized" })).toBe(false);
    expect(isAdminApiRetryableReadError({ code: "service_unavailable" })).toBe(true);
  });

  it("extracts only authoritative manual-order discount boundaries", () => {
    const error = new AdminApiResponseError(
      "Discount exceeds the order",
      400,
      "validation_error",
      {
        reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
        maximumDiscountAmountMinor: 22_900,
        currencyCode: "BDT",
        decimalPlaces: 2,
      },
    );
    expect(readManualOrderDiscountLimitError(error)).toEqual({
      maximumAmount: 229,
      currencyCode: "BDT",
      decimalPlaces: 2,
    });
    expect(readManualOrderDiscountLimitError({
      cause: {
        statusCode: 400,
        code: "validation_error",
        details: {
          reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
          maximumDiscountAmountMinor: 2_472,
          currencyCode: "KWD",
          decimalPlaces: 3,
        },
      },
    })).toEqual({
      maximumAmount: 2.472,
      currencyCode: "KWD",
      decimalPlaces: 3,
    });
    expect(readManualOrderDiscountLimitError(new AdminApiResponseError(
      "Malformed",
      400,
      "validation_error",
      {
        reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
        maximumDiscountAmountMinor: -1,
        currencyCode: "BDT",
        decimalPlaces: 2,
      },
    ))).toBeNull();
    expect(readManualOrderDiscountLimitError(new AdminApiResponseError(
      "Different validation",
      400,
      "validation_error",
      { reason: "sku_unavailable" },
    ))).toBeNull();
  });

  it("extracts only a typed product revision conflict with valid details", () => {
    const conflict = new AdminApiResponseError(
      "This product changed while you were editing.",
      409,
      "product_revision_conflict",
      { expectedRevision: 3, currentRevision: 4 },
    );

    expect(readProductRevisionConflict(conflict)).toEqual({
      expectedRevision: 3,
      currentRevision: 4,
    });
    expect(
      readProductRevisionConflict({
        status: 409,
        cause: {
          code: "product_revision_conflict",
          details: { expectedRevision: 4, currentRevision: null },
        },
      }),
    ).toEqual({ expectedRevision: 4, currentRevision: null });
    expect(
      readProductRevisionConflict(
        new AdminApiResponseError("Slug exists", 409, "conflict"),
      ),
    ).toBeNull();
    expect(
      readProductRevisionConflict(
        new AdminApiResponseError(
          "Malformed conflict",
          409,
          "product_revision_conflict",
          { expectedRevision: 0, currentRevision: "4" },
        ),
      ),
    ).toBeNull();
  });

  it("does not mistake a promotion code collision for a revision conflict", () => {
    expect(readPromotionRevisionConflict(new AdminApiResponseError(
      "Promotion changed",
      409,
      "promotion_revision_conflict",
      { expectedRevision: 4, currentRevision: 5 },
    ))).toEqual({ expectedRevision: 4, currentRevision: 5 });

    expect(readPromotionRevisionConflict(new AdminApiResponseError(
      "Promotion code is already reserved",
      409,
      "conflict",
      { code: "WELCOME10" },
    ))).toBeNull();
  });

  it("extracts only a typed settings revision conflict", () => {
    expect(readSettingsRevisionConflict(new AdminApiResponseError(
      "Settings changed",
      409,
      "settings_revision_conflict",
      { document: "checkout", expectedRevision: 0, currentRevision: 1 },
    ))).toEqual({ document: "checkout", expectedRevision: 0, currentRevision: 1 });

    expect(readSettingsRevisionConflict(new AdminApiResponseError(
      "Wrong conflict",
      409,
      "conflict",
      { document: "checkout", expectedRevision: 2, currentRevision: 3 },
    ))).toBeNull();
    expect(readSettingsRevisionConflict(new AdminApiResponseError(
      "Bad revision",
      409,
      "settings_revision_conflict",
      { document: "checkout", expectedRevision: 0, currentRevision: "3" },
    ))).toBeNull();
  });

  it("extracts only bounded manual-order request mismatch states", () => {
    expect(readAdminOrderCreateRequestMismatch(new AdminApiResponseError(
      "Previous request failed",
      409,
      "admin_order_create_request_mismatch",
      { state: "failed", canRetryWithNewKey: true },
    ))).toEqual({ state: "failed", canRetryWithNewKey: true });

    expect(readAdminOrderCreateRequestMismatch(new AdminApiResponseError(
      "Order already created",
      409,
      "admin_order_create_request_mismatch",
      { state: "committed", canRetryWithNewKey: false, orderId: "01ABCDEF23456789" },
    ))).toEqual({
      state: "committed",
      canRetryWithNewKey: false,
      orderId: "01ABCDEF23456789",
    });

    expect(readAdminOrderCreateRequestMismatch(new AdminApiResponseError(
      "Malformed",
      409,
      "admin_order_create_request_mismatch",
      { state: "committed", canRetryWithNewKey: true, orderId: "" },
    ))).toBeNull();
    expect(readAdminOrderCreateRequestMismatch(new AdminApiResponseError(
      "Generic conflict",
      409,
      "conflict",
      { state: "failed", canRetryWithNewKey: true },
    ))).toBeNull();
  });

  it("fails closed for cyclic causes", () => {
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = { cause: first };
    first.cause = second;

    expect(isAdminApiNotFoundError(first)).toBe(false);
  });

  it("accepts only bounded typed product-media SKU conflicts", () => {
    const details = {
      affectedCount: 2,
      affectedAssociationIds: ["pmed_white"],
      affectedSkus: [{ id: "var_white", sku: "SHOE-WHITE", imageId: "pmed_white" }],
    };
    expect(readProductMediaSkuReferenceConflict(
      new AdminApiResponseError("Confirm fallback", 409, "product_media_sku_reference_conflict", details),
    )).toEqual(details);
    expect(readProductMediaSkuReferenceConflict(
      new AdminApiResponseError("Bad shape", 409, "product_media_sku_reference_conflict", {
        ...details,
        affectedAssociationIds: Array.from({ length: 21 }, (_, index) => `pmed_${index}`),
      }),
    )).toBeNull();
  });
});

describe("customer phone conflict", () => {
  const other = { id: "cust_2", name: "Rahim", phone: "+8801712345678", kind: "guest" };

  it("reads the other customer from a 400 validation error", () => {
    expect(readCustomerPhoneConflict(new AdminApiResponseError("taken", 400, "validation_error", { customer: other }))).toEqual(other);
    expect(readCustomerPhoneConflict({ cause: { status: 400, code: "validation_error", details: { customer: other } } })).toEqual(other);
  });

  it("ignores other failures and malformed details", () => {
    expect(readCustomerPhoneConflict(new AdminApiResponseError("taken", 409, "validation_error", { customer: other }))).toBeNull();
    expect(readCustomerPhoneConflict(new AdminApiResponseError("bad", 400, "validation_error", { fields: [] }))).toBeNull();
    expect(readCustomerPhoneConflict(new AdminApiResponseError("bad", 400, "validation_error", { customer: { ...other, kind: "owner" } }))).toBeNull();
  });
});

describe("failure classes", () => {
  it("tells a lost connection from a server fault, a missing record and a refusal", () => {
    expect(classifyAdminError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyAdminError(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }))).toBe("network");
    expect(classifyAdminError(new AdminApiResponseError("API error", 500))).toBe("server");
    expect(classifyAdminError({ cause: { statusCode: 503 } })).toBe("server");
    expect(classifyAdminError(new AdminApiResponseError("Order not found", 404, "not_found"))).toBe("notFound");
    expect(classifyAdminError(new AdminApiResponseError("No access", 403, "forbidden"))).toBe("other");
    expect(classifyAdminError(new AdminApiResponseError("Already used", 409))).toBe("other");
    expect(classifyAdminError(new Error("Something odd"))).toBe("other");
  });
});
