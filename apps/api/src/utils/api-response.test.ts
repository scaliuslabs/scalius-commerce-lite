import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { errorResponseFromError } from "./api-response";

describe("errorResponseFromError", () => {
  it("hides unexpected internal error messages", () => {
    const response = errorResponseFromError(new Error("D1 token abc123 failed"));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal Server Error",
      },
    });
  });

  it("preserves validation error messages and details", () => {
    const response = errorResponseFromError(
      new ValidationError("Phone number is required", { field: "phone" }),
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toBe("Phone number is required");
    expect(response.body.error.details).toEqual({ field: "phone" });
  });

  it("preserves not-found errors", () => {
    const response = errorResponseFromError(new NotFoundError("Order not found"));

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("Order not found");
  });
});
