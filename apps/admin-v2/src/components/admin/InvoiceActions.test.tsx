// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";

const mocks = vi.hoisted(() => ({ issue: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin/orders/order_1">{children}</a>,
}));
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminOrdersByIdInvoice: mocks.issue }));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("~/lib/api-mutations/orders", () => ({ orderErrorMessage: (error: Error) => error.message }));

import { InvoiceActions } from "./InvoiceActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

describe("InvoiceActions", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onIssued = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  it("prints an issued invoice with the browser print dialog", () => {
    const print = vi.fn();
    Object.defineProperty(window, "print", { value: print, configurable: true });
    act(() => root.render(<InvoiceActions orderId="order_1" issued businessNameMissing={false} expectedOrderVersion={3} onIssued={onIssued} />));
    expect(button(en["invoice.issue"])).toBeUndefined();
    act(() => button(en["invoice.print"])!.click());
    expect(print).toHaveBeenCalledOnce();
  });

  it("reminds about a missing business name in the toolbar, outside the document", () => {
    act(() => root.render(<InvoiceActions orderId="order_1" issued businessNameMissing expectedOrderVersion={3} onIssued={onIssued} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(en["invoice.businessMissing"]);
  });

  it("retries a failed issue with the same operation key and the order version", async () => {
    mocks.issue.mockRejectedValueOnce(new Error("Order changed")).mockResolvedValueOnce({ status: "issued" });
    act(() => root.render(<InvoiceActions orderId="order_1" issued={false} businessNameMissing={false} expectedOrderVersion={3} onIssued={onIssued} />));
    expect(button(en["invoice.print"])).toBeDefined();

    await act(async () => button(en["invoice.issue"])!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Order changed");
    await act(async () => button(en["invoice.issue"])!.click());

    const [first, second] = mocks.issue.mock.calls.map(([options]) => options.body);
    expect(first.expectedOrderVersion).toBe(3);
    expect(second.operationKey).toBe(first.operationKey);
    expect(onIssued).toHaveBeenCalledWith({ status: "issued" });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
