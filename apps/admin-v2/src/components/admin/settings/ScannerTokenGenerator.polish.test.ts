import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./ScannerTokenGenerator.tsx", import.meta.url),
  "utf8",
);

describe("scanner access workspace", () => {
  it("uses shared claim and session lifetimes", () => {
    expect(source).toContain("SCANNER_TOKEN_TTL_SECONDS");
    expect(source).toContain("SCANNER_SESSION_TTL_SECONDS");
    expect(source).not.toContain("6 * 60 * 60 * 1000");
    expect(source).toContain("must be claimed within");
    expect(source).toContain("after the latest check-in");
  });

  it("keeps token claim and device-session language distinct", () => {
    expect(source).toContain("The first device to open this link claims it");
    expect(source).toContain("the token is not reused");
    expect(source).toContain("expiresAt ?? Date.now() + TOKEN_LIFETIME_MS");
  });

  it("enforces inventory permissions and mobile controls", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.PRODUCTS_VIEW");
    expect(source).toContain("ADMIN_PERMISSIONS.PRODUCTS_EDIT");
    expect(source).toContain("min-h-11");
    expect(source).toContain("Creating QR code");
  });
});
