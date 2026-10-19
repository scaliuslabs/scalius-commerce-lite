// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "./types";
import { LazyOrderConversationCard } from "./LazyOrderConversationCard";

const mocks = vi.hoisted(() => ({ canRead: true }));
vi.mock("~/contexts/PermissionContext", () => ({ useHasPermission: () => mocks.canRead }));
vi.mock("./OrderConversationCard", () => ({
  OrderConversationCard: ({ order }: { order: Order }) => <section data-testid="conversation">{order.id}</section>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order = (supportRequests: unknown[] = []) => ({ id: "ord_1", supportRequests }) as unknown as Order;

describe("Messages card on the order page", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.canRead = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("holds its place before the card's code arrives, then shows the card", async () => {
    act(() => root.render(<LazyOrderConversationCard order={order()} />));
    // The reserved box is an empty, non-pulsing, hidden-from-readers spacer.
    const reserved = host.firstElementChild!;
    expect(reserved.getAttribute("aria-hidden")).toBe("true");
    expect(reserved.textContent).toBe("");
    expect(reserved.className).not.toContain("animate-pulse");
    await vi.waitFor(() => expect(host.querySelector('[data-testid="conversation"]')?.textContent).toBe("ord_1"));
    expect(host.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("reserves nothing when the card would draw nothing", async () => {
    mocks.canRead = false;
    await act(async () => root.render(<LazyOrderConversationCard order={order()} />));
    expect(host.innerHTML).toBe("");
  });

  it("still shows the customer's requests to staff without conversations access", async () => {
    mocks.canRead = false;
    await act(async () => root.render(<LazyOrderConversationCard order={order([{ id: "req_1" }])} />));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="conversation"]')).not.toBeNull());
  });
});
