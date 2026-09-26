// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { DraftOption, DraftVariant } from "./option-matrix-editor-model";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), removed: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/hooks/use-currency", () => {
  const fmt = (price: number) => `৳${price}`;
  const salePrice = (price: number, discount: { discountPercentage?: number | null }) =>
    discount.discountPercentage ? price - (price * discount.discountPercentage) / 100 : null;
  const currency = { code: "BDT", symbol: "৳", fmt, formatPrice: fmt, salePrice };
  return { useCurrency: () => currency };
});

import { VariantTable } from "./VariantTable";

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
function Harness({ initial, missing = [], reveal = null, fulfilmentColumn = false }: {
  initial: DraftVariant[];
  missing?: string[][];
  reveal?: { variantId: string; nonce: number } | null;
  fulfilmentColumn?: boolean;
}) {
  const [variants, setVariants] = React.useState(initial);
  latest = variants;
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  return (
    <VariantTable
      options={options}
      variants={variants}
      images={[]}
      productName="Panjabi"
      nameOf={(row) => row.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}
      issue={null}
      reveal={reveal}
      expandedId={expandedId}
      onExpandedChange={setExpandedId}
      onChangeMany={(ids, patch) => setVariants((current) => current.map((row) => ids.has(row.id)
        ? { ...row, ...(typeof patch === "function" ? patch(row) : patch) }
        : row))}
      onRemove={mocks.removed}
      missingCombinations={missing}
      onRestoreCombination={() => {}}
      onRestoreAll={() => {}}
      committedByVariantId={new Map()}
      printingDisabled={false}
      fulfilmentColumn={fulfilmentColumn}
    />
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

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const rows = () => [
    variant("sw", "s", "w", 2500, { discountPercentage: 10 }),
    variant("sb", "s", "b", 2500),
    variant("mw", "m", "w", 2200),
    variant("mb", "m", "b", 2400, { trackInventory: false, stock: 0 }),
  ];

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

describe("VariantTable fulfilment column", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
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
