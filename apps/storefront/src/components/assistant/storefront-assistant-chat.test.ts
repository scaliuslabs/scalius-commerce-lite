import { describe, expect, it } from "vitest";

import {
  createTextMessage,
  messageToHistoryContent,
  normalizeStorefrontAssistantChatResult,
} from "./storefront-assistant-chat";

const origin = "https://shop.example.test";

describe("storefront assistant chat normalization", () => {
  it("validates rich parts and keeps only safe legacy navigation", () => {
    const result = normalizeStorefrontAssistantChatResult(
      {
        status: "ok",
        message: {
          id: "message_1",
          parts: [
            { type: "text", text: "Here are two options." },
            {
              type: "product_grid",
              title: "Recommended",
              products: [
                {
                  id: "product_1",
                  title: "Travel Mug",
                  path: "/products/travel-mug",
                  price: 1200,
                  currency: "BDT",
                  availability: "in_stock",
                  badges: ["Insulated"],
                },
              ],
            },
            { type: "text", text: "" },
            { type: "unknown", value: "ignored" },
          ],
        },
        actions: [
          { type: "navigate", path: "/products/travel-mug", label: "View mug" },
          { type: "navigate", path: "/checkout", label: "Checkout" },
          { type: "navigate", path: "https://evil.test", label: "Leave store" },
        ],
      },
      origin,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected rich response");
    expect(result.message.id).toBe("message_1");
    expect(result.message.parts.map((part) => part.type)).toEqual([
      "text",
      "product_grid",
      "navigation",
    ]);
    expect(result.message.parts.at(-1)).toMatchObject({
      type: "navigation",
      path: "/products/travel-mug",
    });
  });

  it("adapts legacy text and gives a truthful unavailable response", () => {
    expect(
      normalizeStorefrontAssistantChatResult(
        {
          status: "ok",
          message: { role: "assistant", content: "A plain answer." },
        },
        origin,
      ),
    ).toMatchObject({
      status: "ok",
      message: { parts: [{ type: "text", text: "A plain answer." }] },
    });

    expect(
      normalizeStorefrontAssistantChatResult(
        { status: "disabled", message: "" },
        origin,
      ),
    ).toEqual({
      status: "disabled",
      message:
        "The shopping assistant is unavailable. You can keep browsing, use search, and complete cart or checkout steps manually.",
    });
  });

  it("derives bounded plain-text history without serializing rich objects", () => {
    const message = createTextMessage("user", "Help me choose.");
    expect(messageToHistoryContent(message)).toBe("Help me choose.");
  });
});
