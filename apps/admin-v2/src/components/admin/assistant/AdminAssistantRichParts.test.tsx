// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";

import { AdminAssistantRichParts } from "./AdminAssistantRichParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminAssistantRichParts", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("renders comparison, progress, confirmation, and action-result states", async () => {
    const onConfirm = vi.fn();
    const onNavigate = vi.fn();
    const parts: AssistantMessagePart[] = [
      {
        type: "comparison",
        title: "Catalog comparison",
        products: [
          {
            id: "product-one",
            title: "Starter set",
            path: "/admin/products",
            availability: "in_stock",
            badges: [],
          },
          {
            id: "product-two",
            title: "Pro set",
            path: "/admin/products",
            availability: "limited",
            badges: [],
          },
        ],
        rows: [
          {
            label: "Inventory",
            cells: [
              { productId: "product-one", value: "42", status: "known" },
              { productId: "product-two", value: "8", status: "known" },
            ],
          },
        ],
      },
      {
        type: "progress",
        workflowId: "workflow-one",
        label: "Updating inventory",
        status: "running",
        completed: 3,
        total: 10,
      },
      {
        type: "confirmation",
        actionId: "action-one",
        title: "Publish inventory changes?",
        summary: "This changes buyer-visible stock.",
        riskClass: "consequential",
        consequences: ["Three variants will change."],
        confirmLabel: "Publish changes",
        expiresAt: Date.now() + 60_000,
      },
      {
        type: "result",
        title: "Inventory updated",
        summary: "Three variants were updated.",
        status: "succeeded",
        resourcePath: "/admin/inventory",
      },
    ];

    act(() => {
      root.render(
        <AdminAssistantRichParts
          parts={parts}
          onConfirm={onConfirm}
          onNavigate={onNavigate}
        />,
      );
    });

    expect(host.textContent).toContain("Catalog comparison");
    expect(host.textContent).toContain("Starter set");
    expect(host.textContent).toContain("Updating inventory");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
      "Updating inventory: 30%",
    );
    expect(host.textContent).toContain("This changes buyer-visible stock.");
    expect(host.textContent).toContain("Inventory updated");
    expect(onConfirm).not.toHaveBeenCalled();

    await clickButton("Publish changes");
    expect(onConfirm).toHaveBeenCalledWith("action-one");

    await clickButton("View result");
    expect(onNavigate).toHaveBeenCalledWith("/admin/inventory");
  });

  it("does not turn unsafe paths or disconnected confirmations into actions", () => {
    const parts: AssistantMessagePart[] = [
      {
        type: "navigation",
        path: "https://example.com/admin",
        label: "Leave dashboard",
        requiresConfirmation: true,
      },
      {
        type: "confirmation",
        actionId: "action-two",
        title: "Delete products?",
        summary: "This cannot run from the current UI boundary.",
        riskClass: "high_risk",
        consequences: [],
        confirmLabel: "Delete products",
        expiresAt: Date.now() + 60_000,
      },
    ];

    act(() => root.render(<AdminAssistantRichParts parts={parts} />));

    expect(queryButton("Leave dashboard")).toBeNull();
    expect(queryButton("Delete products")).toBeNull();
    expect(host.textContent).toContain("Secure confirmation is not connected yet");
  });

  it("expires a visible confirmation without relying on another render", async () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const expiresAt = Date.now() + 100;
    const parts: AssistantMessagePart[] = [
      {
        type: "confirmation",
        actionId: "action-expiring",
        title: "Publish changes?",
        summary: "Review before publishing.",
        riskClass: "consequential",
        consequences: [],
        confirmLabel: "Publish changes",
        expiresAt,
      },
    ];

    act(() => {
      root.render(
        <AdminAssistantRichParts parts={parts} onConfirm={onConfirm} />,
      );
    });
    expect(queryButton("Publish changes")?.disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(queryButton("Publish changes")?.disabled).toBe(true);
    expect(host.textContent).toContain("Confirmation expired");
  });

  function queryButton(label: string): HTMLButtonElement | null {
    return Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    ) ?? null;
  }

  async function clickButton(label: string) {
    const button = queryButton(label);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
});
