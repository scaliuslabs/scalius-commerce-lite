import { describe, it, expect } from "vitest";

// Simple test to verify vitest setup works
describe("API Health", () => {
  it("should export api-response helpers", async () => {
    const { ok, created, paginated, noContent } = await import(
      "../utils/api-response"
    );
    expect(ok).toBeDefined();
    expect(created).toBeDefined();
    expect(paginated).toBeDefined();
    expect(noContent).toBeDefined();
  });

  it("should export api-error classes", async () => {
    const { ApiError, ValidationError, NotFoundError } = await import(
      "../utils/api-error"
    );
    const err = new ValidationError("test error", { field: "name" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toEqual({ field: "name" });
  });
});
