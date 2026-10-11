// @vitest-environment happy-dom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { formatNumber, translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import type { PurchaseOrder } from "~/lib/api-query-options/purchasing";

const mocks = vi.hoisted(() => ({ mobile: false, receive: vi.fn(), navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => mocks.navigate,
  useBlocker: () => ({ proceed: () => undefined, reset: () => undefined, status: "idle" }),
}));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive: mocks.receive,
}));

import { ReceiveLines, readReceipt, type ReceivableLine, type ReceiveQuantities } from "./ReceiveLines";
import { PurchaseOrderReceive } from "./PurchaseOrderReceive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Vars = Record<string, string | number>;
const pt = (key: keyof typeof purchasingMessages.en, vars?: Vars) => translate(purchasingMessages, key, vars);
const rt = (key: keyof typeof resourceMessages.en, vars?: Vars) => translate(resourceMessages, key, vars);
const showing = (start: number, end: number, total: number) =>
  rt("showing", { start: formatNumber(start), end: formatNumber(end), total: formatNumber(total) });

const KORI = 1500;
const makeLine = (i: number): ReceivableLine => i === KORI
  ? {
    id: `l${i}`, productId: `p${i}`, productName: "Kori Trainer", optionLabel: "Indigo 42", sku: "KORI-42",
    barcode: "8901234567890", open: 5, received: 0, total: 5, retired: false,
  }
  : {
    id: `l${i}`, productId: `p${i}`, productName: `Panjabi ${i}`, optionLabel: i % 2 ? "Blue" : "White",
    sku: `PJ-${String(i).padStart(4, "0")}`, barcode: `89${String(i).padStart(11, "0")}`, open: 5, received: 0, total: 5, retired: false,
  };
const LINES = Array.from({ length: 2000 }, (_, i) => makeLine(i));
const nameOf = (i: number) => (i === KORI ? "Kori Trainer · Indigo 42" : `Panjabi ${i} · ${i % 2 ? "Blue" : "White"}`);

/** The page that owns the quantities, as the receive screens do. */
function Harness({ lines, initial = {} }: { lines: readonly ReceivableLine[]; initial?: ReceiveQuantities }) {
  const [quantities, setQuantities] = useState<ReceiveQuantities>(initial);
  const receipt = readReceipt(lines, quantities);
  return (
    <>
      <ReceiveLines
        lines={lines}
        quantities={quantities}
        onChange={setQuantities}
        notOnDocument={(code) => pt("notOnPurchaseOrder", { code })}
      />
      <output id="receipt">{JSON.stringify({ units: receipt.units, invalid: [...receipt.invalid].sort() })}</output>
    </>
  );
}

