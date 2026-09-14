// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useBlocker: vi.fn(),
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
  saveTaxSettings: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useBlocker: mocks.useBlocker }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("~/lib/api-functions/taxes", () => ({
  saveTaxSettings: mocks.saveTaxSettings,
}));
vi.mock("~/lib/api-helpers", () => ({
  getServerFnError: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("~/lib/query-keys", () => ({
  queryKeys: { settings: { taxes: () => ["settings", "taxes"] } },
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import type { TaxConfigurationPayload } from "~/lib/api-functions/taxes";

import { TaxSettingsPanel } from "./TaxSettingsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function configuration(
  overrides: Partial<TaxConfigurationPayload> = {},
): TaxConfigurationPayload {
  return {
    settings: {
      id: "default",
      enabled: false,
      pricesIncludeTax: false,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
      version: 3,
      createdAt: null,
      updatedAt: null,
    },
    classes: [{
      id: "class_standard",
      name: "Standard",
      description: null,
      isExempt: false,
      version: 1,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
    }],
    rates: [{
      id: "rate_standard",
      taxClassId: "class_standard",
      name: "Standard rate",
      rateBps: 1500,
      jurisdictionType: "all",
      jurisdictionId: null,
      jurisdictionLabel: null,
      priority: 0,
      isCompound: false,
      isActive: true,
      version: 1,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
    }],
    jurisdictions: [],
    ...overrides,
  };
}

describe("tax settings save bar flow", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useBlocker.mockReturnValue({
      status: "idle",
      proceed: vi.fn(),
      reset: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(payload: TaxConfigurationPayload, canManage = true) {
    await act(async () => {
      root.render(
        <TaxSettingsPanel
          configuration={payload}
          canManage={canManage}
          onOpenTarget={() => {}}
        />,
      );
    });
  }

  function saveBar() {
    return document.querySelector<HTMLElement>('[data-testid="contextual-save-bar"]');
  }
  function button(label: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
  }
  async function click(element: Element | null | undefined) {
    if (!element) throw new Error("Expected an element to click");
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("stays hidden until the policy draft differs from the saved policy", async () => {
    await render(configuration());
    expect(saveBar()).toBeNull();

    await click(host.querySelector("#tax-enabled"));

    expect(saveBar()).not.toBeNull();
    expect(saveBar()?.textContent).toContain("Unsaved changes");
    expect(button("Save")?.disabled).toBe(false);
  });

  it("discards the draft back to the saved policy", async () => {
    await render(configuration());
    await click(host.querySelector("#tax-enabled"));
    expect(host.querySelector("#tax-enabled")?.getAttribute("aria-checked")).toBe("true");

    await click(button("Discard"));

    expect(saveBar()).toBeNull();
    expect(host.querySelector("#tax-enabled")?.getAttribute("aria-checked")).toBe("false");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("saves through the bar instead of a per-card button", async () => {
    await render(configuration());
    await click(host.querySelector("#tax-enabled"));
    await click(button("Save"));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(button("Save policy")).toBeUndefined();
    expect(button("Reset")).toBeUndefined();
  });

  it("blocks the save while enabling would leave a taxable class uncovered", async () => {
    await render(configuration({ rates: [] }));
    await click(host.querySelector("#tax-enabled"));

    const save = button("Save");
    expect(save?.disabled).toBe(true);
    expect(save?.title).toContain("active rate to default product class");
    expect(saveBar()?.textContent).toContain("active rate to default product class");

    await click(save);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("shows the field error beside the input that owns it", async () => {
    await render(configuration({ rates: [] }));
    await click(host.querySelector("#tax-enabled"));

    const errors = Array.from(
      host.querySelectorAll('[data-testid="field-error"]'),
    ).map((node) => node.textContent ?? "");
    expect(errors.some((text) => text.includes("active rate to default product class")))
      .toBe(true);
  });

  it("keeps the form read-only for a viewer without manage permission", async () => {
    await render(configuration(), false);
    // Nothing is editable, so no draft can diverge and the bar never appears.
    expect(saveBar()).toBeNull();
    expect(host.querySelector("#tax-enabled")?.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector<HTMLInputElement>("#tax-display-label")?.disabled).toBe(true);
  });

  it("guards navigation only while the draft is dirty", async () => {
    await render(configuration());
    expect(mocks.useBlocker).toHaveBeenCalled();
    expect(mocks.useBlocker.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: true });

    await click(host.querySelector("#tax-enabled"));

    expect(mocks.useBlocker.mock.calls.at(-1)?.[0]).toMatchObject({ disabled: false });
  });
});
