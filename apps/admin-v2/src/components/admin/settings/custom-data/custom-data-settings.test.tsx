// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customFieldMessages } from "~/i18n/custom-fields";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCurrency: vi.fn(),
  getApiV1AdminCustomFieldDefinitions: vi.fn(),
  postApiV1AdminCustomFieldDefinitions: vi.fn(),
  patchApiV1AdminCustomFieldDefinitionsById: vi.fn(),
  deleteApiV1AdminCustomFieldDefinitionsById: vi.fn(),
  postApiV1AdminCustomFieldDefinitionsReorder: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { CustomDataSettings } from "./CustomDataSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customFieldMessages.en, vars?: Record<string, string | number>) => translate(customFieldMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const definition = (id: string, ownerType: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, ownerType, namespace: "custom", key: name.toLowerCase(), name, description: null, type: "single_line_text",
  validations: { min: null, max: null, regex: null, choices: null }, storefrontVisible: false, position: 0, revision: 3,
  createdAt: "", updatedAt: "", valueCount: 0, ...extra,
});

describe("custom data settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => ok({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.getApiV1AdminCustomFieldDefinitions.mockImplementation(() => ok({
      definitions: [
        definition("cfd_care", "product", "Care", { storefrontVisible: true, valueCount: 12, position: 0 }),
        definition("cfd_points", "product", "Points", { namespace: "acme.loyalty", type: "integer", position: 1 }),
        definition("cfd_vip", "customer", "VIP", { type: "boolean" }),
      ],
    }));
    sdk.postApiV1AdminCustomFieldDefinitionsReorder.mockImplementation(() => ok({ definitions: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin><CustomDataSettings /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Care"));
  }

  it("lists one owner type's fields with their binding, type, value count and owner", async () => {
    await render();
    const rows = [...container.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("custom.care");
    expect(rows[0]!.textContent).toContain(t("storefront"));
    expect(rows[0]!.textContent).toContain(t("valueCount", { count: 12 }));
    expect(rows[1]!.textContent).toContain(t("managedBy", { namespace: "acme.loyalty" }));
    expect(container.textContent).not.toContain("VIP");
    // Only the merchant's own field has edit and delete.
    expect(container.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1);
  });

  async function openAddField(name: string) {
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === t("addField"))!;
    await act(async () => add.click());
    const input = document.getElementById("custom-field-definition-name") as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return document.querySelector<HTMLButtonElement>('button[type="submit"][form="custom-field-definition-form"]')!;
  }

  it("creates a field once when Add field is double-clicked, and closes as created", async () => {
    const { toast } = await import("sonner");
    let answer!: () => void;
    sdk.postApiV1AdminCustomFieldDefinitions.mockImplementation(() => new Promise((resolve) => {
      answer = () => resolve({ data: { success: true, data: { definition: definition("cfd_fit", "product", "Fit") } }, response: { status: 201 } });
    }));
    await render();
    const submit = await openAddField("Fit");

    // Both clicks land before React draws the pending state.
    await act(async () => {
      submit.click();
      submit.click();
    });
    await act(async () => answer());

    expect(sdk.postApiV1AdminCustomFieldDefinitions).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.getElementById("custom-field-definition-form")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(t("created"));
    expect(document.body.textContent).not.toContain(t("keyTaken"));
  });

  it("takes its own earlier create, whose answer was lost, as created instead of 'key taken'", async () => {
    const { toast } = await import("sonner");
    sdk.postApiV1AdminCustomFieldDefinitions
      .mockImplementationOnce(() => Promise.reject(new Error("Failed to fetch")))
      .mockImplementationOnce(() => Promise.resolve({
        error: { success: false, error: { code: "CUSTOM_FIELD_KEY_TAKEN", message: "Another field already uses this key." } },
        response: { status: 409 },
      }));
    await render();
    const submit = await openAddField("Fit");
    await act(async () => submit.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminCustomFieldDefinitions).toHaveBeenCalledTimes(1));
    // The first request did create it; the list now has it.
    sdk.getApiV1AdminCustomFieldDefinitions.mockImplementation(() => ok({ definitions: [definition("cfd_fit", "product", "Fit")] }));

    await act(async () => submit.click());

    await vi.waitFor(() => expect(document.getElementById("custom-field-definition-form")).toBeNull());
    expect(sdk.postApiV1AdminCustomFieldDefinitions).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith(t("created"));
  });

  it("still says the key is taken when another field holds it", async () => {
    sdk.postApiV1AdminCustomFieldDefinitions.mockImplementation(() => Promise.resolve({
      error: { success: false, error: { code: "CUSTOM_FIELD_KEY_TAKEN", message: "Another field already uses this key." } },
      response: { status: 409 },
    }));
    await render();
    const submit = await openAddField("Care");
    await act(async () => submit.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain(t("keyTaken")));
  });

  it("reorders the whole owner type at the revisions it read", async () => {
    await render();
    const down = container.querySelector<HTMLButtonElement>(`button[aria-label="${t("moveDown")}: Care"]`)!;
    await act(async () => down.click());
    expect(sdk.postApiV1AdminCustomFieldDefinitionsReorder).toHaveBeenCalledWith({
      body: { ownerType: "product", definitions: [{ id: "cfd_points", expectedRevision: 3 }, { id: "cfd_care", expectedRevision: 3 }] },
    });
  });
});
