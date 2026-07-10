import { describe, expect, it } from "vitest";

import type { AssistantMessagePart } from
  "@scalius/shared/assistant-contracts";

import { getDirectlyConfirmedStorefrontNavigation } from
  "./storefront-assistant-navigation";

const ORIGIN = "https://shop.example.test";

function navigation(
  path: string,
  label: string,
): AssistantMessagePart {
  return { type: "navigation", path, label, requiresConfirmation: true };
}

describe("storefront assistant direct navigation confirmation", () => {
  it.each([
    [
      "Take me to Khaki High Top Casual Shoes",
      navigation(
        "/products/khaki-high-top-casual-shoes",
        "View Khaki High Top Casual Shoes",
      ),
    ],
    [
      "Show me shoes",
      navigation("/search?q=shoes", "Search catalog"),
    ],
    [
      "Take me to shoes category",
      navigation("/categories/shoes", "Browse Shoes"),
    ],
  ])("uses the current explicit command as confirmation: %s", (message, part) => {
    expect(
      getDirectlyConfirmedStorefrontNavigation(message, [part], ORIGIN),
    ).toEqual(part);
  });

  it.each([
    "Do you sell shoes?",
    "Which shoes should I choose?",
    "Where can I find shoes?",
    "Should I open shoes?",
    "Show me shoes or sandals",
    "Open shoes, then open my cart",
  ])("keeps advisory or ambiguous requests click-confirmed: %s", (message) => {
    expect(
      getDirectlyConfirmedStorefrontNavigation(
        message,
        [navigation("/search?q=shoes", "Search catalog")],
        ORIGIN,
      ),
    ).toBeNull();
  });

  it("requires one safe action whose destination agrees exactly", () => {
    expect(
      getDirectlyConfirmedStorefrontNavigation(
        "Open shoes",
        [navigation("/products/rice", "View Rice")],
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      getDirectlyConfirmedStorefrontNavigation(
        "Open shoes",
        [
          navigation("/search?q=shoes", "Search catalog"),
          navigation("/products/shoes", "View Shoes"),
        ],
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      getDirectlyConfirmedStorefrontNavigation(
        "Open shoes",
        [navigation("https://evil.test/products/shoes", "View Shoes")],
        ORIGIN,
      ),
    ).toBeNull();
  });
});