describe("receive lines on a long document", () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrolled: HTMLElement[];
  const originalScroll = Element.prototype.scrollIntoView;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mobile = false;
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this as HTMLElement);
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Element.prototype.scrollIntoView = originalScroll;
  });

  async function show(element: ReactNode) {
    await act(async () => {
      root.render(element);
    });
  }
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
  }
  async function scan(code: string) {
    await type(scanField(), code);
    await act(async () => {
      scanField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
  }
  const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-line-id]"), (row) => row.dataset.lineId);
  const searchField = () => document.getElementById("receive-search") as HTMLInputElement;
  const scanField = () => document.getElementById("receive-scan") as HTMLInputElement;
  const statusText = () => document.getElementById("receive-scan-status")!.textContent;
  const pagerLabel = () => document.querySelector("[data-slot=\"pagination\"] span[aria-live]")?.textContent ?? null;
  const quantityOf = (i: number) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${pt("receivingFor", { name: nameOf(i) })}"]`);
  const pagerButton = (key: "next" | "previous") => document.querySelector<HTMLButtonElement>(`button[aria-label="${rt(key)}"]`)!;
  const buttonByText = (text: string) => Array.from(document.querySelectorAll("button")).find((element) => element.textContent === text)!;
  const receipt = () => JSON.parse(document.getElementById("receipt")!.textContent!) as { units: number; invalid: string[] };
  const lastScrolled = () => scrolled[scrolled.length - 1]?.dataset.lineId;

  it("mounts at most 50 of 2,000 lines on desktop and on a phone", async () => {
    await show(<Harness lines={LINES} />);
    expect(document.querySelectorAll("tbody tr[data-line-id]")).toHaveLength(50);
    expect(document.querySelectorAll("input[inputmode=\"numeric\"]")).toHaveLength(50);
    expect(rowIds()[0]).toBe("l0");
    expect(pagerLabel()).toBe(showing(1, 50, 2000));

    mocks.mobile = true;
    await show(<Harness lines={LINES} />);
    expect(document.querySelectorAll("li[data-line-id]")).toHaveLength(50);
    expect(document.querySelectorAll("tbody tr[data-line-id]")).toHaveLength(0);
    expect(document.querySelectorAll("input[inputmode=\"numeric\"]")).toHaveLength(50);
  });

  it("searches name, option, SKU and barcode across every line", async () => {
    await show(<Harness lines={LINES} />);
    for (const query of ["kori", "  INDIGO 42 ", "kori-42", "8901234567890"]) {
      await type(searchField(), query);
      expect(rowIds()).toEqual(["l1500"]);
      expect(pagerLabel()).toBe(showing(1, 1, 1));
    }
    await type(searchField(), "no such line");
    expect(rowIds()).toEqual([]);
    expect(pagerLabel()).toBeNull();
    const empty = Array.from(document.querySelectorAll("[role=\"status\"]")).find((element) => element.textContent?.includes(rt("noResults")));
    expect(empty?.textContent).toContain(rt("noResultsHint"));
    await type(searchField(), "");
    expect(rowIds()).toHaveLength(50);
  });

  it("keeps typed quantities across pages and layouts, resets on search and clamps a shrinking page", async () => {
    await show(<Harness lines={LINES} />);
    await type(quantityOf(0)!, "4");
    await click(pagerButton("next"));
    expect(rowIds()[0]).toBe("l50");
    expect(pagerLabel()).toBe(showing(51, 100, 2000));
    expect(quantityOf(0)).toBeNull();

    mocks.mobile = true;
    await show(<Harness lines={LINES} />);
    expect(rowIds()[0]).toBe("l50");
    await click(pagerButton("previous"));
    expect(quantityOf(0)!.value).toBe("4");
    expect(receipt()).toEqual({ units: 4, invalid: [] });

    await click(pagerButton("next"));
    await click(pagerButton("next"));
    expect(pagerLabel()).toBe(showing(101, 150, 2000));
    await type(searchField(), "blue");
    expect(pagerLabel()).toBe(showing(1, 50, 1000));
    expect(rowIds()[0]).toBe("l1");
    await type(searchField(), "");
    expect(pagerLabel()).toBe(showing(1, 50, 2000));

    await click(pagerButton("next"));
    await click(pagerButton("next"));
    expect(pagerLabel()).toBe(showing(101, 150, 2000));
    await show(<Harness lines={LINES.slice(0, 60)} />);
    expect(pagerLabel()).toBe(showing(51, 60, 60));
    expect(rowIds()).toEqual(LINES.slice(50, 60).map((line) => line.id));
    expect(receipt().units).toBe(4);

    await show(<Harness lines={LINES} />);
    expect(pagerLabel()).toBe(showing(51, 100, 2000));
    expect(rowIds()).toEqual(LINES.slice(50, 100).map((line) => line.id));
    expect(receipt().units).toBe(4);
  });

  it("receives all and clears the whole document while a search is active", async () => {
    await show(<Harness lines={LINES} />);
    await type(searchField(), "kori");
    await click(buttonByText(pt("receiveAll")));
    expect(receipt()).toEqual({ units: 10000, invalid: [] });
    expect(searchField().value).toBe("kori");
    expect(quantityOf(KORI)!.value).toBe("5");
    await click(buttonByText(pt("clearCounts")));
    expect(receipt()).toEqual({ units: 0, invalid: [] });
    expect(quantityOf(KORI)!.value).toBe("");
  });

  it("reveals an off-page counted line, clearing the search, and keeps the scanner focused", async () => {
    await show(<Harness lines={LINES} />);
    await type(searchField(), "kori");
    scanField().focus();
    await scan("kori-42");
    expect(searchField().value).toBe("kori");
    expect(quantityOf(KORI)!.value).toBe("1");
    expect(lastScrolled()).toBe("l1500");

    await scan("pj-1999");
    expect(statusText()).toBe(pt("scanCounted", { name: nameOf(1999), count: 1 }));
    expect(searchField().value).toBe("");
    expect(pagerLabel()).toBe(showing(1951, 2000, 2000));
    expect(quantityOf(1999)!.value).toBe("1");
    expect(lastScrolled()).toBe("l1999");
    expect(document.activeElement).toBe(scanField());

    await scan("8900000001999");
    expect(quantityOf(1999)!.value).toBe("2");
    expect(receipt()).toEqual({ units: 3, invalid: [] });
    expect(document.activeElement).toBe(scanField());
  });

  it("reveals an off-page line that is already full", async () => {
    await show(<Harness lines={LINES} initial={{ l1800: 5 }} />);
    await type(searchField(), "kori");
    scanField().focus();
    await scan("PJ-1800");
    expect(statusText()).toBe(pt("scanFull", { name: nameOf(1800) }));
    expect(searchField().value).toBe("");
    expect(pagerLabel()).toBe(showing(1801, 1850, 2000));
    expect(quantityOf(1800)!.value).toBe("5");
    expect(lastScrolled()).toBe("l1800");
    expect(document.activeElement).toBe(scanField());
    expect(receipt()).toEqual({ units: 5, invalid: [] });
  });

  it("leaves search, page and quantities alone for an unknown code", async () => {
    await show(<Harness lines={LINES} initial={{ l3: 2 }} />);
    await type(searchField(), "blue");
    await click(pagerButton("next"));
    expect(pagerLabel()).toBe(showing(51, 100, 1000));
    await scan("NOPE-1");
    expect(statusText()).toBe(pt("notOnPurchaseOrder", { code: "NOPE-1" }));
    expect(searchField().value).toBe("blue");
    expect(pagerLabel()).toBe(showing(51, 100, 1000));
    expect(receipt()).toEqual({ units: 2, invalid: [] });
    expect(scrolled).toHaveLength(0);
  });

  it("reveals off-page invalid quantities for correction or a global reset", async () => {
    await show(<Harness lines={LINES} />);
    await type(quantityOf(0)!, "9");
    expect(document.body.textContent).toContain(pt("receiveInvalid", { max: 5 }));
    await click(pagerButton("next"));
    expect(quantityOf(0)).toBeNull();
    await type(quantityOf(50)!, "abc");
    expect(receipt()).toEqual({ units: 0, invalid: ["l0", "l50"] });
    await type(searchField(), "pj-0001");
    expect(rowIds()).toEqual(["l1"]);
    expect(receipt()).toEqual({ units: 0, invalid: ["l0", "l50"] });
    await click(buttonByText(pt("checkQuantities", { count: formatNumber(2) })));
    expect(searchField().value).toBe("");
    expect(pagerLabel()).toBe(showing(1, 50, 2000));
    expect(quantityOf(0)!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(quantityOf(0));
    await type(quantityOf(0)!, "2");
    expect(receipt()).toEqual({ units: 2, invalid: ["l50"] });

    await type(searchField(), "panjabi");
    await click(buttonByText(pt("checkQuantities", { count: formatNumber(1) })));
    expect(searchField().value).toBe("panjabi");
    expect(document.activeElement).toBe(quantityOf(50));
    await type(searchField(), "blue");
    await click(buttonByText(pt("checkQuantities", { count: formatNumber(1) })));
    expect(searchField().value).toBe("");
    expect(pagerLabel()).toBe(showing(51, 100, 2000));
    expect(document.activeElement).toBe(quantityOf(50));
    // NumberInput keeps only the numeric draft across remounts: NaN stays invalid.
    expect(quantityOf(50)!.value).toBe("");
    expect(quantityOf(50)!.getAttribute("aria-invalid")).toBe("true");
    await click(buttonByText(pt("clearCounts")));
    expect(receipt()).toEqual({ units: 0, invalid: [] });
    expect(quantityOf(50)!.hasAttribute("aria-invalid")).toBe(false);
    expect(buttonByText(pt("checkQuantities", { count: formatNumber(1) }))).toBeUndefined();
  });

  it("prevents the real receive screen from submitting while an invalid line is off-page", async () => {
    const order = {
      id: "po_long", displayNumber: "PO1001", status: "partially_received", revision: 4, currencyCode: "BDT",
      destination: { id: "loc_1", name: "Warehouse", code: "WH", status: "active" },
      lines: LINES.map((line) => ({
        ...line, variantId: `var_${line.id}`, quantity: line.total, receivedQuantity: line.received,
        openQuantity: line.open, unitCost: 10, lineTotal: 50, currentCost: 10,
      })),
    } as unknown as PurchaseOrder;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await show(
      <PermissionProvider permissions={[PERMISSIONS.INVENTORY_MANAGE]}>
        <QueryClientProvider client={client}>
          <PurchaseOrderReceive order={order} onReload={async () => undefined} />
        </QueryClientProvider>
      </PermissionProvider>,
    );
    await type(quantityOf(0)!, "9");
    await type(searchField(), "kori");
    await type(quantityOf(KORI)!, "1");
    expect(quantityOf(0)).toBeNull();
    await click(buttonByText(pt("receiveCountOne")));
    expect(mocks.receive).not.toHaveBeenCalled();
    await click(buttonByText(pt("checkQuantities", { count: formatNumber(1) })));
    expect(document.activeElement).toBe(quantityOf(0));
    expect(quantityOf(0)!.getAttribute("aria-invalid")).toBe("true");
    client.clear();
  });
});
