// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

import { PhoneUsedBy } from "./CustomerForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const phone = "+8801712345678";

describe("duplicate phone", () => {
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

  it("links the guest record that already uses the phone, titled by its phone", () => {
    act(() => root.render(<PhoneUsedBy customer={{ id: "cust_guest", name: "R3-SB Guest One", phone, kind: "guest" }} />));
    const link = container.querySelector("a");
    expect(container.textContent).toBe(`Used by ${formatPhoneForDisplay(phone)} · guest orders`);
    expect(link?.getAttribute("href")).toBe("/admin/customers/cust_guest/edit");
  });

  it("links an account by its name", () => {
    act(() => root.render(<PhoneUsedBy customer={{ id: "cust_owner", name: "Owner Rahman", phone, kind: "account" }} />));
    expect(container.querySelector("a")?.textContent).toBe("Owner Rahman");
  });
});
