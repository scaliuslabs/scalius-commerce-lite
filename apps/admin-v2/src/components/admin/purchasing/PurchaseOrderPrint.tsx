/* eslint-disable shadcn/no-unknown-classes -- the printed purchase order is a white paper
   document in its own window that must not follow the dashboard theme, so it carries its
   own stylesheet and class names (as the invoice does). */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PurchaseOrder } from "~/lib/api-query-options/purchasing";
import type { PurchasingMessageKey } from "~/i18n/purchasing";
import { formatNumber } from "~/i18n";
import { formatDay, formatMoment, lineName } from "./purchasing-format";

type Translate = (key: PurchasingMessageKey, vars?: Record<string, string | number>) => string;

export const PURCHASE_ORDER_PRINT_CSS = `
  @page { margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font: 13px/1.5 Inter, "Noto Sans Bengali", system-ui, sans-serif; }
  .po-sheet { max-width: 800px; margin: 0 auto; padding: 24px; }
  .po-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
  .po-store { font-size: 18px; font-weight: 600; }
  .po-title { font-size: 20px; font-weight: 600; text-align: right; }
  .po-muted { color: #555; }
  .po-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 16px; }
  .po-label { color: #555; font-size: 12px; margin-bottom: 2px; }
  .po-facts { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; font-weight: 600; color: #555; border-bottom: 1px solid #999; padding: 6px 8px; }
  td { border-bottom: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
  .po-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .po-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .po-totals { margin: 16px 0 0 auto; width: 280px; }
  .po-totals div { display: flex; justify-content: space-between; padding: 2px 0; }
  .po-total { border-top: 1px solid #999; margin-top: 4px; padding-top: 6px !important; font-weight: 600; }
  .po-notes { margin-top: 24px; white-space: pre-wrap; }
`;

/** The purchase order as a paper document: who, where, when, the lines and the totals. */
export function PurchaseOrderSheet({ order, storeName, t, fmt }: {
  order: PurchaseOrder;
  storeName: string;
  t: Translate;
  fmt: (amount: number) => string;
}) {
  const supplier = order.supplier;
  const dated = formatMoment(order.orderedAt ?? order.createdAt);
  const expected = formatDay(order.expectedOn);
  return (
    <div className="po-sheet">
      <div className="po-head">
        <div className="po-store">{storeName}</div>
        <div>
          <div className="po-title">{t("printTitle", { number: order.displayNumber })}</div>
          {dated ? <div className="po-muted po-num">{t("printDate")}: {dated}</div> : null}
        </div>
      </div>
      <div className="po-parties">
        <div>
          <div className="po-label">{t("printSupplier")}</div>
          {supplier ? (
            <>
              <div>{supplier.name}</div>
              {supplier.contactName ? <div>{supplier.contactName}</div> : null}
              {supplier.phone ? <div>{supplier.phone}</div> : null}
              {supplier.email ? <div>{supplier.email}</div> : null}
            </>
          ) : <div className="po-muted">{t("noSupplier")}</div>}
        </div>
        <div>
          <div className="po-label">{t("printShipTo")}</div>
          <div>{order.destination.name}</div>
        </div>
      </div>
      <div className="po-facts">
        <div>
          <div className="po-label">{t("expectedArrival")}</div>
          <div>{expected ?? t("notSet")}</div>
        </div>
        <div>
          <div className="po-label">{t("reference")}</div>
          <div>{order.reference ?? t("none")}</div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("colProduct")}</th>
            <th>{t("colSku")}</th>
            <th className="po-num">{t("colQuantity")}</th>
            <th className="po-num">{t("colCost")}</th>
            <th className="po-num">{t("colLineTotal")}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id}>
              <td>{lineName(line, t("unknownProduct"))}</td>
              <td className="po-mono">{line.sku}</td>
              <td className="po-num">{formatNumber(line.quantity)}</td>
              <td className="po-num">{fmt(line.unitCost)}</td>
              <td className="po-num">{fmt(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="po-totals">
        <div><span>{t("subtotal")}</span><span className="po-num">{fmt(order.subtotal)}</span></div>
        {order.shipping > 0 ? <div><span>{t("shipping")}</span><span className="po-num">{fmt(order.shipping)}</span></div> : null}
        {order.otherCosts > 0 ? <div><span>{t("otherCosts")}</span><span className="po-num">{fmt(order.otherCosts)}</span></div> : null}
        {order.tax > 0 ? <div><span>{t("tax")}</span><span className="po-num">{fmt(order.tax)}</span></div> : null}
        <div className="po-total"><span>{t("total")}</span><span className="po-num">{fmt(order.total)}</span></div>
      </div>
      {order.notes ? (
        <div className="po-notes">
          <div className="po-label">{t("notes")}</div>
          {order.notes}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Opens the purchase order in its own window and prints it. Called inside
 * the click so pop-up blockers allow it; false when the window was blocked.
 * The sheet is plain React rendered into that window (no dashboard styles).
 */
export function printPurchaseOrder(input: {
  order: PurchaseOrder;
  storeName: string;
  t: Translate;
  fmt: (amount: number) => string;
  lang: string;
}): boolean {
  const printWindow = window.open("", "_blank");
  if (!printWindow) return false;
  const doc = printWindow.document;
  doc.documentElement.lang = input.lang;
  doc.title = input.t("printTitle", { number: input.order.displayNumber });
  const style = doc.createElement("style");
  style.textContent = PURCHASE_ORDER_PRINT_CSS;
  doc.head.append(style);
  const container = doc.createElement("div");
  doc.body.replaceChildren(container);
  const root = createRoot(container);
  flushSync(() => root.render(<PurchaseOrderSheet order={input.order} storeName={input.storeName} t={input.t} fmt={input.fmt} />));
  printWindow.addEventListener("pagehide", () => root.unmount(), { once: true });
  printWindow.focus();
  printWindow.print();
  return true;
}
