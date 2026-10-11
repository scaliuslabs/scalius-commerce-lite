// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime, setLocale, translate } from "~/i18n";
import { setStoreRegion, setStoreTimeZone } from "~/lib/store-time-zone";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { CustomFieldListType, CustomFieldType, CustomFieldWireValue } from "@scalius/shared/custom-fields";
import { customFieldValuesQueryOptions, type CustomFieldDefinition, type CustomFieldEntry, type CustomFieldOwnerValues } from "~/lib/api-query-options/custom-fields";
import { customFieldMessages } from "~/i18n/custom-fields";

const sdk = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    getApiV1AdminSettingsCurrency: fn(),
    getApiV1AdminProducts: fn(),
    getApiV1AdminCollections: fn(),
    getApiV1AdminProductsByIds: fn(),
    getApiV1AdminCollectionsByIds: fn(),
    getApiV1AdminCustomFieldDefinitions: fn(),
    postApiV1AdminCustomFieldDefinitions: fn(),
    patchApiV1AdminCustomFieldDefinitionsById: fn(),
    deleteApiV1AdminCustomFieldDefinitionsById: fn(),
    postApiV1AdminCustomFieldDefinitionsReorder: fn(),
    getApiV1AdminCustomFieldsProductByOwnerId: fn(),
    putApiV1AdminCustomFieldsProductByOwnerId: fn(),
    getApiV1AdminCustomFieldsVariantByOwnerId: fn(),
    putApiV1AdminCustomFieldsVariantByOwnerId: fn(),
    getApiV1AdminCustomFieldsCustomerByOwnerId: fn(),
    putApiV1AdminCustomFieldsCustomerByOwnerId: fn(),
    getApiV1AdminCustomFieldsOrderByOwnerId: fn(),
    putApiV1AdminCustomFieldsOrderByOwnerId: fn(),
    getApiV1AdminCustomFieldsCategoryByOwnerId: fn(),
    putApiV1AdminCustomFieldsCategoryByOwnerId: fn(),
    getApiV1AdminCustomFieldsCollectionByOwnerId: fn(),
    putApiV1AdminCustomFieldsCollectionByOwnerId: fn(),
    getApiV1AdminCustomFieldsBrandByOwnerId: fn(),
    putApiV1AdminCustomFieldsBrandByOwnerId: fn(),
    getApiV1AdminCustomFieldsPageByOwnerId: fn(),
    putApiV1AdminCustomFieldsPageByOwnerId: fn(),
  };
});
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope, type SaveScopeState } from "~/components/admin/shared/SaveBar";
import { CustomFieldsCard, VariantCustomFieldsDialog } from "./CustomFieldsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customFieldMessages.en, vars?: Record<string, string | number>) => translate(customFieldMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const refused = (status: number, code: string, message: string, details?: unknown) =>
  Promise.resolve({ error: { success: false, error: { code, message, details } }, response: { status } });

const definition = (id: string, key: string, type: CustomFieldType, extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id, ownerType: "product", namespace: "custom", key, name: key, description: null, type,
  validations: { min: null, max: null, regex: null, choices: null }, storefrontVisible: false, position: 0, revision: 1,
  createdAt: "", updatedAt: "", ...extra,
});

