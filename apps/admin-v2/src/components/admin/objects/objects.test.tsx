// @vitest-environment happy-dom
/**
 * Content → Objects: the type list, the type form (create, edit, an
 * app's type read-only), the entry form sending typed values, and the types
 * of an app that is no longer installed ("From a removed app", Delete data).
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminObjectsDefinitions: vi.fn(),
  getApiV1AdminObjectsDefinitionsById: vi.fn(),
  postApiV1AdminObjectsDefinitions: vi.fn(),
  patchApiV1AdminObjectsDefinitionsById: vi.fn(),
  deleteApiV1AdminObjectsDefinitionsById: vi.fn(),
  getApiV1AdminObjectsDefinitionsByIdEntries: vi.fn(),
  getApiV1AdminObjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  postApiV1AdminObjectsDefinitionsByIdEntries: vi.fn(),
  patchApiV1AdminObjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  deleteApiV1AdminObjectsDefinitionsByIdEntriesByEntryId: vi.fn(),
  getApiV1AdminApps: vi.fn(),
  getApiV1AdminAppsRemovedData: vi.fn(),
  postApiV1AdminAppsRemovedDataByIdDelete: vi.fn(),
  postApiV1AdminAppsRemovedDataByIdHandOver: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/api")>();
  return { ...original, apiClient: {
    // A type read answers the type the entries fixture names; the entries list carries only records and nextCursor.
    get: (options: { url: string }) => options.url.endsWith("/types") ? sdk.getApiV1AdminObjectsDefinitions(options)
      : options.url.includes("/types/")
        ? sdk.getApiV1AdminObjectsDefinitionsByIdEntries(options).then((result: { data: { data: { type: unknown } } }) => ({ ...result, data: { success: true, data: { type: result.data.data.type } } }))
        : sdk.getApiV1AdminObjectsDefinitionsByIdEntries(options),
    post: (options: unknown) => sdk.postApiV1AdminObjectsDefinitions(options),
    patch: (options: unknown) => sdk.patchApiV1AdminObjectsDefinitionsById(options),
    put: (options: { body: { expectedRevision: number | null } }) => options.body.expectedRevision === null ? sdk.postApiV1AdminObjectsDefinitionsByIdEntries(options) : sdk.patchApiV1AdminObjectsDefinitionsByIdEntriesByEntryId(options),
    delete: vi.fn(),
  } };
});
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
import type { ObjectType, ObjectRecord } from "~/lib/api-query-options/objects";
import { ObjectRecordsList } from "./ObjectRecordsList";
import { ObjectRecordForm } from "./ObjectRecordForm";
import { ObjectTypeForm } from "./ObjectTypeForm";
import { ObjectTypesList } from "./ObjectTypesList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const stamps = { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };

const faq: ObjectType = {
  id: "mod_faq", handle: "custom.faq", namespace: "custom", type: "faq", name: "Questions and answers", description: null,
  fields: [
    { key: "question", name: "Question", type: "single_line_text", required: true, validations: {} },
    { key: "answer", name: "Answer", type: "multi_line_text", required: false, validations: {} },
  ],
  display: "question", storefront: true, owner: "merchant", admin: "edit", handleEnabled: true, indexes: [], unique: [], events: false, recordCount: 2, revision: 4, ...stamps,
};
const tiers: ObjectType = {
  id: "mod_tiers", handle: "acme.loyalty.tiers", namespace: "acme.loyalty", type: "tiers", name: "Loyalty tiers", description: null,
  fields: [{ key: "title", name: "Tier", type: "single_line_text", required: false, validations: {} }],
  display: null, storefront: false, owner: "app", admin: "edit", handleEnabled: true, indexes: [], unique: [], events: false, recordCount: 0, revision: 1, ...stamps,
};
const shipping: ObjectRecord = {
  id: "moe_ship", typeId: "mod_faq", handle: "shipping", displayName: "How long is shipping?", status: "published",
  data: { question: "How long is shipping?", answer: "Two days." }, position: 0, revision: 6, ...stamps,
};

const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("objects", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminObjectsDefinitions.mockImplementation(() => envelope({ nextCursor: null, types: [faq, tiers] }));
    sdk.getApiV1AdminObjectsDefinitionsByIdEntries.mockImplementation(() => envelope({ type: faq, records: [shipping], total: 1 }));
    sdk.getApiV1AdminApps.mockImplementation(() => envelope({ apps: [{ id: "acme.loyalty", name: "Acme Loyalty" }], available: [], sandboxAvailable: true }));
    sdk.getApiV1AdminAppsRemovedData.mockImplementation(() => envelope({ apps: [] }));
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.postApiV1AdminObjectsDefinitions.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ type: { ...faq, id: "mod_new", handle: `custom.${String(body.type)}`, type: body.type, name: body.name, fields: body.fields } }));
    sdk.patchApiV1AdminObjectsDefinitionsById.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ type: { ...faq, ...body, revision: faq.revision + 1 } }));
    sdk.postApiV1AdminObjectsDefinitionsByIdEntries.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ record: { ...shipping, id: "moe_new", ...body } }));
    sdk.patchApiV1AdminObjectsDefinitionsByIdEntriesByEntryId.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
      envelope({ record: { ...shipping, status: body.status ?? shipping.status, revision: shipping.revision + 1 } }));
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

  // Save lives only in the save bar (P4); outside the shell it renders into the body.
  const saveBarSave = () => [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")].find((each) => each.textContent?.trim() === "Save")!;
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

  it("respects an app type's read-only record policy", async () => {
    await render(<ObjectRecordForm definition={{ ...faq, owner: "app", admin: "read" }} entry={shipping} />);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Save")).toBeUndefined();
    expect(button("Delete entry")).toBeUndefined();
  });

  it("lists each object type with its handle, entries and whether the store shows it", async () => {
    await render(<ObjectTypesList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(first).toContain("Questions and answers");
    expect(first).toContain("custom.faq");
    expect(first).toContain("2 entries");
    expect(first).toContain("Shown on store");
    expect(second).toContain("Managed by app");
    expect(second).toContain("Private");
    expect(container.querySelector('a[href="/admin/objects/new"]')).not.toBeNull();
  });

  it("creates an object type from its name, fields, display field and storefront access", async () => {
    await render(<ObjectTypeForm definition={null} />);
    await typeInto(field("object-name"), "Size chart");
    // The handle follows the name until it is edited.
    expect(field("object-handle").getAttribute("value") ?? (field("object-handle") as HTMLInputElement).value).toBe("size_chart");
    const name = container.querySelector<HTMLInputElement>('input[id^="object-field-"][id$="-name"]')!;
    await typeInto(name, "Size label");
    await act(async () => button("Add field")!.click());
    const names = [...container.querySelectorAll<HTMLInputElement>('input[id^="object-field-"][id$="-name"]')];
    expect(names).toHaveLength(2);
    await typeInto(names[1]!, "Chest");
    // Pick the second field's type: a list of integers.
    const typeTriggers = [...container.querySelectorAll<HTMLElement>('button[id^="object-field-"][id$="-type"]')];
    await choose(typeTriggers[1]!, "List of Integer");
    await act(async () => container.querySelector<HTMLElement>('button[id^="object-field-"][id$="-required"]')!.click());
    await choose(field<HTMLButtonElement>("object-display"), "Chest");
    await act(async () => field<HTMLButtonElement>("object-storefront").click());

    // Save lives only in the save bar (P4).
    await act(async () => saveBarSave().click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminObjectsDefinitions).toHaveBeenCalled());
    expect(sdk.postApiV1AdminObjectsDefinitions.mock.calls[0]![0].body).toEqual({
      type: "size_chart",
      name: "Size chart",
      fields: [
        { key: "size_label", name: "Size label", type: "single_line_text", required: true, validations: {} },
        { key: "chest", name: "Chest", type: "list.integer", required: false, validations: {} },
      ],
      display: "chest",
      storefront: true,
      indexes: [],
      admin: "edit", handle: true,
    });
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/admin/objects/$type", params: { type: "custom.size_chart" } }),
    ));
  });

  it("saves a changed type at the revision it loaded and keeps the handle", async () => {
    await render(<ObjectTypeForm definition={faq} />);
    expect(field<HTMLInputElement>("object-handle").disabled).toBe(true);
    await typeInto(field("object-name"), "Frequently asked questions");
    await act(async () => saveBarSave().click());
    await vi.waitFor(() => expect(sdk.patchApiV1AdminObjectsDefinitionsById).toHaveBeenCalled());
    const call = sdk.patchApiV1AdminObjectsDefinitionsById.mock.calls[0]![0];
    expect(call.url).toBe("/api/v1/admin/objects/types/custom.faq");
    expect(call.body).toMatchObject({ name: "Frequently asked questions", expectedRevision: 4, storefront: true, display: "question" });
    expect(call.body).not.toHaveProperty("type");
  });

  it("keeps a field's key and type fixed once entries use it", async () => {
    await render(<ObjectTypeForm definition={faq} />);
    const keys = [...container.querySelectorAll<HTMLInputElement>('input[id^="object-field-"][id$="-key"]')];
    expect(keys.map((key) => key.disabled)).toEqual([true, true]);
    expect([...container.querySelectorAll<HTMLButtonElement>('button[id^="object-field-"][id$="-type"]')].map((trigger) => trigger.disabled)).toEqual([true, true]);
  });

  it("shows an app's object type read-only, managed by the app", async () => {
    await render(<ObjectTypeForm definition={tiers} />);
    await vi.waitFor(() => expect(container.textContent).toContain("Managed by Acme Loyalty"));
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(container.textContent).toContain("only the app can change its fields");
    expect(button("Save")).toBeUndefined();
    expect(button("Delete object type")).toBeUndefined();
  });

  it("names a removed app's types and lets only a Super Admin delete its data, under the listed revision", async () => {
    const demo: ObjectType = { ...tiers, id: "oty_scalius.bazaar.demo_items", handle: "scalius.bazaar.demo_items", namespace: "scalius.bazaar", type: "demo_items", name: "Demo items", admin: "read", recordCount: 3 };
    sdk.getApiV1AdminObjectsDefinitions.mockImplementation(() => envelope({ nextCursor: null, types: [faq, tiers, demo] }));
    sdk.getApiV1AdminAppsRemovedData.mockImplementation(() => envelope({ apps: [{
      id: "scalius.bazaar", name: "Bazaar demo", removedAt: "2026-10-20T08:00:00.000Z", revision: 2,
      objectTypes: 1, records: 3, objectTypeHandles: ["scalius.bazaar.demo_items"], customFields: 0, keyValues: 0,
      customerRoles: 0, jobs: 0, catalogItems: 0, settings: true,
      signerKeyId: "1a2b3c4d5e6f7a8b", waitingRelease: { source: "bundled", version: "2.0.0", signerKeyId: null },
    }] }));
    sdk.postApiV1AdminAppsRemovedDataByIdHandOver.mockImplementation(() => envelope({ id: "scalius.bazaar", revision: 3, installed: true }));
    sdk.postApiV1AdminAppsRemovedDataByIdDelete.mockImplementation(() => envelope({ id: "scalius.bazaar", deleted: true, catalogDeleted: 0, catalogKept: 0 }));

    await render(<ObjectTypesList />, { permissions: ["objects.view", "apps.view"] });
    await vi.waitFor(() => expect(container.textContent).toContain("From a removed app: Bazaar demo"));
    // An installed app's type still reads as managed by it.
    expect(container.textContent).toContain("Managed by app");
    expect(container.textContent).toContain("Data left by uninstalled apps");
    expect(container.textContent).toContain("1 object type, 3 entries, and its settings");
    expect(button("Delete data")).toBeUndefined();
    expect(button("Hand over data")).toBeUndefined();
    expect(container.textContent).toContain("Only the store owner can delete it or hand it over.");
    // Whose data it is, and the release it holds back.
    expect(container.textContent).toContain("Belongs to key 1a2b 3c4d 5e6f 7a8b");
    expect(container.textContent).toContain("Version 2.0.0 in your store's code is waiting to install.");

    act(() => root.unmount());
    root = createRoot(container);
    await render(<ObjectTypesList />, { isSuperAdmin: true });
    await vi.waitFor(() => expect(button("Delete data")).toBeDefined());
    await act(async () => button("Delete data")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Delete data from “Bazaar demo”?");
    expect(dialog.textContent).toContain("can't be undone");
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === "Delete data")!;
    expect(confirm.disabled).toBe(true);
    // The typed confirmation loads with the dialog.
    await vi.waitFor(() => expect(dialog.querySelector("input")).not.toBeNull());
    await act(async () => typeInto(dialog.querySelector("input")!, "Bazaar demo"));
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsRemovedDataByIdDelete).toHaveBeenCalledWith({
      path: { id: "scalius.bazaar" },
      body: { expectedRevision: 2 },
    }));

    // Or hand it to the waiting release, after saying what that release can then do.
    await vi.waitFor(() => expect(button("Hand over data")).toBeDefined());
    await act(async () => button("Hand over data")!.click());
    const handDialog = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find((each) => each.textContent?.includes("Hand data from"))!;
    expect(handDialog.textContent).toContain("Hand data from \u201cBazaar demo\u201d to version 2.0.0?");
    expect(handDialog.textContent).toContain("can then read and change 1 object type, 3 entries, and its settings");
    const handConfirm = [...handDialog.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === "Hand over data")!;
    await act(async () => handConfirm.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsRemovedDataByIdHandOver).toHaveBeenCalledWith({
      path: { id: "scalius.bazaar" },
      body: { expectedRevision: 2, signerKeyId: null },
    }));
  });

  it("shows a role that can only view the type read-only", async () => {
    await render(<ObjectTypeForm definition={faq} />, { permissions: ["objects.view"] });
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Save")).toBeUndefined();
    expect(container.textContent).toContain("You can view this page but not change it.");
  });

  it("draws indexed columns and sends exact leading-field filters", async () => {
    sdk.getApiV1AdminObjectsDefinitionsByIdEntries.mockImplementation(() => envelope({ type: { ...faq, indexes: ["answer"] }, records: [shipping], total: 1, nextCursor: null }));
    await render(<ObjectRecordsList type="custom.faq" />);
    await vi.waitFor(() => expect(container.querySelector("tbody")?.textContent).toContain("Two days."));
    const search = container.querySelector<HTMLInputElement>('input[placeholder="Match Answer exactly"]')!;
    await typeInto(search, "Two days.");
    await vi.waitFor(() => expect(sdk.getApiV1AdminObjectsDefinitionsByIdEntries.mock.lastCall?.[0].query.where).toBe(JSON.stringify({ answer: "Two days." })));
  });

  it("lists a type's entries", async () => {
    await render(<ObjectRecordsList type="mod_faq" />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(container.querySelector("tbody")!.textContent).toContain("How long is shipping?");
    expect(container.querySelector("tbody")!.textContent).toContain("Published");
    expect(container.querySelector('a[href="/admin/objects/mod_faq/records/moe_ship"]')).not.toBeNull();
    expect(container.textContent).not.toContain("This object type is private");
  });

  it("says when the store cannot show a private type", async () => {
    sdk.getApiV1AdminObjectsDefinitionsByIdEntries.mockImplementation(() => envelope({ type: { ...faq, storefront: false }, records: [], total: 0 }));
    await render(<ObjectRecordsList type="mod_faq" />);
    await vi.waitFor(() => expect(container.textContent).toContain("This object type is private"));
    expect(container.textContent).toContain("No entries yet");
  });

  it("adds an entry with each field's value typed", async () => {
    const places: ObjectType = {
      ...faq,
      id: "mod_places",
      fields: [
        { key: "title", name: "Name", type: "single_line_text", required: true, validations: {} },
        { key: "seats", name: "Seats", type: "integer", required: false, validations: {} },
        { key: "tags", name: "Tags", type: "list.single_line_text", required: false, validations: {} },
      ],
    };
    await render(<ObjectRecordForm definition={places} entry={null} />);
    await typeInto(field("object-entry-title"), "Gulshan");
    await typeInto(field("object-entry-seats"), "12");
    await typeInto(field("object-entry-tags"), "cafe");
    await act(async () => button("Add item")!.click());
    const tags = [...container.querySelectorAll<HTMLInputElement>('input[id^="object-entry-tags"]')];
    await typeInto(tags[1]!, "wifi");
    await act(async () => container.querySelector<HTMLElement>('button[role=radio][value=published]')!.click());
    await act(async () => saveBarSave().click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminObjectsDefinitionsByIdEntries).toHaveBeenCalled());
    const call = sdk.postApiV1AdminObjectsDefinitionsByIdEntries.mock.calls[0]![0];
    expect(call.url).toMatch(/^\/api\/v1\/admin\/objects\/custom.faq\/obj_/);
    expect(call.body).toEqual({ status: "published", expectedRevision: null, data: { title: "Gulshan", seats: "12", tags: ["cafe", "wifi"] } });
  });

  it("will not publish an entry before its required fields are filled", async () => {
    await render(<ObjectRecordForm definition={faq} entry={null} />);
    await typeInto(field("object-entry-answer"), "Because.");
    await act(async () => container.querySelector<HTMLElement>('button[role=radio][value=published]')!.click());
    await act(async () => saveBarSave().click());
    expect(sdk.postApiV1AdminObjectsDefinitionsByIdEntries).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Fill in this required field.");
  });

  it("saves the complete record at the revision it loaded", async () => {
    await render(<ObjectRecordForm definition={faq} entry={shipping} />);
    await typeInto(field<HTMLTextAreaElement>("object-entry-answer"), "One to two days.");
    await act(async () => saveBarSave().click());
    await vi.waitFor(() => expect(sdk.patchApiV1AdminObjectsDefinitionsByIdEntriesByEntryId).toHaveBeenCalled());
    const call = sdk.patchApiV1AdminObjectsDefinitionsByIdEntriesByEntryId.mock.calls[0]![0];
    expect(call.url).toBe("/api/v1/admin/objects/custom.faq/moe_ship");
    expect(call.body).toEqual({ expectedRevision: 6, status: "published", handle: "shipping", data: { question: "How long is shipping?", answer: "One to two days." } });
  });
});
