import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("admin auth keyboard order", () => {
  it("uses native focus order instead of positive tabindex or focus interception", () => {
    const authLayout = readFileSync(
      join(ADMIN_SRC_ROOT, "routes", "auth.tsx"),
      "utf8",
    );

    expect(authLayout).not.toContain("tabindex");
    expect(authLayout).not.toContain("tabIndex");
    expect(authLayout).not.toContain("MutationObserver");
    expect(authLayout).not.toContain("preventDefault()");
    expect(authLayout).not.toContain("addEventListener");
  });

  it("keeps the password input before password recovery in DOM order", () => {
    const loginForm = readFileSync(
      join(ADMIN_SRC_ROOT, "components", "auth", "LoginForm.tsx"),
      "utf8",
    );
    const emailPosition = loginForm.indexOf('id="email"');
    const passwordPosition = loginForm.indexOf('id="password"');
    const recoveryPosition = loginForm.indexOf('to="/auth/forgot-password"');
    const rememberPosition = loginForm.indexOf('type="checkbox"');
    const submitPosition = loginForm.indexOf('type="submit"');

    expect(emailPosition).toBeGreaterThan(-1);
    expect(passwordPosition).toBeGreaterThan(emailPosition);
    expect(recoveryPosition).toBeGreaterThan(passwordPosition);
    expect(rememberPosition).toBeGreaterThan(recoveryPosition);
    expect(submitPosition).toBeGreaterThan(rememberPosition);
    expect(loginForm).not.toContain("tabIndex");
  });
});
