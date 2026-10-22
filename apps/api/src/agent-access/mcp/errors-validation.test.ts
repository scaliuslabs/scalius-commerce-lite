// A route's request-schema refusal reaches an agent as a sentence that names
// the field and what it expects, with that field: never zod's issue list as
// a JSON string.
import { describe, expect, it } from "vitest";
import { normalizeZodRefusal } from "../../utils/request-validation-error";
import { errorFromOperationResult } from "./errors";

const rawRefusal = {
  success: false,
  error: {
    name: "ZodError",
    message: JSON.stringify([
      { origin: "string", code: "invalid_format", format: "regex", path: ["media", 0, "id"], message: "Expected this product's own attachment id: pmed_ followed by letters, digits, _ or -." },
      { code: "invalid_type", expected: "string", path: ["name"], message: "Invalid input: expected string, received undefined" },
    ], null, 2),
  },
};

describe("validation refusals for agents", () => {
  it("names the field and what it expects", () => {
    const body = normalizeZodRefusal(rawRefusal);
    const error = errorFromOperationResult({
      operationId: "dashboard.products.create",
      status: 400,
      ok: false,
      requestId: "req_1",
      contentType: "application/json",
      data: body,
    });
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("media.0.id: Expected this product's own attachment id: pmed_ followed by letters, digits, _ or -. (and 1 more problem; see details.issues)");
    expect(error.field).toBe("body.media.0.id");
    expect(JSON.stringify(error)).not.toContain('\\n  {');
  });

  it("leaves every other body alone", () => {
    expect(normalizeZodRefusal({ success: false, error: { code: "invalid_cursor", message: "Bad" } })).toBeNull();
    expect(normalizeZodRefusal({ success: true })).toBeNull();
    expect(normalizeZodRefusal({ success: false, error: { name: "ZodError", message: "not json" } })).toMatchObject({
      error: { code: "validation_error", message: "not json" },
    });
  });
});
