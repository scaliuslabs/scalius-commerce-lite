// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ postApiV1AdminCustomersByIdRestore: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));

import { CustomerTrashNotice, type TrashedCustomer } from "./CustomerTrashNotice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("deleted customer notice", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (customer: TrashedCustomer, canRestore = true) => act(() => root.render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomerTrashNotice customer={customer} canRestore={canRestore} />
    </QueryClientProvider>,
  ));
  const restoreButton = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Restore");

  it("offers Restore for a customer in trash and calls the restore endpoint", async () => {
    sdk.postApiV1AdminCustomersByIdRestore.mockResolvedValue({ data: { success: true, data: { id: "cust_1" } } });
    show({ id: "cust_1", mergedInto: null });
    expect(container.textContent).toContain("In trash");
    await act(async () => restoreButton()!.click());
    expect(sdk.postApiV1AdminCustomersByIdRestore).toHaveBeenCalledWith({ path: { id: "cust_1" } });
  });

  it("hides Restore from staff who can't restore", () => {
    show({ id: "cust_1", mergedInto: null }, false);
    expect(container.textContent).toContain("In trash");
    expect(restoreButton()).toBeUndefined();
  });

  it("only names the account for a merged record, with no Restore", () => {
    show({ id: "cust_guest", mergedInto: { id: "cust_owner", name: "Owner Rahman" } });
    expect(container.textContent).toBe("Merged into Owner Rahman");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
    expect(restoreButton()).toBeUndefined();
  });
});
