// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatNumber, setLocale, translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { DraftIssue, DraftOption, DraftVariant } from "./option-matrix-editor-model";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), removed: vi.fn(), restored: vi.fn(), restoredAll: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/lib/api-query-options/store-defaults", () => ({ useStoreUnits: () => ({ weightUnit: "g", dimensionUnit: "cm" }) }));
vi.mock("@/hooks/use-currency", () => {
  const fmt = (price: number) => `৳${price}`;
  const salePrice = (price: number, discount: { discountPercentage?: number | null }) =>
    discount.discountPercentage ? price - (price * discount.discountPercentage) / 100 : null;
  const currency = { code: "BDT", symbol: "৳", fmt, formatPrice: fmt, salePrice };
  return { useCurrency: () => currency };
});

import { VariantTable } from "./VariantTable";
import { PermissionProvider } from "~/contexts/PermissionContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: DraftOption[] = [
  { id: "o_size", name: "Size", standardMapping: "size", values: [{ id: "s", value: "S" }, { id: "m", value: "M" }] },
  { id: "o_color", name: "Color", standardMapping: "color", values: [{ id: "w", value: "White" }, { id: "b", value: "কালো" }] },
];
const variant = (id: string, size: string, color: string, price: number, extra: Partial<DraftVariant> = {}): DraftVariant => ({
  id, selectedOptionValueIds: [size, color], imageId: null, sku: `PANJABI-${id.toUpperCase()}`, price, stock: 5,
  trackInventory: true, weight: null, barcode: null, barcodeType: null, discountType: "percentage",
  discountPercentage: null, discountAmount: null, ...extra,
});
const label = (key: ProductMessageKey, vars?: Record<string, string | number>) => translate(productMessages, key, vars);

