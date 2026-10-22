// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerFormValues } from "~/lib/customer-form-schema";

type ShellProps = {
  heading: ReactNode;
  children: ReactNode;
  readOnlyNotice?: ReactNode;
  form: UseFormReturn<CustomerFormValues>;
};
const state = vi.hoisted(() => ({ superAdmin: false, permissions: new Set<string>() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/contexts/PermissionContext", () => ({
  usePermissions: () => ({ isSuperAdmin: state.superAdmin, hasPermission: (permission: string) => state.superAdmin || state.permissions.has(permission) }),
}));
vi.mock("@/hooks/use-entity-form-submit", () => ({ useEntityFormSubmit: () => ({ isSubmitting: false, handleSubmit: vi.fn() }) }));
vi.mock("@/components/admin/shared/FormContainer", async () => {
  const { Form } = await import("~/components/ui/form");
  return { FormContainer: ({ heading, children, readOnlyNotice, form }: ShellProps) => (
    <Form {...form}><h1>{heading}</h1>{readOnlyNotice}{children}</Form>
  ) };
});
vi.mock("./CustomerActivity", () => ({ CustomerActivity: () => null }));
vi.mock("./customers/CustomerAddressesCard", () => ({ CustomerAddressesCard: () => null }));
vi.mock("./customers/CustomerMarketingCard", () => ({ CustomerMarketingCard: () => null }));
vi.mock("./customers/CustomerPaymentMethodsCard", () => ({ CustomerPaymentMethodsCard: () => null }));
vi.mock("./customers/CustomerTagsCard", () => ({ CustomerTagsCard: () => null }));
vi.mock("./custom-fields/CustomFieldsCard", () => ({ CustomFieldsCard: () => null }));
vi.mock("./objects/RelatedObjectsCard", () => ({ RelatedObjectsCard: () => null }));
vi.mock("./apps/ui/AppActions", () => ({ AppActionsMenu: () => null }));
vi.mock("./apps/ui/AppResourceCards", () => ({ AppResourceCards: () => null }));
vi.mock("./customers/CustomerEraseCard", () => ({
  CustomerEraseCard: ({ name }: { name: string }) => <div data-testid="erase-card">{name}</div>,
}));

import { CustomerForm } from "./CustomerForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = { id: "cust_1", name: "Rahim Uddin", phone: "+8801712345678", email: null };
const live = { ...saved, kind: "account" as const, deletedAt: null, erasedAt: null, mergedInto: null, tags: [] };

describe("erasing a customer's personal data on the customer page", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    state.superAdmin = false;
    state.permissions.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async (record: Parameters<typeof CustomerForm>[0]["record"], defaults: Partial<CustomerFormValues> = saved) => {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <CustomerForm isEdit defaultValues={defaults} record={record} />
      </QueryClientProvider>,
    ));
  };
  const card = () => host.querySelector('[data-testid="erase-card"]');

  it("is hidden from staff who are not a Super Admin, even with every customer permission", async () => {
    state.permissions = new Set(["customers.view", "customers.edit", "customers.delete", "customers.view_history"]);
    await render(live);
    expect(card()).toBeNull();
  });

  it("is offered to a Super Admin on a live record and on one in Trash, naming the customer", async () => {
    state.superAdmin = true;
    await render(live);
    expect(card()?.textContent).toBe("Rahim Uddin");
    await render({ ...live, deletedAt: 1_760_000_000 });
    expect(card()).not.toBeNull();
  });

  it("is not offered for a record merged into an account, or one already erased", async () => {
    state.superAdmin = true;
    await render({ ...live, deletedAt: 1_760_000_000, mergedInto: { id: "cust_owner", name: "Owner" } });
    expect(card()).toBeNull();
    await render({ ...live, name: "[erased]", phone: null, deletedAt: 1_760_000_000, erasedAt: 1_760_000_000 }, { ...saved, name: "[erased]", phone: "" });
    expect(card()).toBeNull();
  });

  it("opens an erased record read-only, titled and named as erased, with the erased notice", async () => {
    state.superAdmin = true;
    await render({ ...live, name: "[erased]", phone: null, deletedAt: 1_760_000_000, erasedAt: 1_760_000_000 }, { ...saved, name: "[erased]", phone: "" });
    expect(host.querySelector("h1")?.textContent).toBe("Erased customer");
    expect(host.textContent).toContain("Personal data erased on");
    expect(host.textContent).not.toContain("In trash");
    expect(host.textContent).not.toContain("[erased]");
    expect(host.querySelector("input")).toBeNull();
  });
});
