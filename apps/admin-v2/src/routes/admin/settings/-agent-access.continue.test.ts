import { describe, expect, it } from "vitest";

import { isSafeBrowserAction } from "./agent-access.continue.$handoffId";

describe("secure agent browser handoff action", () => {
  const valid = {
    url: "https://storefront.example.test/theme-preview/continue",
    method: "POST" as const,
    fields: { continuationCode: `tpc_${"x".repeat(48)}`, path: "/", device: "desktop" },
  };

  it("accepts only the configured storefront origin and body-only bounded fields", () => {
    expect(isSafeBrowserAction(valid, "https://storefront.example.test")).toBe(true);
    expect(isSafeBrowserAction(
      { ...valid, url: "https://attacker.example/continue" },
      "https://storefront.example.test",
    )).toBe(false);
    expect(isSafeBrowserAction(
      { ...valid, url: `${valid.url}?continuationCode=secret` },
      "https://storefront.example.test",
    )).toBe(false);
    expect(isSafeBrowserAction(
      { ...valid, fields: { continuationCode: "x".repeat(513) } },
      "https://storefront.example.test",
    )).toBe(false);
  });
});
