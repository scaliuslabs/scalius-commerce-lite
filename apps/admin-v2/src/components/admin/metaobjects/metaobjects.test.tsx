// @vitest-environment happy-dom
/**
 * Content → Content types: the type list, the type form (create, edit, an
 * app's type read-only) and the entry form sending typed values.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminMetaobjectsDefinitions: vi.fn(),
  getApiV1AdminMetaobjectsDefinitionsById: vi.fn(),
  postApiV1AdminMetaobjectsDefinitions: vi.fn(),
  patchApiV1AdminMetaobjectsDefinitionsById: vi.fn(),
  deleteApiV1AdminMetaobjectsDefinitionsById: vi.fn(),
  getApiV1AdminMetaobjectsDefinitionsByIdEntries: vi.fn(),
  getApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  postApiV1AdminMetaobjectsDefinitionsByIdEntries: vi.fn(),
  patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  deleteApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  getApiV1AdminApps: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => router.navigate,
  useLocation: ({ select }: { select?: (location: { hash: string }) => unknown } = {}) => (select ? select({ hash: "" }) : { hash: "" }),
  Link: ({ children, to, params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import type { MetaobjectDefinition, MetaobjectEntry } from "~/lib/api-query-options/metaobjects";
import { MetaobjectEntriesList } from "./MetaobjectEntriesList";
import { MetaobjectEntryForm } from "./MetaobjectEntryForm";
import { MetaobjectTypeForm } from "./MetaobjectTypeForm";
import { MetaobjectTypesList } from "./MetaobjectTypesList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const stamps = { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

const faq: MetaobjectDefinition = {
  id: "mod_faq", handle: "custom.faq", namespace: "custom", type: "faq", name: "Questions and answers", description: null,
  fields: [
    { key: "question", name: "Question", type: "single_line_text", required: true },
    { key: "answer", name: "Answer", type: "multi_line_text", required: false },
  ],
  displayField: "question", storefrontAccess: true, owner: "merchant", entryCount: 2, revision: 4, ...stamps,
};
const tiers: MetaobjectDefinition = {
  id: "mod_tiers", handle: "acme.loyalty.tiers", namespace: "acme.loyalty", type: "tiers", name: "Loyalty tiers", description: null,
  fields: [{ key: "title", name: "Tier", type: "single_line_text", required: false }],
  displayField: null, storefrontAccess: false, owner: "app", entryCount: 0, revision: 1, ...stamps,
};
const shipping: MetaobjectEntry = {
  id: "moe_ship", definitionId: "mod_faq", handle: "shipping", displayName: "How long is shipping?", status: "published",
  fields: { question: "How long is shipping?", answer: "Two days." }, position: 0, revision: 6, ...stamps,
};

const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

describe("content types", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [faq, tiers] }));
    sdk.getApiV1AdminMetaobjectsDefinitionsByIdEntries.mockImplementation(() => envelope({ definition: faq, entries: [shipping], total: 1 }));
    sdk.getApiV1AdminApps.mockImplementation(() => envelope({ apps: [{ id: "acme.loyalty", name: "Acme Loyalty" }], available: [], sandboxAvailable: true }));
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.postApiV1AdminMetaobjectsDefinitions.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ definition: { ...faq, id: "mod_new", handle: `custom.${String(body.type)}`, type: body.type, name: body.name, fields: body.fields } }));
    sdk.patchApiV1AdminMetaobjectsDefinitionsById.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ definition: { ...faq, ...body, revision: faq.revision + 1 } }));
    sdk.postApiV1AdminMetaobjectsDefinitionsByIdEntries.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ entry: { ...shipping, id: "moe_new", ...body } }));
    sdk.patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ entry: { ...shipping, status: body.status ?? shipping.status, revision: shipping.revision + 1 } }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(children: ReactNode, permissions: { isSuperAdmin?: boolean; permissions?: string[] } = { isSuperAdmin: true }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider {...permissions}>{children}</PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === label);
  const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => container.querySelector<Element>(`#${CSS.escape(id)}`)!;
  const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
      (element instanceof HTMLTextAreaElement ? setArea : set).call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  async function choose(trigger: HTMLElement, label: string) {
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim().startsWith(label));
    expect(option, label).toBeDefined();
    await act(async () => option!.click());
  }

  it("lists each content type with its handle, entries and whether the store shows it", async () => {
    await render(<MetaobjectTypesList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(first).toContain("Questions and answers");
    expect(first).toContain("custom.faq");
    expect(first).toContain("2 entries");
    expect(first).toContain("Shown on store");
    expect(second).toContain("Managed by app");
    expect(second).toContain("Private");
    expect(container.querySelector('a[href="/admin/metaobjects/new"]')).not.toBeNull();
  });

  it("creates a content type from its name, fields, display field and storefront access", async () => {
    await render(<MetaobjectTypeForm definition={null} />);
    await typeInto(field("metaobject-name"), "Size chart");
    // The handle follows the name until it is edited.
    expect(field("metaobject-handle").getAttribute("value") ?? (field("metaobject-handle") as HTMLInputElement).value).toBe("size_chart");
    const name = container.querySelector<HTMLInputElement>('input[id^="metaobject-field-"][id$="-name"]')!;
    await typeInto(name, "Size label");
    await act(async () => button("Add field")!.click());
    const names = [...container.querySelectorAll<HTMLInputElement>('input[id^="metaobject-field-"][id$="-name"]')];
    expect(names).toHaveLength(2);
    await typeInto(names[1]!, "Chest");
    // Pick the second field's type: a list of integers.
    const typeTriggers = [...container.querySelectorAll<HTMLElement>('button[id^="metaobject-field-"][id$="-type"]')];
    await choose(typeTriggers[1]!, "List of Integer");
    await act(async () => container.querySelector<HTMLElement>('button[id^="metaobject-field-"][id$="-required"]')!.click());
    await choose(field<HTMLButtonElement>("metaobject-display"), "Chest");
    await act(async () => field<HTMLButtonElement>("metaobject-storefront").click());

    await act(async () => button("Create content type")!.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminMetaobjectsDefinitions).toHaveBeenCalled());
    expect(sdk.postApiV1AdminMetaobjectsDefinitions.mock.calls[0]![0].body).toEqual({
      type: "size_chart",
      name: "Size chart",
      fields: [
        { key: "size_label", name: "Size label", type: "single_line_text", required: true },
        { key: "chest", name: "Chest", type: "list.integer", required: false },
      ],
      displayField: "chest",
      storefrontAccess: true,
    });
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/admin/metaobjects/$definitionId", params: { definitionId: "mod_new" } }),
    ));
  });

  it("saves a changed type at the revision it loaded and keeps the handle", async () => {
    await render(<MetaobjectTypeForm definition={faq} />);
    expect(field<HTMLInputElement>("metaobject-handle").disabled).toBe(true);
    await typeInto(field("metaobject-name"), "Frequently asked questions");
    await act(async () => button("Save")!.click());
    await vi.waitFor(() => expect(sdk.patchApiV1AdminMetaobjectsDefinitionsById).toHaveBeenCalled());
    const call = sdk.patchApiV1AdminMetaobjectsDefinitionsById.mock.calls[0]![0];
    expect(call.path).toEqual({ id: "mod_faq" });
    expect(call.body).toMatchObject({ name: "Frequently asked questions", expectedRevision: 4, storefrontAccess: true, displayField: "question" });
    expect(call.body).not.toHaveProperty("type");
  });

  it("keeps a field's key and type fixed once entries use it", async () => {
    await render(<MetaobjectTypeForm definition={faq} />);
    const keys = [...container.querySelectorAll<HTMLInputElement>('input[id^="metaobject-field-"][id$="-key"]')];
    expect(keys.map((key) => key.disabled)).toEqual([true, true]);
    expect([...container.querySelectorAll<HTMLButtonElement>('button[id^="metaobject-field-"][id$="-type"]')].map((trigger) => trigger.disabled)).toEqual([true, true]);
  });

  it("shows an app's content type read-only, managed by the app", async () => {
    await render(<MetaobjectTypeForm definition={tiers} />);
    await vi.waitFor(() => expect(container.textContent).toContain("Managed by Acme Loyalty"));
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(container.textContent).toContain("only the app can change its fields");
    expect(button("Save")).toBeUndefined();
    expect(button("Delete content type")).toBeUndefined();
  });

  it("shows a role that can only view the type read-only", async () => {
    await render(<MetaobjectTypeForm definition={faq} />, { permissions: ["metaobjects.view"] });
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Save")).toBeUndefined();
    expect(container.textContent).toContain("You can view this but not change it.");
  });

  it("lists a type's entries", async () => {
    await render(<MetaobjectEntriesList definitionId="mod_faq" />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(container.querySelector("tbody")!.textContent).toContain("How long is shipping?");
    expect(container.querySelector("tbody")!.textContent).toContain("Published");
    expect(container.querySelector('a[href="/admin/metaobjects/mod_faq/entries/moe_ship"]')).not.toBeNull();
    expect(container.textContent).not.toContain("This content type is private");
  });

  it("says when the store cannot show a private type", async () => {
    sdk.getApiV1AdminMetaobjectsDefinitionsByIdEntries.mockImplementation(() => envelope({ definition: { ...faq, storefrontAccess: false }, entries: [], total: 0 }));
    await render(<MetaobjectEntriesList definitionId="mod_faq" />);
    await vi.waitFor(() => expect(container.textContent).toContain("This content type is private"));
    expect(container.textContent).toContain("No entries yet");
  });

  it("adds an entry with each field's value typed", async () => {
    const places: MetaobjectDefinition = {
      ...faq,
      id: "mod_places",
      fields: [
        { key: "title", name: "Name", type: "single_line_text", required: true },
        { key: "seats", name: "Seats", type: "integer", required: false },
        { key: "tags", name: "Tags", type: "list.single_line_text", required: false },
      ],
    };
    await render(<MetaobjectEntryForm definition={places} entry={null} />);
    await typeInto(field("metaobject-entry-title"), "Gulshan");
    await typeInto(field("metaobject-entry-seats"), "12");
    await typeInto(field("metaobject-entry-tags"), "cafe");
    await act(async () => button("Add item")!.click());
    const tags = [...container.querySelectorAll<HTMLInputElement>('input[id^="metaobject-entry-tags"]')];
    await typeInto(tags[1]!, "wifi");
    await act(async () => container.querySelector<HTMLElement>('button[role=radio][value=published]')!.click());
    await act(async () => button("Add entry")!.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminMetaobjectsDefinitionsByIdEntries).toHaveBeenCalled());
    const call = sdk.postApiV1AdminMetaobjectsDefinitionsByIdEntries.mock.calls[0]![0];
    expect(call.path).toEqual({ id: "mod_places" });
    expect(call.body).toEqual({ status: "published", fields: { title: "Gulshan", seats: "12", tags: ["cafe", "wifi"] } });
  });

  it("will not publish an entry before its required fields are filled", async () => {
    await render(<MetaobjectEntryForm definition={faq} entry={null} />);
    await typeInto(field("metaobject-entry-answer"), "Because.");
    await act(async () => container.querySelector<HTMLElement>('button[role=radio][value=published]')!.click());
    await act(async () => button("Add entry")!.click());
    expect(sdk.postApiV1AdminMetaobjectsDefinitionsByIdEntries).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Fill this in to publish.");
  });

  it("saves only the changed fields of an entry at the revision it loaded", async () => {
    await render(<MetaobjectEntryForm definition={faq} entry={shipping} />);
    await typeInto(field<HTMLTextAreaElement>("metaobject-entry-answer"), "One to two days.");
    await act(async () => button("Save")!.click());
    await vi.waitFor(() => expect(sdk.patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId).toHaveBeenCalled());
    const call = sdk.patchApiV1AdminMetaobjectsDefinitionsByIdEntriesByEntryId.mock.calls[0]![0];
    expect(call.path).toEqual({ id: "mod_faq", entryId: "moe_ship" });
    expect(call.body).toEqual({ expectedRevision: 6, fields: { answer: "One to two days." } });
  });
});
