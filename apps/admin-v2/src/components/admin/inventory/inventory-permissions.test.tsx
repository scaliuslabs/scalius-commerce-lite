// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";

const mocks = vi.hoisted(() => ({ canEdit: false }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({
    inventory: { canAdjustStock: mocks.canEdit, canAcknowledgeAlerts: mocks.canEdit },
  }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  patchApiV1AdminInventoryAlerts: vi.fn(),
  postApiV1AdminInventoryByVariantIdAdjust: vi.fn(),
  postApiV1AdminInventoryStockSet: vi.fn(),
  putApiV1AdminInventoryByVariantIdAlertLevel: vi.fn(),
  getApiV1AdminInventory: async ({ query }: { query: { section: string } }) => query.section === "alerts"
    ? {
        alerts: [{
          id: "alert_1", variantId: "var_1", productId: "prod_1", currentQty: 2, threshold: 5,
          alertStatus: "active", updatedAt: 1_700_000_000, productName: "Kori Trainer",
          variantSku: "KORI-42", variantLabel: "42",
        }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }
    : {
        variants: [{
          id: "var_1", productId: "prod_1", productName: "Kori Trainer", sku: "KORI-42", optionLabel: "42",
          stock: 4, reservedStock: 1, available: 3, lowStockThreshold: 5, version: 1,
        }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      },
}));

import { AlertsTab } from "./AlertsTab";
import { VariantsTab } from "./VariantsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const adjustLabel = translate(inventoryMessages, "adjustFor", { name: "Kori Trainer · 42" });
const markSeen = translate(inventoryMessages, "markSeen");
const review = translate(inventoryMessages, "review");

describe("inventory actions follow stock permissions", () => {
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

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await vi.waitFor(() => expect(host.textContent).toContain("KORI-42"));
  }

  const buttons = () => Array.from(host.querySelectorAll("button"));
  const adjustButton = () => buttons().find((button) => button.getAttribute("aria-label") === adjustLabel);
  const buttonNamed = (name: string) => buttons().find((button) => button.textContent === name);

  it.each([true, false])("variants: Adjust is shown only with stock permission (%s)", async (canEdit) => {
    mocks.canEdit = canEdit;
    await render(<VariantsTab filters={{ q: "", stock: "all" }} onFiltersChange={() => undefined} onSelectionChange={() => undefined} />);
    const button = adjustButton();
    if (canEdit) {
      expect(button?.disabled).toBe(false);
    } else {
      expect(button).toBeUndefined();
    }
  });

  it.each([true, false])("alerts: Mark as seen is shown only with stock permission (%s)", async (canEdit) => {
    mocks.canEdit = canEdit;
    await render(<AlertsTab filters={{ q: "", alert: "active" }} onFiltersChange={() => undefined} onReview={() => undefined} onSetAlertLevels={() => undefined} />);
    expect(buttonNamed(review)).toBeDefined();
    const button = buttonNamed(markSeen);
    if (canEdit) {
      expect(button?.disabled).toBe(false);
    } else {
      expect(button).toBeUndefined();
    }
  });
});
