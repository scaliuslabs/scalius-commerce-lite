import { describe, expect, it } from "vitest";
import { browserHandoffPage } from "./agent-access";

describe("admin agent browser handoff page", () => {
  it("renders a private click-to-continue page without embedding a bearer action", async () => {
    const response = browserHandoffPage();
    const html = await response.text();

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toMatch(
      /^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/=]+';/,
    );
    expect(html).toContain("Continue securely in Scalius");
    expect(html).toContain('credentials: "same-origin"');
    expect(html).toContain("scalius-continuation-fields-v1");
    expect(html).not.toMatch(/tpc_[A-Za-z0-9_-]{48}/);
    expect(html).not.toMatch(/acb_[A-Za-z0-9_-]{48}/);
    expect(html).not.toContain("Authorization");
  });
});