let latest: DraftVariant[] = [];
function Harness({ readOnly = false, initial, missing = [], reveal = null, issue = null, fulfilmentColumn = false, opts = options }: {
  readOnly?: boolean;
  initial: DraftVariant[];
  opts?: DraftOption[];
  missing?: string[][];
  reveal?: { variantId: string; nonce: number } | null;
  issue?: DraftIssue | null;
  fulfilmentColumn?: boolean;
}) {
  const [variants, setVariants] = React.useState(initial);
  latest = variants;
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  // The table reads apps' variant actions (none here: no apps.view).
  const [queryClient] = React.useState(() => new QueryClient());
  const valueLabel = new Map(opts.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  return (
    <QueryClientProvider client={queryClient}>
    {/* A product editor who adjusts stock (products.adjust_stock). */}
    <PermissionProvider permissions={["products.view", "products.edit", "products.adjust_stock"]}>
    <VariantTable
      readOnly={readOnly}
      options={opts}
      variants={variants}
      images={[]}
      productName="Panjabi"
      nameOf={(row) => row.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}
      issue={issue}
      reveal={reveal}
      expandedId={expandedId}
      onExpandedChange={setExpandedId}
      onChangeMany={(ids, patch) => setVariants((current) => current.map((row) => ids.has(row.id)
        ? { ...row, ...(typeof patch === "function" ? patch(row) : patch) }
        : row))}
      onRemove={mocks.removed}
      missingCombinations={missing}
      onRestoreCombination={mocks.restored}
      onRestoreAll={mocks.restoredAll}
      committedByVariantId={new Map()}
      printingDisabled={false}
      fulfilmentColumn={fulfilmentColumn}
    />
    </PermissionProvider>
    </QueryClientProvider>
  );
}

describe("VariantTable", () => {
  let host: HTMLDivElement;
  let root: Root;

  async function render(initial: DraftVariant[], missing: string[][] = []) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness initial={initial} missing={missing} />));
  }
  const input = (ariaLabel: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`)!;
  const button = (text: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)!;
  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => { vi.clearAllMocks(); setLocale("en"); localStorage.clear(); });
  afterEach(() => {
    setLocale("en");
    act(() => root.unmount());
    host.remove();
  });

  const rows = () => [
    variant("sw", "s", "w", 2500, { discountPercentage: 10 }),
    variant("sb", "s", "b", 2500),
    variant("mw", "m", "w", 2200),
    variant("mb", "m", "b", 2400, { trackInventory: false, stock: 0 }),
  ];

  it.each(["en", "bn"] as const)("lets a %s viewer page and find off-page variants without edit controls", async (locale) => {
    setLocale(locale);
    const values = Array.from({ length: 125 }, (_, index) => ({ id: `v${index}`, value: `Size ${index}` }));
    const opts: DraftOption[] = [{ id: "size", name: "Size", standardMapping: "size", values }];
    const initial = values.map((value, index) => variant(`var_${index}`, value.id, "", 250, { selectedOptionValueIds: [value.id] }));
    await render([]);
    await act(async () => root.render(<Harness readOnly initial={initial} opts={opts} key="viewer" />));
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(50);
    const next = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "next")}"]`)!;
    expect(next.disabled).toBe(false);
    await act(async () => next.click());
    expect(host.querySelector('[data-variant-row="var_50"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(50);
    await type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "PANJABI-VAR_124");
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(1);
    const row = host.querySelector('[data-variant-row="var_124"]')!;
    await act(async () => row.querySelector<HTMLButtonElement>(`button[aria-label="${label("moreFieldsFor", { name: "Size 124" })}"]`)!.click());
    expect(row.textContent).toContain("PANJABI-VAR_124");
    expect(row.querySelector("input, [role=checkbox], [role=combobox], [role=switch]")).toBeNull();
    expect(latest).toEqual(initial);
    expect(mocks.removed).not.toHaveBeenCalled();
    expect(mocks.restored).not.toHaveBeenCalled();
  });

  it("opens closed groups and shows missing combinations without restore actions", async () => {
    const initial = Array.from({ length: 40 }, (_, index) => variant(`var_${index}`, index < 20 ? "s" : "m", index % 2 ? "w" : "b", 250));
    await render([]);
    await act(async () => root.render(<Harness readOnly initial={initial} missing={[["s", "b"]]} key="group-viewer" />));
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(0);
    const group = host.querySelector('[data-variant-group="s"]')!;
    const toggle = group.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.disabled).toBe(false);
    await act(async () => toggle.click());
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(20);
    expect(host.querySelector('input[data-cell], [role=checkbox]')).toBeNull();
    await act(async () => button(label("showNotForSale", { count: 1 })).click());
    expect(host.textContent).toContain("S / কালো");
    expect(host.textContent).not.toContain(label("turnOn"));
    expect(host.textContent).not.toContain(label("turnAllOn"));
    expect(mocks.restoredAll).not.toHaveBeenCalled();
  });

  it("shows each variant on one line: ৳ price, SKU with copy, the discounted price as a short note", async () => {
    await render(rows());
    const price = input(label("priceFor", { name: "S / White" }));
    expect(price.value).toBe("2500");
    expect(price.parentElement?.textContent).toContain("৳");
    const row = host.querySelector('[data-variant-row="sw"]')!;
    expect(row.textContent).toContain("PANJABI-SW");
    expect(row.querySelector('button[aria-label^="Copy"]')).not.toBeNull();
    expect(row.textContent).toContain(label("afterDiscount", { amount: "৳2,250" }));
    expect(host.textContent).not.toContain("Customers pay");
    // Untracked variants say so instead of offering a quantity.
    expect(host.querySelector('[data-variant-row="mb"]')!.textContent).toContain(label("notTracked"));
    // Print and stop selling live in the row's "…" menu, not as loose icons.
    expect(row.querySelector('button[aria-label^="Stop selling"]')).toBeNull();
    expect(row.querySelector('button[aria-haspopup="menu"]')).not.toBeNull();
  });

  it("groups by the first option: a group edit sets every variant in it, and a group collapses", async () => {
    await render(rows());
    expect(host.querySelector('[data-variant-row="sw"]')!.textContent).toContain("White");
    const groupPrice = input(label("priceForGroup", { name: "S" }));
    await type(groupPrice, "2600");
    expect(latest.filter((row) => row.selectedOptionValueIds[0] === "s").map((row) => row.price)).toEqual([2600, 2600]);
    expect(latest.find((row) => row.id === "mw")!.price).toBe(2200);
    // M's prices differ: its field is empty, says so, and shows the range on hover.
    expect(input(label("priceForGroup", { name: "M" })).placeholder).toBe(label("mixedValues"));
    expect(input(label("priceForGroup", { name: "M" })).title).toBe("2,200–2,400");

    const groupStock = input(label("quantityForGroup", { name: "M" }));
    await type(groupStock, "9");
    expect(latest.find((row) => row.id === "mw")!.stock).toBe(9);
    expect(latest.find((row) => row.id === "mb")!.stock).toBe(0);

    const toggle = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]:not([role="combobox"])')].find((element) => element.textContent?.startsWith("S"))!;
    await act(async () => toggle.click());
    expect(host.querySelector('[data-variant-row="sw"]')).toBeNull();
    expect(host.querySelector('[data-variant-row="mw"]')).not.toBeNull();
  });

  it("edits the prices and quantities of the selected variants in one step", async () => {
    await render(rows());
    const checkbox = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')]
      .find((element) => element.getAttribute("aria-label")?.endsWith(name))!;
    await act(async () => checkbox("S / White").click());
    await act(async () => checkbox("M / White").click());

    await act(async () => button(label("editPrices")).click());
    const panel = host.querySelector('[role="group"][aria-label]')!;
    await type(panel.querySelector("input")!, "1999");
    await act(async () => button(label("apply")).click());
    expect(latest.map((row) => row.price)).toEqual([1999, 2500, 1999, 2400]);

    await act(async () => button(label("editQuantities")).click());
    await type(host.querySelector<HTMLInputElement>('[role="group"][aria-label] input')!, "12");
    await act(async () => button(label("apply")).click());
    expect(latest.map((row) => row.stock)).toEqual([12, 5, 12, 0]);
  });

  it("writes SKUs from a pattern of option names, Bangla values read in Latin letters", async () => {
    await render(rows());
    const all = host.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="Select all"]`)!;
    await act(async () => all.click());
    // Every row is selected: stopping them all would leave nothing for sale, and the bar says so.
    expect(host.textContent).toContain(label("keepOneVariant"));

    const more = button("More actions");
    await act(async () => {
      more.focus();
      more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const item = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.includes(text))!;
    expect(item(label("stopSelling")).getAttribute("aria-disabled")).toBe("true");
    await act(async () => item(label("setSkus")).click());

    const pattern = host.querySelector<HTMLInputElement>('[role="group"][aria-label] input')!;
    expect(pattern.value).toBe("PANJABI-{Size}-{Color}");
    expect(host.textContent).toContain(label("skuPreview", { sku: "PANJABI-S-WHITE" }));
    await act(async () => button(label("apply")).click());
    expect(latest.map((row) => row.sku)).toEqual(["PANJABI-S-WHITE", "PANJABI-S-KALO", "PANJABI-M-WHITE", "PANJABI-M-KALO"]);
  });

  it("moves between price fields with the arrow keys", async () => {
    await render(rows());
    const first = input(label("priceFor", { name: "S / White" }));
    first.focus();
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S / কালো" })));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    // The next price field is the M group's, then its variants.
    expect(document.activeElement).toBe(input(label("priceForGroup", { name: "M" })));
  });

  it("lists variants that are not for sale behind a filter chip", async () => {
    await render(rows().slice(0, 3), [["m", "b"]]);
    await act(async () => button(label("showNotForSale", { count: 1 })).click());
    expect(host.textContent).toContain("M / কালো");
    expect(host.querySelector('[data-variant-row]')).toBeNull();
    await act(async () => button(label("showAllVariants", { count: 3 })).click());
    expect(host.querySelector('[data-variant-row="sw"]')).not.toBeNull();
  });

  it("opens a large product with its groups closed, and still selects every variant", async () => {
    const many = Array.from({ length: 32 }, (_, index) =>
      variant(`v${index}`, index % 2 ? "m" : "s", index % 4 < 2 ? "w" : "b", 2000 + index));
    await render(many);
    expect(host.querySelector("[data-variant-row]")).toBeNull();
    expect(input(label("priceForGroup", { name: "S" }))).not.toBeNull();

    const toggle = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]:not([role="combobox"])')].find((element) => element.textContent?.startsWith("S"))!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(host.querySelectorAll("[data-variant-row]")).toHaveLength(16);

    const selectAll = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => selectAll.click());
    // Selection covers the closed groups too.
    expect(host.textContent).toContain(translate(resourceMessages, "selected", { count: 32 }));
  });

  it("opens the closed group of a problem it reveals", async () => {
    const many = Array.from({ length: 32 }, (_, index) =>
      variant(`v${index}`, index % 2 ? "m" : "s", index % 4 < 2 ? "w" : "b", 2000 + index));
    await render(many);
    expect(host.querySelector('[data-variant-row="v3"]')).toBeNull();
    await act(async () => root.render(<Harness initial={many} reveal={{ variantId: "v3", nonce: 1 }} />));
    // v3 is an M variant: M opens, S stays closed.
    expect(host.querySelector('[data-variant-row="v3"]')).not.toBeNull();
    expect(host.querySelector('[data-variant-row="v0"]')).toBeNull();
  });

});

describe("VariantTable at 2,000 variants", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => { vi.clearAllMocks(); setLocale("en"); localStorage.clear(); });
  afterEach(() => {
    setLocale("en");
    act(() => root.unmount());
    host.remove();
  });

  const oneAxis: DraftOption[] = [{
    id: "o_style", name: "Style", standardMapping: "none",
    values: Array.from({ length: 2000 }, (_, index) => ({ id: `x${index}`, value: `V${index}` })),
  }];
  const flat = () => Array.from({ length: 2000 }, (_, index) =>
    variant(`v${index}`, `x${index}`, "", 1000, { selectedOptionValueIds: [`x${index}`] }));
  const twoAxes: DraftOption[] = [
    { id: "o_size", name: "Size", standardMapping: "size", values: Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, value: `S${index}` })) },
    { id: "o_color", name: "Color", standardMapping: "color", values: Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, value: `C${index}` })) },
  ];
  const grid = () => twoAxes[0]!.values.flatMap((size) =>
    twoAxes[1]!.values.map((color) => variant(`${size.id}${color.id}`, size.id, color.id, 1000)));

  async function render(initial: DraftVariant[], opts: DraftOption[], missing: string[][] = []) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness initial={initial} opts={opts} missing={missing} />));
  }
  const mounted = () => host.querySelectorAll("[data-variant-row]");
  const input = (ariaLabel: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`)!;
  const button = (text: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)!;
  const checkbox = (ariaLabel: string) => host.querySelector<HTMLButtonElement>(`button[role="checkbox"][aria-label="${ariaLabel}"]`)!;
  const nextPage = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "next")}"]`)!;
  const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const showing = (start: number, end: number, total: number) =>
    translate(resourceMessages, "showing", { start: formatNumber(start), end: formatNumber(end), total: formatNumber(total) });
  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (key: string, shiftKey = false) => {
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
    });
  };

  it("mounts one page of a one-option product, says how many there are, and edits a row on a later page", async () => {
    await render(flat(), oneAxis);
    expect(mounted()).toHaveLength(50);
    expect(host.textContent).toContain(showing(1, 50, 2000));
    await act(async () => nextPage().click());
    expect(mounted()).toHaveLength(50);
    expect(host.querySelector('[data-variant-row="v50"]')).not.toBeNull();
    expect(host.querySelector('[data-variant-row="v0"]')).toBeNull();
    expect(host.textContent).toContain(showing(51, 100, 2000));
    await type(input(label("priceFor", { name: "V60" })), "1500");
    expect(latest.filter((row) => row.price === 1500).map((row) => row.id)).toEqual(["v60"]);
  });

  it("selects across pages and applies a bulk price to every selected variant in the draft", async () => {
    await render(flat(), oneAxis);
    await act(async () => checkbox(translate(resourceMessages, "selectAll")).click());
    expect(host.textContent).toContain(translate(resourceMessages, "selected", { count: 2000 }));
    await act(async () => nextPage().click());
    await act(async () => checkbox(translate(resourceMessages, "select", { name: "V75" })).click());
    expect(host.textContent).toContain(translate(resourceMessages, "selected", { count: 1999 }));
    await act(async () => button(label("editPrices")).click());
    await type(host.querySelector<HTMLInputElement>('[role="group"][aria-label] input')!, "1999");
    await act(async () => button(label("apply")).click());
    expect(latest.filter((row) => row.price === 1999)).toHaveLength(1999);
    expect(latest.find((row) => row.id === "v75")!.price).toBe(1000);
  });

  it("pages 150 missing combinations and restores the exact choice on page two", async () => {
    const missing = oneAxis[0]!.values.slice(1850).map((value) => [value.id]);
    await render(flat().slice(0, 1850), oneAxis, missing);
    await act(async () => nextPage().click());
    await act(async () => button(label("showNotForSale", { count: 150 })).click());
    expect(host.querySelectorAll("li")).toHaveLength(50);
    expect(host.textContent).toContain(showing(1, 50, 150));
    await act(async () => nextPage().click());
    expect(host.querySelectorAll("li")).toHaveLength(50);
    expect(host.textContent).toContain(showing(51, 100, 150));
    const restore = host.querySelector<HTMLButtonElement>(`button[aria-label="${label("turnOn")}: V1900"]`)!;
    await act(async () => restore.click());
    expect(mocks.restored.mock.calls).toEqual([[missing[50]]]);
    await act(async () => button(label("showAllVariants", { count: 1850 })).click());
    expect(host.querySelector('[data-variant-row="v0"]')).not.toBeNull();
    expect(host.textContent).toContain(showing(1, 50, 1850));
  });

  it("searches missing combinations beyond the current page while Restore all remains global", async () => {
    const missing = grid().slice(1850).map((row) => row.selectedOptionValueIds);
    await render(grid().slice(0, 1850), twoAxes, missing);
    await act(async () => button(label("showNotForSale", { count: 150 })).click());
    expect(host.textContent).toContain(showing(1, 50, 150));
    expect(host.querySelector('[role="combobox"]')).toBeNull();
    await type(search(), "s39 c49");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.textContent).toContain("S39 / C49");
    await act(async () => button(label("turnAllOn")).click());
    // The original parent action handles the click; per-combination restoration is unused.
    expect(mocks.restoredAll).toHaveBeenCalledTimes(1);
    expect(mocks.restored).not.toHaveBeenCalled();
    await type(search(), "no such combination");
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.textContent).toContain(translate(resourceMessages, "noResults"));
    expect(host.querySelector('[data-slot="pagination"]')).toBeNull();
  });

  it("keeps group edits whole and bounds a broad search that opens every group", async () => {
    await render(grid(), twoAxes);
    expect(mounted()).toHaveLength(0);
    await type(input(label("priceForGroup", { name: "S39" })), "2600");
    expect(latest.filter((row) => row.price === 2600)).toHaveLength(50);
    await act(async () => checkbox(label("selectGroup", { name: "S39" })).click());
    expect(host.textContent).toContain(translate(resourceMessages, "selected", { count: 50 }));

    await type(search(), "panjabi");
    expect(mounted().length).toBeGreaterThan(0);
    expect(mounted().length).toBeLessThanOrEqual(50);
    expect(nextPage()).not.toBeNull();
    await type(search(), "panjabi-s39c49");
    expect(host.querySelector('[data-variant-row="s39c49"]')).not.toBeNull();
    expect(mounted()).toHaveLength(1);
  });

  it("moves the arrow keys across a page edge and back", async () => {
    await render(flat(), oneAxis);
    input(label("priceFor", { name: "V49" })).focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "V50" })));
    expect(host.querySelector('[data-variant-row="v0"]')).toBeNull();
    await press("ArrowUp");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "V49" })));
  });

  it("skips repeated group headers at page edges without changing ordinary group navigation", async () => {
    await render(grid(), twoAxes);
    await type(search(), "panjabi");
    input(label("priceForGroup", { name: "S0" })).focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S0 / C0" })));
    await press("ArrowUp");
    expect(document.activeElement).toBe(input(label("priceForGroup", { name: "S0" })));

    input(label("priceFor", { name: "S0 / C48" })).focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S0 / C49" })));
    await type(document.activeElement as HTMLInputElement, "1700");
    expect(latest.filter((row) => row.price === 1700).map((row) => row.id)).toEqual(["s0c49"]);
    await press("ArrowUp");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S0 / C48" })));
    await press("Enter");
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S0 / C49" })));
    await press("Enter", true);
    expect(document.activeElement).toBe(input(label("priceFor", { name: "S0 / C48" })));
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("priceForGroup", { name: "S1" })));
  });

  it("skips pages without quantity fields and keeps focus when no later or earlier field exists", async () => {
    await render(flat().map((row, index) => ({ ...row, trackInventory: index === 49 || index === 150 })), oneAxis);
    input(label("quantityFor", { name: "V49" })).focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("quantityFor", { name: "V150" })));
    expect(host.textContent).toContain(showing(151, 200, 2000));
    await press("ArrowDown");
    expect(document.activeElement).toBe(input(label("quantityFor", { name: "V150" })));
    await press("ArrowUp");
    expect(document.activeElement).toBe(input(label("quantityFor", { name: "V49" })));
    expect(host.textContent).toContain(showing(1, 50, 2000));
    await press("ArrowUp");
    expect(document.activeElement).toBe(input(label("quantityFor", { name: "V49" })));
  });

  it("keeps the clamped page after collapsing and reopening a group", async () => {
    await render(grid(), twoAxes);
    const toggle = () => host.querySelector<HTMLButtonElement>('[data-variant-group="s0"] button[aria-expanded]:not([aria-haspopup])')!;
    await act(async () => toggle().click());
    await act(async () => nextPage().click());
    expect(host.querySelector('[data-variant-row="s0c49"]')).not.toBeNull();
    await act(async () => toggle().click());
    expect(mounted()).toHaveLength(0);
    await act(async () => toggle().click());
    expect(host.querySelector('[data-variant-row="s0c0"]')).not.toBeNull();
    expect(host.querySelector('[data-variant-row="s0c49"]')).toBeNull();
  });

  it("reveals and focuses an invalid field on another page after clearing a search hiding it", async () => {
    const initial = flat();
    initial[1500]!.price = Number.NaN;
    await render(initial, oneAxis);
    await type(search(), "v7");
    await act(async () => root.render(<Harness initial={initial} opts={oneAxis}
      reveal={{ variantId: "v1500", nonce: 1 }}
      issue={{ variantId: "v1500", field: "price", message: "Enter a price" }} />));
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(search().value).toBe("");
    expect(host.querySelector('[data-variant-row="v1500"]')).not.toBeNull();
    expect(mounted()).toHaveLength(50);
    expect(host.textContent).toContain(showing(1501, 1550, 2000));
    const invalid = input(label("priceFor", { name: "V1500" }));
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(invalid);
  });
});

