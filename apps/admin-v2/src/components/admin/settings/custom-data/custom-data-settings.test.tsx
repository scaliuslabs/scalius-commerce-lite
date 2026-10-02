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
        definition("cfd_points", "product", "Points", { namespace: "scalius.loyalty", type: "integer", position: 1 }),
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
    expect(rows[1]!.textContent).toContain(t("managedBy", { namespace: "scalius.loyalty" }));
    expect(container.textContent).not.toContain("VIP");
    // Only the merchant's own field has edit and delete.
    expect(container.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1);
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
