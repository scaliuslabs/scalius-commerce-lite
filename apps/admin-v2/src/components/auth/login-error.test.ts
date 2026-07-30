import { describe, expect, it } from "vitest";
import { getSignInErrorMessage } from "./login-error";

describe("getSignInErrorMessage", () => {
  it.each([
    "401",
    new Error("Request failed with status 401"),
    { status: 401 },
    { statusCode: "401" },
    { code: "INVALID_EMAIL_OR_PASSWORD" },
    { message: "Invalid email or password" },
    { message: "Unauthorized" },
  ])("keeps credential failures neutral for %o", (error) => {
    expect(getSignInErrorMessage(error)).toBe("Invalid email or password.");
  });

  it.each([
    { status: 429 },
    { code: "RATE_LIMITED" },
    new Error("Too many requests"),
  ])("gives rate-limited users a useful next step for %o", (error) => {
    expect(getSignInErrorMessage(error)).toBe(
      "Too many sign-in attempts. Wait a moment and try again.",
    );
  });

  it.each([
    new TypeError("Failed to fetch"),
    new Error("Network connection timed out"),
    { code: "OFFLINE" },
  ])("distinguishes connection failures for %o", (error) => {
    expect(getSignInErrorMessage(error)).toBe(
      "Unable to reach Scalius. Check your connection and try again.",
    );
  });

  it.each([
    undefined,
    { status: 500 },
    new Error("Database connection includes private provider details"),
  ])("does not expose unexpected backend details for %o", (error) => {
    expect(getSignInErrorMessage(error)).toBe(
      "Unable to sign in right now. Please try again.",
    );
  });
});
