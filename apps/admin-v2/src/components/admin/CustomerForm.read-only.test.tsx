// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { phoneNumberSchema, validateAndFormatPhone } from "@scalius/shared/customer-utils";
import type { CustomerFormValues } from "~/lib/customer-form-schema";
import { getStoreRegion } from "~/lib/store-time-zone";
import { rebaseForm } from "./shared/use-form-save-bar";

type SubmitOptions = {
  createFn: (values: CustomerFormValues) => Promise<unknown>;
  updateFn: (values: CustomerFormValues & { id: string }) => Promise<unknown>;
};
type ShellProps = {
  heading: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  readOnlyNotice?: ReactNode;
  canSave: boolean;
  form: UseFormReturn<CustomerFormValues>;
};
const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  submit: null as SubmitOptions | null,
  form: null as UseFormReturn<CustomerFormValues> | null,
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: (permission: string) => state.permissions.has(permission) }) }));
vi.mock("@/hooks/use-entity-form-submit", () => ({ useEntityFormSubmit: (options: SubmitOptions) => {
  state.submit = options;
  return { isSubmitting: false, handleSubmit: vi.fn() };
} }));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/api-client/sdk")>(),
  postApiV1AdminCustomers: state.post,
  putApiV1AdminCustomersById: state.put,
}));
vi.mock("@/lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/api")>(), apiData: (result: Promise<unknown>) => result }));
vi.mock("@/components/admin/shared/FormContainer", async () => {
  const { Form } = await import("~/components/ui/form");
  return { FormContainer: ({ heading, children, actions, readOnlyNotice, canSave, form }: ShellProps) => {
    state.form = form;
    void form.formState.isDirty;
    return <Form {...form}><h1>{heading}</h1>{actions}{readOnlyNotice}<fieldset disabled={!canSave}>{children}</fieldset></Form>;
  } };
});
vi.mock("./CustomerActivity", () => ({ CustomerActivity: () => null }));
vi.mock("./address/AddressFields", () => ({
  AddressFields: () => <div data-testid="first-address" />,
  SkipAddressValidation: () => null,
  useAddressErrors: () => ({}),
}));
vi.mock("./customers/CustomerAddressesCard", () => ({ CustomerAddressesCard: () => <div data-testid="saved-addresses" /> }));
vi.mock("./customers/CustomerMarketingCard", () => ({ CustomerMarketingCard: () => <div data-testid="marketing" /> }));
vi.mock("./custom-fields/CustomFieldsCard", () => ({ CustomFieldsCard: () => null }));
vi.mock("./apps/ui/AppActions", () => ({ AppActionsMenu: () => <div data-testid="app-actions" /> }));
vi.mock("./apps/ui/AppResourceCards", () => ({ AppResourceCards: () => null }));
vi.mock("./CustomerTrashNotice", () => ({ CustomerTrashNotice: () => <div data-testid="trash-notice" /> }));

import { CustomerForm } from "./CustomerForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const phone = "+8801712345678";
const saved = { id: "cust_view", name: "Saved customer", phone, email: "saved@example.test" };
const record = { ...saved, kind: "account" as const, deletedAt: null, mergedInto: null, tags: ["vip", "wholesale"] };

