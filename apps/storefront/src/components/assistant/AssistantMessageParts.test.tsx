// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assistantMessagePartSchema,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";

import { AssistantMessageParts } from "./AssistantMessageParts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function part(value: unknown): AssistantMessagePart {
  return assistantMessagePartSchema.parse(value);
}

describe("AssistantMessageParts", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("renders rich shopping content and never executes or auto-navigates", async () => {
    const navigate = vi.fn();
    const product = {
      id: "product_mug",
      title: "Travel Mug",
      path: "/products/travel-mug",
      price: 1_200,
      compareAtPrice: 1_500,
      currency: "BDT",
      availability: "in_stock",
      badges: ["Insulated"],
      rationale: "Keeps drinks warm for long commutes.",
    };
    const parts = [
      part({ type: "text", text: "Here is the strongest match." }),
      part({
        type: "source",
        sourceId: "catalog_public",
        label: "Public catalog",
        description: "Availability and price were checked.",
        path: "/products/travel-mug",
      }),
      part({ type: "product_grid", title: "Recommended", products: [product] }),
      part({
        type: "comparison",
        title: "Quick comparison",
        products: [
          product,
          {
            ...product,
            id: "product_bottle",
            title: "Water Bottle",
            path: "/products/water-bottle",
            price: 900,
          },
        ],
        rows: [
          {
            label: "Best for",
            cells: [
              { productId: "product_mug", value: "Hot drinks" },
              { productId: "product_bottle", value: "Cold drinks" },
            ],
          },
        ],
      }),
      part({
        type: "progress",
        workflowId: "workflow_1",
        label: "Checking stock",
        status: "running",
        completed: 1,
        total: 2,
      }),
      part({
        type: "result",
        title: "Stock checked",
        summary: "The mug is currently available.",
        status: "succeeded",
        resourcePath: "/products/travel-mug",
      }),
      part({
        type: "navigation",
        path: "/products/travel-mug",
        label: "Open Travel Mug",
      }),
      part({
        type: "handoff",
        title: "Ready for checkout",
        description: "Continue with the secure storefront form.",
        path: "/checkout",
        handoffType: "checkout",
      }),
      part({
        type: "confirmation",
        actionId: "action_1",
        title: "Confirm purchase",
        summary: "This would place an order.",
        riskClass: "high_risk",
        consequences: ["A payment may be required."],
        confirmLabel: "Approve purchase",
        expiresAt: Date.now() + 60_000,
      }),
      part({
        type: "error",
        code: "catalog.timeout",
        message: "One source did not respond.",
        retryable: true,
      }),
    ];

    act(() => {
      root.render(
        <AssistantMessageParts
          parts={parts}
          canNavigate={(path) => path.startsWith("/products/")}
          onNavigate={navigate}
        />,
      );
    });

    expect(document.body.textContent).toContain("Travel Mug");
    expect(document.body.textContent).toContain("Quick comparison");
    expect(document.body.textContent).toContain("Hot drinks");
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("50");
    expect(document.body.textContent).toContain(
      "Use the visible cart or checkout controls to continue manually.",
    );
    expect(document.body.textContent).toContain(
      "This storefront assistant cannot approve or execute actions.",
    );
    expect(
      document.querySelector('button[aria-label="Approve purchase"]'),
    ).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    const openButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Travel Mug"]',
    );
    expect(openButton).toBeTruthy();
    await act(async () => openButton?.click());
    expect(navigate).toHaveBeenCalledWith(
      "/products/travel-mug",
      "Open Travel Mug",
    );
  });
});