const FIELDS: CustomFieldOwnerValues = {
  ownerType: "product",
  ownerId: "prod_a",
  fields: [
    { definition: definition("cfd_care", "Care", "single_line_text", { validations: { min: null, max: 10, regex: null, choices: null } }), value: "Hand wash", updatedAt: "" },
    { definition: definition("cfd_sizes", "Sizes", "list.integer"), value: [38, 40], updatedAt: "" },
    { definition: definition("cfd_points", "Points", "integer", { namespace: "acme.loyalty" }), value: 12, updatedAt: "" },
  ],
};

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input ${id}`);
  return element;
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);

describe("custom data card", () => {
  let root: Root;
  let container: HTMLDivElement;
  let scope: SaveScopeState | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    scope = null;
    setLocale("en");
    setStoreRegion("BD");
    setStoreTimeZone("Asia/Dhaka");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => ok({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.getApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => ok(FIELDS));
    sdk.getApiV1AdminProductsByIds.mockImplementation(() => ok({ products: [{ id: "prod_known", name: "Saved product" }] }));
    sdk.getApiV1AdminCollectionsByIds.mockImplementation(() => ok({ collections: [{ id: "col_known", name: "Saved collection" }] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    setLocale("en");
    setStoreTimeZone("Asia/Dhaka");
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(inScope: boolean, canEdit = true, permissions?: string[]) {
    const card = <CustomFieldsCard ownerType="product" ownerId="prod_a" canEdit={canEdit} />;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin={permissions === undefined} permissions={permissions}>
            {inScope ? <SaveScope render={(state) => { scope = state; return null; }}>{card}</SaveScope> : card}
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(canEdit ? input("custom-field-cfd_care").value : savedValue("Care")).toBe("Hand wash"));
  }

  function field(name: string) {
    return [...document.querySelectorAll<HTMLElement>('[data-slot="field"]')]
      .find((element) => element.querySelector('[data-slot="field-label"]')?.textContent?.startsWith(`${name} (`));
  }

  const savedValue = (name: string) => field(name)?.querySelector('[data-slot="field-control"]')?.textContent;
  const entry = (name: string, type: CustomFieldType, value: CustomFieldWireValue): CustomFieldEntry => ({ definition: definition(`cfd_${name.replace(/[^a-z0-9]/gi, "_")}`, name, type), value, updatedAt: "" });
  const load = (entries: CustomFieldEntry[]) => sdk.getApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => ok({ ...FIELDS, fields: [...FIELDS.fields, ...entries] }));

  it("renders an input per field and keeps a plugin's field read-only", async () => {
    await render(false);
    expect(sdk.getApiV1AdminCustomFieldsProductByOwnerId).toHaveBeenCalledWith({ path: { ownerId: "prod_a" } });
    expect(input("custom-field-cfd_sizes").value).toBe("38");
    expect(input("custom-field-cfd_sizes-1").value).toBe("40");
    expect(field("Points")?.querySelector("input, textarea, [role=combobox]")).toBeNull();
    expect(savedValue("Points")).toBe("12");
    expect(container.textContent).toContain(t("managedBy", { namespace: "acme.loyalty" }));
    expect(container.querySelector('a[href="/admin/settings/custom-data"]')?.textContent).toBe(t("manageFields"));
    // Nothing changed: no Save of its own.
    expect(button(t("saveCard"))).toBeUndefined();
  });

  it("checks values with the shared codec and saves only the changed ones on a page without a save bar", async () => {
    await render(false);
    await type(input("custom-field-cfd_care"), "Dry clean only, please");
    expect(container.textContent).toContain(t("issue.too_long", { limit: 10 }));
    await act(async () => button(t("saveCard"))!.click());
    expect(sdk.putApiV1AdminCustomFieldsProductByOwnerId).not.toHaveBeenCalled();

    await type(input("custom-field-cfd_care"), "Dry clean");
    await type(input("custom-field-cfd_sizes-1"), "42");
    sdk.putApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => ok({
      ...FIELDS,
      fields: [
        { ...FIELDS.fields[0], value: "Dry clean" },
        { ...FIELDS.fields[1], value: [38, 42] },
        FIELDS.fields[2],
      ],
    }));
    await act(async () => button(t("saveCard"))!.click());
    expect(sdk.putApiV1AdminCustomFieldsProductByOwnerId).toHaveBeenCalledWith({
      path: { ownerId: "prod_a" },
      body: { values: [{ definitionId: "cfd_care", value: "Dry clean" }, { definitionId: "cfd_sizes", value: ["38", "42"] }] },
    });
    await vi.waitFor(() => expect(button(t("saveCard"))).toBeUndefined());
  });

  it("saves with the page's save scope, shows the API's field problems and reports a stale definition as a conflict", async () => {
    await render(true);
    await type(input("custom-field-cfd_care"), "Machine");
    expect(scope!.dirty).toBe(true);
    expect(button(t("saveCard"))).toBeUndefined();

    sdk.putApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => refused(400, "VALIDATION_ERROR", "bad", {
      issues: [{ path: ["values", 0, "value"], code: "pattern", message: "The value does not match the required pattern." }],
    }));
    let saved = true;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(container.textContent).toContain(t("issue.pattern"));

    sdk.putApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => refused(409, "CUSTOM_FIELD_REVISION_CONFLICT", "changed"));
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(scope!.failure).toBe("conflict");

    sdk.putApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => ok({ ...FIELDS, fields: [{ ...FIELDS.fields[0], value: "Machine" }, FIELDS.fields[1], FIELDS.fields[2]] }));
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    await vi.waitFor(() => expect(scope!.dirty).toBe(false));
  });

  it.each(["en", "bn"] as const)("shows saved scalar values in %s without editors or lost precision", async (locale) => {
    setLocale(locale);
    setStoreTimeZone("America/Los_Angeles");
    load([
      entry("Text", "single_line_text", "Saved text"),
      entry("Multiline", "multi_line_text", "First\nSecond"),
      entry("Zero", "integer", 0),
      entry("Decimal", "decimal", "123456789012345678.123456789"),
      entry("Negative", "decimal", "-0.123456789"),
      entry("False", "boolean", false),
      entry("True", "boolean", true),
      entry("Day", "date", "2026-03-01"),
      entry("Instant", "date_time", "2026-03-01T00:00:01Z"),
      entry("URL", "url", "https://example.test/saved"),
      entry("Colour", "color", "#aabbcc"),
      entry("JSON", "json", { text: "<b>Saved</b>" }),
      entry("JSON false", "json", false),
      entry("JSON zero", "json", 0),
      entry("JSON text", "json", ""),
      entry("JSON list", "json", []),
      entry("Money", "money", 12.5),
      entry("No cost", "money", 0),
      entry("Product", "product_reference", "prod_known"),
      entry("Collection", "collection_reference", "col_known"),
      entry("Variant", "variant_reference", "var_saved"),
      entry("File", "media_reference", "media_saved"),
      entry("Unset", "money", null),
    ]);
    await render(false, false);
    await vi.waitFor(() => expect(savedValue("Product")).toBe("Saved product"));
    await vi.waitFor(() => expect(savedValue("Collection")).toBe("Saved collection"));
    expect(container.querySelector("input, textarea, select, [role=combobox]")).toBeNull();
    expect(savedValue("Text")).toBe("Saved text");
    expect(savedValue("Multiline")).toBe("First\nSecond");
    expect(savedValue("Zero")).toBe(locale === "en" ? "0" : "০");
    expect(savedValue("Decimal")).toBe(locale === "en" ? "1,23,45,67,89,01,23,45,678.123456789" : "১,২৩,৪৫,৬৭,৮৯,০১,২৩,৪৫,৬৭৮.১২৩৪৫৬৭৮৯");
    expect(savedValue("Negative")).toBe(locale === "en" ? "-0.123456789" : "-০.১২৩৪৫৬৭৮৯");
    expect(savedValue("False")).toBe(t("no"));
    expect(savedValue("True")).toBe(t("yes"));
    expect(savedValue("Day")).toBe(formatDateTime(new Date("2026-03-01T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" }));
    expect(savedValue("Instant")).toBe(formatDateTime(new Date("2026-03-01T00:00:01Z"), { dateStyle: "medium", timeStyle: "medium" }));
    expect(savedValue("URL")).toBe("https://example.test/saved");
    expect(field("URL")?.querySelector("a")).toBeNull();
    expect(savedValue("Colour")).toBe("#aabbcc");
    expect(savedValue("JSON")).toBe('{\n  "text": "<b>Saved</b>"\n}');
    expect(field("JSON")?.querySelector("b")).toBeNull();
    expect(savedValue("JSON false")).toBe("false");
    expect(savedValue("JSON zero")).toBe("0");
    expect(savedValue("JSON text")).toBe('""');
    expect(savedValue("JSON list")).toBe("[]");
    expect(savedValue("Money")).toBe(locale === "en" ? "৳12.50" : "৳১২.৫০");
    expect(savedValue("No cost")).toBe(locale === "en" ? "৳0.00" : "৳০.০০");
    expect(savedValue("Unset")).toBe("—");
    expect(savedValue("Variant")).toBe("var_saved");
    expect(savedValue("File")).toBe("media_saved");
    expect(button(t("saveCard"))).toBeUndefined();
    expect(button(t("discard"))).toBeUndefined();
    expect(container.textContent).not.toContain(t("dateTimeHelp"));
    expect(sdk.putApiV1AdminCustomFieldsProductByOwnerId).not.toHaveBeenCalled();
  });

  it("keeps every supported list item in saved order and shows an empty list as absent", async () => {
    const cases: Array<[CustomFieldListType, CustomFieldWireValue[], string[]]> = [
      ["list.single_line_text", ["B", "A"], ["B", "A"]],
      ["list.multi_line_text", ["First\nSecond", "Last"], ["First\nSecond", "Last"]],
      ["list.integer", [0, 12], ["0", "12"]],
      ["list.decimal", ["0", "1.123456789"], ["0", "1.123456789"]],
      ["list.date", ["2026-03-01"], [formatDateTime(new Date("2026-03-01T00:00:00Z"), { dateStyle: "medium", timeZone: "UTC" })]],
      ["list.date_time", ["2026-03-01T00:00:01Z"], [formatDateTime(new Date("2026-03-01T00:00:01Z"), { dateStyle: "medium", timeStyle: "medium" })]],
      ["list.url", ["/saved", "https://example.test"], ["/saved", "https://example.test"]],
      ["list.color", ["#aabbcc", "#ffffff"], ["#aabbcc", "#ffffff"]],
      ["list.money", [0, 12.5], ["৳0.00", "৳12.50"]],
      ["list.product_reference", ["prod_known", "prod_missing"], ["Saved product", "prod_missing"]],
      ["list.collection_reference", ["col_known", "col_missing"], ["Saved collection", "col_missing"]],
      ["list.variant_reference", ["var_b", "var_a"], ["var_b", "var_a"]],
      ["list.media_reference", ["media_b", "media_a"], ["media_b", "media_a"]],
    ];
    load([...cases.map(([type, value]) => entry(type, type, value)), entry("Empty list", "list.integer", [])]);
    await render(false, false);
    await vi.waitFor(() => expect(savedValue("list.collection_reference")).toContain("Saved collection"));
    for (const [type, , expected] of cases) {
      expect([...field(type)!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(expected);
    }
    expect(savedValue("Empty list")).toBe("—");
  });

  it.each([
    ["JPY", "¥", 123, "¥123"],
    ["KWD", "KD", 1.234, "KD1.234"],
  ] as const)("uses the saved %s currency exponent", async (currencyCode, currencySymbol, amount, expected) => {
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => ok({ currencyCode, currencySymbol }));
    load([entry("Amount", "money", amount)]);
    await render(false, false);
    await vi.waitFor(() => expect(savedValue("Amount")).toBe(expected));
  });

  it("resolves all 128 references in bounded batches while preserving duplicates and order", async () => {
    const ids = Array.from({ length: 127 }, (_, index) => `col_${index}`);
    ids.push("col_0");
    sdk.getApiV1AdminCollectionsByIds.mockImplementation(({ query }: { query: { ids: string } }) => ok({
      collections: query.ids.split(",").filter((id) => id !== "col_126").map((id) => ({ id, name: `Saved ${id}` })),
    }));
    load([entry("References", "list.collection_reference", ids)]);
    await render(false, false);
    await vi.waitFor(() => expect(savedValue("References")).toContain("Saved col_125"));
    const shown = [...field("References")!.querySelectorAll("li")].map((li) => li.textContent);
    expect(shown).toEqual(ids.map((id) => id === "col_126" ? id : `Saved ${id}`));
    expect(sdk.getApiV1AdminCollectionsByIds).toHaveBeenCalledTimes(2);
    const batches = sdk.getApiV1AdminCollectionsByIds.mock.calls.map(([call]) => call.query.ids.split(","));
    expect(batches.every((batch) => batch.length <= 90)).toBe(true);
    expect(new Set(batches.flat()).size).toBe(127);
  });

  it("retains saved IDs when a lookup fails or its view permission is missing", async () => {
    sdk.getApiV1AdminProductsByIds.mockImplementation(() => refused(403, "FORBIDDEN", "Unavailable"));
    load([entry("Product", "product_reference", "prod_known"), entry("Collection", "collection_reference", "col_known")]);
    await render(false, false);
    await vi.waitFor(() => expect(savedValue("Collection")).toBe("Saved collection"));
    expect(savedValue("Product")).toBe("prod_known");
    expect(field("Product")?.querySelector("code")?.textContent).toBe("prod_known");
    const calls = sdk.getApiV1AdminCollectionsByIds.mock.calls.length;
    const productCalls = sdk.getApiV1AdminProductsByIds.mock.calls.length;
    await render(false, false, [PERMISSIONS.SETTINGS_GENERAL_VIEW]);
    expect(savedValue("Collection")).toBe("col_known");
    expect(savedValue("Product")).toBe("prod_known");
    expect(sdk.getApiV1AdminCollectionsByIds).toHaveBeenCalledTimes(calls);
    expect(sdk.getApiV1AdminProductsByIds).toHaveBeenCalledTimes(productCalls);
    expect(container.querySelector('a[href="/admin/settings/custom-data"]')).not.toBeNull();
    await render(false, false, []);
    expect(container.querySelector('a[href="/admin/settings/custom-data"]')).toBeNull();
  });

  it("shows saved data immediately after edit permission is revoked, then follows a server refresh", async () => {
    await render(true);
    await type(input("custom-field-cfd_care"), "Unsaved invalid draft");
    expect(scope!.dirty).toBe(true);
    await render(true, false);
    expect(savedValue("Care")).toBe("Hand wash");
    expect(container.textContent).not.toContain("Unsaved invalid draft");
    expect(container.querySelector("input, textarea, [role=combobox], [data-slot=field-error]")).toBeNull();
    expect(scope!.dirty).toBe(false);
    expect(scope!.invalid).toBe(false);
    await act(async () => {
      queryClient.setQueryData(customFieldValuesQueryOptions("product", "prod_a").queryKey, {
        ...FIELDS, fields: [{ ...FIELDS.fields[0], value: "New saved" }, FIELDS.fields[1], FIELDS.fields[2]],
      });
    });
    await vi.waitFor(() => expect(savedValue("Care")).toBe("New saved"));
    expect(sdk.putApiV1AdminCustomFieldsProductByOwnerId).not.toHaveBeenCalled();
  });

  it("updates saved plugin values while preserving an editable neighbour's draft", async () => {
    await render(false);
    await type(input("custom-field-cfd_care"), "Draft");
    await act(async () => {
      queryClient.setQueryData(customFieldValuesQueryOptions("product", "prod_a").queryKey, {
        ...FIELDS, fields: [FIELDS.fields[0], FIELDS.fields[1], { ...FIELDS.fields[2], value: 99 }],
      });
    });
    await vi.waitFor(() => expect(savedValue("Points")).toBe("99"));
    expect(input("custom-field-cfd_care").value).toBe("Draft");
  });

  it("removes the variant dialog Save action for viewers and keeps Cancel usable", async () => {
    sdk.getApiV1AdminCustomFieldsVariantByOwnerId.mockImplementation(() => ok({ ...FIELDS, ownerType: "variant", ownerId: "var_saved" }));
    const close = vi.fn();
    const show = async (canEdit: boolean) => act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider isSuperAdmin>
          <VariantCustomFieldsDialog variantId="var_saved" sku="SKU-SAVED" canEdit={canEdit} open onOpenChange={close} />
        </PermissionProvider>
      </QueryClientProvider>,
    ));
    await show(true);
    await vi.waitFor(() => expect(button(t("save"))).toBeDefined());
    expect(button(t("save"))!.disabled).toBe(true);
    await show(false);
    await vi.waitFor(() => expect(savedValue("Care")).toBe("Hand wash"));
    expect(button(t("save"))).toBeUndefined();
    expect(document.querySelector('[role="dialog"] input')).toBeNull();
    await act(async () => button(t("cancel"))!.click());
    expect(close).toHaveBeenCalledWith(false);
  });

});
