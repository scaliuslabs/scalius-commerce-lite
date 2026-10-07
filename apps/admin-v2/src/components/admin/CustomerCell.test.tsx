// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

import { CustomerCell } from "./CustomerCell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const phone = "+8801712345678";

describe("customer list row", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (customer: Parameters<typeof CustomerCell>[0]["customer"]) =>
    act(() => root.render(<CustomerCell customer={customer} to="/admin/customers/cust_1/edit" />));

  it("names a checkout guest record by the latest order's buyer, with the phone beneath", () => {
    show({ kind: "guest", name: "R3-SB Guest One", phone, latestOrderName: "R3-SB Guest Two" });
    expect(container.querySelector("a")?.textContent).toBe("R3-SB Guest Two");
    expect(container.textContent).toContain(formatPhoneForDisplay(phone, getStoreRegion()));
    expect(container.textContent).not.toContain("R3-SB Guest One");
    expect(container.textContent).not.toContain("not yet claimed");
  });

  it("falls back to the phone, saying guest orders, only when the guest has no name", () => {
    show({ kind: "guest", name: "R3-SB Guest One", phone, latestOrderName: null });
    expect(container.querySelector("a")?.textContent).toBe(formatPhoneForDisplay(phone, getStoreRegion()));
    expect(container.textContent).toContain("Guest orders");
  });

  it("titles an account by its name with the phone beneath", () => {
    show({ kind: "account", name: "Rahim Uddin", phone, latestOrderName: "Karim" });
    expect(container.querySelector("a")?.textContent).toBe("Rahim Uddin");
    expect(container.textContent).toContain(formatPhoneForDisplay(phone, getStoreRegion()));
    expect(container.textContent).not.toContain("Karim");
  });
});
