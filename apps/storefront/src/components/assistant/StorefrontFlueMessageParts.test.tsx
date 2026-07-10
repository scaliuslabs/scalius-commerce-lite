// @vitest-environment happy-dom

import type { FlueConversationPart } from "@flue/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorefrontFlueMessageParts } from "./StorefrontFlueMessageParts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("StorefrontFlueMessageParts", () => {
  it("renders one compact answer without completed-tool clutter or raw payloads", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const parts: FlueConversationPart[] = [
      { type: "text", text: "A".repeat(900), state: "done" },
      ...Array.from(
        { length: 5 },
        (_, index): FlueConversationPart => ({
          type: "dynamic-tool",
          toolName: index % 2 === 0 ? "scalius" : "computer",
          toolCallId: `tool_${index}`,
          state: "output-available",
          input: { program: "hidden input" },
          output: { privatePayload: `MUST_NOT_RENDER_${index}` },
        }),
      ),
    ];

    act(() => root.render(<StorefrontFlueMessageParts parts={parts} />));

    expect(host.querySelectorAll("[data-assistant-short-answer]")).toHaveLength(
      1,
    );
    expect(
      host.querySelectorAll("[data-assistant-tool-progress] li"),
    ).toHaveLength(0);
    expect(host.textContent).not.toContain("MUST_NOT_RENDER");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("[data-assistant-disclosure]")).toBeTruthy();
    act(() => root.unmount());
  });

  it("projects at most three authoritative catalog products into compact rows", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onNavigate = vi.fn();
    const parts: FlueConversationPart[] = [
      {
        type: "text",
        text: "I found a few good options.",
        state: "done",
      },
      {
        type: "dynamic-tool",
        toolName: "scalius",
        toolCallId: "catalog_1",
        state: "output-available",
        input: { program: 'call catalog.search -- {"query":"shoes"}' },
        output: {
          ok: true,
          authoritative: true,
          data: {
            command: "call",
            capability: { id: "catalog.search", title: "Search products" },
            result: {
              currency: { code: "BDT" },
              products: Array.from({ length: 4 }, (_, index) => ({
                id: `product_${index}`,
                name: `Everyday shoe ${index + 1}`,
                route: `/products/everyday-shoe-${index + 1}`,
                imageUrl: `https://cdn.example.test/shoe-${index + 1}.jpg`,
                price: 1_200 + index,
                currentPrice: 1_000 + index,
                availableForSale: index !== 2,
                privatePayload: "MUST_NOT_RENDER",
              })),
            },
          },
        },
      },
    ];

    act(() =>
      root.render(
        <StorefrontFlueMessageParts
          parts={parts}
          canNavigate={(route) => route.startsWith("/products/")}
          onNavigate={onNavigate}
        />,
      ),
    );

    expect(host.querySelectorAll('[aria-label^="View Everyday shoe"]')).toHaveLength(
      3,
    );
    expect(host.textContent).toContain("Everyday shoe 1");
    expect(host.textContent).toContain("Out of stock");
    expect(host.textContent).not.toContain("Everyday shoe 4");
    expect(host.textContent).not.toContain("MUST_NOT_RENDER");
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="View Everyday shoe 1"]')
        ?.click();
    });
    expect(onNavigate).toHaveBeenCalledWith("/products/everyday-shoe-1");
    act(() => root.unmount());
  });

  it("uses the first safe product-detail image without exposing the rest", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const parts: FlueConversationPart[] = [
      {
        type: "dynamic-tool",
        toolName: "scalius",
        toolCallId: "catalog_detail",
        state: "output-available",
        input: { program: 'call catalog.product -- {"slug":"trail-shoe"}' },
        output: {
          ok: true,
          authoritative: true,
          data: {
            command: "call",
            capability: { id: "catalog.product" },
            result: {
              currency: { code: "BDT" },
              product: {
                id: "product_trail",
                name: "Trail shoe",
                route: "/products/trail-shoe",
                price: 1_200,
                availableForSale: true,
                images: [
                  { url: "https://cdn.example.test/trail.jpg" },
                  { url: "https://cdn.example.test/private-detail.jpg" },
                ],
              },
            },
          },
        },
      },
    ];

    act(() => root.render(<StorefrontFlueMessageParts parts={parts} />));

    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example.test/trail.jpg",
    );
    expect(host.innerHTML).not.toContain("private-detail.jpg");
    act(() => root.unmount());
  });

  it("keeps an active tool step visible while work is still running", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StorefrontFlueMessageParts
          parts={[
            {
              type: "dynamic-tool",
              toolName: "scalius",
              toolCallId: "catalog_running",
              state: "input-available",
              input: { program: "find shoes" },
            },
          ]}
        />,
      ),
    );
    expect(host.textContent).toContain("Checking the catalog");
    expect(
      host.querySelectorAll("[data-assistant-tool-progress] li"),
    ).toHaveLength(1);
    act(() => root.unmount());
  });

  it("does not expose unsupported attachment URLs or filenames", () => {
    window.history.replaceState(null, "", "/products/rice");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StorefrontFlueMessageParts
          parts={[
            {
              type: "file",
              mediaType: "image/png",
              filename: "shoe.png",
              url: `${window.location.origin}/api/assistant/image/1`,
              state: "done",
            } as FlueConversationPart,
            {
              type: "file",
              mediaType: "image/png",
              filename: "off-origin.png",
              url: "https://evil.test/image.png",
              state: "done",
            } as FlueConversationPart,
          ]}
        />,
      ),
    );
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).not.toContain("shoe.png");
    expect(host.textContent).not.toContain("off-origin.png");
    act(() => root.unmount());
  });
});
