import { afterEach, describe, expect, it, vi } from "vitest";
import { splitStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";

import {
  createTextMessage,
  messageToHistoryContent,
  normalizeStorefrontAssistantChatResult,
  sendStorefrontAssistantMessage,
} from "./storefront-assistant-chat";

const origin = "https://shop.example.test";

afterEach(() => vi.unstubAllGlobals());

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
                  id: "gid://scalius/product/product_1",
                  title: "Travel Mug",
                  path: "/products/travel-mug",
                  price: 1200,
                  currency: "BDT",
                  pricePresentation: "exact",
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
    expect(result.message.catalogReferences).toEqual([
      "gid://scalius/product/product_1",
    ]);
    expect(splitStorefrontAssistantCatalogReferences(
      messageToHistoryContent(result.message),
    ).productIds).toEqual(["gid://scalius/product/product_1"]);
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

  it("falls back to the read-only one-shot proxy when transcript authority is unavailable", async () => {
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      if (String(input).includes("/conversations/")) {
        return Response.json({
          success: false,
          error: {
            code: "CONVERSATION_SESSION_UNAVAILABLE",
            message: "Assistant session is temporarily unavailable",
          },
        }, { status: 503 });
      }
      return Response.json({
        status: "ok",
        message: { role: "assistant", content: "One-shot answer." },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendStorefrontAssistantMessage({
      message: "Help me choose",
      pageContext: null,
      history: [],
      origin,
      conversationId: "conv_abcdefghijklmnopqrstuv",
    })).resolves.toMatchObject({
      status: "ok",
      transcriptPersisted: false,
      message: { parts: [{ type: "text", text: "One-shot answer." }] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/assistant/conversations/conv_abcdefghijklmnopqrstuv/chat",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/assistant/chat");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit" });
  });
});
