import { describe, expect, it } from "vitest";
import {
  AdminApiResponseError,
  isAdminApiNotFoundError,
  nullForAdminApiNotFound,
  readProductRevisionConflict,
} from "./admin-api-error";

describe("admin API detail-loader errors", () => {
  it("recognizes transport and serialized 404 failures", () => {
    expect(
      isAdminApiNotFoundError(
        new AdminApiResponseError("Product not found", 404, "NOT_FOUND"),
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

  it("extracts only a typed product revision conflict with valid details", () => {
    const conflict = new AdminApiResponseError(
      "This product changed while you were editing.",
      409,
      "PRODUCT_REVISION_CONFLICT",
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
          code: "PRODUCT_REVISION_CONFLICT",
          details: { expectedRevision: 4, currentRevision: null },
        },
      }),
    ).toEqual({ expectedRevision: 4, currentRevision: null });
    expect(
      readProductRevisionConflict(
        new AdminApiResponseError("Slug exists", 409, "CONFLICT"),
      ),
    ).toBeNull();
    expect(
      readProductRevisionConflict(
        new AdminApiResponseError(
          "Malformed conflict",
          409,
          "PRODUCT_REVISION_CONFLICT",
          { expectedRevision: 0, currentRevision: "4" },
        ),
      ),
    ).toBeNull();
  });

  it("fails closed for cyclic causes", () => {
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = { cause: first };
    first.cause = second;

    expect(isAdminApiNotFoundError(first)).toBe(false);
  });
});
