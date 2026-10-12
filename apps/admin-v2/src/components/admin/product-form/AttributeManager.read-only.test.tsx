// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { setLocale, translate } from "~/i18n";
import { productMessages } from "~/i18n/products";

const sdk = vi.hoisted(() => ({
  getApiV1AdminAttributes: vi.fn(),
  getApiV1AdminAttributesByIdValues: vi.fn(),
  getApiV1AdminAttributesCategorySetsByCategoryId: vi.fn(),
  getApiV1AdminAttributesGroups: vi.fn(),
  postApiV1AdminAttributes: vi.fn(),
  postApiV1AdminAttributesByIdValues: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AttributeManager } from "./AttributeManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Assignments = ComponentProps<typeof AttributeManager>["initialAttributes"];
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const t = (key: keyof typeof productMessages.en) => translate(productMessages, key);
const saved: Assignments = [
  { attributeId: "attr_material", name: "Material", value: `  Hand wash only\n${"Cotton-".repeat(80)}  ` },
  { attributeId: "attr_retired", name: "Former care label", value: "Keep this saved fact" },
  { attributeId: "attr_unknown", value: "A value without a current name" },
];

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  setLocale("en");
  sdk.getApiV1AdminAttributes.mockImplementation(() => ok({ attributes: [] }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setLocale("en");
});

async function render(initialAttributes = saved, readOnly = true) {
  await act(async () => root.render(
    <PermissionProvider permissions={[PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.ATTRIBUTES_CREATE, PERMISSIONS.ATTRIBUTES_EDIT]}>
      <AttributeManager initialAttributes={initialAttributes} onAttributesChange={onChange} readOnly={readOnly} />
    </PermissionProvider>,
  ));
}
const values = () => [...host.querySelectorAll('[data-slot="field-control"]')].map((node) => node.textContent);
const noEdits = () => {
  expect(host.querySelector("button, input, select, textarea, [role=combobox]")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(sdk.postApiV1AdminAttributes).not.toHaveBeenCalled();
  expect(sdk.postApiV1AdminAttributesByIdValues).not.toHaveBeenCalled();
  expect(sdk.getApiV1AdminAttributesByIdValues).not.toHaveBeenCalled();
};

describe("saved product attributes", () => {
  it.each(["en", "bn"] as const)("keeps complete saved facts readable in %s even when attribute editing is allowed", async (locale) => {
    setLocale(locale);
    await render();
    expect(values()).toEqual(saved.map((attribute) => attribute.value));
    expect([...host.querySelectorAll('[data-slot="field-label"]')].map((node) => node.textContent))
      .toEqual(["Material", "Former care label", "attr_unknown"]);
    const value = host.querySelector('[data-slot="field-control"]')!;
    expect(value.classList.contains("break-words")).toBe(true);
    expect(value.firstElementChild?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(host.querySelector(".truncate")).toBeNull();
    // A missing live definition is not evidence that this saved fact was removed.
    expect(host.textContent).not.toContain(t("attributeRemoved"));
    noEdits();
  });

  it("keeps values and saved keys visible when the name lookup fails", async () => {
    sdk.getApiV1AdminAttributes.mockRejectedValue(new Error("lookup unavailable"));
    await render();
    expect(host.textContent).toContain(t("attributeNamesFailed"));
    expect(host.textContent).not.toContain(t("attributeRemoved"));
    expect(values()).toEqual(saved.map((attribute) => attribute.value));
    expect(host.textContent).toContain("attr_unknown");
    noEdits();
  });

  it("shows an empty saved list as empty without a mutation control or lookup", async () => {
    await render([]);
    expect(values()).toEqual(["—"]);
    expect(sdk.getApiV1AdminAttributes).not.toHaveBeenCalled();
    noEdits();
  });

  it("preserves editor assignment semantics and removes its controls when read-only replaces editing", async () => {
    await render(saved, false);
    expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(saved.length);
    const remove = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === translate(productMessages, "removeAttribute", { name: "Material" }));
    expect(remove).toBeDefined();
    await act(async () => remove!.click());
    const remaining = saved.slice(1).map(({ attributeId, value }) => ({ attributeId, value }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(remaining);
    onChange.mockClear();
    await render(remaining);
    expect(values()).toEqual(remaining.map((attribute) => attribute.value));
    noEdits();
  });
});