describe("customer saved values without edit permission", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;
  beforeEach(() => {
    state.permissions.clear();
    state.submit = null;
    state.form = null;
    state.post.mockReset().mockResolvedValue({ id: "cust_created" });
    state.put.mockReset().mockResolvedValue({ id: saved.id });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
  });
  const render = async (props: Parameters<typeof CustomerForm>[0] = { isEdit: true, defaultValues: saved, record }, key?: string) => {
    await act(async () => root.render(<QueryClientProvider client={client}><CustomerForm key={key} {...props} /></QueryClientProvider>));
  };
  const fact = (label: string) => [...host.querySelectorAll('[data-slot="field"]')]
    .find(field => field.querySelector('[data-slot="field-label"]')?.textContent === label)
    ?.querySelector('[data-slot="field-control"]')?.textContent;
  const typePhone = (value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="tel"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it.each([
    ["+8801712345678", "01712345678", "01712345679"],
    ["+14155552671", "+14155552671", "+14155552672"],
  ])("keeps %s clean after blur and edit/revert with the actual phone control", async (stored, draft, changed) => {
    state.permissions.add("customers.edit");
    await render({ isEdit: true, defaultValues: { ...saved, phone: stored }, record: { ...record, phone: stored } });
    expect(state.form!.getValues("phone")).toBe(draft);
    expect(state.form!.formState.isDirty).toBe(false);
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="tel"]')!;
      input.focus();
      input.blur();
    });
    expect(state.form!.formState.isDirty).toBe(false);
    await typePhone(changed);
    expect(state.form!.formState.isDirty).toBe(true);
    await typePhone(draft);
    expect(state.form!.formState.isDirty).toBe(false);
    expect(phoneNumberSchema.parse(draft)).toBe(stored);
    expect(validateAndFormatPhone(phoneNumberSchema.parse(draft))).toBe(stored);
    // Address writes carry E.164 too, even when the address is in another country.
    expect(validateAndFormatPhone(validateAndFormatPhone(draft), undefined, { defaultCountry: "US" })).toBe(stored);
  });

  it("keeps the phone draft clean after save acknowledgement, discard and a fresh server load", async () => {
    state.permissions.add("customers.edit");
    await render();
    await typePhone("01712345679");
    expect(state.form!.formState.isDirty).toBe(true);
    const sent = state.form!.getValues();
    const save = vi.fn(async (values: CustomerFormValues) => state.submit!.updateFn({ ...values, id: saved.id }));
    await act(async () => {
      await state.form!.handleSubmit(save)();
      rebaseForm(state.form!, sent, sent);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(state.put).toHaveBeenLastCalledWith({ path: { id: saved.id }, body: { name: saved.name, email: saved.email, phone: "+8801712345679" } });
    expect(state.form!.getValues("phone")).toBe("01712345679");
    expect(state.form!.formState.isDirty).toBe(false);
    await typePhone("01712345678");
    expect(state.form!.formState.isDirty).toBe(true);
    act(() => state.form!.reset());
    expect(state.form!.getValues("phone")).toBe("01712345679");
    expect(state.form!.formState.isDirty).toBe(false);
    await render({ isEdit: true, defaultValues: { ...saved, phone: "+8801712345679" }, record }, "refetched");
    expect(state.form!.getValues("phone")).toBe("01712345679");
    expect(state.form!.formState.isDirty).toBe(false);
  });

  it("shows saved contact and tag facts without inputs or tag mutation controls", async () => {
    await render();
    expect(fact("Name")).toBe(saved.name);
    expect(fact("Phone")).toBe(formatPhoneForDisplay(phone, getStoreRegion()));
    expect(fact("Email")).toBe(saved.email);
    expect(host.querySelector("input,textarea,select,button")).toBeNull();
    expect([...host.querySelectorAll('ul[aria-label="Tags"] li')].map(node => node.textContent)).toEqual(record.tags);
    expect(host.querySelector('[data-testid="app-actions"]')).not.toBeNull();
    expect(state.post).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
  });

  it("keeps the guest heading rule separate from its saved name fact", async () => {
    await render({ isEdit: true, defaultValues: { ...saved, name: "Stored guest name" }, record: { ...record, kind: "guest", name: "Stored guest name" } });
    expect(host.querySelector("h1")?.textContent).toBe(formatPhoneForDisplay(phone, getStoreRegion()));
    expect(fact("Name")).toBe("Stored guest name");
    expect(host.textContent).toContain("Checkout doesn't set this name");
  });

  it("shows absent contact values and the existing empty-tags message truthfully", async () => {
    await render({ isEdit: true, defaultValues: { ...saved, phone: "", email: null }, record: { ...record, phone: null, email: null, tags: [] } });
    expect(fact("Phone")).toBe("—");
    expect(fact("Email")).toBe("—");
    expect(host.textContent).toContain("No tags");
    expect(host.querySelector("input,button")).toBeNull();
  });

  it("shows saved values after edit permission is removed without discarding the draft", async () => {
    state.permissions.add("customers.edit");
    await render();
    act(() => state.form!.setValue("name", "Unsaved name", { shouldDirty: true }));
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Remove tag vip"]');
    expect(remove).not.toBeNull();
    act(() => remove!.click());
    state.permissions.clear();
    await render();
    expect(fact("Name")).toBe(saved.name);
    expect([...host.querySelectorAll('ul[aria-label="Tags"] li')].map(node => node.textContent)).toEqual(record.tags);
    expect(host.querySelector("input,button")).toBeNull();
    expect(state.form!.getValues("name")).toBe("Unsaved name");
    await render({ isEdit: true, defaultValues: { ...saved, name: "Fresh saved name" }, record: { ...record, name: "Fresh saved name" } });
    expect(fact("Name")).toBe("Fresh saved name");
  });

  it("keeps trashed customers read-only even with edit permission", async () => {
    state.permissions.add("customers.edit");
    await render({ isEdit: true, defaultValues: saved, record: { ...record, deletedAt: 1700000000 } });
    expect(fact("Name")).toBe(saved.name);
    expect(host.querySelector("input,button")).toBeNull();
    expect(host.querySelector('[data-testid="trash-notice"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="saved-addresses"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="marketing"], [data-testid="app-actions"], ul[aria-label="Tags"]')).toBeNull();
  });

  it("mounts first-address controls only when creating is permitted", async () => {
    await render({});
    expect(host.querySelector('input,[data-testid="first-address"]')).toBeNull();
    state.permissions.add("customers.create");
    await render({});
    expect(host.querySelector('input[name="name"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="first-address"]')).not.toBeNull();
  });

  it("preserves the existing editor payloads for absent phone, cleared email and empty first address", async () => {
    state.permissions.add("customers.edit");
    await render();
    expect(host.querySelector('input[name="name"]')).not.toBeNull();
    await state.submit!.updateFn({ ...saved, phone: "", email: null });
    expect(state.put).toHaveBeenCalledWith({ path: { id: saved.id }, body: { name: saved.name, email: null } });
    state.permissions.add("customers.create");
    await render({});
    await state.submit!.createFn({ name: "New customer", phone: "", email: "new@example.test" });
    expect(state.post).toHaveBeenCalledWith({ body: { name: "New customer", email: "new@example.test", phone: null, address: null } });
  });
});
