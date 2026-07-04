import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { errorResponseFromError, logApiError } from "./api-response";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("logApiError", () => {
  it("keeps routine client errors out of logs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logApiError(new ValidationError("Bad checkout"), { method: "POST", path: "/api/v1/orders" });

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs expected service unavailability as one compact warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logApiError(new ServiceUnavailableError("Stripe is not configured"), {
      method: "POST",
      path: "/api/v1/payment/stripe/intent",
    });

    expect(warn).toHaveBeenCalledWith(
      "[api-error]",
      JSON.stringify({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Stripe is not configured",
        method: "POST",
        path: "/api/v1/payment/stripe/intent",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps full error objects for unexpected crashes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const crash = new Error("Unexpected DB crash");

    logApiError(crash, { method: "GET", path: "/api/v1/admin/orders" });

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("API Error (onError):", crash);
  });
});