describe("VariantTable fulfilment column", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    setLocale("en");
    act(() => root.unmount());
    host.remove();
  });

  async function render(initial: DraftVariant[], fulfilmentColumn: boolean) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness initial={initial} fulfilmentColumn={fulfilmentColumn} />));
  }
  const select = (ariaLabel: string) => host.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${ariaLabel}"]`);
  const choose = async (element: HTMLButtonElement, value: "physical" | "service") => {
    await act(async () => {
      element.click();
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const optionLabel = label(value === "physical" ? "fulfilmentPhysicalShort" : "fulfilmentServiceShort");
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent === optionLabel)!.click());
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const rows = () => [variant("sw", "s", "w", 1000), variant("sb", "s", "b", 1000, { fulfillmentKind: "service" })];

  it("shows no Fulfilment column while every variant is the same kind", async () => {
    await render(rows(), false);
    expect(select(label("fulfilmentFor", { name: "S / White" }))).toBeNull();
  });

  it("sets a variant's kind from its row, and a group's from its group row", async () => {
    await render(rows(), true);
    expect(host.textContent).toContain(label("fulfilment"));
    const white = select(label("fulfilmentFor", { name: "S / White" }))!;
    expect(white.textContent).toBe(label("fulfilmentPhysicalShort"));
    expect(select(label("fulfilmentFor", { name: "S / কালো" }))!.textContent).toBe(label("fulfilmentServiceShort"));
    // The S group mixes both kinds until one is chosen for all.
    const group = select(label("fulfilmentForGroup", { name: "S" }))!;
    expect(group.textContent).toBe(label("mixedValues"));

    await choose(white, "service");
    expect(latest.find((row) => row.id === "sw")?.fulfillmentKind).toBe("service");
    await choose(select(label("fulfilmentForGroup", { name: "S" }))!, "physical");
    expect(latest.map((row) => row.fulfillmentKind)).toEqual(["physical", "physical"]);
  });
});
