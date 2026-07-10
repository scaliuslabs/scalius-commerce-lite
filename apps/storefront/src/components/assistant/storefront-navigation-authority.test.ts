// @vitest-environment happy-dom

import type { FlueConversationMessage } from "@flue/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildStorefrontNavigationAuthority,
  getAuthorizedStorefrontNavigationRoutes,
  isAuthorizedStorefrontGoto,
  type StorefrontNavigationAuthority,
} from "./storefront-navigation-authority";

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): FlueConversationMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

function authority(
  latestUserText: string,
  candidates: StorefrontNavigationAuthority["candidates"],
): StorefrontNavigationAuthority {
  return { latestUserText, candidates };
}

describe("Storefront navigation authority", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/products/rice");
  });

  it("authorizes one exact explicit destination proven by Scalius", () => {
    const messages: FlueConversationMessage[] = [
      textMessage("user_1", "user", "Please take me to Everyday Shoes"),
      {
        id: "assistant_1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "scalius_1",
            state: "output-available",
            input: { program: "call catalog.product" },
            output: {
              ok: true,
              authoritative: true,
              data: {
                product: {
                  name: "Everyday Shoes",
                  route: "/products/everyday-shoes",
                },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_1",
            state: "input-available",
            input: { program: "goto /products/everyday-shoes" },
          },
        ],
      },
    ];
    const proof = buildStorefrontNavigationAuthority({
      messages,
      messageIndex: 1,
      partIndex: 1,
      document,
    });
    expect(proof.candidates).toContainEqual({
      route: "/products/everyday-shoes",
      label: "Everyday Shoes",
      source: "scalius",
    });
    expect(
      isAuthorizedStorefrontGoto("goto /products/everyday-shoes", proof),
    ).toBe(true);
    expect(
      getAuthorizedStorefrontNavigationRoutes(
        "click @r1.e1",
        proof,
      ),
    ).toEqual(["/products/everyday-shoes"]);
  });

  it("rejects invented, ambiguous, stale, and non-navigation destinations", () => {
    expect(
      isAuthorizedStorefrontGoto(
        "goto /products/invented-shoe",
        authority("Open invented shoe", []),
      ),
    ).toBe(false);
    expect(
      isAuthorizedStorefrontGoto(
        "goto /products/shoes",
        authority("Take me to shoes", [
          {
            route: "/products/shoes",
            label: "Shoes",
            source: "scalius",
          },
          {
            route: "/categories/shoes",
            label: "Shoes",
            source: "visible-page",
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isAuthorizedStorefrontGoto(
        "goto /products/shoes",
        authority("Show me shoes", [
          {
            route: "/products/shoes",
            label: "Shoes",
            source: "scalius",
          },
        ]),
      ),
    ).toBe(false);

    const staleMessages: FlueConversationMessage[] = [
      textMessage("old_user", "user", "Open Everyday Shoes"),
      {
        id: "old_assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "old_scalius",
            state: "output-available",
            input: { program: "call catalog.product" },
            output: {
              ok: true,
              authoritative: true,
              data: {
                product: {
                  name: "Everyday Shoes",
                  route: "/products/everyday-shoes",
                },
              },
            },
          },
        ],
      },
      textMessage("latest_user", "user", "What is its price?"),
      {
        id: "latest_assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "latest_computer",
            state: "input-available",
            input: { program: "goto /products/everyday-shoes" },
          },
        ],
      },
    ];
    const stale = buildStorefrontNavigationAuthority({
      messages: staleMessages,
      messageIndex: 3,
      partIndex: 0,
      document,
    });
    expect(stale.candidates).toEqual([]);
    expect(
      isAuthorizedStorefrontGoto("goto /products/everyday-shoes", stale),
    ).toBe(false);
  });

  it("uses visible public links as provenance and excludes assistant-owned links", () => {
    document.body.innerHTML = `
      <main><a href="/categories/rice">Rice category</a></main>
      <aside data-scalius-computer-exclude>
        <a href="/products/invented">Invented assistant link</a>
      </aside>
    `;
    const messages: FlueConversationMessage[] = [
      textMessage("user_visible", "user", "Go to the rice category"),
      {
        id: "assistant_visible",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_visible",
            state: "input-available",
            input: { program: "goto /categories/rice" },
          },
        ],
      },
    ];
    const proof = buildStorefrontNavigationAuthority({
      messages,
      messageIndex: 1,
      partIndex: 0,
      document,
    });
    expect(proof.candidates.map((candidate) => candidate.route)).toEqual([
      "/categories/rice",
    ]);
    expect(isAuthorizedStorefrontGoto("goto /categories/rice", proof)).toBe(
      true,
    );
    expect(
      getAuthorizedStorefrontNavigationRoutes("click @r1.e1", proof),
    ).toEqual(["/categories/rice"]);
  });

  it("does not grant a link-click route for unrelated or ambiguous intent", () => {
    const candidates: StorefrontNavigationAuthority["candidates"] = [
      {
        route: "/products/shoes",
        label: "Shoes",
        source: "scalius",
      },
      {
        route: "/categories/shoes",
        label: "Shoes",
        source: "visible-page",
      },
    ];
    expect(
      getAuthorizedStorefrontNavigationRoutes(
        "click @r1.e1",
        authority("What shoes do you sell?", candidates),
      ),
    ).toEqual([]);
    expect(
      getAuthorizedStorefrontNavigationRoutes(
        "click @r1.e1",
        authority("Take me to shoes", candidates),
      ),
    ).toEqual([]);
  });
});
