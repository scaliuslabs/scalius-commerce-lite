import { describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { fieldErrorMessages } from "~/i18n/save-bar";
import { AdminApiResponseError } from "./admin-api-error";
import { readApiFieldIssues } from "./api-field-errors";

// Exactly what the API sends for a rejected request body (zod issues serialized as the message).
const zodRejection = (issues: unknown[]) => new AdminApiResponseError(JSON.stringify(issues, null, 2), 400);

describe("API field errors", () => {
  it("reads request-validation issues and rewrites zod's developer text", () => {
    const issues = readApiFieldIssues(zodRejection([
      { origin: "string", code: "too_small", minimum: 1, inclusive: true, path: ["name"], message: "Name is required" },
      { expected: "number", code: "invalid_type", path: ["fee"], message: "Invalid input: expected number, received string" },
      { origin: "string", code: "invalid_format", format: "email", path: ["email"], message: "Invalid email address" },
      { origin: "string", code: "too_big", maximum: 120, path: ["sources", 2], message: "Too big: expected string to have <=120 characters" },
    ]));
    expect(issues).toEqual([
      { path: "name", message: "Name is required" },
      { path: "fee", message: translate(fieldErrorMessages, "invalid") },
      { path: "email", message: translate(fieldErrorMessages, "email") },
      { path: "sources.2", message: translate(fieldErrorMessages, "maxLength", { count: 120 }) },
    ]);
  });

  it("reads a service validation error that names its field", () => {
    const error = new AdminApiResponseError("Phone number is required", 400, "VALIDATION_ERROR", { field: "phone" });
    expect(readApiFieldIssues(error)).toEqual([{ path: "phone", message: "Phone number is required" }]);
  });

  it("ignores errors that aren't about fields", () => {
    expect(readApiFieldIssues(new AdminApiResponseError("Conflict", 409))).toBeNull();
    expect(readApiFieldIssues(new AdminApiResponseError("Bad checkout", 400, "VALIDATION_ERROR"))).toBeNull();
    expect(readApiFieldIssues(new Error("offline"))).toBeNull();
  });
});
