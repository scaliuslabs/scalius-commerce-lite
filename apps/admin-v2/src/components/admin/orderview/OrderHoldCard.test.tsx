// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { showOrderNotice, useOrderNotice } from "~/lib/order-notice";
import { formatOrderTimestamp } from "./formatters";
import type { Order, OrderHold } from "./types";

const mocks = vi.hoisted(() => ({ release: vi.fn(), canChangeOrderStatus: true, pendingHold: null as string | null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canChangeOrderStatus: mocks.canChangeOrderStatus }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  useReleaseOrderHold: () => ({
    mutate: mocks.release,
    isPending: mocks.pendingHold !== null,
    variables: mocks.pendingHold ? { orderId: "ord_1", holdId: mocks.pendingHold } : undefined,
  }),
}));

import { OrderHoldCard } from "./OrderHoldCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const open: OrderHold = {
  id: "ohd_radar", appId: "acme.radar", appName: "Risk radar",
  reason: "Phone has 3 returned orders\nAddress doesn't match the area",
  placedAt: "2026-10-01T08:00:00.000Z", releasedAt: null,
};
const released: OrderHold = {
  id: "ohd_trust", appId: "acme.trust", appName: "Trust score", reason: "New customer",
  placedAt: 1_790_000_000, releasedAt: 1_790_000_600,
};
const withHolds = (holds?: OrderHold[]) => ({ id: "ord_1", holds }) as unknown as Order;

function Banner() {
  return <p data-testid="banner">{useOrderNotice("ord_1")}</p>;
}

describe("order hold card", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canChangeOrderStatus = true;
    mocks.pendingHold = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    setLocale("en");
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  const show = (order: Order) => act(() => root.render(<><OrderHoldCard order={order} /><Banner /></>));
  const releaseButtons = () => [...container.querySelectorAll("button")].filter((button) => button.textContent === "Release hold");

  it("names the app, its reasons and when it held the order, and says what waits", () => {
    show(withHolds([open, released]));
    const notice = container.querySelector('[role="note"]')!;
    expect(notice.getAttribute("role")).toBe("note");
    expect(notice.textContent).toContain("On hold for review");
    expect(notice.textContent).toContain("can't be shipped, handed over or moved to another status");
    expect(notice.textContent).toContain("You can still cancel it.");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe("/admin/apps/acme.radar");
    expect(notice.querySelector("a")?.textContent).toBe("Risk radar");
    expect(notice.textContent).toContain("Phone has 3 returned orders\nAddress doesn't match the area");
    expect(notice.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T08:00:00.000Z");
    expect(notice.querySelector("time")?.textContent).toBe(`Held ${formatOrderTimestamp("2026-10-01T08:00:00.000Z")}`);
    // A released hold isn't news at the top of the page.
    expect(notice.textContent).not.toContain("Trust score");
    expect(releaseButtons()).toHaveLength(1);
  });

  it("shows nothing when no hold is open", () => {
    show(withHolds([released]));
    expect(container.querySelector('[role="note"]')).toBeNull();
    show(withHolds(undefined));
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it("releases the hold after confirming, clearing an earlier refusal from the banner", async () => {
    show(withHolds([open]));
    act(() => showOrderNotice("ord_1", "This order is on hold for review (Risk radar: Phone has 3 returned orders). Release the hold first."));
    expect(container.querySelector('[data-testid="banner"]')?.textContent).toContain("on hold for review");

    await act(async () => releaseButtons()[0]!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Release Risk radar's hold?");
    expect(dialog.textContent).toContain("Risk radar won't hold this order again.");
    expect(mocks.release).not.toHaveBeenCalled();

    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Release hold")!;
    await act(async () => confirm.click());
    expect(mocks.release).toHaveBeenCalledWith({ orderId: "ord_1", holdId: "ohd_radar" });
    expect(container.querySelector('[data-testid="banner"]')?.textContent).toBe("");
  });

  it("keeps the hold's button busy while it is released", () => {
    mocks.pendingHold = "ohd_radar";
    show(withHolds([open]));
    expect(container.querySelector("button")?.disabled).toBe(true);
  });

  it("offers Release only to staff who can change the order's status", () => {
    mocks.canChangeOrderStatus = false;
    show(withHolds([open]));
    expect(container.textContent).toContain("On hold for review");
    expect(releaseButtons()).toHaveLength(0);
    expect(container.querySelector("button")).toBeNull();
  });

  it("speaks Bangla", () => {
    setLocale("bn");
    show(withHolds([open]));
    expect(container.textContent).toContain("রিভিউর জন্য আটকে রাখা হয়েছে");
    expect(container.textContent).toContain("হোল্ড ছেড়ে দিন");
  });
});
