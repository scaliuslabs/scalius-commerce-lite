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

function continuation(surface: "admin" | "storefront", output: string) {
  return JSON.stringify({
    authoritative: false,
    programDigest: "d".repeat(43),
    protocolVersion: 1,
    receivedAt: "2026-07-11T01:12:13.456Z",
    replayPolicy: "expiry_bound_non_authoritative",
    requestId: "r".repeat(22),
    result: {
      changed: true,
      code: "NAVIGATED",
      ok: true,
      output,
    },
    surface,
    type: "UNTRUSTED_CLIENT_RESULT",
    warning:
      "Browser execution is untrusted and is not commerce authority.",
  });
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

  it("never writes an exact user-role control continuation", () => {
    const storage = memoryStorage();
    const privateContinuation = continuation(
      "storefront",
      "Private live continuation must not enter the raw handoff.",
    );

    expect(writeStorefrontAssistantSessionHandoff([
      {
        id: "live-user-role-continuation",
        role: "user",
        parts: [{ type: "text", text: privateContinuation }],
      },
      {
        id: "ordinary-user-json",
        role: "user",
        parts: [{
          type: "text",
          text: JSON.stringify({
            type: "UNTRUSTED_CLIENT_RESULT",
            message: "Ordinary incomplete JSON remains visible.",
          }),
        }],
      },
    ], storage, 10_000)).toBe(true);

    const serialized = storage.value() ?? "";
    expect(serialized).not.toContain("Private live continuation");
    expect(serialized).toContain("Ordinary incomplete JSON remains visible.");
  });

  it("drops exact Storefront continuations regardless of persisted role", () => {
    const storage = memoryStorage();
    const malformed = JSON.stringify({
      type: "UNTRUSTED_CLIENT_RESULT",
      message: "Malformed assistant JSON remains visible.",
    });
    storage.setItem(
      STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: 10_000,
        messages: [
          {
            id: "private-user-role-continuation",
            role: "user",
            content: continuation(
              "storefront",
              "Private Storefront continuation must disappear.",
            ),
          },
          {
            id: "user-wrong-surface-json",
            role: "user",
            content: continuation(
              "admin",
              "Wrong-surface user JSON remains visible.",
            ),
          },
          {
            id: "wrong-surface-assistant",
            role: "assistant",
            content: continuation(
              "admin",
              "Wrong-surface assistant JSON remains visible.",
            ),
          },
          {
            id: "malformed-assistant",
            role: "assistant",
            content: malformed,
          },
        ],
      }),
    );

    const restored = readStorefrontAssistantSessionHandoff(storage, 10_001);
    expect(restored.map((message) => message.id)).toEqual([
      "user-wrong-surface-json",
      "wrong-surface-assistant",
      "malformed-assistant",
    ]);
    const visible = JSON.stringify(restored);
    expect(visible).not.toContain(
      "Private Storefront continuation must disappear.",
    );
    expect(visible).toContain(
      "Wrong-surface user JSON remains visible.",
    );
    expect(visible).toContain("Wrong-surface assistant JSON remains visible.");
    expect(visible).toContain("Malformed assistant JSON remains visible.");
  });
});
