// @vitest-environment happy-dom

// The orders, products and customers lists with the most and the least data
// they can hold, at laptop widths (1024, 1280, 1440 and 1920px windows; below
// 1100px the navigation is the menu drawer) and on phones, in English and Bangla. happy-dom lays nothing out, so widths are
// budgeted with the fonts' real glyph advances (list-width.fixture.ts):
// - every column's minWidth holds its widest content and heading, so fitting
//   the columns by minWidth never overflows the page and never clips;
// - Order and Date always show; 1280 and 1440 show each list's working set,
//   and 1024 the orders list's Total;
// - apps' data-backed columns fit, step aside first, and the column menu
//   shows, hides and moves them;
// - every row has the same lines (stable height) with full or empty data, and
//   the phone card shows the date and the status.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { FULFILLMENT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from "@scalius/shared/order-state";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { formatNumber, setLocale, translate } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { dataTableMessages } from "~/i18n/data-table";
import { orderListMessages, type OrderListMessageKey } from "~/i18n/order-list";
import { orderChannelText, orderMessages } from "~/i18n/orders";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import type { ColumnDef, TableRowData } from "./data-table/table-config";
import { dataColumns, type DataColumnSpec } from "./data-table/data-columns";
import { listDateLabel } from "./data-table/ListDate";
import { NAV_PANEL_QUERY } from "./layout/nav-button";
import {
  CELL_PADDING,
  LAPTOP_VIEWPORTS,
  NAV_PANEL_MIN_WIDTH,
  SORT_ARROW,
  TYPE,
  badgeWidth,
  columnId,
  fitList,
  tableWidth,
  textWidth,
  type Locale,
} from "./data-table/list-width.fixture";
import { getOrderColumns, ORDER_COLUMN_LAYOUT, type OrderRowHandlers } from "./order-list/order-columns";
import { OrderMobileCard } from "./order-list/OrderMobileCard";
import { getProductColumns, PRODUCT_COLUMN_LAYOUT, type ProductListItem } from "./product-list/product-columns";
import { getCustomerColumns, CUSTOMER_COLUMN_LAYOUT, type CustomerListItem } from "./customers/customer-columns";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const money = (symbol: string) => (amount: number) =>
  `${symbol}${formatNumber(amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: money("৳"), fmtIn: money("৳") }) }));
vi.mock("@/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: money("৳"), fmtIn: money("৳") }) }));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => ({ canViewFraudCheck: true }) }));

const LOCALES = ["en", "bn"] as const;
// The widest totals: a crore-sized total in taka and in a future second currency.
const amounts = () => [money("৳")(9_999_999.99), money("$")(9_999_999.99)];
const LONG_NAMES = [
  "Mohammad Abdur Rahman Chowdhury Talukder Bhuiyan Siddiqui of Old Dhaka Wholesale Garments",
  "মোহাম্মদ আব্দুর রহমান চৌধুরী তালুকদার ভূঁইয়া সিদ্দিকী পুরান ঢাকা পাইকারি পোশাক বিক্রেতা",
];
const PHONE = "+8801712345678";
const NOW = new Date("2026-10-07T12:00:00Z");
const t = (key: keyof (typeof dataTableMessages)["en"], vars?: Record<string, string | number>) => translate(dataTableMessages, key, vars);

/** Apps' data-backed columns, as Wave 7 adds them from custom fields marked as list columns. */
function pluginColumns<TData extends TableRowData>(): ColumnDef<TData, unknown>[] {
  const specs: DataColumnSpec<TData>[] = [
    { id: "app.loyalty.tier", label: "Loyalty tier for the current membership year", kind: "text", value: () => "Platinum Plus Lifetime Member — Dhaka North" },
    // An app asking for more than a list's working columns gets less.
    { id: "app.loyalty.points", label: "Points", kind: "number", priority: 99, value: () => 1_234_567 },
    { id: "app.wallet.balance", label: "Wallet balance", kind: "money", value: () => 9_999_999.99 },
    { id: "app.crm.followUp", label: "Follow up", kind: "date", value: () => new Date("2025-09-30T17:48:00Z") },
  ];
  return dataColumns(specs);
}

/** Every label `ListDate` can show, at the widest hours and minutes, in store time. */
function dateLabels(): string[] {
  const labels = new Set<string>();
  for (let daysAgo = 0; daysAgo < 400; daysAgo += 1) {
    for (const hour of [0, 9, 10, 11, 12, 21, 22, 23]) {
      const date = new Date(NOW.getTime() - daysAgo * 86_400_000);
      date.setUTCHours(hour - 6, 48);
      if (date <= NOW) labels.add(listDateLabel(date, NOW, t));
    }
  }
  for (const minutes of [0, 1, 9, 10, 59]) labels.add(listDateLabel(new Date(NOW.getTime() - minutes * 60_000 - 5_000), NOW, t));
  return [...labels];
}

const widest = (texts: string[], width: (text: string) => number) => Math.max(...texts.map(width));
const capped = (width: number, max?: number) => (max ? Math.min(width, max) : width);

/** Each column's widest content and heading in `locale`, plus its padding. */
function orderNeeds(locale: Locale): Record<string, number> {
  const { body, caption } = TYPE[locale];
  const o = (key: string) => translate(orderMessages, key as never);
  const heading = (key: OrderListMessageKey) => textWidth(translate(orderListMessages, key), caption, { medium: true });
  const layout = ORDER_COLUMN_LAYOUT;
  const payment = widest(PAYMENT_STATUSES.map((status) => o(`payment.${status}`)), (label) => badgeWidth(label, locale));
  const fulfilment = widest(
    [...FULFILLMENT_STATUSES.map((status) => o(`fulfillment.${status}`)), o("delivery.readyForPickup")],
    (label) => badgeWidth(label, locale),
  );
  const channels = [
    orderChannelText(o, "online_store", null),
    orderChannelText(o, "admin", "facebook"),
    orderChannelText(o, "agent", null),
    orderChannelText(o, "app", "acme-loyalty-points-and-rewards"),
  ];
  const needs: Record<string, number> = {
    // "#1234567", the attention marker and its gap.
    order: textWidth("#1234567", body, { mono: true }) + 6 + 16,
    date: widest(dateLabels(), (label) => textWidth(label, body)),
    // A long name or the phone, beside the 28px courier history button.
    customer: capped(Math.max(...LONG_NAMES.map((name) => textWidth(name, body, { medium: true })), textWidth(formatPhoneForDisplay(PHONE), body, { mono: true })) + 4 + 28, layout.customer.maxWidth),
    channel: capped(widest(channels, (text) => textWidth(text, body)), layout.channel.maxWidth),
    total: widest(amounts(), (amount) => textWidth(amount, body, { medium: true })),
    payment,
    fulfillment: fulfilment,
    paymentFulfillment: Math.max(payment, fulfilment),
    // The "120 items" button (10px each side).
    items: textWidth(translate(orderListMessages, "itemsOther", { count: 120 }), body, { medium: true }) + 20,
    // The courier's longest word, then the 28px refresh slot.
    deliveryStatus: capped(textWidth("Returned to sender · attempt 3 of 3", body) + 4 + 28, layout.deliveryStatus.maxWidth),
    deliveryMethod: capped(textWidth("Steadfast Courier Express Delivery", body), layout.deliveryMethod.maxWidth),
    // A changeable status: its badge with the 14px chevron and gap.
    status: widest(ORDER_STATUSES.map((status) => o(`status.${status}`)), (label) => badgeWidth(label, locale) + 4 + 14),
  };
  for (const key of Object.keys(needs) as OrderListMessageKey[]) {
    needs[key] = Math.ceil(Math.max(needs[key]!, heading(key)) + CELL_PADDING);
  }
  return needs;
}

function productNeeds(locale: Locale): Record<string, number> {
  const { body, caption } = TYPE[locale];
  const p = (key: ProductMessageKey, vars?: Record<string, string | number>) => translate(productMessages, key, vars);
  const heading = (key: ProductMessageKey, sortable = false) => textWidth(p(key), caption, { medium: true }) + (sortable ? SORT_ARROW : 0);
  const fmt = money("৳");
  const layout = PRODUCT_COLUMN_LAYOUT;
  const needs = {
    status: Math.max(widest([p("statusActive"), p("statusDraft")], (label) => badgeWidth(label, locale)), heading("columnStatus")),
    inventory: Math.max(capped(widest([p("inStockVariants", { count: 1_234_567, variants: 120 }), p("notTracked")], (text) => textWidth(text, body)), layout.inventory.maxWidth), heading("columnInventory")),
    category: Math.max(capped(textWidth("Women's Clothing › Ethnic Wear › Three-piece sets", body), layout.category.maxWidth), heading("columnCategory", true)),
    price: Math.max(
      widest([`${fmt(9_999_999.99)}–${fmt(9_999_999.99)}`, `${fmt(999_999.99)} ${fmt(9_999_999.99)}`, p("saleOnSome"), p("noPrice")], (text) => textWidth(text, body)),
      heading("columnPrice", true),
    ),
  };
  return Object.fromEntries(Object.entries(needs).map(([key, width]) => [key, Math.ceil(width + CELL_PADDING)]));
}

function customerNeeds(locale: Locale): Record<string, number> {
  const { body, caption } = TYPE[locale];
  const c = (key: keyof (typeof customersMessages)["en"], vars?: Record<string, string | number>) => translate(customersMessages, key, vars);
  const heading = (key: keyof (typeof customersMessages)["en"]) => textWidth(c(key), caption, { medium: true }) + SORT_ARROW;
  const needs = {
    name: Math.max(capped(Math.max(...LONG_NAMES.map((name) => textWidth(name, body, { medium: true }))), CUSTOMER_COLUMN_LAYOUT.name.maxWidth), heading("customer")),
    totalOrders: Math.max(textWidth(c("orderCount", { count: 123_456 }), body), heading("orders")),
    totalSpent: Math.max(widest(amounts(), (amount) => textWidth(amount, body)), heading("spent")),
    lastOrderAt: Math.max(widest(dateLabels(), (label) => textWidth(label, body)), heading("lastOrder")),
  };
  return Object.fromEntries(Object.entries(needs).map(([key, width]) => [key, Math.ceil(width + CELL_PADDING)]));
}

const everything = new Proxy({}, { get: () => true }) as OrderActionPermissions;
const orderHandlers: OrderRowHandlers = {
  showArchived: false,
  dateField: "createdAt",
  selectable: true,
  orderActions: everything,
  updatingStatusIds: new Set(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onStatusUpdate: vi.fn(),
  onShipmentRefreshed: vi.fn(),
};
const orderColumns = () => getOrderColumns(orderHandlers, pluginColumns<OrderListItem>());
const withEnds = <TData extends TableRowData>(columns: ColumnDef<TData, unknown>[]): ColumnDef<TData, unknown>[] => [
  { id: "select", cell: () => null },
  ...columns,
  { id: "actions", cell: () => null },
];
const productColumns = () => withEnds(getProductColumns({ trashed: false, fmt: money("৳"), rowTo: () => "/", extra: pluginColumns<ProductListItem>() }));
const customerColumns = () => withEnds(getCustomerColumns({
  t: (key, vars) => translate(customersMessages, key, vars),
  fmt: money("৳"),
  rowTo: () => "/",
  extra: pluginColumns<CustomerListItem>(),
}));

type AnyColumns = () => ColumnDef<TableRowData, unknown>[];

const LISTS = [
  {
    name: "orders",
    columns: orderColumns as unknown as AnyColumns,
    needs: orderNeeds,
    always: ["order", "date"],
    working: ["order", "date", "customer", "total", "status"],
    // Payment and fulfilment side by side, or folded into one cell.
    workingAny: [["payment", "fulfillment"], ["paymentFulfillment"]],
  },
  { name: "products", columns: productColumns as unknown as AnyColumns, needs: productNeeds, always: ["name"], working: ["name", "status", "inventory", "price", "category"], workingAny: [[]] },
  { name: "customers", columns: customerColumns as unknown as AnyColumns, needs: customerNeeds, always: ["name"], working: ["name", "totalOrders", "totalSpent", "lastOrderAt"], workingAny: [[]] },
] as const;

describe("list layout with the most and the least data", () => {
  beforeEach(() => setStoreTimeZone("Asia/Dhaka"));
  afterEach(() => setLocale("en"));

  describe.each(LISTS)("$name list", (list) => {
    it.each(LOCALES)("gives every column room for its widest content and heading (%s)", (locale) => {
      setLocale(locale);
      const needs = list.needs(locale);
      const columns = new Map(list.columns().map((column) => [columnId(column), column]));
      const short = Object.entries(needs)
        .filter(([id, need]) => (columns.get(id)?.meta?.minWidth ?? 0) < need)
        .map(([id, need]) => `${id}: minWidth ${columns.get(id)?.meta?.minWidth}, needs ${need}`);
      expect(short).toEqual([]);
    });

    it.each(LAPTOP_VIEWPORTS.flatMap((viewport) => LOCALES.map((locale) => [viewport, locale] as const)))("fits a %ipx window without sideways scrolling, keeping the columns that identify a row (%s)", (viewport, locale) => {
      setLocale(locale);
      const width = tableWidth(viewport);
      const { shown, used } = fitList(list.columns(), width);
      expect(used, `${shown.join(", ")} need ${used}px of ${width}px`).toBeLessThanOrEqual(width);
      for (const id of list.always) expect(shown).toContain(id);
      if (viewport === 1280 || viewport === 1440) {
        for (const id of list.working) expect(shown, `${viewport}px`).toContain(id);
        expect(list.workingAny.some((ids) => ids.every((id) => shown.includes(id))), `${viewport}px: ${shown.join(", ")}`).toBe(true);
      }
    });

    it.each(LOCALES)("steps apps' columns aside before the list's own (%s)", (locale) => {
      setLocale(locale);
      const own = fitList(list.columns().filter((column) => !columnId(column).startsWith("app.")), tableWidth(1280)).shown;
      const all = fitList(list.columns(), tableWidth(1280)).shown;
      expect(all.filter((id) => !id.startsWith("app."))).toEqual(own);
      // They show where there is room.
      expect(fitList(list.columns(), 4000).shown.filter((id) => id.startsWith("app."))).toHaveLength(4);
    });
  });

  it.each(LOCALES)("shows the orders list's Total on a 1024px laptop, where the navigation is the menu drawer (%s)", (locale) => {
    setLocale(locale);
    expect(NAV_PANEL_QUERY).toBe(`(min-width: ${NAV_PANEL_MIN_WIDTH}px)`);
    expect(tableWidth(1024)).toBeGreaterThan(tableWidth(NAV_PANEL_MIN_WIDTH));
    expect(fitList(orderColumns(), tableWidth(1024)).shown).toContain("total");
  });

  it.each(LOCALES)("folds Payment and Fulfillment into one cell only where they don't fit side by side (%s)", (locale) => {
    setLocale(locale);
    const at = (viewport: number) => fitList(orderColumns(), tableWidth(viewport)).shown;
    expect(at(1280)).toContain("paymentFulfillment");
    expect(at(1280)).not.toContain("payment");
    expect(at(1440)).toEqual(expect.arrayContaining(["payment", "fulfillment"]));
    expect(at(1440)).not.toContain("paymentFulfillment");
    expect(at(1920)).not.toContain("paymentFulfillment");
  });

  it.each(LOCALES)("formats list dates the Shopify way, in store time (%s)", (locale) => {
    setLocale(locale);
    // 18:00 in Dhaka on Wednesday 7 October 2026.
    const at = (iso: string) => listDateLabel(new Date(iso), NOW, t);
    const expected = locale === "en"
      ? ["Just now", "41 min ago", "Today at 3:42 PM", "Yesterday at 11:42 PM", "Sunday at 9:05 AM", "Sep 30 at 3:42 PM", "Oct 3, 2025", "Today at 12:30 AM"]
      : ["এইমাত্র", "৪১ মিনিট আগে", "আজ ১৫:৪২", "গতকাল ২৩:৪২", "রবিবার ০৯:০৫", "৩০ সেপ ১৫:৪২", "৩ অক্টো, ২০২৫", "আজ ০০:৩০"];
    expect([
      at("2026-10-07T11:59:30Z"),
      at("2026-10-07T11:19:00Z"),
      at("2026-10-07T09:42:00Z"),
      at("2026-10-06T17:42:00Z"),
      at("2026-10-04T03:05:00Z"),
      at("2026-09-30T09:42:00Z"),
      at("2025-10-03T09:42:00Z"),
      // Just after midnight in Dhaka is still the same store day, though it is yesterday in UTC.
      at("2026-10-06T18:30:00Z"),
    ].map((label) => label.replace(/\s/g, " "))).toEqual(expected);
  });
});

// ── Rendered rows ───────────────────────────────────────────────────────────

const fullOrder = {
  id: "ord_max",
  orderNumber: 1_234_567,
  customerName: LONG_NAMES[1],
  customerPhone: PHONE,
  customerEmail: "a.very.long.customer.email.address@example-wholesale-garments.com.bd",
  status: "processing",
  paymentStatus: "partially_refunded",
  paymentMethod: "bkash",
  fulfillmentStatus: "partial",
  totalAmount: 9_999_999.99,
  paidAmount: 100,
  itemCount: 120,
  createdAt: new Date("2025-09-30T17:48:00Z"),
  updatedAt: new Date(),
  latestShipment: { id: "s-1", status: "returned", providerName: "Steadfast" },
  shipmentRecovery: { state: "needs_attention", severity: "danger", activeLock: true, status: "reconcile_required" },
  paymentRecovery: { state: "needs_attention" },
  activeRefundOperation: { active: true, status: "processing", severity: "danger" },
  openRequestType: "return",
  onHold: true,
  refundDue: 450,
  refundedAmount: 100,
  cod: { status: "failed", deliveryAttempts: 3 },
  channel: "app",
  channelSource: "acme-loyalty-points-and-rewards",
  requiresShipping: true,
  shippingMethodKind: "delivery",
  archivedAt: null,
} as unknown as OrderListItem;

const emptyOrder = {
  id: "ord_min",
  orderNumber: null,
  customerName: "",
  customerPhone: null,
  customerEmail: null,
  status: "cancelled",
  paymentStatus: "unpaid",
  paymentMethod: "",
  fulfillmentStatus: "pending",
  totalAmount: 0,
  paidAmount: 0,
  itemCount: 0,
  createdAt: null,
  updatedAt: null,
  latestShipment: null,
  shipmentRecovery: null,
  activeRefundOperation: null,
  openRequestType: null,
  refundDue: 0,
  cod: null,
  channel: null,
  channelSource: null,
  archivedAt: null,
} as unknown as OrderListItem;

const fullProduct = {
  id: "prod_max",
  name: `${LONG_NAMES[0]} Premium Hand-embroidered Silk Panjabi`,
  primaryImage: null,
  isActive: true,
  onHand: 1_234_567,
  variantCount: 120,
  category: { id: "cat_1", name: "Women's Clothing › Ethnic Wear › Three-piece sets › Eid Collection 2026" },
  priceRange: { from: 999_999.99, to: 9_999_999.99, compareAt: null },
  hasVariantDiscount: true,
  hasStockHistory: true,
} as unknown as ProductListItem;

const emptyProduct = {
  id: "prod_min",
  name: "",
  primaryImage: null,
  isActive: false,
  onHand: null,
  variantCount: 0,
  category: { id: null, name: "" },
  priceRange: null,
  hasVariantDiscount: false,
  hasStockHistory: false,
} as unknown as ProductListItem;

const fullCustomer = {
  id: "cust_max",
  name: LONG_NAMES[1],
  phone: PHONE,
  email: "a.very.long.customer.email.address@example-wholesale-garments.com.bd",
  kind: "account",
  totalOrders: 123_456,
  totalSpent: 9_999_999.99,
  lastOrderAt: new Date("2025-09-30T17:48:00Z"),
} as unknown as CustomerListItem;

const emptyCustomer = {
  id: "cust_min",
  name: "",
  phone: null,
  email: null,
  kind: "merchant",
  totalOrders: 0,
  totalSpent: 0,
  lastOrderAt: null,
} as unknown as CustomerListItem;

/** Text that could wrap: a text node with no one-line ancestor inside the cell. */
function wrappingText(cell: Element): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    let oneLine = false;
    for (let element = node.parentElement; element && element !== cell.parentElement; element = element.parentElement) {
      if (/\b(truncate|whitespace-nowrap|line-clamp-[12])\b/.test(element.getAttribute("class") ?? "")) {
        oneLine = true;
        break;
      }
    }
    if (!oneLine) found.push(node.textContent);
  }
  return found;
}

/** Lines a cell takes: its one-line blocks stacked, or the reserved `min-h-[2lh]`. */
function lines(cell: Element): number {
  if (cell.querySelector(".min-h-\\[2lh\\]")) return 2;
  const blocks = [...cell.querySelectorAll("[class*='block'], [data-part=value], [class*='line-clamp']")]
    .filter((element) => !element.parentElement?.closest("[class*='block'], [data-part=value]") || element.parentElement === cell);
  return Math.max(1, blocks.length);
}

describe("rendered rows with the most and the least data", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    setStoreTimeZone("Asia/Dhaka");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLocale("en");
  });

  async function render(ui: ReactNode) {
    const rootRoute = createRootRoute();
    const page = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
    const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
  }

  async function renderRows<TData extends TableRowData>(columns: ColumnDef<TData, unknown>[], rows: TData[]) {
    await render(
      <table>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} data-row={index}>
              {columns.map((column) => {
                const cell = column.cell as ((context: { row: { original: TData } }) => ReactNode) | undefined;
                // As the table styles it: numbers never wrap (`data-numeric`).
                return (
                  <td key={columnId(column)} data-col={columnId(column)} className={column.meta?.numeric ? "whitespace-nowrap" : undefined}>
                    {cell?.({ row: { original: row } })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>,
    );
  }

  const cases = [
    { name: "orders", columns: () => getOrderColumns({ ...orderHandlers, selectable: false }, pluginColumns<OrderListItem>()), rows: [fullOrder, emptyOrder] },
    { name: "products", columns: () => getProductColumns({ trashed: true, fmt: money("৳"), rowTo: () => "/", extra: pluginColumns<ProductListItem>() }), rows: [fullProduct, emptyProduct] },
    { name: "customers", columns: customerColumns, rows: [fullCustomer, emptyCustomer] },
  ] as const;

  describe.each(cases)("$name", ({ columns, rows }) => {
    it.each(LOCALES)("keeps every cell to its lines, full or empty, and cuts long text with the whole value on hover (%s)", async (locale) => {
      setLocale(locale);
      const defs = (columns as () => ColumnDef<TableRowData, unknown>[])();
      await renderRows(defs, rows as unknown as TableRowData[]);
      for (const column of defs) {
        const id = columnId(column);
        const [full, empty] = [...host.querySelectorAll(`td[data-col="${CSS.escape(id)}"]`)];
        expect(wrappingText(full!), `${id} wraps`).toEqual([]);
        expect(wrappingText(empty!), `${id} wraps when empty`).toEqual([]);
        // Full and empty rows take the same lines: rows never change height with their data.
        expect(lines(empty!), id).toBe(lines(full!));
        for (const cut of full!.querySelectorAll(".truncate")) {
          if (cut.textContent) expect(cut.getAttribute("title") ?? cut.closest("[title]")?.getAttribute("title"), `${id}: ${cut.textContent}`).toBeTruthy();
        }
      }
    });
  });

  it.each(LOCALES)("shows the date and the status on the phone card, full or empty (%s)", async (locale) => {
    setLocale(locale);
    await render(
      <div>
        {[fullOrder, emptyOrder].map((order) => (
          <div key={order.id} data-card={order.id}>
            <OrderMobileCard order={order} dateField="createdAt" selectable isSelected={false} onToggleSelection={vi.fn()} />
          </div>
        ))}
      </div>,
    );
    const o = (key: string) => translate(orderMessages, key as never);
    const full = host.querySelector('[data-card="ord_max"]')!;
    const empty = host.querySelector('[data-card="ord_min"]')!;
    expect(full.textContent).toContain(o("status.processing"));
    expect(full.querySelector("[title]")?.getAttribute("title")).toBeTruthy();
    expect(full.textContent).toMatch(locale === "en" ? /Sep 30, 2025/ : /সেপ, ২০২৫/);
    expect(empty.textContent).toContain(o("status.cancelled"));
    expect(empty.textContent).toContain("—");
    expect(full.querySelector("a")!.children).toHaveLength(empty.querySelector("a")!.children.length);
  });
});
