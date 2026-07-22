import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ResetPasswordForm.tsx", import.meta.url), "utf8");

describe("password reset proof handling", () => {
  it("exchanges and removes the one-time fragment before rendering the form", () => {
    expect(source).toContain('window.location.hash.slice(1)');
    expect(source).toContain('window.history.replaceState(null, "", window.location.pathname)');
    expect(source).toContain('fetch("/api/auth/reset-session"');
  });

  it("submits the new password without putting the reset proof in client payloads", () => {
    expect(source).toContain('fetch("/api/auth/reset-password-session"');
    expect(source).toContain('JSON.stringify({ newPassword: password })');
    expect(source).not.toContain("authClient.resetPassword");
  });
});
