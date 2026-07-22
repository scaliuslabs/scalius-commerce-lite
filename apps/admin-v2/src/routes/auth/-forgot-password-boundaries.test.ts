import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "forgot-password.tsx"), "utf8");

describe("admin password recovery boundary", () => {
  it("uses the current Better Auth endpoint and never reports an HTTP failure as sent", () => {
    expect(source).toContain('/api/auth/request-password-reset');
    expect(source).toContain("if (!response.ok)");
    expect(source).not.toContain('/api/auth/forget-password');
    expect(source).not.toContain("catch {\n      setSubmitted(true)");
  });

  it("keeps account enumeration protection in the success copy", () => {
    expect(source).toContain("If an account exists for");
  });
});
