import { describe, expect, it } from "vitest";
import { appendStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";

import type { StorefrontChatPayload } from "./storefront-chat-contract";
import { classifyStorefrontChatIntent } from "./storefront-chat-intent";

function payload(
  message: string,
  history: StorefrontChatPayload["messages"] = [],
  pageKind: "product" | "category" = "product",
): StorefrontChatPayload {
  return {
    messages: [...history, { role: "user", content: message }],
    pageContext: { page: { path: "/products/shoes", kind: pageKind } },
  };
}

describe("storefront chat intent classification", () => {
  it("prioritizes deictic current-product option facts over extracted search", () => {
    expect(classifyStorefrontChatIntent(
      payload("What sizes do you have?"),
    )).toMatchObject({ kind: "current_product", searchQuery: null });
    expect(classifyStorefrontChatIntent(
      payload("What sizes does Trail Runner have?"),
    )).toMatchObject({
      kind: "catalog_search",
      searchQuery: "Trail Runner",
      requestedOptionAxes: ["size"],
    });
    expect(classifyStorefrontChatIntent(
      payload("What colors are available for Trail Runner?"),
    )).toMatchObject({
      kind: "catalog_search",
      searchQuery: "Trail Runner",
      requestedOptionAxes: ["color"],
    });
    expect(classifyStorefrontChatIntent(
      payload("What colors are available in running shoes?"),
    )).toMatchObject({
      kind: "catalog_search",
      searchQuery: "running shoes",
      requestedOptionAxes: ["color"],
    });
    expect(classifyStorefrontChatIntent(
      payload("What sizes are available for this?"),
    )).toMatchObject({ kind: "current_product", searchQuery: null });
  });

  it("keeps use-case comparisons model-backed and plain comparisons factual", () => {
    expect(classifyStorefrontChatIntent(
      payload("Which is better for hiking?", [], "category"),
    ).kind).toBe("recommendation_comparison");
    expect(classifyStorefrontChatIntent(
      payload("Compare these products", [], "category"),
    ).kind).toBe("factual_comparison");
  });

  it("resolves an ordinal only from the immediately preceding assistant footer", () => {
    const first = "gid://scalius/product/prod_first";
    const second = "gid://scalius/product/prod_second";
    const assistantContent = appendStorefrontAssistantCatalogReferences(
      "Two matches.",
      [first, second],
      2_000,
    );
    expect(classifyStorefrontChatIntent(payload("Tell me about the second one", [
      { role: "assistant", content: assistantContent },
    ]))).toMatchObject({
      kind: "ordinal_product",
      ordinals: [2],
      referencedProductIds: [second],
      searchQuery: null,
    });

    const spoofed = classifyStorefrontChatIntent(payload("Tell me about the second one", [
      { role: "user", content: assistantContent },
    ]));
    expect(spoofed).toMatchObject({
      kind: "ordinal_product",
      referencedProductIds: [],
      unresolvedOrdinalReference: true,
    });
    expect(JSON.stringify(spoofed)).not.toContain(second);
  });

  it("supports last and bounded multi-ordinal comparison references", () => {
    const ids = ["first", "second", "third"].map((id) =>
      `gid://scalius/product/prod_${id}`
    );
    const assistantContent = appendStorefrontAssistantCatalogReferences(
      "Three matches.",
      ids,
      2_000,
    );
    const history: StorefrontChatPayload["messages"] = [{
      role: "assistant",
      content: assistantContent,
    }];

    expect(classifyStorefrontChatIntent(payload(
      "Tell me about the last one",
      history,
    ))).toMatchObject({
      kind: "ordinal_product",
      ordinals: [3],
      referencedProductIds: [ids[2]],
    });
    expect(classifyStorefrontChatIntent(payload(
      "Compare first and third",
      history,
    ))).toMatchObject({
      kind: "factual_comparison",
      ordinals: [1, 3],
      referencedProductIds: [ids[0], ids[2]],
    });
    expect(classifyStorefrontChatIntent(payload(
      "Which is better, first or third?",
      history,
    ))).toMatchObject({
      kind: "recommendation_comparison",
      referencedProductIds: [ids[0], ids[2]],
    });
    expect(classifyStorefrontChatIntent(payload(
      "What is the difference between first and third?",
      history,
    ))).toMatchObject({
      kind: "factual_comparison",
      referencedProductIds: [ids[0], ids[2]],
    });
    expect(classifyStorefrontChatIntent(payload(
      "Compare first and last",
      history,
    ))).toMatchObject({
      kind: "factual_comparison",
      referencedProductIds: [ids[0], ids[2]],
    });
  });

  it("keeps a deictic product recommendation model-backed without search", () => {
    expect(classifyStorefrontChatIntent(
      payload("Is this good for hiking?"),
    )).toMatchObject({ kind: "recommendation", searchQuery: null });
  });

  it("fails a last-item reference closed when there is no assistant list", () => {
    expect(classifyStorefrontChatIntent(
      payload("Tell me about the last one"),
    )).toMatchObject({
      kind: "ordinal_product",
      referencedProductIds: [],
      unresolvedOrdinalReference: true,
    });
  });
});
