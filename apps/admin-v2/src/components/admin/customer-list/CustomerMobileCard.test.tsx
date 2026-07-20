// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, params: _params, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to?: string;
    params?: unknown;
  }) => <a {...props}>{children}</a>,
}));

vi.mock("~/components/admin/data-table/DataTableRowActions", () => ({
  DataTableRowActions: ({
    menuLabel,
    onEdit,
    onDelete,
    onRestore,
    onPermanentDelete,
  }: {
    menuLabel: string;
    onEdit?: () => void;
    onDelete?: () => void;
    onRestore?: () => void;
    onPermanentDelete?: () => void;
  }) => (
    <button
      type="button"
      aria-label={menuLabel}
      data-edit={Boolean(onEdit)}
      data-archive={Boolean(onDelete)}
      data-restore={Boolean(onRestore)}
      data-permanent={Boolean(onPermanentDelete)}
    >
      Actions
    </button>
  ),
}));

import { CustomerMobileCard } from "./CustomerMobileCard";
import type { CustomerListBuyer } from "./customer-list-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const buyer: CustomerListBuyer = {
  id: "cust_1",
  name: "Samira Rahman",
  email: "samira@example.com",
  phone: "+8801712345678",
  address: "12 Lake Road",
  city: "dhaka",
  zone: "dhanmondi",
  area: null,
  cityName: "Dhaka",
  zoneName: "Dhanmondi",
  areaName: null,
  totalOrders: 3,
  totalSpent: 1250,
  lastOrderAt: "2026-07-20T21:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
  accountClaimedAt: "2026-07-02T00:00:00.000Z",
};

describe("CustomerMobileCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows account identity, buyer contacts, and paid commerce facts", async () => {
    await act(async () => root.render(
      <CustomerMobileCard
        customer={buyer}
        selected={false}
        showTrashed={false}
        symbol="৳"
        canSelect
        canViewHistory
        canEdit
        canDelete
        onSelectedChange={vi.fn()}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    ));

    expect(host.querySelector("article")).toBeTruthy();
    expect(host.querySelector('[aria-label="Buyer type: Account"]')?.textContent).toBe("Account");
    expect(host.textContent).toContain("+880 1712 345678");
    expect(host.textContent).toContain("samira@example.com");
    expect(host.textContent).toContain("12 Lake Road, Dhanmondi, Dhaka");
    expect(host.textContent).toContain("Paid spend");
    expect(host.textContent).toContain("৳1,250");
    expect(host.textContent).toContain("Jul 21, 2026");
    expect(host.textContent).toContain("View order history");
    expect(host.querySelector('[aria-label="Select Samira Rahman"]')).toBeTruthy();
  });

  it("labels a guest and exposes only trash actions in trash", async () => {
    await act(async () => root.render(
      <CustomerMobileCard
        customer={{ ...buyer, accountClaimedAt: null }}
        selected={false}
        showTrashed
        symbol="৳"
        canSelect
        canViewHistory={false}
        canEdit
        canDelete
        onSelectedChange={vi.fn()}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    ));

    expect(host.querySelector('[aria-label="Buyer type: Guest"]')?.textContent).toBe("Guest");
    expect(host.textContent).not.toContain("View order history");
    const actions = host.querySelector('[aria-label="Open actions for Samira Rahman"]');
    expect(actions?.getAttribute("data-edit")).toBe("false");
    expect(actions?.getAttribute("data-archive")).toBe("false");
    expect(actions?.getAttribute("data-restore")).toBe("true");
    expect(actions?.getAttribute("data-permanent")).toBe("true");
  });
});
