import { describe, expect, it } from "vitest";

import type { StorefrontAssistantUiMessage } from
  "./storefront-assistant-chat";
import {
  STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
  readStorefrontAssistantSessionHandoff,
  writeStorefrontAssistantSessionHandoff,
} from "./storefront-assistant-session";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    value: () => values.get(STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY),
  };
}

describe("storefront assistant session handoff", () => {
  it("restores redacted transcript-shaped text without rich product data", () => {
    const storage = memoryStorage();
    const messages: StorefrontAssistantUiMessage[] = [
      {
        id: "user-message-1",
        role: "user",
        parts: [{
          type: "text",
          text: "My email is buyer@example.test and token is chk_privateproof",
        }],
      },
      {
        id: "assistant-message-1",
        role: "assistant",
        parts: [
          { type: "text", text: "I found a safe match." },
          {
            type: "product_grid",
            products: [{
              id: "gid://scalius/product/product_public_1",
              title: "Private-priced product title",
              path: "/products/private-priced-product",
              imageUrl: "https://images.example.test/private.jpg",
              price: 9_999,
              currency: "BDT",
              pricePresentation: "exact",
              availability: "in_stock",
              badges: [],
            }],
          },
        ],
      },
    ];

    expect(writeStorefrontAssistantSessionHandoff(messages, storage, 1_000))
      .toBe(true);
    const serialized = storage.value() ?? "";
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("gid://scalius/product/product_public_1");
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("chk_privateproof");
    expect(serialized).not.toContain("Private-priced product title");
    expect(serialized).not.toContain("9,999");
    expect(serialized).not.toContain("private.jpg");

    const restored = readStorefrontAssistantSessionHandoff(
      storage,
      1_001,
    );
    expect(restored).toHaveLength(2);
    expect(restored[0]?.parts[0]).toEqual({
      type: "text",
      text: "My email is [redacted]",
    });
    expect(restored[1]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "I found a safe match." }],
      catalogReferences: ["gid://scalius/product/product_public_1"],
    });
  });

  it("bounds message count and rejects malformed, oversized, or expired state", () => {
    const storage = memoryStorage();
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: `Question ${index}` }],
    }));
    writeStorefrontAssistantSessionHandoff(messages, storage, 10_000);
    expect(readStorefrontAssistantSessionHandoff(storage, 10_001))
      .toHaveLength(12);

    expect(readStorefrontAssistantSessionHandoff(storage, 86_410_001))
      .toEqual([]);
    storage.setItem(
      STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
      "{".repeat(32_001),
    );
    expect(readStorefrontAssistantSessionHandoff(storage, 10_001)).toEqual([]);
  });
});
