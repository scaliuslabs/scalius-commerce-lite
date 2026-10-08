// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
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
import { CustomFieldsCard } from "./CustomFieldsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customFieldMessages.en, vars?: Record<string, string | number>) => translate(customFieldMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const refused = (status: number, code: string, message: string, details?: unknown) =>
  Promise.resolve({ error: { success: false, error: { code, message, details } }, response: { status } });

const definition = (id: string, key: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, ownerType: "product", namespace: "custom", key, name: key, description: null, type,
  validations: { min: null, max: null, regex: null, choices: null }, storefrontVisible: false, position: 0, revision: 1,
  createdAt: "", updatedAt: "", ...extra,
});

const FIELDS = {
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

  beforeEach(() => {
    vi.clearAllMocks();
    scope = null;
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => ok({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.getApiV1AdminCustomFieldsProductByOwnerId.mockImplementation(() => ok(FIELDS));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(inScope: boolean) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const card = <CustomFieldsCard ownerType="product" ownerId="prod_a" canEdit />;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            {inScope ? <SaveScope render={(state) => { scope = state; return null; }}>{card}</SaveScope> : card}
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(input("custom-field-cfd_care").value).toBe("Hand wash"));
  }

  it("renders an input per field and keeps a plugin's field read-only", async () => {
    await render(false);
    expect(sdk.getApiV1AdminCustomFieldsProductByOwnerId).toHaveBeenCalledWith({ path: { ownerId: "prod_a" } });
    expect(input("custom-field-cfd_sizes").value).toBe("38");
    expect(input("custom-field-cfd_sizes-1").value).toBe("40");
    expect(input("custom-field-cfd_points").disabled).toBe(true);
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
});
