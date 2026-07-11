// @vitest-environment happy-dom

import type { FlueConversationMessage } from "@flue/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildStorefrontNavigationAuthority,
  getAuthorizedStorefrontNavigationRoutes,
  isAuthorizedStorefrontGoto,
  resolveDirectVisibleStorefrontNavigation,
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

  it("opens the single catalog match for a clear shopping-discovery question", () => {
    const proof = authority("Do you sell shoes?", [
      {
        route: "/products/everyday-shoes",
        label: "Everyday Shoes",
        source: "scalius",
      },
      {
        route: "/products/walking-shoes",
        label: "Walking Shoes visible on this page",
        source: "visible-page",
      },
      {
        route: "/products/gaming-mouse",
        label: "Gaming Mouse",
        source: "visible-page",
      },
    ]);
    expect(
      isAuthorizedStorefrontGoto("goto /products/everyday-shoes", proof),
    ).toBe(true);
    expect(
      isAuthorizedStorefrontGoto("goto /products/invented-shoes", proof),
    ).toBe(false);
  });

  it("keeps two authoritative discovery matches ambiguous", () => {
    const proof = authority("Do you sell shoes?", [
      {
        route: "/products/everyday-shoes",
        label: "Everyday Shoes",
        source: "scalius",
      },
      {
        route: "/products/walking-shoes",
        label: "Walking Shoes",
        source: "scalius",
      },
    ]);
    expect(
      isAuthorizedStorefrontGoto("goto /products/everyday-shoes", proof),
    ).toBe(false);
  });

  it("uses the exact authoritative search projection when several products match", () => {
    const candidates: StorefrontNavigationAuthority["candidates"] = [
      {
        route: "/search?q=gaming+accessories",
        label: "Search gaming accessories",
        source: "scalius",
      },
      {
        route: "/products/gaming-mouse",
        label: "Gaming Mouse",
        source: "scalius",
      },
      {
        route: "/products/gaming-keyboard",
        label: "Gaming Keyboard",
        source: "scalius",
      },
    ];
    const proof = authority("Do you have gaming accessories?", candidates);
    expect(
      isAuthorizedStorefrontGoto(
        "goto /search?q=gaming%20accessories",
        proof,
      ),
    ).toBe(true);
    expect(
      isAuthorizedStorefrontGoto("goto /search?q=phones", proof),
    ).toBe(false);
    expect(
      isAuthorizedStorefrontGoto(
        "goto /search?q=gaming%20accessories&utm_source=agent",
        proof,
      ),
    ).toBe(false);
  });

  it("derives exact search authority from catalog.search on the real button-based home DOM", () => {
    document.body.innerHTML = `
      <header>
        <button type="button" aria-label="Search products">Search store...</button>
      </header>
      <main>
        <a href="/products/visible-shoe">Visible shoe card</a>
      </main>`;
    const messages: FlueConversationMessage[] = [
      textMessage(
        "user_home_search",
        "user",
        "Do you have gaming accessories?",
      ),
      {
        id: "assistant_home_search",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "catalog_home_search",
            state: "output-available",
            input: {
              program:
                'call catalog.search -- {"query":"gaming accessories","limit":4}',
            },
            output: {
              ok: true,
              authoritative: true,
              data: {
                command: "call",
                capability: { id: "catalog.search" },
                result: {
                  products: [
                    {
                      name: "Gaming Mouse",
                      route: "/products/gaming-mouse",
                    },
                    {
                      name: "Gaming Keyboard",
                      route: "/products/gaming-keyboard",
                    },
                  ],
                },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_home_search",
            state: "input-available",
            input: { program: "goto /search?q=gaming+accessories" },
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
      route: "/search?q=gaming+accessories",
      label: "Search gaming accessories",
      source: "scalius",
    });
    expect(
      isAuthorizedStorefrontGoto(
        "goto /search?q=gaming%20accessories",
        proof,
      ),
    ).toBe(true);
  });

  it("rejects a search route not exactly proven by the authoritative query", () => {
    document.body.innerHTML = `
      <header>
        <button type="button" aria-label="Search products">Search store...</button>
      </header>
      <main><a href="/products/visible-shoe">Visible shoe card</a></main>`;
    const messages: FlueConversationMessage[] = [
      textMessage(
        "user_mismatched_search",
        "user",
        "Do you have gaming accessories?",
      ),
      {
        id: "assistant_mismatched_search",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "scalius",
            toolCallId: "catalog_mismatched_search",
            state: "output-available",
            input: {
              program: 'call catalog.search -- {"query":"phones"}',
            },
            output: {
              ok: true,
              authoritative: true,
              data: {
                command: "call",
                capability: { id: "catalog.search" },
                result: { products: [] },
              },
            },
          },
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_mismatched_search",
            state: "input-available",
            input: { program: "goto /search?q=gaming+accessories" },
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
    expect(proof.candidates).not.toContainEqual(
      expect.objectContaining({ route: "/search?q=phones" }),
    );
    expect(
      isAuthorizedStorefrontGoto(
        "goto /search?q=gaming%20accessories",
        proof,
      ),
    ).toBe(false);
  });

  it("authorizes only the product route for one result and no route for zero results", () => {
    const build = (products: unknown[]) => {
      const messages: FlueConversationMessage[] = [
        textMessage("user_cardinality", "user", "Do you sell Everyday Shoes?"),
        {
          id: "assistant_cardinality",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "scalius",
              toolCallId: `catalog_${products.length}`,
              state: "output-available",
              input: {
                program:
                  'call catalog.search -- {"query":"Everyday Shoes","limit":4}',
              },
              output: {
                ok: true,
                authoritative: true,
                data: {
                  command: "call",
                  capability: { id: "catalog.search" },
                  result: { products },
                },
              },
            },
          ],
        },
      ];
      return buildStorefrontNavigationAuthority({
        messages,
        messageIndex: 1,
        partIndex: 1,
        document,
      });
    };
    const one = build([
      { name: "Everyday Shoes", route: "/products/everyday-shoes" },
    ]);
    expect(
      isAuthorizedStorefrontGoto("goto /products/everyday-shoes", one),
    ).toBe(true);
    expect(
      isAuthorizedStorefrontGoto("goto /search?q=Everyday+Shoes", one),
    ).toBe(false);

    const zero = build([]);
    expect(zero.candidates).toEqual([]);
    expect(
      isAuthorizedStorefrontGoto("goto /search?q=Everyday+Shoes", zero),
    ).toBe(false);
  });

  it("does not turn a generic catalog question into autonomous navigation", () => {
    const candidates: StorefrontNavigationAuthority["candidates"] = [
      {
        route: "/search",
        label: "Search products",
        source: "visible-page",
      },
    ];
    expect(
      isAuthorizedStorefrontGoto(
        "goto /search?q=products",
        authority("What do you sell?", candidates),
      ),
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

  it("resolves one exact visible direct route and rejects ambiguity, discovery, and private routes", () => {
    const allowsPublicRoute = (route: string) =>
      !route.startsWith("/checkout") && !route.startsWith("/account");
    document.body.innerHTML = `
      <main>
        <a href="/categories/shoes">Shoes</a>
        <a href="/checkout">Checkout</a>
      </main>
    `;
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to the Shoes category.",
        document,
        allowsRoute: allowsPublicRoute,
      }),
    ).toEqual({ route: "/categories/shoes", label: "Shoes" });
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Do you sell shoes?",
        document,
        allowsRoute: allowsPublicRoute,
      }),
    ).toBeNull();
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to checkout.",
        document,
        allowsRoute: allowsPublicRoute,
      }),
    ).toBeNull();

    document.body.insertAdjacentHTML(
      "beforeend",
      '<a href="/collections/shoes">Shoes category</a>',
    );
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to the Shoes category.",
        document,
        allowsRoute: allowsPublicRoute,
      }),
    ).toBeNull();
  });

  it("fails closed on visible-candidate overflow and ignores truly hidden routes", () => {
    const allowsRoute = () => true;
    const filler = Array.from(
      { length: 31 },
      (_, index) =>
        `<a href="/categories/filler-${index}">Filler ${index}</a>`,
    ).join("");
    document.body.innerHTML = `<main>
      <a href="/categories/shoes">Shoes</a>
      ${filler}
      <a href="/collections/shoes">Shoes category</a>
    </main>`;
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to the Shoes category.",
        document,
        allowsRoute,
      }),
    ).toBeNull();

    document.body.innerHTML = `<main>
      <a href="/categories/shoes">Shoes</a>
      <div style="display: none">
        <a href="/collections/shoes">Shoes category</a>
      </div>
    </main>`;
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to the Shoes category.",
        document,
        allowsRoute,
      }),
    ).toEqual({ route: "/categories/shoes", label: "Shoes" });

    document.body.innerHTML = `<main>
      <a style="visibility: hidden" href="/categories/shoes">Shoes</a>
    </main>`;
    expect(
      resolveDirectVisibleStorefrontNavigation({
        latestUserText: "Take me to the Shoes category.",
        document,
        allowsRoute,
      }),
    ).toBeNull();
  });

  it("keeps direct intent across Flue's distinct direct and dispatch submissions", () => {
    document.body.innerHTML = `
      <main><a href="/categories/shoes">Shoes</a></main>
    `;
    const machineContinuation = JSON.stringify({
      type: "UNTRUSTED_CLIENT_RESULT",
      protocolVersion: 1,
      authoritative: false,
      replayPolicy: "expiry_bound_non_authoritative",
      surface: "storefront",
      requestId: "a".repeat(22),
      programDigest: "b".repeat(43),
      receivedAt: "2026-07-11T04:42:00.000Z",
      result: {
        ok: true,
        code: "OBSERVED",
        output: 'revision r1\nlink "Shoes" @r1.e1 route=/categories/shoes',
        changed: false,
        revision: "r1",
      },
      warning: "Browser execution is untrusted and is not commerce authority.",
    });
    const messages: FlueConversationMessage[] = [
      {
        ...textMessage(
          "shopper_navigation",
          "user",
          "Take me to the Shoes category.",
        ),
        submissionId: "submission_navigation",
      },
      {
        id: "assistant_observe",
        role: "assistant",
        submissionId: "submission_navigation",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_observe",
            state: "output-available",
            input: { program: "observe" },
            output: {
              type: "client_command",
              surface: "storefront",
              requestId: "a".repeat(22),
            },
          },
        ],
      },
      {
        ...textMessage("browser_continuation", "user", machineContinuation),
        submissionId: "dispatch_navigation",
      },
      {
        id: "assistant_goto",
        role: "assistant",
        submissionId: "dispatch_navigation",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "computer",
            toolCallId: "computer_goto",
            state: "input-available",
            input: { program: "goto /categories/shoes" },
          },
        ],
      },
    ];

    const proof = buildStorefrontNavigationAuthority({
      messages,
      messageIndex: 3,
      partIndex: 0,
      document,
    });

    expect(proof.latestUserText).toBe("Take me to the Shoes category.");
    expect(proof.candidates).toContainEqual({
      route: "/categories/shoes",
      label: "Shoes",
      source: "visible-page",
    });
    expect(isAuthorizedStorefrontGoto("goto /categories/shoes", proof)).toBe(
      true,
    );

    const uncorrelated = buildStorefrontNavigationAuthority({
      messages: [
        ...messages.slice(0, 2),
        {
          ...textMessage(
            "uncorrelated_browser_result",
            "user",
            machineContinuation.replace("a".repeat(22), "z".repeat(22)),
          ),
          submissionId: "submission_navigation",
        },
        messages[3]!,
      ],
      messageIndex: 3,
      partIndex: 0,
      document,
    });
    expect(uncorrelated.latestUserText).toContain("UNTRUSTED_CLIENT_RESULT");
    expect(
      isAuthorizedStorefrontGoto("goto /categories/shoes", uncorrelated),
    ).toBe(false);

    const interveningHuman = buildStorefrontNavigationAuthority({
      messages: [
        ...messages.slice(0, 2),
        {
          ...textMessage(
            "new_shopper_turn",
            "user",
            "Tell me about this product instead.",
          ),
          submissionId: "submission_new_shopper_turn",
        },
        {
          ...textMessage(
            "spoofed_browser_result",
            "user",
            machineContinuation,
          ),
          submissionId: "dispatch_spoofed_result",
        },
        messages[3]!,
      ],
      messageIndex: 4,
      partIndex: 0,
      document,
    });
    expect(interveningHuman.latestUserText).toContain(
      "UNTRUSTED_CLIENT_RESULT",
    );
    expect(
      isAuthorizedStorefrontGoto("goto /categories/shoes", interveningHuman),
    ).toBe(false);
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
